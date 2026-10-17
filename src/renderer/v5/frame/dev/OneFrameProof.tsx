import type { JSX } from 'react';

import type { OperatorRefusal } from '../../../../shared/audit/event-shape';
import type {
  ForceCloseShiftResponse,
  ListStuckShiftsResponse,
  ReceiptsBridgeAPI,
  SalesFindByNumberResponse,
  OperatorBridgeAPI,
  PairingBridgeAPI,
} from '../../../../shared/bridge-api';
import type { ReturnsBridgeAPI } from '../../../../shared/returns/types';
import type { PairingStatus } from '../../../../shared/pairing-types';
import type { Role } from '../../../../shared/operator/role';
import type { BannerState } from '../../../../shared/sales/types';
import { AppRouter } from '../../../router';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';

/**
 * RT-498 (VN-S10 S10-1) — DEV-ONLY one-frame harness (`#/dev/one-frame-proof`),
 * the same contract as the RT-243 / RT-244 / RT-424 / RT-441 harnesses: the
 * REAL AppRouter at any `/app` path, against in-memory bridges, so every
 * former AppShell route can be captured inside the v5 frame at 1024 and 1280
 * without a backend. It proves layout and presentation only; the packaged
 * bench (S10-V, RT-505) remains the acceptance evidence.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds.
 *
 * Query (after the hash): `path` = any `/app/...` route (default
 * `/app/dashboard`); `role` = manager | admin | cashier (default manager);
 * `banner` = none | printer (a printer failure for the D-10-6 notice; default
 * none); `shifts` = some | none (what `listStuckShifts` answers; default some);
 * `returns` = off | on (RT-501: `on` hydrates the returns flag and installs an
 * in-memory `window.api.returns`, so `/app/returns` shows the sale lookup and an
 * empty history instead of the flag-off policy message; default off);
 * `sale` = missing | found | noprint (what `sales.findByNumber` answers: no
 * such sale, a sale whose latest print succeeded, or one that never printed;
 * default missing); `reprint` = ok | fail (what the receipts reprint and
 * preview fakes answer; default ok);
 * `shift` = on | off (RT-499: the shift-cashup flag, which decides the manager
 * home's «حالة الوردية» card; default off).
 *
 * RT-502 (VN-S10 S10-5) adds, for the stuck-shifts captures: `list` = ok |
 * unreachable (`unreachable` answers a `no_connection` refusal; default ok);
 * `close` = refused | state_invalid | ok (what `forceCloseShift` answers:
 * `invalid_input`, `state_invalid` or `forced_closed`; default refused, as
 * before). `shifts=some` now holds three shifts, one with a very long name.
 *
 * `payments` = on | off (the payments feature flag, so `/app/checkout`
 * can show its flag-off notice; default on); `search` = none | results (what
 * the diagnostics search answers: not found, or twelve items; default none).
 */

export interface OneFrameProofParams {
  path: string;
  role: Role;
  banner: 'none' | 'printer';
  shifts: 'some' | 'none';
  returns: 'off' | 'on';
  sale: 'missing' | 'found' | 'noprint';
  reprint: 'ok' | 'fail';
  shift: 'on' | 'off';
  list: 'ok' | 'unreachable';
  close: 'refused' | 'state_invalid' | 'ok';
  payments: 'on' | 'off';
  search: 'none' | 'results';
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((v) => v === raw) ?? fallback;
}

export function readOneFrameProofParams(): OneFrameProofParams {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const rawPath = params.get('path') ?? '';
  return {
    path: rawPath.startsWith('/app') ? rawPath : '/app/dashboard',
    role: oneOf<Role>(params.get('role'), ['manager', 'admin', 'cashier'], 'manager'),
    banner: oneOf(params.get('banner'), ['none', 'printer'], 'none'),
    shifts: oneOf(params.get('shifts'), ['some', 'none'], 'some'),
    returns: oneOf(params.get('returns'), ['off', 'on'], 'off'),
    sale: oneOf(params.get('sale'), ['missing', 'found', 'noprint'], 'missing'),
    reprint: oneOf(params.get('reprint'), ['ok', 'fail'], 'ok'),
    shift: oneOf(params.get('shift'), ['on', 'off'], 'off'),
    list: oneOf(params.get('list'), ['ok', 'unreachable'], 'ok'),
    close: oneOf(params.get('close'), ['refused', 'state_invalid', 'ok'], 'refused'),
    payments: oneOf(params.get('payments'), ['on', 'off'], 'on'),
    search: oneOf(params.get('search'), ['none', 'results'], 'none'),
  };
}

