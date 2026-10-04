import { addBreadcrumb } from '@sentry/electron/main';

import type { PairingSubmitResult } from '../../shared/pairing-types.js';
import type { PairingStore } from './store.js';
import { TransportError, type Network, type PairResult } from './network.js';
import { mapFailure } from './failure-mapping.js';

/**
 * 002-terminal-pairing T023 + T023a + T041 + T049 + T055 — `PairingService.submit`.
 *
 * The orchestrator. Composes:
 *
 *   network.pair(code)          // transport-only rejection
 *     -> on ok=true:   pairingStore.persist({...})  -> success log
 *     -> on ok=false:  mapFailure -> typed PairingSubmitResult
 *                      (US3 wires invalid_code / expired_code /
 *                       already_paired; US4 wires branch_mismatch;
 *                       US5 wires rate_limited with retry_after_s)
 *     -> on TransportError:                        -> network_error log
 *                      (timed_out propagates to log)
 *
 * Bridge contract LOCKED FROM MVP (T023a): submit() resolves for every
 * backend/network outcome with a typed `PairingSubmitResult`. The only
 * rejection path is programmer error (non-string code). US3/US4/US5/US7
 * later refine outcome categories without ever changing this rule.
 *
 * T041 (US3) — failure path = log only. The three US3 outcomes
 * (invalid_code / expired_code / already_paired) NEVER call
 * `pairingStore.persist()` or `pairingStore.clear()`. Prior persisted
 * state (token + assignment row) is byte-for-byte unchanged across a
 * failed submit (FR-8).
 *
 * T049 (US4) — extends the same "failure path = log only" invariant
 * to BRANCH_MISMATCH, with the extra-strong FR-14 guarantee: a
 * BRANCH_MISMATCH attempt against a re-pair MUST preserve the existing
 * valid token + assignment row byte-for-byte. The "no persist + no
 * clear" branch below is the load-bearing line; do NOT introduce a
 * "clear on mismatch" path here under any circumstances. The recovery
 * surface is admin-driven (Option B from the 2026-05-03 clarification),
 * not client-side state mutation.
 *
 * T055 (US5) — adds the rate_limited outcome with `retry_after_s`
 * pass-through. Same FR-8 invariant: failure path = log only. The
 * service trusts `network.ts` as the single source of truth for
 * Retry-After parsing — it does NOT re-parse, does NOT re-clamp.
 * Defensive guard: if `pairResult.retry_after_s` is undefined despite
 * outcome === 'rate_limited' (would only happen if network.ts has a
 * bug or the body code arrived on a non-429 status), the service
 * falls through to `unknown_error` so the renderer never sees an
 * `undefined * 1000` setTimeout.
 *
 * Security policy (Constitution VII + spec NFR-4 / FR-9 / FR-10):
 *   - The `pairing_code` is read from the argument and passed to the
 *     network module ONLY. It is never placed in any log payload, any
 *     error message, or any retained closure.
 *   - The `device_token` is read from the network success body and
 *     handed directly to `pairingStore.persist()`; it is never logged
 *     or returned through the bridge (the success result type omits
 *     the token by design).
 *   - The pairingLog emitter is schema-restricted (US6 will tighten
 *     it further); US2 ships a thin wrapper around the base pino
 *     logger that the redaction list (PR #15) already scrubs.
 *   - Exactly one log record per call, regardless of outcome.
 */

/**
 * In-memory shape the schema-restricted pairing logger accepts.
 * Mirrors `data-model.md § PairingAttemptLogRecord`. US6 will land a
 * runtime guard; US2 enforces the shape via TypeScript.
 */
export interface PairingAttemptLogRecord {
  event: 'pairing_attempt';
  outcome:
    | 'success'
    | 'invalid_code'
    | 'expired_code'
    | 'already_paired'
    | 'branch_mismatch'
    | 'rate_limited'
    | 'network_error'
    | 'unknown_error';
  /** ISO-8601, second precision. */
  at: string;
  /** Present only when outcome === 'success'. Opaque server-issued ID. Never the device token. */
  terminal_id?: string;
  /** Present only when outcome === 'rate_limited' (US5). */
  retry_after_s?: number;
  /** Present only when outcome === 'network_error' AND the cause was the 30s timeout. */
  timed_out?: boolean;
}

