/**
 * T170 — `receipts.preview` bridge handler (008 Slice 2).
 *
 * The renderer-facing entry for the read-only receipt preview. Gates on an
 * active session, reads the Sale (tenant/branch/terminal-scoped), derives the
 * canonical `ReceiptPayload` (T164), renders the AD-6 engine's HTML (T160), and
 * returns it plus layout metadata for the preview pane.
 *
 * Strictly read-only (contracts/bridge-api.md §"receipts.preview" Notes):
 *   • emits no print command, kicks no drawer, mutates no Sale;
 *   • cross-tenant misses refuse with `sale_not_found` (no information leak,
 *     §A4 #6) — same posture as `sales.read`;
 *   • a defensive forbidden-field-in-request guard runs FIRST (§A4 #2).
 *
 * RT-546 (OD-534-2): every handler runs the main-process role gate
 * (`sale-access-policy.ts`) after the forbidden-field guard. A locked session
 * refuses as `no_session`, a role outside the allowlist as `role_denied`, and a
 * cashier acts only on their own sales — another operator's sale refuses as
 * `sale_not_found` before anything renders or prints.
 */

import { FORBIDDEN_PAYLOAD_KEYS } from '../../shared/audit/forbidden-keys.js';
import type { SalesRepository, SaleRow } from '../sales/repositories/sales.repository.js';
import type { PrintEventsRepository } from '../sales/repositories/print-events.repository.js';
import type { SaleAuditEmitter } from '../sales/audit-emitter.js';
import type { OperatorSessionForSales } from '../sales/sales-bridge.js';
import type {
  ReceiptsBridgeAPI,
  ReceiptsPreviewRequest,
  ReceiptsPreviewResponse,
  ReceiptsRetryPrintRequest,
  ReceiptsRetryPrintResponse,
  ReceiptsReprintRequest,
  ReceiptsReprintResponse,
  ReceiptsManualOverrideRequest,
  ReceiptsManualOverrideResponse,
} from '../../shared/bridge-api.js';
import { deriveReceiptPayload } from './receipts-payload.js';
import { renderReceipt } from './template-engine.js';
import type { PrintDispatcher, PrintDispatchContext } from './print-dispatcher.js';
import type { DrawerKickDispatcher } from '../drawer/drawer-kick.js';
import { createSaleAccessPolicy, type SaleAccessAction } from '../sales/sale-access-policy.js';

/** 80 mm Font A column width — the v1 printed-slip dimension (§(a) layout). */
const PREVIEW_WIDTH_CHARS = 42;

// ── Forbidden-field-in-request scan (mirrors sales-bridge) ──────────────────

const RECEIPTS_BRIDGE_FORBIDDEN_KEYS = new Set<string>([
  'pan',
  'cvv',
  'cvc',
  'track',
  'track1',
  'track2',
  'cardholder',
  'cardholder_name',
  'expiry',
  'auth_payload',
  'cryptogram',
  'voucher_code',
  'voucher_balance',
  'voucher_redemption_intent_token',
  'authority_payload',
  'envelope_payload',
  'raw_envelope',
  'issuer_name',
  'pin_record_id',
]);

function findForbiddenKey(node: unknown, seen: WeakSet<object> = new WeakSet()): string | null {
  if (node === null || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findForbiddenKey(item, seen);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const key of Object.keys(node)) {
    if ((FORBIDDEN_PAYLOAD_KEYS as readonly string[]).includes(key)) return key;
    if (RECEIPTS_BRIDGE_FORBIDDEN_KEYS.has(key)) return key;
    const hit = findForbiddenKey((node as Record<string, unknown>)[key], seen);
    if (hit !== null) return hit;
  }
  return null;
}

export type ReceiptsBridge = ReceiptsBridgeAPI;

