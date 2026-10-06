/**
 * RT-17 slice 4 part 3 — the manager's v5 shift screen (`/app/shift/manager`):
 * the shift status panel and the manager PIN enrolment. Manager / admin only;
 * hidden entirely with the flag off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { V5ShiftManagerRoute } from '../shift/V5ShiftManagerRoute';
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
  delete (window as unknown as { api?: unknown }).api;
});

function renderManager(bridge: FakeShiftBridge | null | undefined) {
  return renderAt({
    path: '/app/shift/manager',
    pattern: '/app/shift/manager',
    element:
      bridge === undefined ? <V5ShiftManagerRoute /> : <V5ShiftManagerRoute bridge={bridge} />,
  });
}

const BUSY = statusView({
  openShift: openShiftView(),
  queue: { pending: 3, waiting: 1, blocked: 2, envelopePending: 4 },
  stranded: { unsyncedFacts: 5, openShifts: 1 },
  pendingDrawerActivity: { refundPayouts: 6, unfinalizedSales: 7 },
  probeRefusals: { payOut: 8, varianceClose: 9, approverFailure: 11 },
});

function row(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value for ${label}`);
  return value;
}

describe('V5ShiftManagerRoute — gating', () => {
  it('leaves the screen (no call) with the flag off', async () => {
    signIn('manager');
    enableShiftFlag(false);
    const bridge = fakeShiftBridge();
    renderManager(bridge);
    expect(await screen.findByTestId('where')).toHaveTextContent('/app');
    expect(bridge.status).not.toHaveBeenCalled();
  });

  it('turns a cashier away (no call)', async () => {
    signIn('cashier');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    renderManager(bridge);
    expect(await screen.findByTestId('where')).toHaveTextContent('/app');
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.enrollManagerPin).not.toHaveBeenCalled();
  });

  it('renders nothing while signed out', () => {
    enableShiftFlag();
    expect(renderManager(fakeShiftBridge()).container).toBeEmptyDOMElement();
  });

  it('says so when this build has no shift bridge', () => {
    signIn('admin');
    enableShiftFlag();
    renderManager(null);
    expect(screen.getByText(SHIFT_COPY.bridgeMissing)).toBeInTheDocument();
  });

  it('reads the bridge from window.api by default', async () => {
    signIn('manager');
    enableShiftFlag();
    const bridge = fakeShiftBridge();
    (window as unknown as { api: unknown }).api = { shiftCashup: bridge };
    renderManager(undefined);
    expect(await screen.findByText(SHIFT_COPY.noOpenShift)).toBeInTheDocument();
  });
});

describe('ShiftStatusPanel — what a manager sees', () => {
  it('shows the open shift, queue, stranded, pending drawer activity and probe counts', async () => {
    signIn('manager');
    enableShiftFlag();
    renderManager(fakeShiftBridge(BUSY));
    expect(await screen.findByTestId('shift-status-open')).toHaveTextContent('500.00 EGP');
    const expected: Array<[string, string]> = [
      [SHIFT_COPY.queuePending, '3'],
      [SHIFT_COPY.queueWaiting, '1'],
      [SHIFT_COPY.queueBlocked, '2'],
      [SHIFT_COPY.queueEnvelope, '4'],
      [SHIFT_COPY.strandedFacts, '5'],
      [SHIFT_COPY.strandedShifts, '1'],
      [SHIFT_COPY.pendingRefunds, '6'],
      [SHIFT_COPY.pendingSales, '7'],
      [SHIFT_COPY.probePayOut, '8'],
      [SHIFT_COPY.probeVariance, '9'],
      [SHIFT_COPY.probeApprover, '11'],
    ];
    for (const [label, value] of expected) expect(row(label)).toHaveTextContent(value);
  });

  it('says when no shift is open', async () => {
    signIn('admin');
    enableShiftFlag();
    renderManager(fakeShiftBridge());
    expect(await screen.findByText(SHIFT_COPY.noOpenShift)).toBeInTheDocument();
  });

  it('shows a refused read with its message and refreshes on request', async () => {
    signIn('manager');
    enableShiftFlag();
    const bridge = fakeShiftBridge(BUSY);
    bridge.status.mockResolvedValueOnce({ kind: 'refused', reason: 'no_session' });
    renderManager(bridge);
    expect(await screen.findByText(shiftRefusalMessage('no_session'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SHIFT_COPY.retry }));
    expect(await screen.findByTestId('shift-status-open')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: SHIFT_COPY.refresh }));
    await waitFor(() => {
      expect(bridge.status).toHaveBeenCalledTimes(3);
    });
  });
});

describe('ManagerPinEnrollment — a manager sets their own PIN', () => {
  async function form(bridge = fakeShiftBridge()) {
    signIn('manager');
    enableShiftFlag();
    renderManager(bridge);
    const region = await screen.findByTestId('manager-pin-enrollment');
    return { bridge, region };
  }

  function fill(region: HTMLElement, values: { pin: string; confirm: string; current?: string }) {
    const set = (label: string, value: string) => {
      fireEvent.change(within(region).getByLabelText(label), { target: { value } });
    };
    set(SHIFT_COPY.newPinLabel, values.pin);
    set(SHIFT_COPY.confirmPinLabel, values.confirm);
    if (values.current !== undefined) set(SHIFT_COPY.currentPinLabel, values.current);
    fireEvent.click(within(region).getByRole('button', { name: SHIFT_COPY.enrollCommit }));
  }

  it('masks every PIN field', async () => {
    const { region } = await form();
    for (const label of [
      SHIFT_COPY.newPinLabel,
      SHIFT_COPY.confirmPinLabel,
      SHIFT_COPY.currentPinLabel,
    ]) {
      const input = within(region).getByLabelText(label);
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('autocomplete', 'off');
    }
  });

  it('enrols a first PIN (no current PIN sent) and clears the fields', async () => {
    const { bridge, region } = await form();
    fill(region, { pin: '٥٨٢٠٤٧', confirm: '582047' });
    await waitFor(() => {
      expect(bridge.enrollManagerPin).toHaveBeenCalledWith({ managerPin: '582047' });
    });
    expect(await within(region).findByText(SHIFT_COPY.enrolled)).toBeInTheDocument();
    expect(within(region).getByLabelText(SHIFT_COPY.newPinLabel)).toHaveValue('');
    expect(within(region).getByLabelText(SHIFT_COPY.confirmPinLabel)).toHaveValue('');
    expect(document.body.textContent).not.toContain('582047');
  });

  it('sends the current PIN when replacing one', async () => {
    const { bridge, region } = await form();
    fill(region, { pin: '582047', confirm: '582047', current: '640913' });
    await waitFor(() => {
      expect(bridge.enrollManagerPin).toHaveBeenCalledWith({
        managerPin: '582047',
        currentPin: '640913',
      });
    });
    expect(within(region).getByLabelText(SHIFT_COPY.currentPinLabel)).toHaveValue('');
  });

  it.each([
    ['a mismatched confirmation', { pin: '582047', confirm: '582048' }, SHIFT_COPY.pinMismatch],
    ['a short PIN', { pin: '58204', confirm: '58204' }, SHIFT_COPY.pinShape],
    ['a malformed current PIN', { pin: '582047', confirm: '582047', current: '12' }, SHIFT_COPY.pinShape],
  ])('refuses %s without a call', async (_name, values, message) => {
    const { bridge, region } = await form();
    fill(region, values);
    expect(await within(region).findByRole('alert')).toHaveTextContent(message);
    expect(bridge.enrollManagerPin).not.toHaveBeenCalled();
  });

  it.each([
    'reauth_required',
    'pin_too_weak',
    'current_pin_required',
    'current_pin_invalid',
    'current_pin_locked',
    'not_manager',
  ] as const)('shows the %s refusal as its user message', async (reason) => {
    const bridge = fakeShiftBridge();
    bridge.enrollManagerPin.mockResolvedValue({ kind: 'refused', reason });
    const { region } = await form(bridge);
    fill(region, { pin: '582047', confirm: '582047' });
    expect(await within(region).findByRole('alert')).toHaveTextContent(shiftRefusalMessage(reason));
    expect(within(region).getByLabelText(SHIFT_COPY.newPinLabel)).toHaveValue('');
  });

  it('maps a rejected enrolment call to the generic unavailable message', async () => {
    const bridge = fakeShiftBridge();
    bridge.enrollManagerPin.mockRejectedValue(new Error('ipc'));
    const { region } = await form(bridge);
    fill(region, { pin: '582047', confirm: '582047' });
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      shiftRefusalMessage('unavailable'),
    );
  });
});