export interface PairingService {
  submit(pairing_code: string): Promise<PairingSubmitResult>;
}

export interface CreatePairingServiceOptions {
  store: PairingStore;
  network: Network;
  /**
   * Schema-restricted log emitter. The service NEVER calls a generic
   * logger.info() or logger.error() — every emission goes through this
   * function, which validates the record shape via TypeScript today
   * and via runtime guard in US6.
   */
  pairingLog: (record: PairingAttemptLogRecord) => void;
  /** Provides `new Date()` for testability of the `at` field. */
  clock: () => Date;
}

export function createPairingService(deps: CreatePairingServiceOptions): PairingService {
  const { store, network, pairingLog, clock } = deps;

  function nowIso(): string {
    return clock().toISOString();
  }
  function pairedAtSeconds(): number {
    return Math.floor(clock().getTime() / 1000);
  }

  // T065 (US6) — Sentry breadcrumb emitter. Category 'pairing'; data
  // carries `outcome` (string) and `status` (HTTP status or null for
  // transport errors). No code, no token, no request/response body.
  // Sentry is inert without a DSN (initSentryMain no-ops); addBreadcrumb
  // becomes a no-op — callers need no DSN guard here.
  function emitBreadcrumb(outcome: string, status: number | null): void {
    addBreadcrumb({ category: 'pairing', data: { outcome, status } });
  }

  return {
    async submit(pairing_code: string): Promise<PairingSubmitResult> {
      // Programmer error guard. The IPC handler will repeat this check
      // (T024+); here we defend against in-process callers that bypass
      // IPC. Rejection is the documented "only" path.
      if (typeof pairing_code !== 'string') {
        throw new TypeError('PairingService.submit: pairing_code must be a string.');
      }

      let pairResult: PairResult;
      try {
        pairResult = await network.pair(pairing_code);
      } catch (err) {
        // T023a — split network rejections by type:
        //   - TransportError (DNS/TLS/refused/abort/30s timeout) is the
        //     documented "no clean network" path -> outcome='network_error'.
        //     If the TransportError carries timed_out: true, the log
        //     record carries it too.
        //   - Anything ELSE that escaped from network.pair() is a bug
        //     in the network module or one of its deps (the contract
        //     says network.pair() rejects ONLY with TransportError).
        //     We catch defensively and resolve as 'unknown_error' so
        //     the bridge contract — "submit() never rejects for any
        //     backend/network outcome" — holds even if a future
        //     contributor breaks the network module's contract.
        if (err instanceof TransportError) {
          const record: PairingAttemptLogRecord = err.timed_out
            ? { event: 'pairing_attempt', outcome: 'network_error', at: nowIso(), timed_out: true }
            : { event: 'pairing_attempt', outcome: 'network_error', at: nowIso() };
          pairingLog(record);
          emitBreadcrumb('network_error', null);
          return { outcome: 'network_error' };
        }
        pairingLog({ event: 'pairing_attempt', outcome: 'unknown_error', at: nowIso() });
        emitBreadcrumb('unknown_error', null);
        return { outcome: 'unknown_error' };
      }

      if (pairResult.ok) {
        // Success path. Persist atomically through the store; a SQL
        // failure inside persist() is compensated by deleting the
        // SecretStore entry (PR #16 contract). If persist itself
        // throws (storage failure beyond the store's compensation),
        // we catch and route to unknown_error so the bridge contract
        // holds.
        try {
          // 008 T094a — six new fields from the post-PR #272 pinned
          // TerminalPairResponse shape. The snapshot's response type
          // declares them as required strings (printer_com_port is
          // `string | null`), so the body is guaranteed to carry them
          // on a 200 response. We pass them straight through to the
          // store; the store row TypeScript shape declares all six as
          // `string | null` for forward compatibility with pre-migration-
          // 0027 dev rows (NULL on read).
          await store.persist({
            device_token: pairResult.body.device_token,
            tenant_id: pairResult.body.tenant_id,
            branch_id: pairResult.body.branch_id,
            terminal_id: pairResult.body.terminal_id,
            terminal_label: pairResult.body.terminal_label,
            paired_at: pairedAtSeconds(),
            branch_name: pairResult.body.branch_name,
            branch_address: pairResult.body.branch_address,
            tenant_tax_registration_id: pairResult.body.tenant_tax_registration_id,
            printer_vendor_id: pairResult.body.printer_vendor_id,
            printer_product_id: pairResult.body.printer_product_id,
            printer_com_port: pairResult.body.printer_com_port,
          });
        } catch {
          // Storage error after a successful network call. The store
          // already rolled back the SecretStore (PR #16). We emit one
          // log record with unknown_error and resolve — the bridge
          // contract is preserved.
          pairingLog({ event: 'pairing_attempt', outcome: 'unknown_error', at: nowIso() });
          emitBreadcrumb('unknown_error', 200);
          return { outcome: 'unknown_error' };
        }

        pairingLog({
          event: 'pairing_attempt',
          outcome: 'success',
          at: nowIso(),
          terminal_id: pairResult.body.terminal_id,
        });
        emitBreadcrumb('success', 200);

        // The success result type explicitly OMITS device_token — that
        // is the renderer-visible shape, and the only place the token
        // ever has to live is the SecretStore.
        return {
          outcome: 'success',
          tenant_id: pairResult.body.tenant_id,
          branch_id: pairResult.body.branch_id,
          terminal_id: pairResult.body.terminal_id,
          terminal_label: pairResult.body.terminal_label,
        };
      }

      // Reachable non-2xx. US3 wires the three documented recoverable
      // outcomes (invalid_code / expired_code / already_paired); US4
      // adds branch_mismatch; US5 adds rate_limited (with
      // retry_after_s). Any outcome the switch does not yet recognise
      // falls through to 'unknown_error' so the bridge contract holds.
      //
      // No store call on any branch — failure path = log only (FR-8).
      // Prior persisted token + assignment row remain byte-for-byte
      // untouched across every failure outcome.
      //
      // FR-14 cross-reference: the 'branch_mismatch' arm specifically
      // protects an EXISTING valid token. A re-pair attempt that hits
      // BRANCH_MISMATCH MUST NOT clear or replace the prior pairing —
      // recovery is admin-driven (Option B from the 2026-05-03
      // clarification). Do NOT introduce a "clear on mismatch" path
      // here; the absence of any store call IS the invariant.
      const outcome = mapFailure(pairResult.status, pairResult.body);
      switch (outcome) {
        case 'rate_limited': {
          // US5 — retry_after_s flows from network.ts (the SSOT for
          // Retry-After parsing) onto the envelope, then through to
          // both the log record and the returned PairingSubmitResult.
          // The service does NOT re-clamp.
          //
          // Defensive: if retry_after_s is missing (would only happen
          // if network mis-attached the field, or RATE_LIMITED arrived
          // on a non-429 status where network skips attaching), fall
          // through to unknown_error so the renderer never sees
          // setTimeout(NaN) or setTimeout(undefined * 1000).
          const retry_after_s = pairResult.retry_after_s;
          if (retry_after_s === undefined) {
            pairingLog({ event: 'pairing_attempt', outcome: 'unknown_error', at: nowIso() });
            emitBreadcrumb('unknown_error', pairResult.status);
            return { outcome: 'unknown_error' };
          }
          pairingLog({
            event: 'pairing_attempt',
            outcome: 'rate_limited',
            at: nowIso(),
            retry_after_s,
          });
          emitBreadcrumb('rate_limited', pairResult.status);
          return { outcome: 'rate_limited', retry_after_s };
        }
        case 'invalid_code':
        case 'expired_code':
        case 'already_paired':
        case 'branch_mismatch': {
          pairingLog({ event: 'pairing_attempt', outcome, at: nowIso() });
          emitBreadcrumb(outcome, pairResult.status);
          return { outcome };
        }
        default: {
          pairingLog({ event: 'pairing_attempt', outcome: 'unknown_error', at: nowIso() });
          emitBreadcrumb('unknown_error', pairResult.status);
          return { outcome: 'unknown_error' };
        }
      }
    },
  };
}
