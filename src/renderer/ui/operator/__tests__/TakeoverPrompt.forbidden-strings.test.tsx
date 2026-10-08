import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { TakeoverPrompt } from '../TakeoverPrompt.js';
import type { OperatorBridgeAPI, SignInResponse } from '../../../../shared/bridge-api.js';
import { useOperatorSessionStore } from '../../../stores/operator-session-store.js';

/**
 * 004-operator-session T072 [S5] — TakeoverPrompt forbidden-strings guard (TEST-FIRST).
 *
 * FR-013 minimum-disclosure contract:
 *   The rendered dialog MUST contain canonical copy verbatim and MUST NOT
 *   expose any identifying, role, or time-based information about the
 *   conflicting session.
 *
 * Canonical copy (locked by visual-direction spec):
 *   Heading : "You are already signed in on another POS terminal in this branch."
 *   Body    : "Continue here and sign out there?"
 *   Primary : "Continue here"
 *   Ghost   : "Cancel"
 *
 * Forbidden strings (per FR-013):
 *   - POS-<id>  (terminal identifier pattern)
 *   - "ago"     (time-relative string)
 *   - "Cashier " (role label, trailing space to avoid mid-word hits)
 *   - "Manager" (role label)
 *   - "Admin"   (role label)
 *   - /\d{2}:\d{2}/ (HH:MM timestamp pattern)
 *   - "View details"
 *   - "Why am I seeing this"
 *   - "Show details"
 */

const PENDING_ID = 'test-pending-forbidden-0001';

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
  useOperatorSessionStore.setState({
    state: { kind: 'takeoverPrompt', pending_takeover_id: PENDING_ID },
  });
});

afterEach(() => {
  useOperatorSessionStore.getState().reset();
  cleanup();
});

describe('TakeoverPrompt — FR-013 canonical copy (verbatim)', () => {
  it('heading is exactly the canonical FR-013 string', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-title').textContent).toBe(
      'You are already signed in on another POS terminal in this branch.',
    );
  });

  it('body is exactly the canonical FR-013 string', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-body').textContent).toBe(
      'Continue here and sign out there?',
    );
  });

  it('primary button label is exactly "Continue here"', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-confirm').textContent).toBe('Continue here');
  });

  it('ghost button label is exactly "Cancel"', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt-cancel').textContent).toBe('Cancel');
  });
});

describe('TakeoverPrompt — FR-013 forbidden strings', () => {
  it('does NOT contain any POS-<id> terminal identifier', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/POS-\w/);
  });

  it('does NOT contain "ago" (time-relative string)', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/\bago\b/);
  });

  it('does NOT contain "Cashier " (role label)', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/Cashier /);
  });

  it('does NOT contain "Manager" (role label)', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/Manager/);
  });

  it('does NOT contain "Admin" (role label)', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/Admin/);
  });

  it('does NOT contain HH:MM timestamp pattern', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/\d{2}:\d{2}/);
  });

  it('does NOT contain "View details"', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/View details/i);
  });

  it('does NOT contain "Why am I seeing this"', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/Why am I seeing this/i);
  });

  it('does NOT contain "Show details"', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toMatch(/Show details/i);
  });

  it('does NOT expose the pending_takeover_id in rendered text', () => {
    render(<TakeoverPrompt operator={makeBridge()} pending_takeover_id={PENDING_ID} />);
    expect(screen.getByTestId('takeover-prompt').textContent).not.toContain(PENDING_ID);
  });
});
