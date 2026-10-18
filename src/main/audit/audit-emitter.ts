/**
 * T046 — Audit-event emitter (S3 bootstrap).
 *
 * Validates FR-025 mandatory attributes, refuses forbidden payload field
 * names (PR-1 / FR-027), then writes to the local `audit_events` table via
 * the injected `AuditEventsStore`. Idempotency is enforced at the SQL layer
 * with `INSERT OR IGNORE` (AD-3 / composite PK).
 *
 * Out of scope for this PR: T047 (sync loop), T048 (bridge wiring), T050
 * (pino extension). The emitter is intentionally narrow — call it from
 * wherever an operator action needs auditing.
 */

import type { AuditEvent, Fr025MandatoryAttribute } from '../../shared/audit/event-shape.js';
import { FR025_MANDATORY_ATTRIBUTES } from '../../shared/audit/event-shape.js';
import { findForbiddenKey } from './find-forbidden-key.js';

// ─── Forbidden payload field names (PR-1 / FR-027) ─────────────────────────

/**
 * Re-export the canonical list from `shared/audit/forbidden-keys.ts`.
 * The same list also drives `src/main/logging/logger.ts` redaction paths
 * and the Sentry `beforeSend` denylist (T050) — one source of truth.
 */
export {
  FORBIDDEN_PAYLOAD_KEYS,
  type ForbiddenPayloadKey,
} from '../../shared/audit/forbidden-keys.js';

// ─── DI interface ──────────────────────────────────────────────────────────

/**
 * Narrow data-access interface injected into the emitter. Production code
 * binds this to the better-sqlite3 handle; tests inject a fake.
 */
export interface AuditEventsStore {
  /**
   * Persist one audit event. Must use `INSERT OR IGNORE` semantics so a
   * duplicate `(event_id, tenant_id)` pair silently no-ops (AD-3).
   */
  insertIgnore(event: AuditEvent): void;
}

// ─── Validation errors ─────────────────────────────────────────────────────

export class MissingMandatoryAttributeError extends Error {
  readonly attribute: Fr025MandatoryAttribute;
  constructor(attribute: Fr025MandatoryAttribute) {
    super(`audit-emitter: missing mandatory FR-025 attribute: ${attribute}`);
    this.name = 'MissingMandatoryAttributeError';
    this.attribute = attribute;
  }
}

export class ForbiddenPayloadKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`audit-emitter: payload contains forbidden field name: ${key}`);
    this.name = 'ForbiddenPayloadKeyError';
    this.key = key;
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

// ─── Emitter ───────────────────────────────────────────────────────────────

export class AuditEmitter {
  private readonly store: AuditEventsStore;

  constructor(store: AuditEventsStore) {
    this.store = store;
  }

  /**
   * Validate and emit one audit event to the local store.
   *
   * Throws `MissingMandatoryAttributeError` if any FR-025 key is absent from
   * the event object (value may be `null` — presence, not truthiness, is the
   * contract).
   *
   * Throws `ForbiddenPayloadKeyError` if the payload tree contains a
   * forbidden field name at any nesting depth.
   *
   * On success, delegates to `store.insertIgnore()` — duplicate
   * `(event_id, tenant_id)` pairs are silently dropped (idempotent).
   */
  emit(event: AuditEvent): void {
    this.validateMandatoryAttributes(event);
    this.validatePayload(event.payload);
    this.store.insertIgnore(event);
  }

  private validateMandatoryAttributes(event: AuditEvent): void {
    for (const attr of FR025_MANDATORY_ATTRIBUTES) {
      if (!(attr in event)) {
        throw new MissingMandatoryAttributeError(attr);
      }
    }
  }

  private validatePayload(payload: Readonly<Record<string, unknown>>): void {
    const forbidden = findForbiddenKey(payload);
    if (forbidden !== null) {
      throw new ForbiddenPayloadKeyError(forbidden);
    }
  }
}
