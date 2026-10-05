import type { Logger } from 'pino';

import {
  OFFLINE_GRANT_INVALIDATION_REASONS,
  type OfflineGrantInvalidationReason,
} from '../../shared/audit/payload-schemas.js';
import type { DatabaseHandle } from '../db/client.js';
import type { SafeStorageLike } from '../secrets/safe-storage.js';

import type { CashierAdmittedEvent } from './cashier-admission.js';

/**
 * RT-113 P1.1 — the sealed offline grant store (Jira RT-113: planning record
 * 10763 D3/D4/D5/D10, P1 plan 10871, owner approval 10874).
 *
 * A grant is the local proof that Backend-Core admitted a cashier ONLINE on
 * this terminal. P3 will let that cashier sign in offline, within bounds, on
 * the strength of it. This module only stores, bounds and checks grants. It is
 * pure (injected seal, DB handle and clock). P1.2 wires it into the
 * cashier-admission grant seam, the pairing changes and the clock tick
 * (`offline-grant-wiring.ts`).
 *
 * Storage (migration 0041): one `cashier_offline_grants` row per
 * (tenant, branch, terminal, user_id). Everything that decides admissibility
 * sits in `sealed_body` (safeStorage; DPAPI on Windows), and the counter and
 * the invalidation are re-sealed on every change (OD3). The body also seals
 * the row's own key and the pairing epoch, so a body copied into another row,
 * a row whose key was edited, or a grant from before a re-pair, is no proof.
 *
 * Bounds (10763 D4):
 *  - time: expired at exactly `issued_at_local + min(ttl_ms, 72 h)`, where
 *    `issued_at_local` is the local receipt time of the admission;
 *  - count: at most 8 offline uses per grant; the 9th is refused;
 *  - clock: refused when `now < high-water mark − 5 min`. The mark only rises.
 *    The grant's own issue and last-use times floor the clock too, so an older
 *    mark written back does not reopen a rolled-back clock below them. F2
 *    (P1.2): a mark that is MISSING while any grant row exists is `storage`.
 *  - epoch: every new pairing gets an epoch above the mark (F4), so a grant
 *    from an earlier pairing never matches, even when `paired_at` repeats.
 *
 * Failure is never proof (D10): any read, unseal or parse failure refuses.
 * `evaluate`, `consumeOfflineUse`, `observeClock` and `nextPairingEpoch` never
 * throw, not even on a throwing logger (F3). The writes
 * (`upsertFromAdmitted`, `invalidate`, `invalidateAll`, `purgeAll`) throw an
 * {@link OfflineGrantStoreError} carrying a category only. When a write that
 * should end or replace a grant fails, the store first deletes that grant, so
 * the failure leaves no stale proof behind.
 *
 * Privacy: no grant field (ids, operator_id, display_name, times) ever reaches
 * the logger or an error message. Log lines carry an event name and a closed
 * category, reason, operation or count, nothing else.
 *
 * Residual risk accepted for the pilot (OD11): DPAPI binds a seal to the
 * Windows user, not to this application. Code running as the same Windows
 * user can unseal, edit and re-seal a body, or restore an older one (an older
 * counter). The PIN is still required, Backend-Core audits, and the offline
 * session is reconciled on reconnect (P4).
 */

/** D4: the hard ceiling on a grant's lifetime, whatever the server says. */
const OFFLINE_GRANT_MAX_TTL_SECONDS = 72 * 60 * 60;
export const OFFLINE_GRANT_MAX_TTL_MS = OFFLINE_GRANT_MAX_TTL_SECONDS * 1000;

/** D4: offline admissions per grant. */
export const OFFLINE_GRANT_MAX_USES = 8;

/** D4/OD7: how far the wall clock may sit behind the high-water mark. */
export const OFFLINE_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

/** Why a grant was invalidated (10763 D4, OD6, OD8). Closed set, shared with the audit payload. */
export { OFFLINE_GRANT_INVALIDATION_REASONS, type OfflineGrantInvalidationReason };

/** Why there is no proof. Closed set; logged and audited as-is, never a field. */
export const OFFLINE_GRANT_REFUSAL_CATEGORIES = [
  'grant_missing',
  'grant_invalidated',
  'grant_expired',
  'count_exhausted',
  'clock_suspect',
  'scope_mismatch',
  'tampered',
  'storage',
] as const;

export type OfflineGrantRefusalCategory = (typeof OFFLINE_GRANT_REFUSAL_CATEGORIES)[number];

