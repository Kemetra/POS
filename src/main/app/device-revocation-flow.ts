import type { Logger } from 'pino';

import {
  SYSTEM_DEVICE_ACTOR_ID,
  type ActionCategory,
  type AuditEvent,
} from '../../shared/audit/event-shape.js';
import type {
  DeviceRevokedSource,
  PairingStatus,
  PairingStatusChangedEvent,
  PairingSubmitResult,
} from '../../shared/pairing-types.js';
import type { CashierAdmissionClient } from '../operator/cashier-admission-client.js';
import type { OfflineGrantSeam } from '../operator/cashier-admission.js';
import type { SessionManager } from '../operator/session-manager.js';
import type { DeviceAuthOutcome } from '../pairing/device-auth-detector.js';
import type { PairingService } from '../pairing/service.js';
import type { DeviceRevocationStore, RevokedTerminalScope } from '../pairing/store.js';

/**
 * RT-215 (RT-138 P-1) — the device-revoked state and the pairing-recovery flow.
 *
 * {@link DeviceRevocationFlow.onConfirmed} runs ONCE, when the shared
 * device-401 detector confirms a revocation (two consecutive device-bearer
 * 401s). In order, each step isolated so one failure cannot stop the others:
 *
 *  1. record it durably on the pairing row (`device_revoked_at`). From now on
 *     `PairingStatus` is `invalid / device_revoked` and the sendable-token
 *     reader returns null: the device token stays sealed but is NEVER sent;
 *  2. clear the in-memory operator JWT and envelope holders;
 *  3. invalidate the offline grants through the EXISTING grant seam only
 *     (RT113-P1.2 owns that wiring);
 *  4. latch the current session at once — no new sale can start — and let the
 *     keeper end it at its first safe point (RT-24 / 10857 #1). Nothing is
 *     reversed or discarded; sales and the outbox are never touched (RT-221
 *     already holds rows of a pairing that is not current);
 *  5. audit `pairing.device_revoked` (actor `system:device`, payload
 *     `{ source }` only — Jira RT-215 comment 10879);
 *  6. route to pairing recovery: push `pairing:status-changed` now when there
 *     is no session, else when the session ends.
 *
 * At boot the router reads `getStatus()` and lands on `/pairing` with the
 * `device_revoked` reason unconditionally (the state is durable).
 *
 * Review F3: a session that starts while revoked is latched at once; a
 * pairing is refused while any operator session is alive.
 *
 * {@link DeviceRevocationFlow.onPaired} runs after every SUCCESSFUL pairing
 * (via {@link withDeviceRevocationRecovery}): the detector is reset, a session
 * still open from the previous pairing is latched (Codex P1), the
 * `cashier_pin_records` of every OTHER terminal are deleted (decision 5), a
 * revocation that was cleared is audited (`pairing.device_revoked_cleared`),
 * and `{ kind: 'paired' }` is pushed; if the paired-only workers already ran in
 * this process, the app then relaunches (review F2). The re-pair itself (`persist`, INSERT OR
 * REPLACE) already cleared `device_revoked_at`.
 */