const PAIRED: Extract<PairingStatus, { kind: 'paired' }> = {
  kind: 'paired',
  tenant_id: '7c1e2a90-4b6d-4f1a-9a0e-2f5d8c3b1e77',
  branch_id: 'b42f0c11-9d3e-4c8a-8f21-6e0a5d7c9b13',
  terminal_id: '0556bfa4-2c7e-4d19-b3a8-91f0e6d2c450',
  terminal_label: 'POS-03',
  paired_at: 1_735_689_600,
};

function stuckShifts(params: OneFrameProofParams): ListStuckShiftsResponse {
  if (params.list === 'unreachable') return { kind: 'refused', category: 'no_connection' };
  if (params.shifts === 'none') return { kind: 'stuck_shifts', shifts: [] };
  return {
    kind: 'stuck_shifts',
    shifts: [
      {
        shift_id: 'shift-1',
        cashier_display_name: 'أحمد سمير',
        terminal_label: 'POS-01',
        opened_at: '2026-10-15T06:00:00Z',
        duration_minutes: 190,
      },
      {
        shift_id: 'shift-2',
        cashier_display_name: 'ياسمين خالد',
        terminal_label: 'POS-03',
        opened_at: '2026-10-15T08:05:00Z',
        duration_minutes: 65,
      },
      {
        // RT-502: a very long name, so the never-clipped rule is visible.
        shift_id: 'shift-3',
        cashier_display_name: 'عبد الرحمن مصطفى السيد عبد الفتاح الشناوي',
        terminal_label: 'POS-02',
        opened_at: '2026-10-15T09:25:00Z',
        duration_minutes: 45,
      },
    ],
  };
}

/** The G-6 sale: its number, who sold it and where. */
function findAnswer(sale: OneFrameProofParams['sale']): SalesFindByNumberResponse {
  if (sale === 'missing') return { kind: 'refused', reason: 'sale_not_found' };
  return {
    kind: 'ok',
    sale: {
      sale_id: 'sale-proof-1',
      sale_number: 'TERM-01-2026-10-15-000042',
      receipt_number: 'TERM-01-2026-10-15-000042',
      tenant_id: PAIRED.tenant_id,
      branch_id: PAIRED.branch_id,
      terminal_id: PAIRED.terminal_id,
      terminal_label: 'POS-03',
      selling_operator_id: 'op-mona',
      selling_operator_display_name: 'منى عبد الرحمن',
      subtotal_minor: 12_500,
      total_tax_minor: 0,
      total_change_due_minor: 0,
      tender_lines_summary: [],
      finalized_at: '2026-10-15T10:00:00Z',
      latest_print_event: {
        print_event_id: 'pe-proof-1',
        outcome: sale === 'found' ? 'success' : 'failure',
        purpose: 'first_print',
        printed_at: '2026-10-15T10:00:05Z',
      },
    },
  } as unknown as SalesFindByNumberResponse;
}

const PREVIEW_HTML =
  '<div dir="ltr" style="text-align:center"><p><b>POS Pulse</b></p><p>TERM-01-2026-10-15-000042</p><p>POS-03</p></div>';

/** The receipts fakes: `reprint=fail` refuses the reprint and the preview. */
function receiptsBridge(reprint: OneFrameProofParams['reprint']): ReceiptsBridgeAPI {
  const fail = reprint === 'fail';
  return {
    reprint: () =>
      Promise.resolve(
        fail
          ? { kind: 'refused', reason: 'printer_unavailable' }
          : {
              kind: 'ok',
              print_event_id: 'pe-proof-2',
              duplicate_copy_sequence_number: 1,
              reprinted_at: '2026-10-15T10:05:00Z',
              render_path: 'escpos_direct',
            },
      ),
    preview: () =>
      Promise.resolve(
        fail
          ? { kind: 'refused', reason: 'sale_not_found' }
          : {
              kind: 'ok',
              preview: { html: PREVIEW_HTML, width_chars: 42, bilingual_locale: 'ar-EG-RTL' },
            },
      ),
    retryPrint: () => Promise.resolve({ kind: 'refused', reason: 'printer_unavailable' }),
  } as unknown as ReceiptsBridgeAPI;
}

function forceCloseAnswer(
  close: OneFrameProofParams['close'],
): ForceCloseShiftResponse | OperatorRefusal {
  if (close === 'ok') return { kind: 'forced_closed', audit_event_id: 'proof-event' };
  return {
    kind: 'refused',
    category: close === 'state_invalid' ? 'state_invalid' : 'invalid_input',
  };
}

function refused<T>(): () => Promise<T> {
  return () => Promise.resolve({ kind: 'refused', category: 'invalid_input' } as T);
}