/** The terminal a grant belongs to: the current pairing (D5, OD4). */
export interface OfflineGrantScope {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  /** `terminal_assignment.paired_at` (unix seconds): changes on every pairing. */
  pairing_epoch: number;
}

/** What an admissible grant tells its caller. Contains PII: never log it. */
export interface OfflineGrant {
  user_id: string;
  /** The session `operator_id` (RT-116 seam 1). */
  operator_id: string;
  display_name: string;
  admission_id: string;
  issued_at_local_ms: number;
  /** `issued_at_local + min(ttl, 72 h)`: the grant is expired from this instant. */
  expires_at_local_ms: number;
  offline_admissions_used: number;
  offline_admissions_remaining: number;
}

export type OfflineGrantEvaluation =
  | { admissible: true; grant: OfflineGrant }
  | { admissible: false; category: OfflineGrantRefusalCategory };

/** Who lost a grant, for one audit event each (OD10). */
export interface InvalidatedGrant {
  user_id: string;
  operator_id: string;
}

export interface InvalidateResult {
  /** Grants that were valid-shaped and are now invalidated (or removed). */
  invalidated: InvalidatedGrant[];
  /** Rows that could not be read as a grant of their own key and were deleted. */
  removed_unreadable: number;
}

export type UpsertResult =
  | { kind: 'written' }
  /** OD8: grace 0 — nothing written; any existing grant invalidated. */
  | { kind: 'grace_disabled'; invalidated: InvalidatedGrant[] }
  /** The event was malformed — nothing written; any existing grant invalidated. */
  | { kind: 'rejected'; invalidated: InvalidatedGrant[] }
  /**
   * Codex P2 4183383061 — the fresh grant could not be written, so the old one
   * was deleted (fail closed). `invalidated` names a standing (not yet
   * invalidated) grant that this removed, for its `refresh_failed` audit.
   */
  | { kind: 'refresh_failed'; invalidated: InvalidatedGrant[] };

export type ClockObservation = { kind: 'raised' } | { kind: 'unchanged' } | { kind: 'unavailable' };

export type OfflineGrantStoreErrorCategory = 'storage' | 'invalid_input';

/** A failed write. Carries a category only: never a grant field. */
export class OfflineGrantStoreError extends Error {
  readonly category: OfflineGrantStoreErrorCategory;

  constructor(category: OfflineGrantStoreErrorCategory) {
    super(`offline grant store: ${category}`);
    this.name = 'OfflineGrantStoreError';
    this.category = category;
  }
}