export interface DeviceRevocationFlowDeps {
  /** {@link DeviceRevocationStore.markDeviceRevoked}. */
  markDeviceRevoked: DeviceRevocationStore['markDeviceRevoked'];
  getStatus: () => Promise<PairingStatus>;
  sessions: Pick<SessionManager, 'getCurrent' | 'onEnded' | 'onStarted'>;
  /** Review F3 — SYNC: is the pairing revoked right now (`PairingStore.isDeviceRevoked`)? */
  isDeviceRevoked: () => boolean;
  /**
   * Review F2 — have the paired-only workers (read-down, finalize listener,
   * sale-sync) already started in this process? They keep the scope they
   * started with, so a re-pair after that needs a relaunch.
   */
  workersAlreadyStarted: () => boolean;
  /** Review F2 — `app.relaunch(); app.exit(0)` in production. */
  relaunch: () => void;
  /** The keeper: latch the current session and end it at its safe point. */
  latchSession: () => void;
  /** Clear the operator JWT + envelope holders. */
  clearCredentials: () => void;
  /** The existing offline-grant seam: invalidate every grant (device 401). */
  invalidateGrants: () => void;
  /** Back to a clean detector after a pairing. */
  resetDetector: () => void;
  /** Delete PIN records of every terminal but this one; returns the count. */
  purgeOtherTerminalPins: (terminalId: string) => number;
  /** Main → renderer `pairing:status-changed`. */
  pushStatus: (event: PairingStatusChangedEvent) => void;
  audit: { emit(event: AuditEvent): void };
  uuid: () => string;
  now: () => Date;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface DeviceRevocationFlow {
  /** The detector confirmed a revocation; `source` is the first 401's route family. */
  onConfirmed(source: DeviceRevokedSource): void;
  /** A pairing succeeded; `previouslyRevoked` = the status before it was device_revoked. */
  onPaired(input: { previouslyRevoked: boolean }): Promise<void>;
}

type Step =
  | 'mark'
  | 'credentials'
  | 'grants'
  | 'latch'
  | 'audit'
  | 'push'
  | 'detector'
  | 'status'
  | 'pins'
  | 'relaunch';

const DEVICE_REVOKED_EVENT: PairingStatusChangedEvent = {
  kind: 'invalid',
  reason: 'device_revoked',
};

export function createDeviceRevocationFlow(deps: DeviceRevocationFlowDeps): DeviceRevocationFlow {
  const { logger } = deps;
  /** A confirmed revocation that has not routed the renderer yet. */
  let routePending = false;

  /** Run one step; a failure is logged (step name only) and yields null. */
  function attempt<T>(name: Step, fn: () => T): T | null {
    try {
      return fn();
    } catch {
      // The error itself is not logged: it could carry a path or row data.
      logger.error({ event: 'pairing.device_revoked.step_failed', step: name }, 'step failed');
      return null;
    }
  }

  function step(name: Step, fn: () => void): void {
    attempt(name, fn);
  }

  function audit(
    action_category: Extract<ActionCategory, `pairing.${string}`>,
    scope: RevokedTerminalScope,
    payload: { source: string },
  ): void {
    step('audit', () => {
      deps.audit.emit({
        event_id: deps.uuid(),
        tenant_id: scope.tenant_id,
        branch_id: scope.branch_id,
        originating_terminal_id: scope.terminal_id,
        acting_operator_id: SYSTEM_DEVICE_ACTOR_ID,
        session_id: null,
        shift_id: null,
        action_category,
        created_at: deps.now().toISOString(),
        approving_supervisor_id: null,
        payload,
      });
    });
  }

  function routeIfPending(): void {
    if (!routePending) return;
    routePending = false;
    step('push', () => {
      deps.pushStatus(DEVICE_REVOKED_EVENT);
    });
    logger.info({ event: 'pairing.device_revoked.routed' }, 'routed to pairing recovery');
  }

  // The latched session ended (at its safe point, or any other way): route now.
  deps.sessions.onEnded(() => {
    routeIfPending();
  });

  // Review F3 + Codex P1: no session may start under a revoked pairing. One
  // that slips past the handlers' own checks is latched at once (it ends at
  // its safe point — immediately, as it has no sale) and its credentials are
  // cleared. The keeper's own start subscriber runs first (it is constructed
  // first), so an online cashier admission is already armed here.
  deps.sessions.onStarted(() => {
    if (!deps.isDeviceRevoked()) return;
    logger.warn(
      { event: 'pairing.device_revoked.session_refused' },
      'session started while revoked',
    );
    step('latch', deps.latchSession);
    step('credentials', deps.clearCredentials);
  });

  return {
    onConfirmed(source) {
      logger.warn({ event: 'pairing.device_revoked', source }, 'device revoked; re-pair required');
      const scope = attempt('mark', deps.markDeviceRevoked);
      step('credentials', deps.clearCredentials);
      step('grants', deps.invalidateGrants);
      routePending = true;
      step('latch', deps.latchSession);
      if (scope !== null) audit('pairing.device_revoked', scope, { source });
      if (deps.sessions.getCurrent() === null) routeIfPending();
    },

    async onPaired({ previouslyRevoked }) {
      routePending = false;
      step('detector', deps.resetDetector);
      // Codex P1 4181556645: a session from the previous pairing must not
      // survive into this one. Latch it; the keeper ends it at its safe point
      // (a live tender is never cut).
      if (deps.sessions.getCurrent() !== null) step('latch', deps.latchSession);
      let status: PairingStatus | null = null;
      try {
        status = await deps.getStatus();
      } catch {
        logger.error(
          { event: 'pairing.device_revoked.step_failed', step: 'status' },
          'step failed',
        );
      }
      if (status?.kind === 'paired') {
        const scope: RevokedTerminalScope = {
          tenant_id: status.tenant_id,
          branch_id: status.branch_id,
          terminal_id: status.terminal_id,
        };
        step('pins', () => {
          const deleted = deps.purgeOtherTerminalPins(scope.terminal_id);
          logger.info(
            { event: 'pairing.repaired.pin_records_purged', count: deleted },
            'PIN records of other terminals deleted',
          );
        });
        if (previouslyRevoked) {
          audit('pairing.device_revoked_cleared', scope, { source: 're_pair' });
        }
      }
      step('push', () => {
        deps.pushStatus({ kind: 'paired' });
      });
      // Review F2: the paired-only workers keep the scope they started with
      // (RT-202). After a re-pair in a process where they already ran, the
      // finalize listener and the read-down would keep the OLD pairing, so the
      // app relaunches — only once the new pairing is persisted and audited
      // (above), and never while an operator session is alive (`submit` is
      // refused then, review F3).
      if (
        status?.kind === 'paired' &&
        deps.workersAlreadyStarted() &&
        deps.sessions.getCurrent() === null
      ) {
        logger.info({ event: 'pairing.repaired.relaunch' }, 're-paired; relaunching');
        step('relaunch', deps.relaunch);
      }
    },
  };
}

/**
 * Wrap the pairing service so every SUCCESSFUL pairing runs
 * {@link DeviceRevocationFlow.onPaired}, told whether the terminal was
 * device-revoked just before. The pairing result (or an inner rejection) is
 * returned unchanged whatever the flow does.
 */
export function withDeviceRevocationRecovery(
  inner: PairingService,
  deps: {
    getStatus: () => Promise<PairingStatus>;
    onPaired: DeviceRevocationFlow['onPaired'];
    /**
     * Review F3 — is an operator session alive? A pairing is refused while one
     * is (a latched session first ends at its safe point), so a renderer reload
     * in the middle of a tender cannot re-pair under it. Defaults to none.
     */
    hasSession?: () => boolean;
  },
): PairingService {
  return {
    async submit(pairing_code: string): Promise<PairingSubmitResult> {
      if (deps.hasSession?.() === true) return { outcome: 'session_active' };
      const before = await deps.getStatus().catch(() => null);
      const result = await inner.submit(pairing_code);
      if (result.outcome === 'success') {
        const previouslyRevoked = before?.kind === 'invalid' && before.reason === 'device_revoked';
        await deps.onPaired({ previouslyRevoked }).catch(() => undefined);
      }
      return result;
    },
  };
}

/**
 * The detector's confirmation call (decision 1): the cashier-admissions roster
 * on an UNOBSERVED client (so its answer is not counted twice). A 2xx is `ok`,
 * a 401 `unauthorized`, anything else (including no token — a revoked device
 * never sends one) a non-answer.
 */
export function createRosterConfirmationProbe(
  client: Pick<CashierAdmissionClient, 'listRoster'>,
): () => Promise<DeviceAuthOutcome> {
  return async () => {
    try {
      const result = await client.listRoster();
      if (result.kind === 'roster') return 'ok';
      return result.kind === 'device_unauthorized' ? 'unauthorized' : 'other';
    } catch {
      return 'other';
    }
  };
}

/**
 * RT-215 review F4 × RT-113 P1.2 — what the device-401 detector does to the
 * offline grants, always THROUGH the grant seam (so the tombstones, the
 * invalidation sequence and the audit apply), never the store directly.
 *
 *  - `onSuspect` (the FIRST device 401 of a count, from ANY observed source:
 *    admit, `end`, roster, read-down): invalidate every grant (OD5). Within one
 *    count no grant can be written again — any device-bearer 2xx (an
 *    `admitted` included) resets the count — so the first 401 of each count
 *    covers every 401 of it. The admission path ALSO reports its own 401s
 *    (`notifyGrantSeam`, every 401); the second invalidation finds no standing
 *    grant and audits nothing.
 *  - `onConfirmed`: invalidate every grant AND clear the grant scope, so
 *    nothing is admissible or written until a re-pair sets a new scope.
 */
export function deviceRevocationGrantHooks(grants: {
  seam: Pick<OfflineGrantSeam, 'onCashierAdmissionInvalidated'>;
  setScope(scope: null): void;
}): { onSuspect: () => void; onConfirmed: () => void } {
  const invalidateAll = (): void => {
    grants.seam.onCashierAdmissionInvalidated({ reason: 'device_unauthorized' });
  };
  return {
    onSuspect: invalidateAll,
    onConfirmed: () => {
      invalidateAll();
      grants.setScope(null);
    },
  };
}
