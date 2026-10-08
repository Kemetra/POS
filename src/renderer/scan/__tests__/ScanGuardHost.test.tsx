/**
 * RT-239 (VNext A2) — the scan guard on the real window listener.
 *
 * These tests use real events and real timing: a burst is keys dispatched in one
 * synchronous run (gaps under a millisecond), human typing waits between keys.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PinPad } from '../../ui/operator/PinPad.js';
import { CashEntry } from '../../ui/payments/CashEntry.js';
import { ExternalCardTerminalEntry } from '../../ui/payments/ExternalCardTerminalEntry.js';
import {
  ScanGuardHost,
  SCAN_NOTICE_MS,
  resetScanGuardForTests,
  useScanOwner,
} from '../ScanGuardHost.js';
import {
  SCAN_DIALOG_OPEN_MESSAGE,
  SCAN_REFUSED_MESSAGE,
  SCAN_UNAVAILABLE_MESSAGE,
} from '../scan-messages.js';

/** Keys of one scan, dispatched back to back, ending in Enter. */
function burst(target: Element | Window, code: string): void {
  for (const key of code) fireEvent.keyDown(target, { key });
  fireEvent.keyDown(target, { key: 'Enter' });
}

/** What the browser does for a scan typed into a text field: each character lands in it. */
function scanIntoField(field: HTMLInputElement, code: string): void {
  for (const key of code) {
    fireEvent.keyDown(field, { key });
    fireEvent.change(field, { target: { value: field.value + key } });
  }
  fireEvent.keyDown(field, { key: 'Enter' });
}

/**
 * Time is fake so burst timing is exact under any machine load: events created
 * with no clock movement are a burst (gap 0), and a person's pause is an
 * explicit advance. Real clocks made this suite flaky when the machine was busy.
 */
