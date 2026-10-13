import type { JSX } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import type {
  ListBranchRosterResponse,
  OperatorBridgeAPI,
  PairingBridgeAPI,
  SignInResponse,
} from '../../../../shared/bridge-api';
import type { RefusalCategory } from '../../../../shared/audit/event-shape';
import type { PairingOutcome } from '../../../../shared/pairing-types';
import { SignInRoute } from '../../../routes/sign-in';
import { PairedScreen } from '../../../routes/paired/PairedScreen';
import { PairingScreen } from '../../../routes/pairing/PairingScreen';
import { SupportedViewport } from '../../foundation/SupportedViewport';
import { SessionLockGate } from '../../../session/SessionLockGate';

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
 * (default invalid_input); `screen` = sign-in | ready | pairing | revoked
 * (default sign-in; RT-244 PR2); `pair` = the outcome every pairing submit
 * returns (default invalid_code).
 *
 * RT-444: `screen=locked` puts the sign-in screen behind a locked session (the
 * real `SessionLockGate`), so the lock's «دخول موظف آخر» and the notice over
 * the sign-in screen can be captured; `signin=terminal_has_unresolved_payment`
 * shows the admission refusal.
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

const REFUSALS: ReadonlyArray<RefusalCategory> = [
  'invalid_input',
  'rate_limited',
  'no_connection',
  'terminal_has_unresolved_payment',
];

const SCREENS = {
  'sign-in': '/sign-in',
  locked: '/sign-in',
  ready: '/paired',
  pairing: '/pairing',
  revoked: '/pairing',
};
type ProofScreen = keyof typeof SCREENS;

const PAIR_OUTCOMES: ReadonlyArray<PairingOutcome> = [
  'invalid_code',
  'expired_code',
  'already_paired',
  'branch_mismatch',
  'rate_limited',
  'network_error',
  'unknown_error',
  'session_active',
  'terminal_already_paired',
];

interface HarnessParams {
  readonly roster: string;
  readonly signin: RefusalCategory;
  readonly screen: ProofScreen;
  readonly pair: PairingOutcome;
}

function oneOf<T extends string>(value: string | null, allowed: ReadonlyArray<T>, fallback: T): T {
  return value !== null && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback;
}

export function readSignInProofParams(): HarnessParams {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  return {
    roster: params.get('roster') ?? 'typical',
    signin: oneOf(params.get('signin'), REFUSALS, 'invalid_input'),
    screen: oneOf(params.get('screen'), Object.keys(SCREENS) as ProofScreen[], 'sign-in'),
    pair: oneOf(params.get('pair'), PAIR_OUTCOMES, 'invalid_code'),
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
      Promise.resolve(
        params.screen === 'locked'
          ? {
              state: 'locked' as const,
              locked_at: '2026-10-13T14:40:00.000Z',
              role: 'cashier' as const,
              display_name: 'منى عبد الرحمن',
              summary: null,
            }
          : {
              state: 'active' as const,
              locked_at: null,
              role: null,
              display_name: null,
              summary: null,
            },
      ),
    onSessionStateChanged: () => () => undefined,
  };
}

/** A paired terminal whose every pairing submit returns `pair` (never success). */
export function makeProofPairing(params: HarnessParams): PairingBridgeAPI {
  return {
    getStatus: () =>
      Promise.resolve({
        kind: 'paired',
        tenant_id: 'proof-tenant',
        branch_id: 'proof-branch',
        terminal_id: 'proof-terminal',
        terminal_label: 'POS-03',
        paired_at: 1735689600,
      }),
    submit: () =>
      Promise.resolve(
        params.pair === 'rate_limited'
          ? { outcome: 'rate_limited', retry_after_s: 30 }
          : { outcome: params.pair },
      ),
    recheckRevocation: () => Promise.resolve({ outcome: 'still_revoked' }),
  } as unknown as PairingBridgeAPI;
}

export function SignInProof(): JSX.Element {
  const params = readSignInProofParams();
  const pairing = makeProofPairing(params);
  const operator = makeProofOperator(params);
  const routes = (
    <Routes>
      <Route path="/sign-in" element={<SignInRoute operator={operator} pairing={pairing} />} />
      <Route path="/paired" element={<PairedScreen pairing={pairing} />} />
      <Route
        path="/pairing"
        element={
          params.screen === 'revoked' ? (
            <PairingScreen pairing={pairing} invalidReason="device_revoked" />
          ) : (
            <PairingScreen pairing={pairing} />
          )
        }
      />
    </Routes>
  );
  return (
    <MemoryRouter initialEntries={[SCREENS[params.screen]]}>
      <SupportedViewport>
        {params.screen === 'locked' ? (
          <SessionLockGate operator={operator}>{routes}</SessionLockGate>
        ) : (
          routes
        )}
      </SupportedViewport>
    </MemoryRouter>
  );
}
