/**
 * RT-412 (RT-312 D2) — the in-surface fit notice. The geometry is
 * fit-measure.test.ts's job (and the Chromium measurement on RT-412's); here
 * the measurement is stubbed so the guard's behaviour can be driven: what it
 * covers, what it says, which keys and scans still reach the screen, and where
 * focus goes.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';

import { getScanGuard, resetScanGuardForTests } from '../../../scan/ScanGuardHost';
import { SCAN_UNAVAILABLE_MESSAGE } from '../../../scan/scan-messages';
import { useScanNoticeStore } from '../../../scan/scan-notice-store';
import { expectNoAxeViolations } from '../../../ui/primitives/__tests__/axe-config';
import { FitGuard } from '../FitGuard';

const measured = vi.hoisted(() => ({ fits: true }));

vi.mock('../fit-measure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fit-measure')>()),
  surfaceFits: () => measured.fits,
}));

let resizeCallbacks: Array<() => void> = [];

beforeEach(() => {
  measured.fits = true;
  resizeCallbacks = [];
  resetScanGuardForTests();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The height the screen receives changes: every observer re-measures. */
function remeasure(fits: boolean): void {
  measured.fits = fits;
  act(() => {
    for (const callback of resizeCallbacks) callback();
  });
}

function Frame(props: { surface?: 'sale' | 'checkout'; banner?: boolean }): JSX.Element {
  return (
    <div className="v5-frame">
      <div className="v5-frame__body">
        {props.banner === true && (
          <div className="v5-frame__notices">
            <button type="button">تم</button>
          </div>
        )}
        <main className="v5-frame__main" tabIndex={-1}>
          <FitGuard surface={props.surface ?? 'checkout'}>
            <section aria-label="الدفع">
              <button type="button">نقدي</button>
            </section>
          </FitGuard>
        </main>
      </div>
    </div>
  );
}

/** A banner takes height above <main> (the test DOM lays nothing out). */
function giveBannerHeight(): void {
  const notices = document.querySelector('.v5-frame__notices');
  if (notices === null) throw new Error('no banner area');
  Object.defineProperty(notices, 'getBoundingClientRect', {
    value: () => ({ top: 0, bottom: 62, height: 62, left: 0, right: 0, width: 0, x: 0, y: 0 }),
  });
}

const guardBox = (): HTMLElement => document.querySelector('.v5-fit-guard') as HTMLElement;

describe('fits: nothing changes', () => {
  it('renders the screen, no notice, nothing inert', () => {
    render(<Frame />);
    expect(screen.getByRole('button', { name: 'نقدي' })).toBeInTheDocument();
    expect(screen.queryByTestId('fit-block')).toBeNull();
    expect(guardBox()).not.toHaveAttribute('inert');
  });
});

describe('does not fit: the screen is covered, never shown clipped', () => {
  it('keeps the screen mounted but inert under the notice (mid-payment state survives)', () => {
    render(<Frame />);
    const tile = screen.getByRole('button', { name: 'نقدي' });
    remeasure(false);
    expect(screen.getByTestId('fit-block')).toBeInTheDocument();
    expect(guardBox()).toHaveAttribute('inert');
    // The same node: not unmounted and remounted.
    expect(tile.isConnected).toBe(true);
    remeasure(true);
    expect(screen.queryByTestId('fit-block')).toBeNull();
    expect(guardBox()).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'نقدي' })).toBe(tile);
  });

  it.each([
    ['checkout', 'لا تتّسع الشاشة لعرض الدفع كاملًا.'],
    ['sale', 'لا تتّسع الشاشة لعرض البيع كاملًا.'],
  ] as const)('%s: the heading names the screen', (surface, heading) => {
    render(<Frame surface={surface} />);
    remeasure(false);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(heading);
    expect(screen.getByRole('region', { name: heading })).toHaveAttribute('data-surface', surface);
  });

  it('with a banner showing, the action starts with dealing with it', () => {
    render(<Frame banner />);
    giveBannerHeight();
    remeasure(false);
    expect(screen.getByTestId('fit-block').querySelector('p')).toHaveTextContent(
      'تعامل مع أحد التنبيهات أعلاه، أو كبّر النافذة، أو اضبط مقياس العرض في Windows على 100% أو 125%.',
    );
  });

  it('with no banner, it gives the M-F2 height action (no banner to point at)', () => {
    render(<Frame />);
    remeasure(false);
    expect(screen.getByTestId('fit-block').querySelector('p')).toHaveTextContent(
      'كبّر النافذة، أو اضبط مقياس العرض في Windows على 100% أو 125%.',
    );
  });

  it('the percentages are Western digits in LTR isolates', () => {
    render(<Frame />);
    remeasure(false);
    const runs = Array.from(screen.getByTestId('fit-block').querySelectorAll('bdi'));
    expect(runs.map((r) => [r.textContent, r.getAttribute('dir')])).toEqual([
      ['100%', 'ltr'],
      ['125%', 'ltr'],
    ]);
  });

  it('has no axe violations while blocked', async () => {
    render(<Frame banner />);
    remeasure(false);
    await expectNoAxeViolations(document.body);
  });
});

