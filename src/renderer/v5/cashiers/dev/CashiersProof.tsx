import type { JSX } from 'react';
import { MemoryRouter } from 'react-router-dom';

import type {
  CashierPinState,
  CashierPinStatus,
  ListCashierPinStatusResponse,
  OperatorBridgeAPI,
  PairingBridgeAPI,
} from '../../../../shared/bridge-api';
import type { OperatorRefusal } from '../../../../shared/audit/event-shape';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { V5Frame } from '../../frame/V5Frame';
import { CashiersScreen } from '../CashiersScreen';

/**
 * RT-424 — DEV-ONLY Manager → Cashiers harness (`#/dev/cashiers-proof`), the
 * same contract as the RT-243 / RT-244 harnesses: the REAL `CashiersScreen`
 * inside the REAL `V5Frame`, against an in-memory operator bridge, so every
 * G-3 state can be captured at 1024 and 1280 without a backend. It proves
 * layout and presentation only: no main process, PIN store or backend runs
 * here. The packaged bench remains the acceptance evidence.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds.
 *
 * Query (after the hash): `list` = typical | long | offline | refused | empty
 * (default typical); `provision` = ok | not_ready | reauth (the answer to the
 * first «حفظ» of a first PIN; default ok).
 */

type Row = [string, CashierPinState];

const TYPICAL: Row[] = [
  ['منى عبد الرحمن', 'ready'],
  ['أحمد سمير', 'no_pin'],
  ['ياسمين خالد', 'locked'],
  ['محمود عادل', 'ready'],
  ['نورهان إبراهيم', 'no_pin'],
  ['كريم فتحي', 'ready'],
];

const LONG: Row[] = [
  ...TYPICAL,
  ['عبد الرحمن مصطفى السيد عبد الفتاح الشناوي', 'ready'],
  ['هدى محمد', 'ready'],
  ['مصطفى جمال', 'no_pin'],
  ['سلمى طارق', 'ready'],
  ['إسلام حسن', 'locked'],
  ['محمد عبد الرحمن مصطفى السيد عبد الفتاح الشناوي الدمياطي', 'ready'],
  ['عمرو وليد', 'ready'],
  ['دينا سامح', 'no_pin'],
  ['يوسف أشرف', 'ready'],
  ['رحاب عصام', 'ready'],
  ['شريف ماهر', 'ready'],
  ['آية رضا', 'no_pin'],
];

export interface CashiersProofParams {
  list: 'typical' | 'long' | 'offline' | 'refused' | 'empty';
  provision: 'ok' | 'not_ready' | 'reauth';
}

function oneOf<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((v) => v === raw) ?? fallback;
}

export function readCashiersProofParams(): CashiersProofParams {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  return {
    list: oneOf(params.get('list'), ['typical', 'long', 'offline', 'refused', 'empty'], 'typical'),
    provision: oneOf(params.get('provision'), ['ok', 'not_ready', 'reauth'], 'ok'),
  };
}

/** A lock that ends at 14:35 today, local time (G-3 draws «حتى 14:35»). */
function lockEnd(): string {
  const at = new Date();
  at.setHours(14, 35, 0, 0);
  return at.toISOString();
}

function seed(list: CashiersProofParams['list']): CashierPinStatus[] {
  const rows = list === 'long' ? LONG : list === 'empty' ? [] : TYPICAL;
  return rows.map(([display_name, pin], i) => ({
    id: `proof-cashier-${String(i)}`,
    display_name,
    pin,
    ...(pin === 'locked' ? { locked_until: lockEnd() } : {}),
  }));
}

type ProofOperator = Pick<
  OperatorBridgeAPI,
  | 'listCashierPinStatus'
  | 'provisionCashierPin'
  | 'resetCashierPin'
  | 'unlockCashier'
  | 'reauthenticate'
>;

/** An in-memory bridge: every action makes the row «جاهز», as main would. */
export function makeCashiersProofBridge(params: CashiersProofParams): ProofOperator {
  let rows = seed(params.list);
  let firstProvision = true;
  const ready = (id: string): void => {
    rows = rows.map((r) =>
      r.id === id ? { id: r.id, display_name: r.display_name, pin: 'ready' } : r,
    );
  };
  const read = (): ListCashierPinStatusResponse => {
    if (params.list === 'offline') return { kind: 'refused', category: 'no_connection' };
    if (params.list === 'refused') return { kind: 'refused', category: 'invalid_input' };
    return { kind: 'cashiers', cashiers: rows };
  };
  const provisionRefusal = (): OperatorRefusal | null => {
    const first = firstProvision;
    firstProvision = false;
    if (!first || params.provision === 'ok') return null;
    return {
      kind: 'refused',
      category: params.provision === 'reauth' ? 'reauth_required' : 'not_ready',
    };
  };
  return {
    listCashierPinStatus: () => Promise.resolve(read()),
    provisionCashierPin: (req) => {
      const refusal = provisionRefusal();
      if (refusal !== null) return Promise.resolve(refusal);
      ready(req.target_cashier_id);
      return Promise.resolve({ kind: 'pin_provisioned', audit_event_id: req.event_id });
    },
    resetCashierPin: (req) => {
      ready(req.target_cashier_id);
      return Promise.resolve({ kind: 'pin_reset', audit_event_id: req.event_id });
    },
    unlockCashier: (req) => {
      ready(req.target_cashier_id);
      return Promise.resolve({ kind: 'unlocked', audit_event_id: req.event_id });
    },
    reauthenticate: () => Promise.resolve({ kind: 'reauthenticated' }),
  };
}

const PROOF_PAIRING = {
  getStatus: () =>
    Promise.resolve({
      kind: 'paired',
      tenant_id: 'dev-tenant',
      branch_id: 'dev-branch',
      terminal_id: 'dev-terminal',
      terminal_label: 'POS-03',
      paired_at: 0,
    }),
} as unknown as PairingBridgeAPI;

let prepared: { bridge: ProofOperator } | null = null;

/** Seeds the session once, before the first render (module state: the harness is one page). */
function prepare(): { bridge: ProofOperator } {
  if (prepared !== null) return prepared;
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'dev-session',
        operator_id: 'dev-manager',
        display_name: 'سارة عبد الحميد',
        role: 'manager',
        tenant_id: 'dev-tenant',
        branch_id: 'dev-branch',
        started_at: new Date().toISOString(),
      },
    },
  });
  prepared = { bridge: makeCashiersProofBridge(readCashiersProofParams()) };
  return prepared;
}

/** Tests only: forget the seeded page so the next render reads the hash again. */
export function resetCashiersProofForTests(): void {
  prepared = null;
}

export function CashiersProof(): JSX.Element {
  const { bridge } = prepare();
  return (
    <MemoryRouter initialEntries={['/app/manager/cashiers']}>
      <V5Frame>
        <CashiersScreen operator={bridge} pairing={PROOF_PAIRING} />
      </V5Frame>
    </MemoryRouter>
  );
}
