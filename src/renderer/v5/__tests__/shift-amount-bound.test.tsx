/**
 * RT-278 S1 (plan `docs/design/vnext/29-rt278-shift-amount-bounds.md` §3.5,
 * owner decisions OD-278-6/7, RT-278 comment 12764) — the shift screens run
 * main's plausibility rule as a pre-check: above the cap nothing is sent, the
 * field is marked invalid with the new line, the amount stays and focus goes
 * back to the field. Main's own `amount_out_of_range` is shown the same way,
 * never as a retry line. A pay-out has no pre-check (the drawer bound is
 * main's alone).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { ShiftStatusResponse } from '../../../shared/shift-cashup/types';
import { latinLeaks } from '../../ui/payments/__tests__/latin-leaks';
import { V5ShiftRoute } from '../shift/V5ShiftRoute';
import { SHIFT_COPY, shiftRefusalMessage } from '../shift/shift-copy';
import {
  enableShiftFlag,
  fakeShiftBridge,
  openShiftView,
  renderAt,
  resetShiftStores,
  signIn,
  statusView,
  type FakeShiftBridge,
} from './__helpers__/shift-test-kit';

afterEach(() => {
  cleanup();
  resetShiftStores();
});

const LINE = 'المبلغ أكبر من الحد المسموح لهذه العملية. راجع المبلغ. لم يُسجَّل شيء.';
/** F-02: the 13-digit barcode typed or pasted as an amount. */
const F02_TYPED = '6221000000011';

const OPEN: ShiftStatusResponse = {
  kind: 'status',
  status: statusView({ openShift: openShiftView() }),
};

function renderRoute(bridge: FakeShiftBridge) {
  signIn('cashier');
  enableShiftFlag();
  return renderAt({
    path: '/app/shift',
    pattern: '/app/shift',
    element: <V5ShiftRoute bridge={bridge} />,
  });
}

function openBridge(): FakeShiftBridge {
  return fakeShiftBridge(OPEN.kind === 'status' ? OPEN.status : statusView());
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function press(name: string, scope: HTMLElement = document.body): void {
  const button = within(scope).getByRole('button', { name });
  button.focus();
  fireEvent.click(button);
}

/** The field is marked invalid, shows the line, keeps the value and has focus. */
function expectRefusedEntry(label: string, value: string): void {
  const field = screen.getByLabelText(label);
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(field).toHaveValue(value);
  expect(field).toHaveFocus();
  expect(field).toHaveAccessibleDescription(LINE);
}

/**
 * Main answers `amount_out_of_range` for a plausible-looking entry: type it,
 * commit, and the field ends up as for the pre-check (invalid, the line, the
 * value kept, focus back), never a retry line.
 */
async function expectMainRefusalMarksEntry(input: {
  label: string;
  value: string;
  commit: string;
  scope?: HTMLElement;
}): Promise<void> {
  type(input.label, input.value);
  press(input.commit, input.scope);
  await waitFor(() => {
    expect(screen.getByLabelText(input.label)).toHaveAttribute('aria-invalid', 'true');
  });
  expectRefusedEntry(input.label, input.value);
}

describe('RT-278 — the copy', () => {
  it('is the owner-approved line, with no amount, bound or retry', () => {
    const message = shiftRefusalMessage('amount_out_of_range');
    expect(message).toBe(LINE);
    expect(message).not.toMatch(/[0-9٠-٩]/);
    expect(message).not.toContain('حاول');
  });
});

describe('RT-278 — the opening float', () => {
  it('above EGP 100,000.00: no call, the field invalid with the line, the amount kept, focus on it', async () => {
    const bridge = fakeShiftBridge();
    const { container } = renderRoute(bridge);
    await screen.findByLabelText(SHIFT_COPY.floatLabel);
    type(SHIFT_COPY.floatLabel, '100000.01');
    press(SHIFT_COPY.openCommit);
    expectRefusedEntry(SHIFT_COPY.floatLabel, '100000.01');
    expect(bridge.open).not.toHaveBeenCalled();
    expect(latinLeaks(container)).toEqual([]);
  });

  it('at the cap is sent', async () => {
    const bridge = fakeShiftBridge();
    renderRoute(bridge);
    await screen.findByLabelText(SHIFT_COPY.floatLabel);
    type(SHIFT_COPY.floatLabel, '100000');
    press(SHIFT_COPY.openCommit);
    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith({ openingFloatMinor: 10_000_000 });
    });
  });
});

