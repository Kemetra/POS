/**
 * T100 + T101 + T102 — `sales.*` bridge handlers (008 Slice 1c.2).
 *
 * The renderer-facing trust boundary for sale-reads. Three handlers:
 *
 *   • `sales.read({ sale_id })` — read a single sale by id.
 *   • `sales.findByNumber({ sale_number })` — read by cashier-quotable
 *     number; tenant-scoped to (session.tenant_id, branch_id, terminal_id).
 *   • `sales.subscribe({ topic })` + `sales.unsubscribe({ subscription_token })`
 *     — SNAPSHOT-subscribe (008 follow-up slice): subscribe returns the current
 *     projection for the topic (`banner_state` → BannerState; `recent` →
 *     RecentSaleSummary | null) via the injected `bannerStateProjector`; the
 *     renderer POLLS it (no `webContents.send` push — consistent with the
 *     poll-based AD-2 finalize design). When the projector isn't wired (legacy
 *     S1 construction), subscribe falls back to the `not_implemented` refusal.
 *     `unsubscribe` is a no-op (no registry; snapshot mode).
 *
 * Per contracts/bridge-api.md (§A4 CLEARED 2026-05-26):
 *   • Every handler is gated by an active session (`no_session` refusal).
 *   • RT-546 (OD-534-1): every handler then runs the main-process role gate
 *     (`sale-access-policy.ts`): a locked session refuses as `no_session`, a
 *     role outside the allowlist as `role_denied`, and a cashier sees only
 *     their own sales — another operator's sale refuses as `sale_not_found`;
 *     `subscribe` projects only the cashier's own sales.
 *   • Cross-tenant misses on `findByNumber` refuse with `sale_not_found`
 *     NOT `tenant_isolation` (§A4 #6 — no information leak).
 *   • Main-only fields (envelope_handoff_action_id, payment_attempt_id,
 *     envelope_cart_id, tenant_tax_registration_id) MUST NOT cross the
 *     bridge (Constitution §P15).
 *   • Defensive forbidden-field-in-request guard refuses any request
 *     payload containing voucher tokens, card data, secrets, etc.
 *     (§A4 #2).
 *   • `sales.read` includes projected `latest_print_event` and
 *     `latest_drawer_event` — populated when rows exist (post-S2/S3),
 *     omitted otherwise.
 *   • RT-541: `sales.read` / `sales.findByNumber` carry the sale's recorded
 *     `lines` (`sale-lines.ts`); `sales.list` reads this device's sales over a
 *     range of store business days (`sales-list.ts`) behind the same gate,
 *     with a cashier limited to their own sales by `ownerFilter`.
 */

import { FORBIDDEN_PAYLOAD_KEYS } from '../../shared/audit/forbidden-keys.js';
import type { SalesRepository, TenantScope } from './repositories/sales.repository.js';
import type {
  PrintEventsRepository,
  PrintEventRow,
} from './repositories/print-events.repository.js';
import type {
  DrawerEventsRepository,
  DrawerEventRow,
} from './repositories/drawer-events.repository.js';
import type {
  SalesBridgeAPI,
  SalesReadRequest,
  SalesReadResponse,
  SalesFindByNumberRequest,
  SalesFindByNumberResponse,
  SalesSubscribeRequest,
  SalesSubscribeResponse,
  SalesUnsubscribeRequest,
  SalesUnsubscribeResponse,
  SalesListRequest,
  SalesListResponse,
  SaleSummary,
} from '../../shared/bridge-api.js';
import type { SaleId, SaleNumber, TenderLineSummary } from '../../shared/sales/types.js';
import type { BannerStateProjector } from './banner-state-projector.js';
import type { SaleAuditEmitter } from './audit-emitter.js';
import { createSaleAccessPolicy } from './sale-access-policy.js';
import { projectSaleLines } from './sale-lines.js';
import { planSalesList, runSalesList } from './sales-list.js';

// ─── Session shape (mirrors 006's OperatorSessionForPayments) ──────────────
//
// The session shape is sales-specific because 008 doesn't need the
// payment-attempt-state vocabulary that 006's OperatorSessionForPayments
// carries. Tenant/branch/terminal + operator identity is all the bridge
// handlers gate on.

export interface OperatorSessionForSales {
  readonly role: 'cashier' | 'manager' | 'admin';
  readonly operator_id: string;
  readonly operator_session_id: string;
  readonly tenant_id: string;
  readonly branch_id: string;
  readonly terminal_id: string;
}

// ─── Bridge factory interface (implements SalesBridgeAPI) ───────────────────
//
// Request/Response/Subscribe types live in src/shared/bridge-api.ts (S1b);
// this factory implements the SalesBridgeAPI surface so the preload can
// wire ipcRenderer.invoke calls directly to its methods.