export function operatorBridge(params: OneFrameProofParams): OperatorBridgeAPI {
  return {
    signIn: refused(),
    signOut: () => Promise.resolve({ kind: 'signed_out' as const }),
    getCurrentSession: () => Promise.resolve(null),
    _reportActivity: () => undefined,
    emitAuditEvent: refused(),
    _emitAuditEventSmoke: refused(),
    listBranchRoster: () => Promise.resolve({ kind: 'roster' as const, cashiers: [] }),
    confirmTakeover: refused(),
    cancelTakeover: () => Promise.resolve({ kind: 'cancelled' as const }),
    resetCashierPin: refused(),
    provisionCashierPin: refused(),
    unlockCashier: refused(),
    forceCloseShift: () => Promise.resolve(forceCloseAnswer(params.close)),
    listStuckShifts: () => Promise.resolve(stuckShifts(params)),
    dismissShiftClosedNotice: () => Promise.resolve(),
  } as unknown as OperatorBridgeAPI;
}

export const pairingBridge: PairingBridgeAPI = {
  getStatus: () => Promise.resolve(PAIRED),
  submit: () => Promise.reject(new Error('not used in the harness')),
};

function bannerState(banner: OneFrameProofParams['banner']): BannerState {
  return {
    printer_failure:
      banner === 'printer'
        ? { sale_id: 'sale-1', failure_reason: 'printer_offline', has_successful_print: false }
        : null,
    drawer_failure: null,
  };
}

/** RT-501: a returns namespace with an empty journal and no sale to find. */
const returnsBridge: ReturnsBridgeAPI = {
  lookup: () => Promise.resolve({ kind: 'refused', reason: 'sale_not_found' }),
  quote: () => Promise.resolve({ kind: 'refused', reason: 'sale_not_found' }),
  submit: () => Promise.resolve({ kind: 'refused', reason: 'sale_not_found', ret: null }),
  resolve: () => Promise.resolve({ kind: 'ok', confirmed: 0, refused: 0, unresolved: 0 }),
  list: () => Promise.resolve({ kind: 'ok', returns: [] }),
  payout: () => Promise.resolve({ kind: 'refused', reason: 'return_not_found', ret: null }),
  reprintSlip: () => Promise.resolve({ kind: 'refused', reason: 'return_not_found' }),
};

const PROOF_SEARCH_HITS = 12;

function catalogueSearch(search: OneFrameProofParams['search']): unknown {
  if (search === 'none') return { kind: 'not_found' };
  return {
    kind: 'results',
    items: Array.from({ length: PROOF_SEARCH_HITS }, (_, i) => ({
      product_id: `proof-${String(i)}`,
    })),
    truncated: false,
  };
}

/** The read-only bridges the moved screens touch on mount, in memory. */
export function installWindowApi(
  params: OneFrameProofParams,
  extraApi: Readonly<Record<string, unknown>> = {},
): void {
  (window as unknown as { api?: unknown }).api = {
    ...extraApi,
    pairing: pairingBridge,
    ...(params.returns === 'on' ? { returns: returnsBridge } : {}),
    catalogue: {
      counts: () => Promise.resolve({ kind: 'ok', products: 12_480, barcodes: 15_902 }),
      freshness: () =>
        Promise.resolve({ kind: 'ok', last_success_at: '2026-10-15T09:42:00Z', is_empty: false }),
      refresh: () => Promise.resolve({ kind: 'started' }),
      search: () => Promise.resolve(catalogueSearch(params.search)),
    },
    receipts: receiptsBridge(params.reprint),
    sales: {
      read: () => Promise.resolve({ kind: 'not_found' }),
      findByNumber: () => Promise.resolve(findAnswer(params.sale)),
      subscribe: () =>
        Promise.resolve({
          kind: 'ok',
          subscription_token: 'proof',
          banner_state: bannerState(params.banner),
        }),
      unsubscribe: () => Promise.resolve({ kind: 'ok' }),
    },
  };
}

interface OneFrameProofProps {
  /** RT-604: a harness built on this one may pass its own params. */
  params?: OneFrameProofParams;
  /** RT-604: extra in-memory bridges (e.g. `terminalStatus`). */
  extraApi?: Readonly<Record<string, unknown>>;
}

export function OneFrameProof(props: Readonly<OneFrameProofProps> = {}): JSX.Element {
  const params = props.params ?? readOneFrameProofParams();
  installWindowApi(params, props.extraApi);
  useFeatureFlagsStore.getState().hydrate({
    cart: true,
    payments: params.payments === 'on',
    productSearch: true,
    returns: params.returns === 'on',
    ...(params.shift === 'on' ? { shiftCashup: true } : {}),
  });
  useOperatorSessionStore.getState().hydrateSignedIn({
    id: `proof-${params.role}`,
    operator_id: `op-${params.role}`,
    display_name: 'سارة عبد الحميد',
    role: params.role,
    tenant_id: PAIRED.tenant_id,
    branch_id: PAIRED.branch_id,
    started_at: '2026-10-15T07:00:00Z',
  });
  return (
    <AppRouter
      pairing={pairingBridge}
      operator={operatorBridge(params)}
      initialEntry={params.path}
    />
  );
}