function pause(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetScanGuardForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Owner(props: { onScan: (code: string) => void }): JSX.Element {
  useScanOwner(props.onScan);
  return <button type="button">حذف</button>;
}

describe('a burst is a scan wherever focus is (F-01)', () => {
  it('a burst Enter on a focused control never reaches the control and goes to the owner', () => {
    const onScan = vi.fn<(code: string) => void>();
    const onKeyDown = vi.fn();
    render(
      <>
        <ScanGuardHost />
        <Owner onScan={onScan} />
        <button type="button" onKeyDown={onKeyDown}>
          +
        </button>
      </>,
    );
    const plus = screen.getByRole('button', { name: '+' });
    plus.focus();
    burst(plus, '6221000000011');
    expect(onScan).toHaveBeenCalledWith('6221000000011');
    // Only the printable keys reached the button; the Enter that would press it did not.
    const enters = onKeyDown.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Enter');
    expect(enters).toHaveLength(0);
  });

  it('a person pressing Enter on a control is untouched', () => {
    const onKeyDown = vi.fn();
    render(
      <>
        <ScanGuardHost />
        <button type="button" onKeyDown={onKeyDown}>
          +
        </button>
      </>,
    );
    const plus = screen.getByRole('button', { name: '+' });
    plus.focus();
    pause(60);
    fireEvent.keyDown(plus, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('with no scan owner the cashier is told scanning is unavailable', () => {
    render(
      <>
        <ScanGuardHost />
        <button type="button">x</button>
      </>,
    );
    burst(screen.getByRole('button', { name: 'x' }), '123');
    // A polite status region, not an alert that steals focus.
    expect(screen.getByRole('status')).toHaveTextContent(SCAN_UNAVAILABLE_MESSAGE);
    expect(screen.getByTestId('scan-notice')).toHaveTextContent(SCAN_UNAVAILABLE_MESSAGE);
  });
});

describe('money, PIN and card-reference fields (M-S5)', () => {
  it('the cash amount field keeps its value, shows the notice and cannot be confirmed by a scan', () => {
    render(
      <>
        <ScanGuardHost />
        <CashEntry remainingBalanceMinor={1500} onConfirm={vi.fn()} />
      </>,
    );
    const input = screen.getByTestId<HTMLInputElement>('cash-entry-amount-input');
    input.focus();
    scanIntoField(input, '6221000000011');
    expect(input.value).toBe('');
    expect(screen.getByTestId('scan-notice')).toHaveTextContent(SCAN_REFUSED_MESSAGE.amount);
    expect(screen.getByTestId('cash-entry-confirm')).toBeDisabled();
  });

  it('a typed amount survives and a later burst does not overwrite it', () => {
    render(
      <>
        <ScanGuardHost />
        <CashEntry remainingBalanceMinor={1500} onConfirm={vi.fn()} />
      </>,
    );
    const input = screen.getByTestId<HTMLInputElement>('cash-entry-amount-input');
    input.focus();
    fireEvent.change(input, { target: { value: '20' } });
    scanIntoField(input, '99');
    expect(input.value).toBe('20');
  });

  it('the card reference field refuses a scan with the reference message', () => {
    render(
      <>
        <ScanGuardHost />
        <ExternalCardTerminalEntry
          remainingBalanceMinor={1500}
          paymentAttemptId="pa-1"
          tenderApply={vi.fn()}
          onApplied={vi.fn()}
        />
      </>,
    );
    const ref = screen.getByTestId<HTMLInputElement>('external-card-reference-input');
    ref.focus();
    scanIntoField(ref, 'AB12');
    expect(ref.value).toBe('');
    expect(screen.getByTestId('scan-notice')).toHaveTextContent(SCAN_REFUSED_MESSAGE.reference);
  });

  it('the PIN pad is restored and the scanner Enter does not submit it', () => {
    const onSubmit = vi.fn();
    function Pad(): JSX.Element {
      const [pin, setPin] = useState('');
      return <PinPad value={pin} onChange={setPin} onSubmit={onSubmit} />;
    }
    render(
      <>
        <ScanGuardHost />
        <Pad />
      </>,
    );
    burst(window, '6221');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('pin-pad-dots').querySelectorAll('[data-state="filled"]'),
    ).toHaveLength(0);
    expect(screen.getByTestId('scan-notice')).toHaveTextContent(SCAN_REFUSED_MESSAGE.pin);
  });

  it('a person typing a PIN with the hardware numpad still works', () => {
    const onSubmit = vi.fn();
    function Pad(): JSX.Element {
      const [pin, setPin] = useState('');
      return <PinPad value={pin} onChange={setPin} onSubmit={onSubmit} />;
    }
    render(
      <>
        <ScanGuardHost />
        <Pad />
      </>,
    );
    for (const key of '1234') {
      pause(60);
      fireEvent.keyDown(window, { key });
    }
    pause(60);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('screens that already take a scanned code keep working', () => {
  it('a burst into a lookup field still submits it, and no notice is shown', () => {
    const onSubmit = vi.fn();
    render(
      <>
        <ScanGuardHost />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <input aria-label="رقم البيع" type="text" />
        </form>
      </>,
    );
    const field = screen.getByLabelText<HTMLInputElement>('رقم البيع');
    field.focus();
    const keyDowns: string[] = [];
    field.addEventListener('keydown', (e) => keyDowns.push(e.key));
    scanIntoField(field, 'S-000042');
    expect(field.value).toBe('S-000042');
    expect(keyDowns.at(-1)).toBe('Enter');
    expect(screen.queryByTestId('scan-notice')).not.toBeInTheDocument();
  });
});

describe('dialogs suspend scanning visibly (M-S6)', () => {
  it('a burst while a modal dialog is open is refused and the owner is not called', () => {
    const onScan = vi.fn<(code: string) => void>();
    render(
      <>
        <ScanGuardHost />
        <Owner onScan={onScan} />
        <div role="dialog" aria-modal="true" aria-label="تأكيد">
          <button type="button">إلغاء</button>
        </div>
      </>,
    );
    const cancel = screen.getByRole('button', { name: 'إلغاء' });
    cancel.focus();
    burst(cancel, '123456');
    expect(onScan).not.toHaveBeenCalled();
    expect(screen.getByTestId('scan-notice')).toHaveTextContent(SCAN_DIALOG_OPEN_MESSAGE);
  });
});

describe('the notice', () => {
  it('goes away by itself', () => {
    render(
      <>
        <ScanGuardHost />
        <button type="button">x</button>
      </>,
    );
    burst(screen.getByRole('button', { name: 'x' }), '123');
    expect(screen.getByTestId('scan-notice')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(SCAN_NOTICE_MS);
    });
    expect(screen.queryByTestId('scan-notice')).not.toBeInTheDocument();
  });
});
