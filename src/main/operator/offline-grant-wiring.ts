import type { Logger } from 'pino';

import type { AuditEvent } from '../../shared/audit/event-shape.js';
import type { PairingStatus } from '../../shared/pairing-types.js';
import type { PairingStore, PersistInput } from '../pairing/store.js';

import type {
  CashierAdmissionInvalidation,
  CashierAdmittedEvent,
  OfflineGrantSeam,
} from './cashier-admission.js';
import type {
  InvalidatedGrant,
  OfflineGrantEvaluation,
  OfflineGrantInvalidationReason,
  OfflineGrantRefusalCategory,
  OfflineGrantScope,
  OfflineGrantStore,
  UpsertResult,
} from './offline-grant-store.js';

/**
 * RT-113 P1.2 — the sealed offline grant store wired into the app (Jira
 * RT-113: plan 10871 §"PR P1.2"; OD4–OD7, OD10 confirmed in 10874; F2–F4 and
 * the `refused` → `forbidden` mapping carried in 10893).
 *
 * The cashier-admission grant seam:
 *  - `admitted` (sign-in, takeover, heartbeat) writes or refreshes the grant
 *    for the CURRENT pairing scope (tenant, branch, terminal, pairing epoch);
 *  - a 403 (`refused`) invalidates that user, reason `forbidden`;
 *  - `active_elsewhere` invalidates that user, reason `superseded` (OD6);
 *  - a device 401 invalidates EVERY grant, reason `device_unauthorized`, on the
 *    first 401 (OD5; the session keeps its own 2×401 debounce);
 *  - 5xx, 429, 409, 400, transport and `no_token` never reach the seam.
 *
 * Fail closed (10871): when the store throws on an invalidation, or on a
 * write that should replace a grant, the user (or, for a 401 or a failed
 * pairing purge, the whole terminal) is held in an in-memory TOMBSTONE that
 * {@link OfflineGrantWiring.evaluate} consults before the store. The clock
 * tick retries the held operation; it is lifted when the store applies it, or
 * (per user) when a fresh `admitted` for that user is recorded. Nothing here
 * ever throws into sign-in, takeover or the heartbeat.
 *
 * Audit (OD10): one `operator.offline_grant.invalidated` per grant actually
 * invalidated, attributed to that grant's operator, payload `{reason}` only.
 *
 * Pairing (OD4, F4): {@link withOfflineGrantPairing} purges every grant
 * whenever the pairing is persisted or cleared, and gives every re-pair an
 * epoch strictly above any epoch a grant on this device can hold, so an old
 * sealed body written back after a same-second re-pair is no proof.
 *
 * Clock (OD7): the high-water mark is raised at start and every 60 s; the
 * tick stops through the RT-198 latch (`stop()`): nothing runs afterwards.
 *
 * No session is created here. `evaluate` and `consumeOfflineUse` are the P3
 * entry points; nothing calls them yet. A grant carries the server's last
 * `admission_id` but no `admission_generation` (RT-219), so P3 must never arm
 * an offline-admitted session as online-admitted: it must not heartbeat or
 * `end` a server admission, only reconcile later (P4).
 *
 * Privacy: log lines carry an event name and a closed reason, op or count.
 * No grant field and no identifier reaches a log line.
 */

/** OD7: how often the clock high-water mark is raised. */
export const OFFLINE_GRANT_CLOCK_TICK_MS = 60_000;

/**
 * Codex P2 4183175501 — invalidation audit events whose insert failed, held
 * for the tick to retry. Bounded: past this, the oldest is dropped with a
 * category-only warning (never silently).
 */
export const OFFLINE_GRANT_AUDIT_RETRY_MAX = 256;

const INVALIDATED_CATEGORY = 'operator.offline_grant.invalidated';