export interface OfflineGrantStoreDeps {
  db: DatabaseHandle;
  safeStorage: SafeStorageLike;
  /** The wall clock for write stamps (`sealed_at`, invalidation time, write-time mark). */
  now: () => Date;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export interface OfflineGrantStore {
  /** Write or refresh a grant from an online `admitted` event (resets the counter). */
  upsertFromAdmitted(scope: OfflineGrantScope, event: CashierAdmittedEvent): UpsertResult;
  /** Invalidate one user's grant. */
  invalidate(
    scope: OfflineGrantScope,
    user_id: string,
    reason: OfflineGrantInvalidationReason,
  ): InvalidateResult;
  /** Invalidate every grant of the scope's tenant, branch and terminal. */
  invalidateAll(scope: OfflineGrantScope, reason: OfflineGrantInvalidationReason): InvalidateResult;
  /**
   * OD4: delete every grant on this device (pairing persisted or cleared).
   * Codex P1 4181552529: the purge first raises (or, when missing or
   * unreadable, re-seals) the clock mark above every purged grant's epoch and
   * clock floor and above `prior_epoch`, so deleting the grants never erases
   * the evidence {@link nextPairingEpoch} needs.
   */
  purgeAll(prior_epoch?: number): { removed: number };
  /** Is there proof for an offline admission now? Read-only but for the clock mark. */
  evaluate(scope: OfflineGrantScope, user_id: string, nowWall: Date): OfflineGrantEvaluation;
  /** Use one offline admission: evaluate, then increment and re-seal (P3 calls it). */
  consumeOfflineUse(
    scope: OfflineGrantScope,
    user_id: string,
    nowWall: Date,
  ): OfflineGrantEvaluation;
  /** OD7: raise the clock high-water mark to `nowWall`; never lowers it. */
  observeClock(nowWall: Date): ClockObservation;
  /**
   * F4 (10893): the epoch for a NEW pairing. `paired_at` has 1 s granularity,
   * so two pairings can share it; the epoch returned is strictly above every
   * epoch a grant on this device can hold. The mark is raised to it, so the
   * next call is above it again. Never throws: on a storage failure, or an
   * unreadable mark, it returns `candidate` (offline then stays refused until
   * an online write repairs the mark).
   */
  nextPairingEpoch(candidate: number): number;
}

// ── Sealed body ──────────────────────────────────────────────────────────────

const GRANT_KIND = 'cashier_offline_grant';
const HWM_KIND = 'cashier_offline_clock_hwm';
const BODY_VERSION = 1;

interface GrantBody {
  v: 1;
  kind: typeof GRANT_KIND;
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  user_id: string;
  pairing_epoch: number;
  admission_id: string;
  operator_id: string;
  display_name: string;
  issued_at_local: number;
  ttl_ms: number;
  server_time_at_issue: string;
  offline_admissions_used: number;
  last_used_at_local: number | null;
  invalidated: { reason: OfflineGrantInvalidationReason; at_local: number } | null;
}

interface HwmBody {
  v: 1;
  kind: typeof HWM_KIND;
  hwm_ms: number;
}

type Check = (v: unknown) => boolean;

/** A body shape: one check per field. A body must have exactly these fields. */
type Shape<T> = Readonly<Record<keyof T, Check>>;

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** An integer >= 0 of any size (`Number.isInteger`), as the admission client checks it. */
function isWholeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPositiveCount(v: unknown): boolean {
  return isCount(v) && v > 0;
}

function isNullOrCount(v: unknown): boolean {
  return v === null || isCount(v);
}

function isString(v: unknown): boolean {
  return typeof v === 'string';
}

function is(expected: unknown): Check {
  return (v) => v === expected;
}

function isReason(v: unknown): v is OfflineGrantInvalidationReason {
  return (OFFLINE_GRANT_INVALIDATION_REASONS as readonly unknown[]).includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  return !Array.isArray(v);
}

/** Exactly the shape's fields (none missing, none extra), each passing its check. */
function matchesShape<T>(v: unknown, shape: Shape<T>): v is T {
  if (!isRecord(v)) return false;
  const fields = Object.keys(shape) as (keyof T & string)[];
  if (Object.keys(v).length !== fields.length) return false;
  return fields.every((f) => Object.hasOwn(v, f) && shape[f](v[f]));
}

const INVALIDATION_SHAPE: Shape<NonNullable<GrantBody['invalidated']>> = {
  reason: isReason,
  at_local: isCount,
};

const GRANT_SHAPE: Shape<GrantBody> = {
  v: is(BODY_VERSION),
  kind: is(GRANT_KIND),
  tenant_id: isText,
  branch_id: isText,
  terminal_id: isText,
  user_id: isText,
  pairing_epoch: isCount,
  admission_id: isText,
  operator_id: isText,
  display_name: isString,
  issued_at_local: isCount,
  ttl_ms: isPositiveCount,
  server_time_at_issue: isString,
  offline_admissions_used: isCount,
  last_used_at_local: isNullOrCount,
  invalidated: (v) => v === null || matchesShape(v, INVALIDATION_SHAPE),
};

const HWM_SHAPE: Shape<HwmBody> = {
  v: is(BODY_VERSION),
  kind: is(HWM_KIND),
  hwm_ms: isCount,
};

/** Strict JSON parse against a shape; anything else is null. */
function parseBody<T>(text: string, shape: Shape<T>): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return matchesShape(parsed, shape) ? parsed : null;
}

/** The body seals the row's own key: a body read from another row is no proof. */
function bodyBelongsTo(body: GrantBody, scope: OfflineGrantScope, user_id: string): boolean {
  return (
    body.tenant_id === scope.tenant_id &&
    body.branch_id === scope.branch_id &&
    body.terminal_id === scope.terminal_id &&
    body.user_id === user_id
  );
}

function expiresAt(body: GrantBody): number {
  return body.issued_at_local + Math.min(body.ttl_ms, OFFLINE_GRANT_MAX_TTL_MS);
}

function grantView(body: GrantBody): OfflineGrant {
  return {
    user_id: body.user_id,
    operator_id: body.operator_id,
    display_name: body.display_name,
    admission_id: body.admission_id,
    issued_at_local_ms: body.issued_at_local,
    expires_at_local_ms: expiresAt(body),
    offline_admissions_used: body.offline_admissions_used,
    offline_admissions_remaining: Math.max(
      0,
      OFFLINE_GRANT_MAX_USES - body.offline_admissions_used,
    ),
  };
}

