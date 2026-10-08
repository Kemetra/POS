import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { expectNoAxeViolations } from '../../primitives/__tests__/axe-config.js';
import { PinPad } from '../PinPad.js';
import { RosterList, type RosterEntry } from '../RosterList.js';
import { OperatorBadge } from '../OperatorBadge.js';
import { TakeoverPrompt } from '../TakeoverPrompt.js';
import { ManagerAdminSignInForm } from '../ManagerAdminSignInForm.js';
import type { OperatorBridgeAPI, SignInResponse } from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';

/**
 * 004-operator-session T080 [S5] — axe baseline smoke on all restyled
 * operator session surfaces.
 *
 * Zero serious or critical violations per surface variant.
 */

const CASHIERS: RosterEntry[] = [
  { id: 'c1', display_name: 'Alice Smith', role: 'cashier' },
  { id: 'c2', display_name: 'Bob Jones', role: 'cashier' },
];

const PENDING_ID = 'axe-pending-0001';

function makeBridge(overrides?: Partial<OperatorBridgeAPI>): OperatorBridgeAPI {
  return {
    signIn: vi.fn(() =>
      Promise.resolve({ kind: 'refused', category: 'invalid_input' } as SignInResponse),
    ),
    signOut: vi.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    getCurrentSession: vi.fn(() => Promise.resolve(null)),
    _reportActivity: vi.fn(),
    emitAuditEvent: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    _emitAuditEventSmoke: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'not_signed_in' as const }),
    ),
    listBranchRoster: vi.fn(() => Promise.resolve({ kind: 'roster' as const, cashiers: [] })),
    confirmTakeover: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    cancelTakeover: vi.fn(() => Promise.resolve({ kind: 'cancelled' as const })),
    resetCashierPin: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    provisionCashierPin: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    unlockCashier: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    forceCloseShift: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, category: 'invalid_input' as const }),
    ),
    listStuckShifts: vi.fn(() => Promise.resolve({ kind: 'stuck_shifts' as const, shifts: [] })),
    dismissShiftClosedNotice: vi.fn(() => Promise.resolve()),
    unlockSession: vi.fn(() => Promise.resolve({ kind: 'unlocked' as const })),
    getLockState: vi.fn(() =>
      Promise.resolve({
        state: 'active' as const,
        locked_at: null,
        role: null,
        display_name: null,
        summary: null,
      }),
    ),
    onSessionStateChanged: vi.fn(() => () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  useOperatorSessionStore.getState().reset();
});

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('axe baseline smoke — S5 operator surfaces (T080)', () => {
  // ── PinPad ────────────────────────────────────────────────────────────────

  it('PinPad empty: no axe violations', async () => {
    const { container } = render(<PinPad value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    await expectNoAxeViolations(container);
  });

  it('PinPad partial (3 digits): no axe violations', async () => {
    const { container } = render(<PinPad value="123" onChange={vi.fn()} onSubmit={vi.fn()} />);
    await expectNoAxeViolations(container);
  });

  it('PinPad full (6 digits): no axe violations', async () => {
    const { container } = render(<PinPad value="123456" onChange={vi.fn()} onSubmit={vi.fn()} />);
    await expectNoAxeViolations(container);
  });

  it('PinPad disabled: no axe violations', async () => {
    const { container } = render(
      <PinPad value="1234" onChange={vi.fn()} onSubmit={vi.fn()} disabled />,
    );
    await expectNoAxeViolations(container);
  });

  // ── RosterList ────────────────────────────────────────────────────────────

  it('RosterList inert (empty): no axe violations', async () => {
    const { container } = render(<RosterList cashiers={[]} />);
    await expectNoAxeViolations(container);
  });

  it('RosterList active with cashiers: no axe violations', async () => {
    const { container } = render(<RosterList cashiers={CASHIERS} onSelect={vi.fn()} />);
    await expectNoAxeViolations(container);
  });

  it('RosterList with selected cashier: no axe violations', async () => {
    const { container } = render(
      <RosterList cashiers={CASHIERS} onSelect={vi.fn()} selectedId="c1" />,
    );
    await expectNoAxeViolations(container);
  });

  // ── OperatorBadge ─────────────────────────────────────────────────────────

  it('OperatorBadge cashier role: no axe violations', async () => {
    const { container } = render(<OperatorBadge display_name="Alice Smith" role="cashier" />);
    await expectNoAxeViolations(container);
  });

  it('OperatorBadge manager role: no axe violations', async () => {
    const { container } = render(<OperatorBadge display_name="Bob Manager" role="manager" />);
    await expectNoAxeViolations(container);
  });

  it('OperatorBadge admin role: no axe violations', async () => {
    const { container } = render(<OperatorBadge display_name="Carol Admin" role="admin" />);
    await expectNoAxeViolations(container);
  });

  // ── TakeoverPrompt ────────────────────────────────────────────────────────

  it('TakeoverPrompt idle: no axe violations', async () => {
    useOperatorSessionStore.setState({
      state: { kind: 'takeoverPrompt', pending_takeover_id: PENDING_ID },
    });
    const { container } = render(
      <TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />,
    );
    await expectNoAxeViolations(container);
  });

  // ── ManagerAdminSignInForm ────────────────────────────────────────────────

  it('ManagerAdminSignInForm idle: no axe violations', async () => {
    useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
    const { container } = render(<ManagerAdminSignInForm operator={makeBridge()} />);
    await expectNoAxeViolations(container);
  });

  it('ManagerAdminSignInForm with back link: no axe violations', async () => {
    useOperatorSessionStore.setState({ state: { kind: 'signedOut' } });
    const { container } = render(
      <ManagerAdminSignInForm operator={makeBridge()} onBack={vi.fn()} />,
    );
    await expectNoAxeViolations(container);
  });
});