export type SalesBridge = SalesBridgeAPI;

export interface SalesBridgeDependencies {
  getCurrentSession: () => OperatorSessionForSales | null;
  salesRepo: Pick<
    SalesRepository,
    'readById' | 'findByNumber' | 'findByHandoffActionId' | 'insert' | 'listByFinalizedRange'
  >;
  printEventsRepo: Pick<
    PrintEventsRepository,
    'readBySale' | 'hasSuccessfulPrint' | 'countReprints' | 'insert'
  >;
  drawerEventsRepo: Pick<
    DrawerEventsRepository,
    'readBySale' | 'findLastSuccessfulOpenForTerminal' | 'insert'
  >;
  /**
   * Snapshot-subscribe projector (008 follow-up slice). `sales.subscribe`
   * returns the current projection for the topic (the renderer polls it);
   * see coordination §S3c mechanism-corrected note. Optional so the existing
   * S1 construction sites that don't wire it keep compiling — when absent,
   * subscribe falls back to the `not_implemented` refusal.
   */
  bannerStateProjector?: BannerStateProjector;
  /** Injected token generator for subscribe (symmetry with unsubscribe). */
  newSubscriptionToken?: () => string;
  /** RT-546: true while the operator session is locked (refused as no_session). */
  isSessionLocked?: () => boolean;
  /** RT-546: records `sale.access.refused` for a role-gate refusal. */
  auditEmitter?: Pick<SaleAuditEmitter, 'emitRaw'>;
}

// ─── Forbidden-field-in-request scan ────────────────────────────────────────

const SALES_BRIDGE_FORBIDDEN_KEYS = new Set<string>([
  // Card data
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
  // Voucher tokens
  'voucher_code',
  'voucher_balance',
  'voucher_redemption_intent_token',
  'authority_payload',
  // Raw envelope
  'envelope_payload',
  'raw_envelope',
  // Identifiers we never want renderers to send
  'issuer_name',
  'pin_record_id',
]);

function findForbiddenKey(node: unknown, seen: WeakSet<object> = new WeakSet()): string | null {
  // Per CR10 on PR #266 — Electron's IPC structured-clone preserves
  // cycles (per HTML structured-clone algorithm), so a malicious renderer
  // could in principle ship a cyclic payload across `ipcRenderer.invoke`
  // and reach this scan. The WeakSet tracks already-visited nodes so the
  // recursion terminates on a cycle. The renderer is already inside the
  // trust boundary (contextIsolation: true + sandbox: true), so this is
  // defence-in-depth, not load-bearing.
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
    if (SALES_BRIDGE_FORBIDDEN_KEYS.has(key)) return key;
    const hit = findForbiddenKey((node as Record<string, unknown>)[key], seen);
    if (hit !== null) return hit;
  }
  return null;
}

// ─── Projection helpers ─────────────────────────────────────────────────────

function projectLatestPrintEvent(rows: PrintEventRow[]): SaleSummary['latest_print_event'] {
  if (rows.length === 0) return undefined;
  // Repo returns ordered by printed_at DESC, so rows[0] is latest.
  /* c8 ignore start — defensive: rows.length > 0 above guarantees rows[0] is defined */
  const latest = rows[0];
  if (latest === undefined) return undefined;
  /* c8 ignore stop */
  const projection: NonNullable<SaleSummary['latest_print_event']> = {
    print_event_id: latest.print_event_id,
    outcome: latest.outcome,
    purpose: latest.purpose,
    printed_at: latest.printed_at,
  };
  if (latest.duplicate_copy_sequence_number !== null) {
    projection.duplicate_copy_sequence_number = latest.duplicate_copy_sequence_number;
  }
  return projection;
}

function projectLatestDrawerEvent(row: DrawerEventRow | null): SaleSummary['latest_drawer_event'] {
  if (row === null) return undefined;
  return {
    drawer_event_id: row.drawer_event_id,
    outcome: row.outcome,
    attempted_at: row.attempted_at,
  };
}

