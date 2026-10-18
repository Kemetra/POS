/**
 * T113 — `payment_action_outbox` repository.
 *
 * Owns SQL access for the append-only `payment_action_outbox` table
 * (006-payments-tender Slice 3a). Wraps the production `DatabaseHandle` so
 * tests can inject a sql.js adapter.
 *
 * Surface per tasks.md T113: insert + lookup-by-action-id, plus the
 * canonical payload-hash helper used by S3b's idempotency-replay module
 * (research §R-10).
 *
 * SECURITY (Constitution §P6 / §P7 / §P11): the hash is computed over the
 * payload object the caller hands in. **The caller is responsible for
 * stripping forbidden fields before hashing** — voucher tokens must never
 * be hashed at all, `external_reference` must be redacted to `'*****'`.
 * This module's only job is the deterministic canonicalisation.
 *
 * Determinism: keys are sorted at every nesting level, primitives are
 * JSON-stringified verbatim, and the resulting canonical string is fed to
 * SHA-256. Two payloads that differ only in key order produce the same
 * hash; two payloads that differ in any value produce different hashes.
 */

import { createHash } from 'node:crypto';

import { compareCodeUnits } from '../../../shared/compare-code-units.js';
import type { DatabaseHandle } from '../../db/client.js';

interface PrepareRun {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

export type PaymentActionKind =
  | 'payment.attempt.start'
  | 'payment.confirm'
  | 'payment.cancel'
  | 'payment.fail'
  | 'payment.force_fail'
  | 'payment.discarded_on_session_end'
  | 'tender.apply'
  | 'tender.reverse';

export interface PaymentActionOutboxRow {
  action_id: string;
  payment_attempt_id: string;
  tender_line_id: string | null;
  action_kind: PaymentActionKind;
  action_payload_hash: string;
  acting_operator_id: string;
  created_at: string;
}

export interface InsertPaymentActionOutboxInput {
  action_id: string;
  payment_attempt_id: string;
  tender_line_id: string | null;
  action_kind: PaymentActionKind;
  action_payload_hash: string;
  acting_operator_id: string;
  created_at: string;
}

export interface PaymentActionOutboxRepository {
  insert(input: InsertPaymentActionOutboxInput): void;
  findByActionId(action_id: string): PaymentActionOutboxRow | undefined;
}

export function bindPaymentActionOutboxRepository(
  db: DatabaseHandle,
): PaymentActionOutboxRepository {
  const insertStmt = db.prepare(
    `INSERT INTO payment_action_outbox (
       action_id, payment_attempt_id, tender_line_id,
       action_kind, action_payload_hash,
       acting_operator_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ) as PrepareRun;

  const findByActionIdStmt = db.prepare(
    `SELECT * FROM payment_action_outbox WHERE action_id=?`,
  ) as PrepareGet<PaymentActionOutboxRow>;

  return {
    insert(input: InsertPaymentActionOutboxInput): void {
      insertStmt.run(
        input.action_id,
        input.payment_attempt_id,
        input.tender_line_id,
        input.action_kind,
        input.action_payload_hash,
        input.acting_operator_id,
        input.created_at,
      );
    },

    findByActionId(action_id: string): PaymentActionOutboxRow | undefined {
      return findByActionIdStmt.get(action_id) ?? undefined;
    },
  };
}

/**
 * Deterministic SHA-256 hash of a canonicalised JSON payload.
 *
 * Canonicalisation rules:
 *   • Object keys are sorted ascending at every nesting level.
 *   • Arrays preserve their order (positional semantics matter — e.g.,
 *     LIFO apply order on tender lines).
 *   • Primitives are serialised via `JSON.stringify` defaults.
 *   • `undefined` values are omitted (matches JSON semantics).
 *
 * The caller MUST redact PII / card data / voucher tokens before calling.
 * This helper enforces no semantic redaction; it only canonicalises.
 */
export function computeActionPayloadHash(payload: unknown): string {
  const canonical = canonicalise(payload, new WeakSet());
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function canonicalise(value: unknown, seen: WeakSet<object>): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError('computeActionPayloadHash payload must not contain cycles');
    }
    seen.add(value);
    const out = `[${value.map((v) => canonicalise(v, seen)).join(',')}]`;
    seen.delete(value);
    return out;
  }
  // The bridge layer only forwards plain JSON-shaped data (string / number /
  // boolean / null / object / array); types narrow `unknown` to that subset by
  // the time payloads reach this function. We still guard against cycles —
  // those would otherwise blow the stack rather than produce a clear error.
  const obj = value as Record<string, unknown>;
  if (seen.has(obj)) {
    throw new TypeError('computeActionPayloadHash payload must not contain cycles');
  }
  seen.add(obj);
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(compareCodeUnits);
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalise(obj[k], seen)}`);
  seen.delete(obj);
  return `{${entries.join(',')}}`;
}