export interface ReceiptsBridgeDependencies {
  getCurrentSession: () => OperatorSessionForSales | null;
  /** Read-only: preview never writes. `insert` is in the Pick only to share
   *  the repository type; it is never called. */
  salesRepo: Pick<SalesRepository, 'readById' | 'insert'>;
  /**
   * S3 retryPrint: read prior failed print_events to build the lineage.
   * S5 reprint: `hasSuccessfulPrint` (AD-10 precondition) + `countReprints`
   * (n-th-reprint sequence-number allocation).
   */
  printEventsRepo: Pick<
    PrintEventsRepository,
    'readBySale' | 'hasSuccessfulPrint' | 'countReprints' | 'insert'
  >;
  /**
   * S3 retryPrint: re-runs the print pipeline + writes the retry row.
   * S5 reprint: writes the `purpose='reprint'` row + reprinted audit event.
   */
  printDispatcher: Pick<PrintDispatcher, 'dispatchRetryPrint' | 'dispatchReprint'>;
  /**
   * S6 manualOverride: emits the `sale.receipt.manual_override` audit event via
   * `emitRaw` + writes the override print_events row directly (no dispatcher —
   * no slip is rendered). RT-546: also records `sale.access.refused` for a
   * role-gate refusal. Optional — absent in S2/S3/S5-era construction.
   */
  auditEmitter?: Pick<SaleAuditEmitter, 'emitRaw'>;
  /** RT-546: true while the operator session is locked (refused as no_session). */
  isSessionLocked?: () => boolean;
  /** S6 manualOverride: id generator for the override print_events PK. */
  newPrintEventId?: () => string;
  /**
   * S4 (optional): chains the drawer-kick after a retry that SUCCEEDS. Per
   * FR-052, a retry-success IS the canonical first print, so it runs the same
   * drawer gating a first-print success would (cash-inclusive → kick). Absent
   * in Slice-3-era construction / tests; when absent, retry behaves exactly as
   * before. The dispatcher's `readBySale` guard keeps it idempotent — a sale
   * that already opened/suppressed its drawer is a no-op.
   */
  drawerKickDispatcher?: DrawerKickDispatcher;
  /**
   * Injected clock (ISO-8601 UTC). Used by `reprint` to stamp the
   * `reprinted_at` that flows into the rendered slip, so the slip time matches
   * the `print_events.printed_at` the dispatcher writes (both must read the SAME
   * clock — in production `index.ts` wires this and the dispatcher's `now` to
   * one source). Defaults to wall-clock when omitted (Slice-2/3-era callers).
   */
  now?: () => string;
}

/**
 * Session + role + tenant-isolation + ownership gate shared by every handler:
 * returns the scoped Sale row, or a refusal reason. A cross-scope, missing or
 * (for a cashier) another operator's row refuses as `sale_not_found` (no
 * existence-distinguishing leak; §A4 #6, RT-546).
 */
type ScopedSale =
  | { ok: true; row: SaleRow; session: OperatorSessionForSales }
  | { ok: false; reason: 'no_session' | 'role_denied' | 'sale_not_found' };