function projectSaleForRenderer(
  saleRow: {
    sale_id: string;
    sale_number: string;
    receipt_number: string;
    tenant_id: string;
    branch_id: string;
    terminal_id: string;
    terminal_label: string;
    selling_operator_id: string;
    selling_operator_display_name: string;
    subtotal_minor: number;
    total_tax_minor: number;
    total_change_due_minor: number;
    tender_lines_summary_json: string;
    finalized_at: string;
    lines_json: string;
  },
  printEvents: PrintEventRow[],
  drawerEvent: DrawerEventRow | null,
): SaleSummary {
  const view: SaleSummary = {
    sale_id: saleRow.sale_id as SaleId,
    sale_number: saleRow.sale_number as SaleNumber,
    receipt_number: saleRow.receipt_number,
    tenant_id: saleRow.tenant_id,
    branch_id: saleRow.branch_id,
    terminal_id: saleRow.terminal_id,
    terminal_label: saleRow.terminal_label,
    selling_operator_id: saleRow.selling_operator_id,
    selling_operator_display_name: saleRow.selling_operator_display_name,
    subtotal_minor: saleRow.subtotal_minor,
    total_tax_minor: saleRow.total_tax_minor,
    total_change_due_minor: saleRow.total_change_due_minor,
    tender_lines_summary: JSON.parse(saleRow.tender_lines_summary_json) as TenderLineSummary[],
    finalized_at: saleRow.finalized_at,
    lines: projectSaleLines(saleRow.lines_json),
  };
  const latestPrint = projectLatestPrintEvent(printEvents);
  if (latestPrint !== undefined) view.latest_print_event = latestPrint;
  const latestDrawer = projectLatestDrawerEvent(drawerEvent);
  if (latestDrawer !== undefined) view.latest_drawer_event = latestDrawer;
  return view;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createSalesBridge(deps: SalesBridgeDependencies): SalesBridge {
  const { salesRepo, printEventsRepo, drawerEventsRepo } = deps;
  const access = createSaleAccessPolicy(deps);
  // Per-bridge monotonic fallback token source (snapshot mode — the token is
  // vestigial for unsubscribe symmetry; uniqueness avoids two subscriptions
  // sharing a token). Overridable via deps.newSubscriptionToken.
  let subscriptionSeq = 0;
  const nextToken = (): string => {
    if (deps.newSubscriptionToken !== undefined) return deps.newSubscriptionToken();
    subscriptionSeq += 1;
    return `sub-${String(subscriptionSeq)}`;
  };

  // The admitted sale with its latest print / drawer projections.
  const okSale = (
    saleRow: Parameters<typeof projectSaleForRenderer>[0],
  ): { kind: 'ok'; sale: SaleSummary } => ({
    kind: 'ok',
    sale: projectSaleForRenderer(
      saleRow,
      printEventsRepo.readBySale(saleRow.sale_id),
      drawerEventsRepo.readBySale(saleRow.sale_id),
    ),
  });

  return {
    async read(req: SalesReadRequest): Promise<SalesReadResponse> {
      // Defensive forbidden-field-in-request guard FIRST (§A4 #2).
      const forbidden = findForbiddenKey(req);
      if (forbidden !== null) {
        return await Promise.resolve({ kind: 'refused', reason: 'forbidden_field_in_request' });
      }

      const admitted = access.admitSession('sales.read');
      if (!admitted.ok) {
        return await Promise.resolve({ kind: 'refused', reason: admitted.reason });
      }
      const { session } = admitted;

      const saleRow = salesRepo.readById(req.sale_id);
      if (saleRow === null) {
        return await Promise.resolve({ kind: 'refused', reason: 'sale_not_found' });
      }

      // Tenant-isolation: session scope MUST match sale scope.
      if (
        saleRow.tenant_id !== session.tenant_id ||
        saleRow.branch_id !== session.branch_id ||
        saleRow.terminal_id !== session.terminal_id
      ) {
        return await Promise.resolve({ kind: 'refused', reason: 'tenant_isolation' });
      }
      // OD-534-1: a cashier reads only their own sale (non-disclosing refusal).
      if (!access.admitSale('sales.read', session, saleRow)) {
        return await Promise.resolve({ kind: 'refused', reason: 'sale_not_found' });
      }

      return await Promise.resolve(okSale(saleRow));
    },

    async findByNumber(req: SalesFindByNumberRequest): Promise<SalesFindByNumberResponse> {
      const forbidden = findForbiddenKey(req);
      if (forbidden !== null) {
        return await Promise.resolve({ kind: 'refused', reason: 'forbidden_field_in_request' });
      }

      const admitted = access.admitSession('sales.findByNumber');
      if (!admitted.ok) {
        return await Promise.resolve({ kind: 'refused', reason: admitted.reason });
      }
      const { session } = admitted;

      // Scope to the session's (tenant, branch, terminal). Cross-scope misses
      // refuse with sale_not_found NOT tenant_isolation (§A4 #6 — no
      // information leak via existence-distinguishing reasons).
      const scope: TenantScope = {
        tenant_id: session.tenant_id,
        branch_id: session.branch_id,
        terminal_id: session.terminal_id,
      };
      const saleRow = salesRepo.findByNumber(req.sale_number, scope);
      if (saleRow === null) {
        return await Promise.resolve({ kind: 'refused', reason: 'sale_not_found' });
      }
      // OD-534-1: sale numbers are sequential, so another operator's sale
      // refuses exactly like a missing one (no existence leak).
      if (!access.admitSale('sales.findByNumber', session, saleRow)) {
        return await Promise.resolve({ kind: 'refused', reason: 'sale_not_found' });
      }

      return await Promise.resolve(okSale(saleRow));
    },

    async subscribe(req: SalesSubscribeRequest): Promise<SalesSubscribeResponse> {
      // Forbidden-field-in-request guard FIRST (§A4 #2 + CR3 on PR #266).
      // Defence-in-depth: even though the typed request shape is
      // `{ topic }`, callers can smuggle additional keys at the IPC layer.
      const forbidden = findForbiddenKey(req);
      if (forbidden !== null) {
        return await Promise.resolve({ kind: 'refused', reason: 'forbidden_field_in_request' });
      }
      const admitted = access.admitSession('sales.subscribe');
      if (!admitted.ok) {
        return await Promise.resolve({ kind: 'refused', reason: admitted.reason });
      }
      const { session } = admitted;
      // Snapshot-subscribe (008 follow-up slice): return the current projection
      // for the topic; the renderer POLLS this (no push channel) — consistent
      // with the poll-based AD-2 finalize design. See coordination §S3c
      // mechanism-corrected note. If the projector wasn't wired (legacy S1
      // construction sites), fall back to the prior not_implemented refusal.
      const projector = deps.bannerStateProjector;
      if (projector === undefined) {
        return await Promise.resolve({ kind: 'refused', reason: 'not_implemented' });
      }
      // OD-534-1: a cashier's snapshot covers only their own sales, so the
      // banner never offers a recovery action main would then refuse.
      const scope = {
        tenant_id: session.tenant_id,
        branch_id: session.branch_id,
        terminal_id: session.terminal_id,
        selling_operator_id: access.ownerFilter(session),
      };
      const subscription_token = nextToken();
      if (req.topic === 'banner_state') {
        return await Promise.resolve({
          kind: 'ok',
          subscription_token,
          banner_state: projector.projectBannerState(scope),
        });
      }
      // `SalesSubscribeTopic` is the closed union `'recent' | 'banner_state'`,
      // so after the `banner_state` branch `req.topic` is narrowed to `'recent'`
      // — handle it directly (a redundant `if (topic === 'recent')` is an
      // always-true comparison eslint rejects). The `satisfies` anchor is a
      // compile-time guard: a future-added topic widens `req.topic` and breaks
      // this assertion at build time, rather than silently falling through to
      // the `recent` projection.
      req.topic satisfies 'recent';
      return await Promise.resolve({
        kind: 'ok',
        subscription_token,
        recent: projector.projectRecentSale(scope),
      });
    },

    async list(req: SalesListRequest): Promise<SalesListResponse> {
      const forbidden = findForbiddenKey(req);
      if (forbidden !== null) {
        return await Promise.resolve({ kind: 'refused', reason: 'forbidden_field_in_request' });
      }
      const admitted = access.admitSession('sales.list');
      if (!admitted.ok) {
        return await Promise.resolve({ kind: 'refused', reason: admitted.reason });
      }
      const { session } = admitted;
      const planned = planSalesList(req as unknown as Record<string, unknown>);
      if (!planned.ok) return await Promise.resolve(planned.refusal);
      // Scope and the OD-534-1 own-sales filter come from the session only.
      const scope = {
        tenant_id: session.tenant_id,
        branch_id: session.branch_id,
        terminal_id: session.terminal_id,
      };
      return await Promise.resolve(
        runSalesList(salesRepo, scope, access.ownerFilter(session), planned.plan),
      );
    },

    async unsubscribe(req: SalesUnsubscribeRequest): Promise<SalesUnsubscribeResponse> {
      // Forbidden-field guard at handler entry (§A4 #2 + CR3 on PR #266).
      // SalesUnsubscribeResponse has no refusal branch in the shared type,
      // so a forbidden-key hit surfaces as a rejected promise — IPC
      // translates that into an exception on the renderer side. Same
      // posture as an unhandled main-process throw on any handler:
      // visible to the renderer as a generic "bridge invocation failed"
      // and to the support bundle as an exception trace (without the
      // forbidden key value, which never reaches the log).
      const forbidden = findForbiddenKey(req);
      if (forbidden !== null) {
        throw new Error('sales.unsubscribe: refused — forbidden field in request');
      }
      // Stub no-op — no subscription registry yet.
      // STUB — no subscription registry exists yet (subscribe also returns
      // not_implemented), so unsubscribing any token is a no-op. Returning
      // `kind: 'ok'` matches the shared SalesUnsubscribeResponse type
      // (which has no refusal branch). When the push primitive lands, this
      // becomes a real token-detach against the registry.
      return await Promise.resolve({ kind: 'ok' });
    },
  };
}