function isValidScope(scope: OfflineGrantScope): boolean {
  return (
    isText(scope.tenant_id) &&
    isText(scope.branch_id) &&
    isText(scope.terminal_id) &&
    isCount(scope.pairing_epoch)
  );
}

// ── SQL ─────────────────────────────────────────────────────────────────────

interface Stmt {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

const SELECT_GRANT = `SELECT sealed_body FROM cashier_offline_grants
  WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND user_id = ?`;
const SELECT_SCOPE_USERS = `SELECT user_id FROM cashier_offline_grants
  WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ?`;
const UPSERT_GRANT = `INSERT INTO cashier_offline_grants
  (tenant_id, branch_id, terminal_id, user_id, sealed_body, sealed_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (tenant_id, branch_id, terminal_id, user_id)
  DO UPDATE SET sealed_body = excluded.sealed_body, sealed_at = excluded.sealed_at`;
const CAS_GRANT = `UPDATE cashier_offline_grants SET sealed_body = ?, sealed_at = ?
  WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND user_id = ? AND sealed_body = ?`;
const DELETE_GRANT = `DELETE FROM cashier_offline_grants
  WHERE tenant_id = ? AND branch_id = ? AND terminal_id = ? AND user_id = ?`;
const DELETE_ALL_GRANTS = 'DELETE FROM cashier_offline_grants';
const SELECT_ALL_BODIES = 'SELECT sealed_body FROM cashier_offline_grants';
const SELECT_ANY_GRANT = 'SELECT 1 AS present FROM cashier_offline_grants LIMIT 1';
const SELECT_HWM = 'SELECT sealed_body FROM cashier_offline_clock_hwm WHERE id = 1';
const UPSERT_HWM = `INSERT INTO cashier_offline_clock_hwm (id, sealed_body, sealed_at) VALUES (1, ?, ?)
  ON CONFLICT (id) DO UPDATE SET sealed_body = excluded.sealed_body, sealed_at = excluded.sealed_at`;

/** better-sqlite3 returns a Buffer, sql.js a Uint8Array; NULL / text are no blob. */
function asBlob(v: unknown): Buffer | null {
  if (!(v instanceof Uint8Array) || v.length === 0) return null;
  return Buffer.from(v.buffer, v.byteOffset, v.length);
}

/** A grant row read and judged; `blob` is the exact stored value (for compare-and-swap). */
type GrantRead =
  | { kind: 'absent' }
  | { kind: 'no_body' }
  | { kind: 'unsealable' }
  | { kind: 'malformed' }
  | { kind: 'foreign' }
  | { kind: 'ok'; body: GrantBody; blob: Buffer };

/** The clock mark: `null` when no mark was ever written. */
type HwmRead = { kind: 'ok'; hwm_ms: number | null } | { kind: 'unreadable' };

const REFUSAL_BY_READ: Readonly<
  Record<Exclude<GrantRead['kind'], 'ok'>, OfflineGrantRefusalCategory>
> = {
  absent: 'grant_missing',
  no_body: 'grant_missing',
  unsealable: 'storage',
  malformed: 'tampered',
  foreign: 'tampered',
};

/** An `admitted` event the store can record. Its `user_id` is checked by the caller. */
const EVENT_RULES: readonly ((event: CashierAdmittedEvent) => boolean)[] = [
  // The client's own rule (any integer >= 0, no maximum): a huge grace is clamped, never rejected.
  (event) => isWholeNumber(event.offline_grace_seconds),
  (event) => isCount(Date.parse(event.received_at)),
  (event) => isText(event.operator_id),
  (event) => isText(event.admission_id),
  // The contract types display_name as any string; "" is valid.
  (event) => isString(event.display_name),
  (event) => isString(event.server_time),
];

/** The sealed body for an `admitted` event: counter 0, no invalidation. Null when malformed. */
function grantBodyFromEvent(
  scope: OfflineGrantScope,
  event: CashierAdmittedEvent,
): GrantBody | null {
  if (!EVENT_RULES.every((rule) => rule(event))) return null;
  return {
    v: BODY_VERSION,
    kind: GRANT_KIND,
    tenant_id: scope.tenant_id,
    branch_id: scope.branch_id,
    terminal_id: scope.terminal_id,
    user_id: event.user_id,
    pairing_epoch: scope.pairing_epoch,
    admission_id: event.admission_id,
    operator_id: event.operator_id,
    display_name: event.display_name,
    // D4: the local receipt time, never server_time (clock skew).
    issued_at_local: Date.parse(event.received_at),
    // Clamp BEFORE scaling: a huge grace times 1000 is no longer a safe integer.
    ttl_ms: Math.min(event.offline_grace_seconds, OFFLINE_GRANT_MAX_TTL_SECONDS) * 1000,
    server_time_at_issue: event.server_time,
    offline_admissions_used: 0,
    last_used_at_local: null,
    invalidated: null,
  };
}

type Judged =
  | { admissible: true; body: GrantBody; blob: Buffer }
  | { admissible: false; category: OfflineGrantRefusalCategory };

function refusedJudgement(category: OfflineGrantRefusalCategory): Judged {
  return { admissible: false, category };
}

function isAddressable(scope: OfflineGrantScope, user_id: string, now_ms: number): boolean {
  if (!isValidScope(scope)) return false;
  if (!isText(user_id)) return false;
  return isCount(now_ms);
}

/** The latest local time the grant itself saw: its issue or its last use. */
function clockFloor(body: GrantBody): number {
  return Math.max(body.issued_at_local, body.last_used_at_local ?? 0);
}

type BodyRule = readonly [
  OfflineGrantRefusalCategory,
  (body: GrantBody, scope: OfflineGrantScope, now_ms: number) => boolean,
];

/** Checked in order once the body is authentic and belongs to its row (D4, D5). */
const BODY_RULES: readonly BodyRule[] = [
  ['scope_mismatch', (body, scope) => body.pairing_epoch !== scope.pairing_epoch],
  ['grant_invalidated', (body) => body.invalidated !== null],
  ['clock_suspect', (body, _s, now_ms) => now_ms < clockFloor(body) - OFFLINE_CLOCK_TOLERANCE_MS],
  ['grant_expired', (body, _s, now_ms) => now_ms >= expiresAt(body)],
  ['count_exhausted', (body) => body.offline_admissions_used >= OFFLINE_GRANT_MAX_USES],
];

function refusalForBody(
  body: GrantBody,
  scope: OfflineGrantScope,
  now_ms: number,
): OfflineGrantRefusalCategory | null {
  return BODY_RULES.find(([, refuses]) => refuses(body, scope, now_ms))?.[0] ?? null;
}

export function createOfflineGrantStore(deps: OfflineGrantStoreDeps): OfflineGrantStore {
  const { db, safeStorage } = deps;

  function stmt(sql: string): Stmt {
    return db.prepare(sql) as Stmt;
  }

  function tx<T>(fn: () => T): T {
    return db.transaction(fn)();
  }

  function stamp(): string {
    return deps.now().toISOString();
  }

  /** F3 (10893): a throwing logger never escapes, and never aborts a write. */
  function log(level: 'info' | 'warn', fields: Record<string, string | number>): void {
    try {
      deps.logger?.[level](fields, String(fields['event']).replace(/\./g, ' '));
    } catch {
      // Logging is best-effort.
    }
  }

  function seal(text: string): Buffer {
    if (!safeStorage.isEncryptionAvailable()) throw new OfflineGrantStoreError('storage');
    return safeStorage.encryptString(text);
  }

  // ── grant rows ──

  /** A sealed grant body, opened and shape-checked; null when it is no readable grant. */
  function openGrantBody(sealed: unknown): GrantBody | null {
    const blob = asBlob(sealed);
    if (blob === null) return null;
    try {
      return parseBody(safeStorage.decryptString(blob), GRANT_SHAPE);
    } catch {
      return null;
    }
  }

  function readGrant(scope: OfflineGrantScope, user_id: string): GrantRead {
    const row = stmt(SELECT_GRANT).get(
      scope.tenant_id,
      scope.branch_id,
      scope.terminal_id,
      user_id,
    ) as { sealed_body: unknown } | undefined;
    if (row === undefined) return { kind: 'absent' };
    const blob = asBlob(row.sealed_body);
    if (blob === null) return { kind: 'no_body' };
    let text: string;
    try {
      text = safeStorage.decryptString(blob);
    } catch {
      return { kind: 'unsealable' };
    }
    const body = parseBody(text, GRANT_SHAPE);
    if (body === null) return { kind: 'malformed' };
    if (!bodyBelongsTo(body, scope, user_id)) return { kind: 'foreign' };
    return { kind: 'ok', body, blob };
  }

  function writeGrant(body: GrantBody): void {
    stmt(UPSERT_GRANT).run(
      body.tenant_id,
      body.branch_id,
      body.terminal_id,
      body.user_id,
      seal(JSON.stringify(body)),
      stamp(),
    );
  }

  function deleteGrant(scope: OfflineGrantScope, user_id: string): void {
    stmt(DELETE_GRANT).run(scope.tenant_id, scope.branch_id, scope.terminal_id, user_id);
  }

  // ── clock mark ──

  function readHwm(): HwmRead {
    const row = stmt(SELECT_HWM).get() as { sealed_body: unknown } | undefined;
    if (row === undefined) return { kind: 'ok', hwm_ms: null };
    const blob = asBlob(row.sealed_body);
    if (blob === null) return { kind: 'unreadable' };
    let body: HwmBody | null;
    try {
      body = parseBody(safeStorage.decryptString(blob), HWM_SHAPE);
    } catch {
      return { kind: 'unreadable' };
    }
    return body === null ? { kind: 'unreadable' } : { kind: 'ok', hwm_ms: body.hwm_ms };
  }

  function writeHwm(hwm_ms: number): void {
    const body: HwmBody = { v: BODY_VERSION, kind: HWM_KIND, hwm_ms };
    stmt(UPSERT_HWM).run(seal(JSON.stringify(body)), stamp());
  }

  function anyGrantRow(): boolean {
    return stmt(SELECT_ANY_GRANT).get() !== undefined;
  }

  /**
   * F2 (10893): a mark that is missing while a grant row exists was deleted,
   * not never written. It is as good as unreadable: a deleted mark plus a clock
   * rollback must not extend a grant. With no grant at all it is a first run.
   */
  function readHwmChecked(): HwmRead {
    const current = readHwm();
    if (current.kind === 'ok' && current.hwm_ms === null && anyGrantRow()) {
      return { kind: 'unreadable' };
    }
    return current;
  }

  /**
   * Raise the mark to `now_ms` (never lower). An unreadable (or F2: deleted)
   * mark is left as it is, unless `repair` (an online admission): then it is
   * re-sealed at `now_ms`. Returns the mark after the call, or null when it is
   * unreadable.
   */
  function raiseHwm(now_ms: number, repair: boolean): { hwm_ms: number; raised: boolean } | null {
    const current = readHwmChecked();
    if (current.kind === 'unreadable') {
      if (!repair) return null;
      writeHwm(now_ms);
      return { hwm_ms: now_ms, raised: true };
    }
    if (current.hwm_ms !== null && current.hwm_ms >= now_ms) {
      return { hwm_ms: current.hwm_ms, raised: false };
    }
    writeHwm(now_ms);
    return { hwm_ms: now_ms, raised: true };
  }

  /** The latest time any grant row (readable ones) or the prior pairing vouches for. */
  function purgeEvidenceMs(prior_epoch: number | undefined): number {
    let floor = isCount(prior_epoch) ? prior_epoch * 1000 : 0;
    for (const row of stmt(SELECT_ALL_BODIES).all() as { sealed_body: unknown }[]) {
      const body = openGrantBody(row.sealed_body);
      if (body !== null) floor = Math.max(floor, body.pairing_epoch * 1000, clockFloor(body));
    }
    return floor;
  }

  /** Codex P1 4181552529: a purge never lowers, and never erases, the evidence in the mark. */
  function keepPurgeEvidence(prior_epoch: number | undefined): void {
    const evidence = purgeEvidenceMs(prior_epoch);
    const current = readHwm();
    if (current.kind === 'ok' && current.hwm_ms !== null) {
      if (current.hwm_ms < evidence) writeHwm(evidence);
      return;
    }
    if (current.kind === 'ok' && evidence === 0) return; // a first run: nothing to keep
    // Missing (with evidence) or unreadable: re-seal, never below now.
    writeHwm(Math.max(evidence, deps.now().getTime()));
  }

  // ── evaluation ──

  /** The clock against the high-water mark (raised first, OD7); null when it is sane. */
  function clockRefusal(now_ms: number): OfflineGrantRefusalCategory | null {
    const mark = raiseHwm(now_ms, false);
    if (mark === null) return 'storage';
    return now_ms < mark.hwm_ms - OFFLINE_CLOCK_TOLERANCE_MS ? 'clock_suspect' : null;
  }

  function judge(scope: OfflineGrantScope, user_id: string, now_ms: number): Judged {
    if (!isAddressable(scope, user_id, now_ms)) return refusedJudgement('scope_mismatch');
    const clock = clockRefusal(now_ms);
    if (clock !== null) return refusedJudgement(clock);
    const read = readGrant(scope, user_id);
    if (read.kind !== 'ok') return refusedJudgement(REFUSAL_BY_READ[read.kind]);
    const category = refusalForBody(read.body, scope, now_ms);
    if (category !== null) return refusedJudgement(category);
    return { admissible: true, body: read.body, blob: read.blob };
  }

  function refused(category: OfflineGrantRefusalCategory): OfflineGrantEvaluation {
    log('info', { event: 'operator.offline_grant.refused', category });
    return { admissible: false, category };
  }

  // ── invalidation ──

  function assertReason(reason: unknown): void {
    if (!isReason(reason)) throw new OfflineGrantStoreError('invalid_input');
  }

  /**
   * Invalidate one row (inside the caller's transaction). A readable grant is
   * re-sealed with the reason, or deleted when the re-seal fails. A row that
   * is no grant of its own key is deleted. Returns who lost a grant, if anyone.
   */
  function invalidateRow(
    scope: OfflineGrantScope,
    user_id: string,
    reason: OfflineGrantInvalidationReason,
    result: InvalidateResult,
  ): void {
    const read = readGrant(scope, user_id);
    if (read.kind === 'absent') return;
    if (read.kind !== 'ok') {
      deleteGrant(scope, user_id);
      result.removed_unreadable += 1;
      return;
    }
    if (read.body.invalidated !== null) return;
    const who = { user_id: read.body.user_id, operator_id: read.body.operator_id };
    try {
      writeGrant({ ...read.body, invalidated: { reason, at_local: deps.now().getTime() } });
    } catch {
      log('warn', { event: 'operator.offline_grant.storage_failed', op: 'reseal' });
      deleteGrant(scope, user_id);
    }
    result.invalidated.push(who);
  }

  function logInvalidated(reason: OfflineGrantInvalidationReason, r: InvalidateResult): void {
    if (r.invalidated.length > 0) {
      log('info', {
        event: 'operator.offline_grant.invalidated',
        reason,
        count: r.invalidated.length,
      });
    }
    if (r.removed_unreadable > 0) {
      log('warn', {
        event: 'operator.offline_grant.removed_unreadable',
        count: r.removed_unreadable,
      });
    }
  }

  function invalidateUsers(
    scope: OfflineGrantScope,
    users: () => string[],
    reason: OfflineGrantInvalidationReason,
    op: string,
  ): InvalidateResult {
    const result: InvalidateResult = { invalidated: [], removed_unreadable: 0 };
    try {
      tx(() => {
        for (const user_id of users()) invalidateRow(scope, user_id, reason, result);
      });
    } catch {
      log('warn', { event: 'operator.offline_grant.storage_failed', op });
      throw new OfflineGrantStoreError('storage');
    }
    logInvalidated(reason, result);
    return result;
  }

  function invalidate(
    scope: OfflineGrantScope,
    user_id: string,
    reason: OfflineGrantInvalidationReason,
  ): InvalidateResult {
    assertReason(reason);
    if (!isValidScope(scope) || !isText(user_id)) throw new OfflineGrantStoreError('invalid_input');
    return invalidateUsers(scope, () => [user_id], reason, 'invalidate');
  }

  /** A standing (readable, not yet invalidated) grant of this key, for attribution. */
  function standingGrant(scope: OfflineGrantScope, user_id: string): InvalidatedGrant[] {
    const read = readGrant(scope, user_id);
    if (read.kind !== 'ok' || read.body.invalidated !== null) return [];
    return [{ user_id: read.body.user_id, operator_id: read.body.operator_id }];
  }

  /**
   * Write a fresh grant and raise (or repair) the clock mark, atomically. If
   * that fails, the old grant is deleted: a refresh that cannot be recorded
   * must not leave the old grant standing. Returns null when written, else the
   * standing grant the delete removed (Codex P2 4183383061: so its
   * `refresh_failed` invalidation can be audited). Throws storage only when
   * even the delete fails (the wiring then holds a tombstone).
   */
  function writeFreshGrant(scope: OfflineGrantScope, body: GrantBody): InvalidatedGrant[] | null {
    try {
      tx(() => {
        writeGrant(body);
        raiseHwm(deps.now().getTime(), true);
      });
      return null;
    } catch {
      log('warn', { event: 'operator.offline_grant.storage_failed', op: 'upsert' });
    }
    try {
      return tx(() => {
        const removed = standingGrant(scope, body.user_id);
        deleteGrant(scope, body.user_id);
        return removed;
      });
    } catch {
      throw new OfflineGrantStoreError('storage');
    }
  }

  // ── public ──

  return {
    upsertFromAdmitted(scope, event) {
      if (!isValidScope(scope)) throw new OfflineGrantStoreError('invalid_input');
      if (!isText(event.user_id)) throw new OfflineGrantStoreError('invalid_input');
      const body = grantBodyFromEvent(scope, event);
      if (body === null) {
        const r = invalidate(scope, event.user_id, 'refresh_failed');
        log('warn', { event: 'operator.offline_grant.rejected', category: 'invalid_event' });
        return { kind: 'rejected', invalidated: r.invalidated };
      }
      if (event.offline_grace_seconds === 0) {
        const r = invalidate(scope, event.user_id, 'grace_disabled');
        return { kind: 'grace_disabled', invalidated: r.invalidated };
      }
      const removed = writeFreshGrant(scope, body);
      if (removed !== null) return { kind: 'refresh_failed', invalidated: removed };
      log('info', { event: 'operator.offline_grant.written' });
      return { kind: 'written' };
    },

    invalidate,

    invalidateAll(scope, reason) {
      assertReason(reason);
      if (!isValidScope(scope)) throw new OfflineGrantStoreError('invalid_input');
      const users = (): string[] =>
        (
          stmt(SELECT_SCOPE_USERS).all(scope.tenant_id, scope.branch_id, scope.terminal_id) as {
            user_id: string;
          }[]
        ).map((r) => r.user_id);
      return invalidateUsers(scope, users, reason, 'invalidate_all');
    },

    purgeAll(prior_epoch) {
      let removed: number;
      try {
        removed = tx(() => {
          keepPurgeEvidence(prior_epoch);
          return stmt(DELETE_ALL_GRANTS).run().changes;
        });
      } catch {
        log('warn', { event: 'operator.offline_grant.storage_failed', op: 'purge' });
        throw new OfflineGrantStoreError('storage');
      }
      log('info', { event: 'operator.offline_grant.purged', count: removed });
      return { removed };
    },

    evaluate(scope, user_id, nowWall) {
      let judged: Judged;
      try {
        judged = judge(scope, user_id, nowWall.getTime());
      } catch {
        return refused('storage');
      }
      if (!judged.admissible) return refused(judged.category);
      return { admissible: true, grant: grantView(judged.body) };
    },

    consumeOfflineUse(scope, user_id, nowWall) {
      const now_ms = nowWall.getTime();
      let outcome: Judged;
      try {
        outcome = tx((): Judged => {
          const judged = judge(scope, user_id, now_ms);
          if (!judged.admissible) return judged;
          const next: GrantBody = {
            ...judged.body,
            offline_admissions_used: judged.body.offline_admissions_used + 1,
            last_used_at_local: now_ms,
          };
          const changed = stmt(CAS_GRANT).run(
            seal(JSON.stringify(next)),
            stamp(),
            scope.tenant_id,
            scope.branch_id,
            scope.terminal_id,
            user_id,
            judged.blob,
          ).changes;
          // Compare-and-swap: the row changed since it was read; never double-spend.
          if (changed !== 1) throw new OfflineGrantStoreError('storage');
          return { admissible: true, body: next, blob: judged.blob };
        });
      } catch {
        return refused('storage');
      }
      if (!outcome.admissible) return refused(outcome.category);
      log('info', { event: 'operator.offline_grant.consumed' });
      return { admissible: true, grant: grantView(outcome.body) };
    },

    nextPairingEpoch(candidate) {
      try {
        return tx(() => {
          const current = readHwmChecked();
          const above =
            current.kind === 'ok' && current.hwm_ms !== null
              ? Math.floor(current.hwm_ms / 1000) + 1
              : 0;
          const epoch = Math.max(candidate, above);
          // An unreadable mark stays as it is (raiseHwm leaves it; no repair here).
          raiseHwm(epoch * 1000, false);
          return epoch;
        });
      } catch {
        log('warn', { event: 'operator.offline_grant.storage_failed', op: 'pairing_epoch' });
        return candidate;
      }
    },

    observeClock(nowWall) {
      try {
        const mark = tx(() => raiseHwm(nowWall.getTime(), false));
        if (mark === null) {
          log('warn', { event: 'operator.offline_grant.clock_unreadable' });
          return { kind: 'unavailable' };
        }
        return { kind: mark.raised ? 'raised' : 'unchanged' };
      } catch {
        log('warn', { event: 'operator.offline_grant.storage_failed', op: 'observe_clock' });
        return { kind: 'unavailable' };
      }
    },
  };
}
