/**
 * RT-658 — the DEV-only shift harness (`#/dev/shift-proof`). It must reach
 * every G-2 state with the real screens; these tests drive it the way the
 * capture script does. Presentation scaffolding only, not evidence about main.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { SHIFT_PROOF_STATES, ShiftProof, readShiftProofState } from '../shift/dev/ShiftProof';
import { SHIFT_COPY, shiftRefusalMessage } from '../shift/shift-copy';

function at(state: string): void {
  window.location.hash = `#/dev/shift-proof?state=${state}`;
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

describe('readShiftProofState', () => {
  it('reads one of the 20 G-2 states, else Open', () => {
    expect(SHIFT_PROOF_STATES).toHaveLength(20);
    at('MgrStranded');
    expect(readShiftProofState()).toBe('MgrStranded');
    at('nope');
    expect(readShiftProofState()).toBe('Open');
  });
});

describe('ShiftProof', () => {
  it('opens the cashier screen with no shift on Open', async () => {
    at('Open');
    render(<ShiftProof />);
    expect(await screen.findByRole('region', { name: SHIFT_COPY.openHeading })).toBeInTheDocument();
  });

  it('shows the open shift and its totals on Status', async () => {
    at('Status');
    render(<ShiftProof />);
    const summary = await screen.findByTestId('shift-summary');
    expect(summary).toHaveTextContent('500.00 EGP');
    expect(summary).toHaveTextContent('1,250.00 EGP');
  });

  it('moves to the open shift after an open, as main answers', async () => {
    const user = userEvent.setup();
    at('Opened');
    render(<ShiftProof />);
    const card = await screen.findByRole('region', { name: SHIFT_COPY.openHeading });
    await user.type(within(card).getByLabelText(SHIFT_COPY.floatLabel), '500');
    await user.click(within(card).getByRole('button', { name: SHIFT_COPY.openCommit }));
    expect(await screen.findByText(SHIFT_COPY.opened)).toBeInTheDocument();
    expect(await screen.findByTestId('shift-summary')).toHaveTextContent('500.00 EGP');
  });

  it('refuses the close for parked sales on ParkedBlocked', async () => {
    const user = userEvent.setup();
    at('ParkedBlocked');
    render(<ShiftProof />);
    const close = await screen.findByRole('region', { name: SHIFT_COPY.closeHeading });
    await user.type(within(close).getByLabelText(SHIFT_COPY.countLabel), '2450');
    await user.click(within(close).getByRole('button', { name: SHIFT_COPY.closeCommit }));
    expect(await screen.findByTestId('shift-parked-block')).toBeInTheDocument();
  });

  it('opens the manager page with the stranded warning on MgrStranded', async () => {
    at('MgrStranded');
    render(<ShiftProof />);
    expect(await screen.findByTestId('shift-stranded-warning')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: SHIFT_COPY.managerTitle }),
    ).toBeInTheDocument();
  });

  it('refuses the status read on Unavailable', async () => {
    at('Unavailable');
    render(<ShiftProof />);
    expect(await screen.findByText(shiftRefusalMessage('unavailable'))).toBeInTheDocument();
  });
});