describe('no key reaches the covered screen', () => {
  function keysSeen(): string[] {
    const seen: string[] = [];
    window.addEventListener('keydown', (e) => seen.push(e.key));
    return seen;
  }

  function press(target: EventTarget, key: string): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }

  it('Esc (Checkout: Back) and digits are swallowed on the notice and on <body>', () => {
    render(<Frame banner />);
    const seen = keysSeen();
    remeasure(false);
    press(screen.getByRole('heading', { level: 2 }), 'Escape');
    press(document.body, 'Escape');
    press(document.body, '5');
    expect(seen).toEqual([]);
  });

  it('Tab passes', () => {
    render(<Frame banner />);
    const seen = keysSeen();
    remeasure(false);
    press(document.body, 'Tab');
    expect(seen).toEqual(['Tab']);
  });

  it('a key on a banner reaches the banner, but not the screen behind (Codex P1 on #651)', () => {
    render(<Frame banner />);
    const seen = keysSeen();
    const button = screen.getByRole('button', { name: 'تم' });
    const onButton: string[] = [];
    button.addEventListener('keydown', (e) => onButton.push(e.key));
    remeasure(false);
    press(button, 'Escape');
    press(button, 'Enter');
    expect(onButton).toEqual(['Escape', 'Enter']);
    // Checkout's Esc = Back listens on window: it never hears it.
    expect(seen).toEqual([]);
  });

  it('an open modal dialog keeps its keys (a window-level PIN pad still works)', () => {
    render(<Frame banner />);
    const seen = keysSeen();
    remeasure(false);
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const field = document.createElement('input');
    dialog.append(field);
    document.body.append(dialog);
    press(field, '5');
    expect(seen).toEqual(['5']);
    dialog.remove();
  });

  it('once it fits again, keys flow as before', () => {
    render(<Frame />);
    const seen = keysSeen();
    remeasure(false);
    remeasure(true);
    press(document.body, 'Escape');
    expect(seen).toEqual(['Escape']);
  });
});

describe('no scan reaches the covered screen', () => {
  function burst(code: string): void {
    const guard = getScanGuard();
    let t = 1000;
    const event = (key: string) => ({
      key,
      timeStamp: (t += 5),
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
    });
    for (const ch of code) guard.handleKeyDown(event(ch));
    guard.handleKeyDown(event('Enter'));
  }

  it('a burst is refused with M-S1 while blocked and routed again after', () => {
    const owner = vi.fn();
    getScanGuard().setOwner(owner);
    render(<Frame />);
    remeasure(false);
    burst('6221000000011');
    expect(owner).not.toHaveBeenCalled();
    expect(useScanNoticeStore.getState().message).toBe(SCAN_UNAVAILABLE_MESSAGE);
    remeasure(true);
    burst('6221000000011');
    expect(owner).toHaveBeenCalledWith('6221000000011');
  });
});

describe('focus', () => {
  it('moves from the screen to the notice heading, and back to the same control', () => {
    render(<Frame />);
    const tile = screen.getByRole('button', { name: 'نقدي' });
    act(() => {
      tile.focus();
    });
    remeasure(false);
    expect(screen.getByRole('heading', { level: 2 })).toHaveFocus();
    remeasure(true);
    expect(tile).toHaveFocus();
  });

  it('stays on a banner the cashier is using, and the notice is announced instead (Codex P2 on #651)', () => {
    render(<Frame banner />);
    const live = screen.getByTestId('fit-block-live');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toBeEmptyDOMElement();
    const banner = screen.getByRole('button', { name: 'تم' });
    act(() => {
      banner.focus();
    });
    remeasure(false);
    expect(banner).toHaveFocus();
    expect(live).toHaveTextContent('لا تتّسع الشاشة لعرض الدفع كاملًا.');
    remeasure(true);
    expect(live).toBeEmptyDOMElement();
  });

  it('is not announced twice: when focus moves to the heading, the live region stays empty', () => {
    render(<Frame />);
    act(() => {
      screen.getByRole('button', { name: 'نقدي' }).focus();
    });
    remeasure(false);
    expect(screen.getByRole('heading', { level: 2 })).toHaveFocus();
    expect(screen.getByTestId('fit-block-live')).toBeEmptyDOMElement();
  });

  it('lands on <main>, never <body>, when the last control is gone', () => {
    render(<Frame />);
    remeasure(false);
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    remeasure(true);
    expect(document.querySelector('main')).toHaveFocus();
  });
});
