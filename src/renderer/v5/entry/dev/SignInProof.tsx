import type { JSX } from 'react';
import { MemoryRouter } from 'react-router-dom';

import type {
  ListBranchRosterResponse,
  OperatorBridgeAPI,
  PairingBridgeAPI,
  SignInResponse,
} from '../../../../shared/bridge-api';
import type { RefusalCategory } from '../../../../shared/audit/event-shape';
import { SignInRoute } from '../../../routes/sign-in';
import { SupportedViewport } from '../../foundation/SupportedViewport';

/**
 * RT-244 W1-D — DEV-ONLY sign-in harness (`#/dev/sign-in-proof`), the same
 * contract as the RT-243 Checkout harness: the REAL `SignInRoute` against an
 * in-memory operator bridge, so every G-1 state can be captured at 1024 and
 * 1280 without a backend. It proves layout and presentation only — no main
 * process, credential store or backend runs here, so nothing it shows is
 * authentication evidence. Packaged captures remain the acceptance evidence.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds.
 *
 * Query (after the hash): `roster` = typical | long | offline | refused | empty
 * (default typical); `signin` = a refusal category every cashier sign-in returns
 * (default invalid_input).
 */

const TYPICAL = [
  'منى عبد الرحمن',
  'أحمد سمير',
  'ياسمين خالد',
  'محمود عادل',
  'نورهان إبراهيم',
  'كريم فتحي',
];

const LONG = [
  ...TYPICAL,
  'عبد الرحمن مصطفى السيد عبد الفتاح الشناوي',
  'هدى محمد',
  'مصطفى جمال',
  'سلمى طارق',
  'إسلام حسن',
  'محمد عبد الرحمن مصطفى السيد عبد الفتاح الشناوي الدمياطي',
  'عمرو وليد',
  'دينا سامح',
  'يوسف أشرف',
  'رحاب عصام',
  'شريف ماهر',
  'آية رضا',
];

const REFUSALS: ReadonlyArray<RefusalCategory> = ['invalid_input', 'rate_limited', 'no_connection'];

interface HarnessParams {
  readonly roster: string;
  readonly signin: RefusalCategory;
}

export function readSignInProofParams(): HarnessParams {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const signin = params.get('signin') as RefusalCategory | null;
  return {
    roster: params.get('roster') ?? 'typical',
    signin: signin !== null && REFUSALS.includes(signin) ? signin : 'invalid_input',
  };
}

function rosterFor(kind: string): ListBranchRosterResponse {
  if (kind === 'offline') return { kind: 'refused', category: 'no_connection' };
  if (kind === 'refused') return { kind: 'refused', category: 'invalid_input' };
  const names = kind === 'empty' ? [] : kind === 'long' ? LONG : TYPICAL;
  return {
    kind: 'roster',
    source: 'online',
    cashiers: names.map((display_name, i) => ({
      id: `proof-cashier-${String(i)}`,
      display_name,
      role: 'cashier' as const,
    })),
  };
}

const refusedOperatorCall = (): Promise<{ kind: 'refused'; category: 'not_signed_in' }> =>
  Promise.resolve({ kind: 'refused', category: 'not_signed_in' });

export function makeProofOperator(params: HarnessParams): OperatorBridgeAPI {
  const signIn = (): Promise<SignInResponse> =>
    Promise.resolve({ kind: 'refused', category: params.signin });
  // Only the calls the sign-in screen makes are meaningful; the rest refuse.
  return {
    signIn,
    getCurrentSession: () => Promise.resolve(null),
    listBranchRoster: () => Promise.resolve(rosterFor(params.roster)),
    signOut: () => Promise.resolve({ kind: 'signed_out' as const }),
    _reportActivity: () => undefined,
    emitAuditEvent: refusedOperatorCall,
    _emitAuditEventSmoke: refusedOperatorCall,
    confirmTakeover: refusedOperatorCall,
    cancelTakeover: () => Promise.resolve({ kind: 'cancelled' as const }),
    resetCashierPin: refusedOperatorCall,
    provisionCashierPin: refusedOperatorCall,
    unlockCashier: refusedOperatorCall,
    forceCloseShift: refusedOperatorCall,
    listStuckShifts: () => Promise.resolve({ kind: 'stuck_shifts' as const, shifts: [] }),
    dismissShiftClosedNotice: () => Promise.resolve(),
    unlockSession: refusedOperatorCall,
    getLockState: () =>
      Promise.resolve({
        state: 'active' as const,
        locked_at: null,
        role: null,
        display_name: null,
        summary: null,
      }),
    onSessionStateChanged: () => () => undefined,
  };
}

const PROOF_PAIRING: PairingBridgeAPI = {
  getStatus: () =>
    Promise.resolve({
      kind: 'paired',
      tenant_id: 'proof-tenant',
      branch_id: 'proof-branch',
      terminal_id: 'proof-terminal',
      terminal_label: 'POS-03',
      paired_at: 1735689600,
    }),
  submit: () => Promise.reject(new Error('the sign-in proof does not pair')),
} as unknown as PairingBridgeAPI;

export function SignInProof(): JSX.Element {
  const params = readSignInProofParams();
  return (
    <MemoryRouter initialEntries={['/sign-in']}>
      <SupportedViewport>
        <SignInRoute operator={makeProofOperator(params)} pairing={PROOF_PAIRING} />
      </SupportedViewport>
    </MemoryRouter>
  );
}