describe('RT-278 — pay-in and pay-out', () => {
  async function openDialog(kind: 'payIn' | 'payOut', bridge = openBridge()) {
    renderRoute(bridge);
    press(SHIFT_COPY[kind], await screen.findByTestId('shift-actions'));
    return { bridge, dialog: screen.getByRole('dialog', { name: SHIFT_COPY[kind] }) };
  }

  it('a pay-in of the F-02 digits: no call, the field invalid with the line, the amount kept, focus on it', async () => {
    const { bridge, dialog } = await openDialog('payIn');
    type(SHIFT_COPY.amountLabel, F02_TYPED);
    press(SHIFT_COPY.record, dialog);
    expectRefusedEntry(SHIFT_COPY.amountLabel, F02_TYPED);
    expect(bridge.payIn).not.toHaveBeenCalled();
    expect(latinLeaks(dialog)).toEqual([]);
  });

  it('a pay-out above the pay-in cap is sent (no pre-check)', async () => {
    const { bridge, dialog } = await openDialog('payOut');
    type(SHIFT_COPY.amountLabel, '100000.01');
    press(SHIFT_COPY.record, dialog);
    await waitFor(() => {
      expect(bridge.payOut).toHaveBeenCalledWith({
        amountMinor: 10_000_001,
        reasonCode: 'bank_drop',
      });
    });
  });
});

describe('RT-278 — the blind-count close', () => {
  async function startClose(bridge = openBridge()) {
    const view = renderRoute(bridge);
    const panel = await screen.findByTestId('shift-close-panel');
    return { bridge, panel, container: view.container };
  }

  it('a count above EGP 1,000,000.00: no call, the field invalid with the line, the amount kept, focus on it', async () => {
    const { bridge, panel } = await startClose();
    type(SHIFT_COPY.countLabel, '1000000.01');
    press(SHIFT_COPY.closeCommit, panel);
    expectRefusedEntry(SHIFT_COPY.countLabel, '1000000.01');
    expect(bridge.close).not.toHaveBeenCalled();
    expect(latinLeaks(panel)).toEqual([]);
  });

  it('a count at the cap is sent', async () => {
    const { bridge, panel } = await startClose();
    type(SHIFT_COPY.countLabel, '1000000');
    press(SHIFT_COPY.closeCommit, panel);
    await waitFor(() => {
      expect(bridge.close).toHaveBeenCalledWith({ countedCashMinor: 100_000_000 });
    });
  });
});

describe("RT-278 — main's own amount_out_of_range", () => {
  const REFUSED = { kind: 'refused', reason: 'amount_out_of_range' } as const;
  const CASES = [
    {
      entry: 'the opening float',
      bridge: () => fakeShiftBridge(),
      refuse: (b: FakeShiftBridge) => b.open.mockResolvedValue(REFUSED),
      openDialog: null,
      label: SHIFT_COPY.floatLabel,
      value: '500',
      commit: SHIFT_COPY.openCommit,
      // No dialog was open, and none opens.
      dialogAfter: false,
    },
    {
      entry: 'a pay-in',
      bridge: openBridge,
      refuse: (b: FakeShiftBridge) => b.payIn.mockResolvedValue(REFUSED),
      openDialog: SHIFT_COPY.payIn,
      label: SHIFT_COPY.amountLabel,
      value: '25',
      commit: SHIFT_COPY.record,
      // The movement dialog stays open for the correction.
      dialogAfter: true,
    },
    {
      entry: 'the count',
      bridge: openBridge,
      refuse: (b: FakeShiftBridge) => b.close.mockResolvedValue(REFUSED),
      openDialog: null,
      label: SHIFT_COPY.countLabel,
      value: '515',
      commit: SHIFT_COPY.closeCommit,
      // No manager approval step opens for it.
      dialogAfter: false,
    },
  ];

  it.each(CASES)(
    '$entry: the line marked invalid, the amount kept, focus back, never a retry line',
    async (c) => {
      const bridge = c.bridge();
      c.refuse(bridge);
      renderRoute(bridge);
      if (c.openDialog !== null) press(c.openDialog, await screen.findByTestId('shift-actions'));
      await screen.findByLabelText(c.label);
      await expectMainRefusalMarksEntry({ label: c.label, value: c.value, commit: c.commit });
      expect(screen.queryByRole('dialog') !== null).toBe(c.dialogAfter);
    },
  );
});