export interface OfflineGrantWiringDeps {
  store: OfflineGrantStore;
  audit: { emit(event: AuditEvent): void };
  uuid: () => string;
  now: () => Date;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

/** Why the pairing changed (OD4). */
export type PairingChangeReason = Extract<OfflineGrantInvalidationReason, 'repair' | 'unpair'>;

export interface OfflineGrantWiring {
  /** Plugs into `CashierAdmissionDeps.grantSeam`. Never throws. */
  readonly seam: OfflineGrantSeam;
  /** The current pairing scope, or null when the terminal is not paired. */
  setScope(scope: OfflineGrantScope | null): void;
  /** Is there proof for an offline admission (P3)? Tombstones first. Never throws. */
  evaluate(user_id: string, nowWall: Date): OfflineGrantEvaluation;
  /** Use one offline admission (P3). Tombstones first. Never throws. */
  consumeOfflineUse(user_id: string, nowWall: Date): OfflineGrantEvaluation;
  /**
   * OD4: the pairing is about to change; invalidate (audited) and purge every
   * grant. The purge keeps the evidence of every purged epoch, and of
   * `prior_epoch` (the pairing being replaced), in the clock mark, so the next
   * epoch is above them (Codex P1 4181552529).
   */
  onPairingChange(reason: PairingChangeReason, prior_epoch?: number | null): void;
  /** F4: the epoch for the new pairing (see `OfflineGrantStore.nextPairingEpoch`). */
  reservePairingEpoch(candidate: number): number;
  /** OD7: raise the mark now, then every 60 s. A no-op once stopped. */
  start(): void;
  /** RT-198 stop latch: clears the tick; the seam and the tick do nothing afterwards. */
  stop(): void;
}

/** The grant scope of a pairing status; null unless paired. */
export function scopeFromPairingStatus(status: PairingStatus): OfflineGrantScope | null {
  if (status.kind !== 'paired') return null;
  return {
    tenant_id: status.tenant_id,
    branch_id: status.branch_id,
    terminal_id: status.terminal_id,
    pairing_epoch: status.paired_at,
  };
}

/** Who an invalidation affects: one user, or every user of the terminal. */
type InvalidationTarget = { user_id: string } | 'terminal';

/** The envelope fields an audit event takes from a scope. */
type AuditScope = Pick<OfflineGrantScope, 'tenant_id' | 'branch_id' | 'terminal_id'>;

/** The reason for each store-side result that invalidates (Codex P1 4183852355). */
const STORE_RESULT_REASON: Readonly<
  Record<Exclude<UpsertResult['kind'], 'written'>, OfflineGrantInvalidationReason>
> = {
  grace_disabled: 'grace_disabled',
  rejected: 'refresh_failed',
  refresh_failed: 'refresh_failed',
};

/** Codex P2 4184105427: a held purge covers every scope, invalidate_all only the bound one. */
const TERMINAL_STRENGTH = { invalidate_all: 1, purge: 2 } as const;

/** A held operation the store has not applied yet. */
type TerminalTombstone =
  | { op: 'invalidate_all'; reason: OfflineGrantInvalidationReason }
  /**
   * Codex P1 4184710216: a held purge keeps the prior pairing epoch its first
   * attempt had (the max over merged holds), for every retry and for the next
   * epoch reservation.
   */
  | { op: 'purge'; reason: OfflineGrantInvalidationReason; prior_epoch: number | null };

/** The larger of two optional epochs. */
function maxEpoch(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}

/** Merge a new hold into the held one: never weaker, and a purge never loses its epoch. */
function mergeHold(held: TerminalTombstone | null, next: TerminalTombstone): TerminalTombstone {
  if (held === null || TERMINAL_STRENGTH[next.op] > TERMINAL_STRENGTH[held.op]) return next;
  if (held.op === 'purge' && next.op === 'purge') {
    return { ...held, prior_epoch: maxEpoch(held.prior_epoch, next.prior_epoch) };
  }
  return held;
}

const SEAM_REASON: Readonly<
  Record<
    Exclude<CashierAdmissionInvalidation['reason'], 'device_unauthorized'>,
    OfflineGrantInvalidationReason
  >
> = {
  // 10893: the seam's `refused` (a 403) is the store's `forbidden`.
  refused: 'forbidden',
  // OD6.
  active_elsewhere: 'superseded',
};

export function createOfflineGrantWiring(deps: OfflineGrantWiringDeps): OfflineGrantWiring {
  let scope: OfflineGrantScope | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const userTombstones = new Map<string, OfflineGrantInvalidationReason>();
  let terminalTombstone: TerminalTombstone | null = null;
  /**
   * Codex P1 4181552524 — bumped on every pairing change. An admission request
   * records it when SENT; its `admitted` result writes a grant only while it is
   * still current, so a result obtained under pairing A never becomes a grant
   * of pairing B.
   */
  let pairingGeneration = 0;
  /**
   * rev545 F-2 — a clock bumped on every invalidation event, with the clock
   * value of each user's (and the terminal-wide) latest one. An `admitted` whose
   * request was sent before an invalidation for that user is dropped, so a late
   * answer never resurrects a grant that was just invalidated.
   */
  let invalidationSeq = 0;
  const userInvalidatedAt = new Map<string, number>();
  let terminalInvalidatedAt = 0;

  /** Advance the sequence for one user, or for every user (`'terminal'`). */
  function noteInvalidation(target: InvalidationTarget): void {
    invalidationSeq += 1;
    if (target === 'terminal') terminalInvalidatedAt = invalidationSeq;
    else userInvalidatedAt.set(target.user_id, invalidationSeq);
  }

  /** True when the request was sent before an invalidation for this user (or unknown). */
  function invalidatedSinceSent(event: CashierAdmittedEvent): boolean {
    if (event.invalidation_seq === undefined) return true;
    const last = Math.max(userInvalidatedAt.get(event.user_id) ?? 0, terminalInvalidatedAt);
    return last > event.invalidation_seq;
  }

  function log(level: 'info' | 'warn', fields: Record<string, string | number>): void {
    try {
      deps.logger?.[level](fields, String(fields['event']).replace(/\./g, ' '));
    } catch {
      // Logging is best-effort.
    }
  }

  /**
   * Codex P2 4183175501 — the invalidation has already committed when its audit
   * is written, so a failed insert is NOT rolled back with it: the invalidation
   * is the safety property, and coupling it to the audit write would let an
   * audit failure keep a grant admissible. The event (same id, same time) is
   * queued and the tick retries it; the emitter is idempotent by event id. The
   * queue is in memory: a restart loses it, the same accepted class as the
   * tombstones.
   */
  const auditRetry: AuditEvent[] = [];

  function emitOrQueue(event: AuditEvent): void {
    try {
      deps.audit.emit(event);
    } catch {
      log('warn', { event: 'operator.offline_grant.audit_failed', op: 'queued' });
      auditRetry.push(event);
      if (auditRetry.length <= OFFLINE_GRANT_AUDIT_RETRY_MAX) return;
      auditRetry.shift();
      log('warn', { event: 'operator.offline_grant.audit_dropped', count: 1 });
    }
  }

  function retryAudits(): void {
    const pending = auditRetry.splice(0, auditRetry.length);
    for (const [i, event] of pending.entries()) {
      try {
        deps.audit.emit(event);
      } catch {
        // Still failing: keep this one and the rest, in order, for the next tick.
        auditRetry.unshift(...pending.slice(i));
        return;
      }
    }
  }

  function audit(
    at: AuditScope,
    grants: readonly InvalidatedGrant[],
    reason: OfflineGrantInvalidationReason,
  ): void {
    for (const grant of grants) {
      try {
        emitOrQueue({
          event_id: deps.uuid(),
          tenant_id: at.tenant_id,
          branch_id: at.branch_id,
          originating_terminal_id: at.terminal_id,
          acting_operator_id: grant.operator_id,
          session_id: null,
          shift_id: null,
          action_category: INVALIDATED_CATEGORY,
          created_at: deps.now().toISOString(),
          approving_supervisor_id: null,
          payload: { reason },
        });
      } catch {
        log('warn', { event: 'operator.offline_grant.audit_failed', reason });
      }
    }
  }

  /**
   * Codex P1 4183852355 — THE one way a path reports grants it invalidated or
   * removed: it advances the invalidation sequence (so a late `admitted` sent
   * before it is dropped) and queues one audit per grant, together. A path
   * whose store call throws still calls {@link noteInvalidation} itself and
   * holds a tombstone; its audit follows when the retry applies it here.
   */
  function recordInvalidation(
    target: InvalidationTarget,
    reason: OfflineGrantInvalidationReason,
    at: AuditScope,
    grants: readonly InvalidatedGrant[],
  ): void {
    noteInvalidation(target);
    audit(at, grants, reason);
  }

  function hold(op: string): void {
    log('warn', { event: 'operator.offline_grant.tombstoned', op });
  }

  // ── held operations (Codex P2 4184105427) ──
  //
  // Every write of the tombstone state goes through these four helpers. A
  // terminal-wide hold only ever strengthens (purge > invalidate_all); per-user
  // holds sit under it and are kept alongside. A hold is lifted only once an
  // operation at least as strong as the one held has applied.

  function holdTerminal(next: TerminalTombstone): void {
    terminalTombstone = mergeHold(terminalTombstone, next);
    hold(next.op);
  }

  /** The prior epoch a held purge still has to protect, or null. */
  function heldPurgeEpoch(): number | null {
    const held = terminalTombstone;
    return held?.op === 'purge' ? held.prior_epoch : null;
  }

  /** `applied` reached the store: lift the terminal hold (and the per-user ones under it) if it covers it. */
  function releaseTerminal(applied: TerminalTombstone['op']): void {
    const held = terminalTombstone;
    if (held !== null && TERMINAL_STRENGTH[applied] < TERMINAL_STRENGTH[held.op]) return;
    terminalTombstone = null;
    userTombstones.clear();
  }

  function holdUser(user_id: string, reason: OfflineGrantInvalidationReason, op: string): void {
    if (!userTombstones.has(user_id)) userTombstones.set(user_id, reason);
    hold(op);
  }

  function releaseUser(user_id: string): void {
    userTombstones.delete(user_id);
  }

  // ── store operations: each returns true when the store applied it ──

  function invalidateUser(user_id: string, reason: OfflineGrantInvalidationReason): boolean {
    const at = scope;
    if (at === null) return false;
    try {
      const r = deps.store.invalidate(at, user_id, reason);
      recordInvalidation({ user_id }, reason, at, r.invalidated);
      return true;
    } catch {
      return false;
    }
  }

  function invalidateEveryone(reason: OfflineGrantInvalidationReason): boolean {
    const at = scope;
    if (at === null) return false;
    try {
      recordInvalidation('terminal', reason, at, deps.store.invalidateAll(at, reason).invalidated);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Codex P2 4183628413 — the purge is the reliable audit point for a pairing
   * change: every standing grant it deletes is audited with `reason`, in its
   * own scope. Grants the preceding `invalidateAll` already invalidated (and
   * audited) are not standing, so none is audited twice.
   */
  function purge(reason: OfflineGrantInvalidationReason, prior_epoch?: number): boolean {
    try {
      for (const grant of deps.store.purgeAll(prior_epoch).invalidated) {
        recordInvalidation('terminal', reason, grant, [grant]);
      }
      return true;
    } catch {
      return false;
    }
  }

  // ── seam ──

  function onAdmitted(event: CashierAdmittedEvent): void {
    const at = scope;
    if (stopped || at === null) return;
    if (event.pairing_generation !== pairingGeneration) {
      // Sent under another pairing (or unknown): no grant for this one. The
      // result is dropped, not held: the next heartbeat refreshes it.
      log('info', { event: 'operator.offline_grant.stale_result' });
      return;
    }
    if (invalidatedSinceSent(event)) {
      log('info', { event: 'operator.offline_grant.superseded_result' });
      return;
    }
    try {
      const result = deps.store.upsertFromAdmitted(at, event);
      // A fresh server admission: the store now holds this user's true state.
      releaseUser(event.user_id);
      if (result.kind !== 'written') {
        // grace_disabled, rejected, refresh_failed: the user lost offline
        // authority, even with no grant to audit (Codex P1 4183852355).
        const user = { user_id: event.user_id };
        recordInvalidation(user, STORE_RESULT_REASON[result.kind], at, result.invalidated);
      }
    } catch {
      // The store deleted the old grant if it could; if not, it must not stand.
      noteInvalidation({ user_id: event.user_id });
      holdUser(event.user_id, 'refresh_failed', 'upsert');
    }
  }

  function onUserInvalidated(user_id: string, reason: OfflineGrantInvalidationReason): void {
    if (invalidateUser(user_id, reason)) {
      releaseUser(user_id);
      return;
    }
    holdUser(user_id, reason, 'invalidate');
  }

  function onDeviceUnauthorized(): void {
    if (invalidateEveryone('device_unauthorized')) {
      // Every grant of the scope is now invalidated; a held purge stays held.
      releaseTerminal('invalidate_all');
      return;
    }
    holdTerminal({ op: 'invalidate_all', reason: 'device_unauthorized' });
  }

  const seam: OfflineGrantSeam = {
    onCashierAdmitted(event) {
      onAdmitted(event);
    },
    onCashierAdmissionInvalidated(event) {
      // Not filtered by pairing generation (Codex P2 4182060617, decided): a
      // stale refusal from an earlier pairing only removes offline authority
      // (fail closed) and the next `admitted` restores it; dropping it could
      // drop a real refusal.
      if (stopped) return;
      noteInvalidation(event.reason === 'device_unauthorized' ? 'terminal' : event);
      if (event.reason === 'device_unauthorized') {
        onDeviceUnauthorized();
        return;
      }
      onUserInvalidated(event.user_id, SEAM_REASON[event.reason]);
    },
    pairingGeneration() {
      return pairingGeneration;
    },
    invalidationSeq() {
      return invalidationSeq;
    },
  };

  // ── tick ──

  /** Re-apply a held terminal-wide operation; true when the store applied it. */
  function applyTerminalHold(held: TerminalTombstone): boolean {
    if (held.op === 'purge') return purge(held.reason, held.prior_epoch ?? undefined);
    return invalidateEveryone(held.reason);
  }

  function retryTerminalHold(): void {
    const held = terminalTombstone;
    if (held === null || !applyTerminalHold(held)) return;
    releaseTerminal(held.op);
  }

  function retryUserHolds(): void {
    for (const [user_id, reason] of [...userTombstones]) {
      if (invalidateUser(user_id, reason)) releaseUser(user_id);
    }
  }

  function retryHeld(): void {
    retryTerminalHold();
    retryUserHolds();
  }

  function tick(): void {
    if (stopped) return;
    try {
      deps.store.observeClock(deps.now());
      retryHeld();
      retryAudits();
    } catch {
      log('warn', { event: 'operator.offline_grant.tick_failed' });
    }
  }

  // ── evaluation ──

  function tombstoneRefusal(user_id: string): OfflineGrantEvaluation | null {
    if (terminalTombstone === null && !userTombstones.has(user_id)) return null;
    log('info', { event: 'operator.offline_grant.refused', category: 'grant_invalidated' });
    return { admissible: false, category: 'grant_invalidated' };
  }

  function refused(category: OfflineGrantRefusalCategory): OfflineGrantEvaluation {
    return { admissible: false, category };
  }

  function judged(
    user_id: string,
    read: (at: OfflineGrantScope) => OfflineGrantEvaluation,
  ): OfflineGrantEvaluation {
    const blocked = tombstoneRefusal(user_id);
    if (blocked !== null) return blocked;
    const at = scope;
    if (at === null) return refused('scope_mismatch');
    try {
      return read(at);
    } catch {
      return refused('storage');
    }
  }

  return {
    seam,

    setScope(next) {
      scope = next;
      pairingGeneration += 1;
    },

    evaluate(user_id, nowWall) {
      return judged(user_id, (at) => deps.store.evaluate(at, user_id, nowWall));
    },

    consumeOfflineUse(user_id, nowWall) {
      return judged(user_id, (at) => deps.store.consumeOfflineUse(at, user_id, nowWall));
    },

    onPairingChange(reason, prior_epoch) {
      const before = scope;
      scope = null;
      pairingGeneration += 1;
      // Every user loses offline authority, whatever the store does below.
      noteInvalidation('terminal');
      if (before !== null) {
        try {
          const r = deps.store.invalidateAll(before, reason);
          recordInvalidation('terminal', reason, before, r.invalidated);
        } catch {
          log('warn', { event: 'operator.offline_grant.storage_failed', op: 'pairing_change' });
        }
      }
      // Codex P1 4184710216: the epoch of a still-held purge counts too.
      const epoch = maxEpoch(
        maxEpoch(prior_epoch ?? null, before?.pairing_epoch ?? null),
        heldPurgeEpoch(),
      );
      if (purge(reason, epoch ?? undefined)) {
        releaseTerminal('purge');
        return;
      }
      holdTerminal({ op: 'purge', reason, prior_epoch: epoch });
    },

    reservePairingEpoch(candidate) {
      // Codex P1 4184710216: while a purge is held, its epoch is not yet in
      // the clock mark; reserve above it here.
      const held = heldPurgeEpoch();
      const floor = held === null ? candidate : Math.max(candidate, held + 1);
      try {
        return deps.store.nextPairingEpoch(floor);
      } catch {
        return floor;
      }
    },

    start() {
      if (stopped || timer !== undefined) return;
      tick();
      timer = setInterval(tick, OFFLINE_GRANT_CLOCK_TICK_MS);
    },

    stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

type PairingHooks = Pick<
  OfflineGrantWiring,
  'onPairingChange' | 'reservePairingEpoch' | 'setScope'
>;

/**
 * OD4 + F4 — wrap the pairing store OUTSIDE `src/main/pairing/` (the RT-202
 * `withPairedNotification` precedent): every `persist` and `clear` first
 * purges the offline grants, and every `persist` gets a new epoch
 * (`paired_at` is raised past the clock mark when it would repeat). The grant
 * scope then follows the pairing. Every other method passes through.
 */
export function withOfflineGrantPairing<S extends PairingStore>(inner: S, grants: PairingHooks): S {
  async function rebindFromStatus(): Promise<void> {
    try {
      grants.setScope(scopeFromPairingStatus(await inner.getStatus()));
    } catch {
      grants.setScope(null);
    }
  }

  /**
   * The epoch of the pairing being replaced, from the pairing store itself.
   * RT-215 rev546b S-2: a revoked pairing reports `invalid/device_revoked`, so
   * its stored epoch is read directly when the store offers it; otherwise the
   * `prior + 1` floor would be lost on a re-pair after a revocation.
   */
  async function priorEpoch(): Promise<number | null> {
    try {
      const stored = inner.getStoredPairingEpoch?.();
      if (stored !== undefined) return stored;
      return scopeFromPairingStatus(await inner.getStatus())?.pairing_epoch ?? null;
    } catch {
      return null;
    }
  }

  return {
    ...inner,
    async persist(input: PersistInput): Promise<void> {
      const prior = await priorEpoch();
      grants.onPairingChange('repair', prior);
      // Codex P1 4181552529: above the replaced pairing's epoch even when the
      // clock mark could not keep it (deleted, unreadable).
      const paired_at = grants.reservePairingEpoch(
        prior === null ? input.paired_at : Math.max(input.paired_at, prior + 1),
      );
      try {
        await inner.persist({ ...input, paired_at });
      } catch (err) {
        await rebindFromStatus();
        throw err;
      }
      grants.setScope({
        tenant_id: input.tenant_id,
        branch_id: input.branch_id,
        terminal_id: input.terminal_id,
        pairing_epoch: paired_at,
      });
    },
    async clear(): Promise<void> {
      grants.onPairingChange('unpair', await priorEpoch());
      try {
        await inner.clear();
      } catch (err) {
        // Codex P2 4183175505: still paired; the purge stands (fail closed).
        await rebindFromStatus();
        throw err;
      }
    },
  };
}