export function createReceiptsBridge(deps: ReceiptsBridgeDependencies): ReceiptsBridge {
  const { salesRepo, printEventsRepo, printDispatcher, drawerKickDispatcher, auditEmitter } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const access = createSaleAccessPolicy(deps);

  function scopedSale(action: SaleAccessAction, sale_id: string): ScopedSale {
    const admitted = access.admitSession(action);
    if (!admitted.ok) return admitted;
    const { session } = admitted;
    const row = salesRepo.readById(sale_id);
    if (
      row === null ||
      row.tenant_id !== session.tenant_id ||
      row.branch_id !== session.branch_id ||
      row.terminal_id !== session.terminal_id
    ) {
      return { ok: false, reason: 'sale_not_found' };
    }
    // OD-534-1/2: a cashier acts only on their own sale.
    if (!access.admitSale(action, session, row)) {
      return { ok: false, reason: 'sale_not_found' };
    }
    return { ok: true, row, session };
  }

  return {
    async preview(req: ReceiptsPreviewRequest): Promise<ReceiptsPreviewResponse> {
      // §A4 #2 — forbidden-field guard first, before any session/DB work.
      const forbidden = findForbiddenKey(req);
      if (forbidden !== null) {
        return await Promise.resolve({ kind: 'refused', reason: 'forbidden_field_in_request' });
      }

      // Session, role, tenant isolation and (RT-546) ownership — a cross-scope
      // or another cashier's sale refuses as sale_not_found (§A4 #6).
      const scoped = scopedSale('receipts.preview', req.sale_id);
      if (!scoped.ok) {
        return await Promise.resolve({ kind: 'refused', reason: scoped.reason });
      }
      const { row } = scoped;

      // S2: preview always renders the `preview` variant (byte-equal to
      // first_print content per AD-6). The reprint_duplicate preview lands with
      // the reprint flow in Slice 5.
      //
      // A corrupt persisted JSON column (engine-written, so unreachable in
      // practice) throws a typed derivation error; we map it to sale_not_found
      // so the renderer shows the preview error state rather than the IPC call
      // rejecting with an unstructured failure.
      let html: string;
      try {
        const payload = deriveReceiptPayload(row, { variant: 'preview' });
        html = renderReceipt(payload).html;
      } catch {
        return await Promise.resolve({ kind: 'refused', reason: 'sale_not_found' });
      }

      return await Promise.resolve({
        kind: 'ok',
        preview: {
          html,
          width_chars: PREVIEW_WIDTH_CHARS,
          bilingual_locale: 'ar-EG-RTL-with-latin-en',
        },
      });
    },

    async retryPrint(req: ReceiptsRetryPrintRequest): Promise<ReceiptsRetryPrintResponse> {
      // §A4 #2 — forbidden-field guard first.
      const forbidden = findForbiddenKey(req);
      if (forbidden !== null) {
        return { kind: 'refused', reason: 'forbidden_field_in_request' };
      }

      const scoped = scopedSale('receipts.retryPrint', req.sale_id);
      if (!scoped.ok) {
        return { kind: 'refused', reason: scoped.reason };
      }
      const { row, session } = scoped;

      // FR-052: a retry that succeeds is the canonical FIRST print — render the
      // `first_print` variant (no duplicate-copy marker). The reprint variant
      // is Slice 5's `receipts.reprint`, a different handler.
      let payload;
      try {
        payload = deriveReceiptPayload(row, { variant: 'first_print' });
      } catch {
        // A corrupt persisted JSON column (engine-written, unreachable in
        // practice) maps to sale_not_found rather than rejecting the IPC call.
        return { kind: 'refused', reason: 'sale_not_found' };
      }

      // Idempotency / FR-052 double-print guard (Path A — key-on-state, Ahmed
      // 2026-05-29). A sale that ALREADY printed SUCCESSFULLY must NOT print
      // again — a re-fired retry is a no-op returning the original success.
      //
      // NARROWED in Slice 6 (Ahmed 2026-05-30) to outcome='success' ONLY — a
      // prior `manual_override` is NON-terminal: the cashier may still retry
      // once the printer is back online (contract §receipts.manualOverride:
      // "The cashier can still invoke receipts.retryPrint later"). So an
      // override no longer blocks the retry — the retry-success becomes the
      // canonical first print (FR-052), and drawer gating runs on it (T502/T503).
      const priorEvents = printEventsRepo.readBySale(req.sale_id);
      const alreadyPrinted = priorEvents.find((e) => e.outcome === 'success');
      if (alreadyPrinted !== undefined) {
        return {
          kind: 'ok',
          outcome: 'success',
          print_event_id: alreadyPrinted.print_event_id,
          purpose: 'retry_after_failure',
          render_path: alreadyPrinted.render_path ?? 'escpos_direct',
          printed_at: alreadyPrinted.printed_at,
        };
      }

      // Lineage: the ids of the prior FAILED print events for this sale, so the
      // retry row records what it superseded (FR-052 audit trail).
      const previousFailedPrintEventIds = priorEvents
        .filter((e) => e.outcome === 'failure')
        .map((e) => e.print_event_id);

      const ctx: PrintDispatchContext = {
        sale_id: row.sale_id,
        tenant_id: row.tenant_id,
        branch_id: row.branch_id,
        terminal_id: row.terminal_id,
        // Attribution is the CURRENT signed-in operator (the retrying operator),
        // not the selling operator on the Sale row (FR-024).
        session_id: session.operator_session_id,
        attribution_operator_id: session.operator_id,
      };

      // An INFRA throw inside the dispatcher (render/INSERT/emit bug — not a
      // printer fault) must NOT reject the IPC call with an unstructured error.
      // Degrade to sale_not_found (the generic refusal); the Sale is durable
      // and the renderer's banner stays raised for another retry.
      let dispatched;
      try {
        dispatched = await printDispatcher.dispatchRetryPrint(
          payload,
          ctx,
          previousFailedPrintEventIds,
        );
      } catch {
        return { kind: 'refused', reason: 'sale_not_found' };
      }
      const { result, print_event_id, printed_at } = dispatched;

      if (result.ok) {
        // FR-052 / Slice 4: a retry that succeeds IS the canonical first print,
        // so it runs drawer gating exactly like an auto-fired first print
        // (cash-inclusive → kick). The drawer dispatch is a sibling step — its
        // own faults never reject this handler (the dispatcher resolves void on
        // internal faults; the Sale + print are already durable). The
        // `readBySale` guard makes a re-fired retry idempotent.
        //
        // Attribution is the RETRYING operator (FR-052 retry semantics +
        // FR-022/FR-023 operator attribution), mirroring this handler's print
        // ctx above — NOT FR-024 (which governs reprint attribution). Deliberate
        // asymmetry: an auto-fired first-print drawer event attributes to the
        // SELLING operator (dispatch-first-print-on-finalize → row.selling_operator_id),
        // while a retry-success drawer event for the same logical first print
        // attributes to the operator who clicked Retry. Both are "the operator
        // who caused this drawer kick" — the intended attribution.
        if (drawerKickDispatcher !== undefined) {
          try {
            await drawerKickDispatcher.dispatchOnFirstPrintSuccess({
              sale_id: row.sale_id,
              tenant_id: row.tenant_id,
              branch_id: row.branch_id,
              terminal_id: row.terminal_id,
              session_id: session.operator_session_id,
              attribution_operator_id: session.operator_id,
              tender_lines_summary_json: row.tender_lines_summary_json,
              triggering_print_event_id: print_event_id,
            });
          } catch {
            // Defence-in-depth: dispatcher resolves void by contract, but a
            // buggy drawer dispatch must not turn a successful print into a
            // refused retry. The print already succeeded + is durable.
          }
        }
        return {
          kind: 'ok',
          outcome: 'success',
          print_event_id,
          purpose: 'retry_after_failure',
          render_path: result.render_path,
          printed_at,
        };
      }
      // Still-failed: attempt accepted, print failed → ok+failure (NOT refused).
      return {
        kind: 'ok',
        outcome: 'failure',
        print_event_id,
        purpose: 'retry_after_failure',
        failure_reason: result.failure_reason,
      };
    },

    async reprint(req: ReceiptsReprintRequest): Promise<ReceiptsReprintResponse> {
      // §A4 #2 — forbidden-field guard first.
      const forbidden = findForbiddenKey(req);
      if (forbidden !== null) {
        return { kind: 'refused', reason: 'forbidden_field_in_request' };
      }

      // RT-546 / OD-534-2 (supersedes AD-10's "any operator"): a cashier
      // reprints only their own sale; a manager or admin any sale in scope. A
      // cross-scope, missing or another cashier's sale refuses as
      // `sale_not_found` (no information leak; §A4 #6).
      const scoped = scopedSale('receipts.reprint', req.sale_id);
      if (!scoped.ok) {
        return { kind: 'refused', reason: scoped.reason };
      }
      const { row, session } = scoped;

      // Precondition (FR-028 / data-model Invariant 3): the sale must already
      // have a successful print. `hasSuccessfulPrint` matches any outcome=success
      // row, which is a safe superset of "first_print OR retry_after_failure
      // success" — a success row can only carry one of those purposes (a reprint
      // success itself requires a prior success, so it can never be the first).
      if (!printEventsRepo.hasSuccessfulPrint(req.sale_id)) {
        return { kind: 'refused', reason: 'not_yet_printed' };
      }

      // The n-th reprint gets duplicate_copy_sequence_number=n. countReprints
      // counts ONLY successful reprints, so before the first reprint it is 0 → 1.
      // Reprint is repeatable: no state-keyed idempotency no-op (unlike retry).
      const duplicateCopySequenceNumber = printEventsRepo.countReprints(req.sale_id) + 1;

      // FR-029 / AD-6: render the reprint_duplicate variant (bilingual
      // duplicate-copy marker). The sequence number + reprint time flow into the
      // payload so the marker renders.
      let payload;
      try {
        payload = deriveReceiptPayload(row, {
          variant: 'reprint_duplicate',
          duplicate_copy_sequence_number: duplicateCopySequenceNumber,
          // Injected clock so the slip time matches print_events.printed_at
          // (the dispatcher reads the SAME clock in production — index.ts).
          reprinted_at: now(),
        });
      } catch {
        // A corrupt persisted JSON column (engine-written, unreachable in
        // practice) maps to sale_not_found rather than rejecting the IPC call.
        return { kind: 'refused', reason: 'sale_not_found' };
      }

      const ctx: PrintDispatchContext = {
        sale_id: row.sale_id,
        tenant_id: row.tenant_id,
        branch_id: row.branch_id,
        terminal_id: row.terminal_id,
        // Attribution is the CURRENT signed-in operator (the REPRINTING
        // operator), not the selling operator on the Sale row (FR-024 / AD-10).
        session_id: session.operator_session_id,
        attribution_operator_id: session.operator_id,
      };

      // An INFRA throw inside the dispatcher (render/INSERT/emit bug — not a
      // printer fault) must NOT reject the IPC call with an unstructured error.
      // Degrade to sale_not_found (the generic refusal); the Sale is durable.
      let dispatched;
      try {
        dispatched = await printDispatcher.dispatchReprint(payload, ctx, {
          duplicateCopySequenceNumber,
          sellingOperatorId: row.selling_operator_id,
        });
      } catch {
        return { kind: 'refused', reason: 'sale_not_found' };
      }
      const { result, print_event_id, printed_at } = dispatched;

      // Reprint is TWO-way: a print FAILURE refuses with `printer_unavailable`
      // (NOT retry's ok+failure). NEVER kicks the drawer (FR-030) — no drawer
      // dispatch is wired on this path at all.
      if (!result.ok) {
        return { kind: 'refused', reason: 'printer_unavailable' };
      }
      return {
        kind: 'ok',
        print_event_id,
        duplicate_copy_sequence_number: duplicateCopySequenceNumber,
        reprinted_at: printed_at,
        render_path: result.render_path,
      };
    },

    manualOverride(req: ReceiptsManualOverrideRequest): Promise<ReceiptsManualOverrideResponse> {
      // Synchronous internally (one INSERT + one emit, no awaited I/O) but the
      // bridge contract is Promise-returning; resolve the computed result. (Not
      // `async` — there is no await, which lint would flag.)
      return Promise.resolve(runManualOverride(req));
    },
  };

  function runManualOverride(req: ReceiptsManualOverrideRequest): ReceiptsManualOverrideResponse {
    // §A4 #2 — forbidden-field guard first.
    const forbidden = findForbiddenKey(req);
    if (forbidden !== null) {
      return { kind: 'refused', reason: 'forbidden_field_in_request' };
    }

    const scoped = scopedSale('receipts.manualOverride', req.sale_id);
    if (!scoped.ok) {
      return { kind: 'refused', reason: scoped.reason };
    }
    const { row, session } = scoped;

    // Idempotency (T504, Path A — key-on-state): a sale that ALREADY has a
    // manual_override is a no-op returning the original row. print_events has
    // no idempotency_key column (migrations frozen), so the durable state IS
    // the key. The contract's payload-mismatch arm is unreachable for a
    // sale-scoped key. (A manual_override is distinct from a print SUCCESS —
    // a sale can be overridden then later print successfully on retry, so we
    // key only on a prior manual_override here, not on any success.)
    const priorOverride = printEventsRepo
      .readBySale(req.sale_id)
      .find((e) => e.outcome === 'manual_override');
    if (priorOverride !== undefined) {
      return {
        kind: 'ok',
        print_event_id: priorOverride.print_event_id,
        purpose: 'first_print',
        outcome: 'manual_override',
        overridden_at: priorOverride.printed_at,
      };
    }

    // No slip is rendered — the cashier handled the receipt out-of-band. Write
    // the print_events row directly (NOT via the dispatcher, which would render
    // + set render_path; the CHECK requires render_path NULL on a
    // manual_override row). Attribution is the CURRENT (overriding) operator.
    const overridden_at = now();
    const print_event_id = (deps.newPrintEventId ?? ((): string => overridden_at))();

    // An INFRA throw from the durable INSERT (a code/DB bug — e.g. the
    // print_events CHECK or a sql.js write failure, not a printer fault) must
    // NOT escape as an unstructured IPC rejection (this method is called
    // synchronously inside `Promise.resolve(...)`, so a throw here would reject
    // before the bridge can return a typed refusal). Degrade to sale_not_found
    // — the generic refusal the sibling handlers use — so the renderer keeps
    // its banner raised for another attempt. (CodeRabbit #294, T512 hardening.)
    try {
      printEventsRepo.insert({
        print_event_id,
        sale_id: row.sale_id,
        outcome: 'manual_override',
        purpose: 'first_print',
        render_path: null,
        acting_operator_id: session.operator_id,
        acting_operator_session_id: session.operator_session_id,
        duplicate_copy_sequence_number: null,
        failure_reason: null,
        previous_failed_print_event_ids: null,
        printed_at: overridden_at,
      });
    } catch {
      return { kind: 'refused', reason: 'sale_not_found' };
    }

    // Emit the audit event (structural only — no slip content). emitRaw allows
    // sale.receipt.manual_override (it is in the non-finalize raw category set).
    // Best-effort: the override row is ALREADY durably written, so an audit
    // emit failure (forbidden-category/key guard or a sink write fault) must
    // not turn a recorded override into a refusal. Swallow it here.
    try {
      auditEmitter?.emitRaw({
        action_category: 'sale.receipt.manual_override',
        attribution_operator_id: session.operator_id,
        tenant_id: row.tenant_id,
        branch_id: row.branch_id,
        originating_terminal_id: row.terminal_id,
        session_id: session.operator_session_id,
        created_at: overridden_at,
        payload: { sale_id: row.sale_id, print_event_id },
      });
    } catch {
      /* audit emit is best-effort; the durable override row already landed */
    }

    return {
      kind: 'ok',
      print_event_id,
      purpose: 'first_print',
      outcome: 'manual_override',
      overridden_at,
    };
  }
}
