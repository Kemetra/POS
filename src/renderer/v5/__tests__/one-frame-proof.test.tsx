/**
 * RT-498 (VN-S10 S10-1) — the DEV-only one-frame harness: its query
 * parameters, its in-memory bridges, and that it renders the real AppRouter
 * inside the one v5 frame. Same contract as the cashiers and recovery proof
 * tests, so the harness meets the per-file coverage floor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { useFeatureFlagsStore } from '../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import {
  OneFrameProof,
  installWindowApi,
  operatorBridge,
  pairingBridge,
  readOneFrameProofParams,
  type OneFrameProofParams,
} from '../frame/dev/OneFrameProof';
import { installViewport } from './__helpers__/viewport-bands';

const DEFAULTS: OneFrameProofParams = {
  path: '/app/dashboard',
  role: 'manager',
  banner: 'none',
  shifts: 'some',
  returns: 'off',
  sale: 'missing',
  reprint: 'ok',
  preview: 'ok',
  shift: 'off',
  list: 'ok',
  close: 'refused',
  payments: 'on',
  search: 'none',
  closed: 'none',
};

type AnyFn = (...args: unknown[]) => unknown;

function windowApi(): Record<string, Record<string, AnyFn>> {
  return (window as unknown as { api: Record<string, Record<string, AnyFn>> }).api;
}

beforeEach(() => {
  installViewport(1280);
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
  window.location.hash = '';
  vi.unstubAllGlobals();
});

describe('OneFrameProof — parameters', () => {
  it('defaults to a manager on the dashboard with no banner and the stuck shifts listed', () => {
    window.location.hash = '#/dev/one-frame-proof';
    expect(readOneFrameProofParams()).toEqual(DEFAULTS);
  });

  it('reads path, role, banner and shifts', () => {
    window.location.hash =
      '#/dev/one-frame-proof?path=%2Fapp%2Fmanager%2Fstuck-shifts&role=cashier&banner=printer&shifts=none';
    // Only the params this URL sets: later slices add params of their own.
    expect(readOneFrameProofParams()).toMatchObject({
      path: '/app/manager/stuck-shifts',
      role: 'cashier',
      banner: 'printer',
      shifts: 'none',
    });
  });

  it('RT-501: reads returns=on, and defaults it to off', () => {
    window.location.hash = '#/dev/one-frame-proof?returns=on';
    expect(readOneFrameProofParams().returns).toBe('on');
    window.location.hash = '#/dev/one-frame-proof?returns=nope';
    expect(readOneFrameProofParams().returns).toBe('off');
  });

  it('RT-500: reads sale and reprint, and ignores unknown values', () => {
    window.location.hash = '#/dev/one-frame-proof?path=/app/sales&sale=noprint&reprint=fail';
    expect(readOneFrameProofParams()).toMatchObject({
      path: '/app/sales',
      sale: 'noprint',
      reprint: 'fail',
    });
    window.location.hash = '#/dev/one-frame-proof?sale=nope&reprint=nope';
    expect(readOneFrameProofParams()).toMatchObject({ sale: 'missing', reprint: 'ok' });
  });

  it('RT-499: reads shift=on, and defaults it to off', () => {
    window.location.hash = '#/dev/one-frame-proof?shift=on';
    expect(readOneFrameProofParams().shift).toBe('on');
    window.location.hash = '#/dev/one-frame-proof?shift=nope';
    expect(readOneFrameProofParams().shift).toBe('off');
  });

  it('RT-499: shift=on hydrates the shift-cashup flag when the harness renders', async () => {
    window.location.hash = '#/dev/one-frame-proof?shift=on';
    render(<OneFrameProof />);
    await screen.findByTestId('v5-frame');
    expect(useFeatureFlagsStore.getState().shiftCashup).toBe(true);
  });

  it('RT-605: reads closed=shift, and defaults it to none', () => {
    window.location.hash = '#/dev/one-frame-proof?closed=shift';
    expect(readOneFrameProofParams().closed).toBe('shift');
    window.location.hash = '#/dev/one-frame-proof?closed=bogus';
    expect(readOneFrameProofParams().closed).toBe('none');
  });

  it('RT-605: closed=shift signs in with a forced-close notice, which dismiss clears', async () => {
    render(<OneFrameProof params={{ ...DEFAULTS, closed: 'shift' }} />);
    const banner = await screen.findByTestId('shift-closed-banner');
    await userEvent.click(within(banner).getByRole('button', { name: 'إخفاء' }));
    await waitFor(() => {
      expect(screen.queryByTestId('shift-closed-banner')).toBeNull();
    });
  });

  it('RT-502: reads list and close, and ignores unknown values', () => {
    window.location.hash = '#/dev/one-frame-proof?list=unreachable&close=state_invalid';
    expect(readOneFrameProofParams()).toMatchObject({
      list: 'unreachable',
      close: 'state_invalid',
    });
    window.location.hash = '#/dev/one-frame-proof?list=nope&close=nope';
    expect(readOneFrameProofParams()).toMatchObject({ list: 'ok', close: 'refused' });
  });

  it('RT-503: reads payments and search, and ignores unknown values', () => {
    window.location.hash = '#/dev/one-frame-proof?payments=off&search=results';
    expect(readOneFrameProofParams()).toMatchObject({ payments: 'off', search: 'results' });
    window.location.hash = '#/dev/one-frame-proof?payments=nope&search=nope';
    expect(readOneFrameProofParams()).toMatchObject({ payments: 'on', search: 'none' });
  });

  it('RT-503: payments=off hydrates the payments flag off when the harness renders', async () => {
    window.location.hash = '#/dev/one-frame-proof?payments=off';
    render(<OneFrameProof />);
    await screen.findByTestId('v5-frame');
    expect(useFeatureFlagsStore.getState().payments).toBe(false);
  });

  it('RT-503: search=results answers twelve items, search=none answers not found', async () => {
    installWindowApi({ ...DEFAULTS, search: 'results' });
    const results = (await windowApi().catalogue?.search?.()) as { kind: string; items: unknown[] };
    expect(results.kind).toBe('results');
    expect(results.items).toHaveLength(12);
    installWindowApi(DEFAULTS);
    expect(await windowApi().catalogue?.search?.()).toEqual({ kind: 'not_found' });
  });

  it('ignores unknown values and any path outside /app', () => {
    window.location.hash = '#/dev/one-frame-proof?path=%2Fpairing&role=root&banner=x&shifts=x';
    expect(readOneFrameProofParams()).toEqual(DEFAULTS);
  });
});

describe('OneFrameProof — the in-memory returns bridge (RT-501)', () => {
  it('returns=off installs no returns namespace', () => {
    installWindowApi(DEFAULTS);
    expect(windowApi().returns).toBeUndefined();
  });

  it('returns=on installs a returns namespace whose every call answers', async () => {
    installWindowApi({ ...DEFAULTS, returns: 'on' });
    const returns = windowApi().returns ?? {};
    for (const [name, fn] of Object.entries(returns)) {
      await expect(Promise.resolve(fn()), `returns.${name}`).resolves.toBeDefined();
    }
    expect(await returns.list?.()).toEqual({ kind: 'ok', returns: [] });
    expect(await returns.lookup?.()).toEqual({ kind: 'refused', reason: 'sale_not_found' });
  });

  it('returns=on hydrates the returns flag when the harness renders', async () => {
    window.location.hash = '#/dev/one-frame-proof?path=%2Fapp%2Freturns&returns=on';
    render(<OneFrameProof />);
    await screen.findByTestId('v5-frame');
    expect(useFeatureFlagsStore.getState().returns).toBe(true);
  });
});

describe('OneFrameProof — the in-memory bridges', () => {
  it('the operator bridge lists three stuck shifts, none, or cannot be reached', async () => {
    const some = await operatorBridge(DEFAULTS).listStuckShifts();
    expect(some.kind === 'stuck_shifts' && some.shifts.map((s) => s.shift_id)).toEqual([
      'shift-1',
      'shift-2',
      'shift-3',
    ]);
    const none = await operatorBridge({ ...DEFAULTS, shifts: 'none' }).listStuckShifts();
    expect(none).toEqual({ kind: 'stuck_shifts', shifts: [] });
    const unreachable = await operatorBridge({
      ...DEFAULTS,
      list: 'unreachable',
    }).listStuckShifts();
    expect(unreachable).toEqual({ kind: 'refused', category: 'no_connection' });
  });

  it.each([
    ['refused', { kind: 'refused', category: 'invalid_input' }],
    ['state_invalid', { kind: 'refused', category: 'state_invalid' }],
    ['ok', { kind: 'forced_closed', audit_event_id: 'proof-event' }],
  ] as const)('RT-502: close=%s drives what forceCloseShift answers', async (close, answer) => {
    const bridge = operatorBridge({ ...DEFAULTS, close }) as unknown as Record<string, AnyFn>;
    expect(await (bridge.forceCloseShift as AnyFn)()).toEqual(answer);
  });

  it('every other operator call answers without throwing', async () => {
    const bridge = operatorBridge(DEFAULTS) as unknown as Record<string, AnyFn>;
    for (const [name, fn] of Object.entries(bridge)) {
      await expect(Promise.resolve(fn()), name).resolves.not.toThrow();
    }
    expect(await (bridge.signOut as AnyFn)()).toEqual({ kind: 'signed_out' });
    expect(await (bridge.getCurrentSession as AnyFn)()).toBeNull();
    expect(await (bridge.forceCloseShift as AnyFn)()).toEqual({
      kind: 'refused',
      category: 'invalid_input',
    });
  });

  it('the pairing bridge reports a paired terminal and refuses a submit', async () => {
    expect(await pairingBridge.getStatus()).toMatchObject({
      kind: 'paired',
      terminal_label: 'POS-03',
    });
    await expect(pairingBridge.submit({} as never)).rejects.toThrow();
  });

  it.each([
    ['none', null],
    ['printer', 'printer_offline'],
  ] as const)('banner=%s drives the banner state the notices poll', async (banner, reason) => {
    installWindowApi({ ...DEFAULTS, banner });
    const answer = (await windowApi().sales?.subscribe?.()) as {
      banner_state: { printer_failure: { failure_reason: string } | null };
    };
    expect(answer.banner_state.printer_failure?.failure_reason ?? null).toBe(reason);
  });

  it('the catalogue, sales and pairing fakes all answer', async () => {
    installWindowApi(DEFAULTS);
    const api = windowApi();
    for (const ns of ['pairing', 'catalogue', 'sales'] as const) {
      for (const [name, fn] of Object.entries(api[ns] ?? {})) {
        if (ns === 'pairing' && name === 'submit') continue;
        await expect(Promise.resolve(fn()), `${ns}.${name}`).resolves.toBeDefined();
      }
    }
    expect(await api.catalogue?.counts?.()).toEqual({
      kind: 'ok',
      products: 12_480,
      barcodes: 15_902,
    });
  });
});

describe('OneFrameProof — renders the real router in the one frame', () => {
  it('a manager on the dashboard: the v5 frame, signed in, dashboard current', async () => {
    window.location.hash = '#/dev/one-frame-proof';
    render(<OneFrameProof />);
    const frame = await screen.findByTestId('v5-frame');
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(useOperatorSessionStore.getState().state.kind).toBe('signedIn');
    const nav = within(frame).getByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(within(nav).getByRole('link', { name: 'لوحة المتابعة' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('a cashier sees only the Sale in the nav', async () => {
    window.location.hash = '#/dev/one-frame-proof?role=cashier';
    render(<OneFrameProof />);
    const frame = await screen.findByTestId('v5-frame');
    const nav = within(frame).getByRole('navigation', { name: 'التنقل الرئيسي' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['نقطة البيع']);
  });
});

describe('OneFrameProof — the Sales fakes (RT-500)', () => {
  async function lookup(query: string): Promise<HTMLElement> {
    window.location.hash = `#/dev/one-frame-proof?path=/app/sales&${query}`;
    render(<OneFrameProof />);
    const main = within(await screen.findByTestId('v5-frame')).getByRole('main');
    await userEvent.type(
      await within(main).findByRole('textbox', { name: 'رقم البيع' }),
      'TERM-01-2026-10-15-000042{Enter}',
    );
    return main;
  }

  it('sale=missing answers «لم يُعثر على بيع بهذا الرقم.»', async () => {
    const main = await lookup('sale=missing');
    expect(await within(main).findByText('لم يُعثر على بيع بهذا الرقم.')).toBeInTheDocument();
  });

  it('sale=found shows the sale, and reprint=ok shows the sent notice', async () => {
    const main = await lookup('sale=found&reprint=ok');
    expect(await within(main).findByText('منى عبد الرحمن')).toBeInTheDocument();
    await userEvent.click(within(main).getByRole('button', { name: 'إعادة طباعة الإيصال' }));
    expect(await within(main).findByText('أُرسل الإيصال للطابعة.')).toBeInTheDocument();
  });

  it('reprint=fail shows the warning', async () => {
    const main = await lookup('sale=found&reprint=fail');
    await userEvent.click(await within(main).findByRole('button', { name: 'إعادة طباعة الإيصال' }));
    await waitFor(() => {
      expect(
        within(main).getByText('تعذّرت إعادة طباعة الإيصال. حاول مرة أخرى.'),
      ).toBeInTheDocument();
    });
  });

  // RT-659: the preview dialog's three states for the captures.
  async function openPreview(query: string): Promise<HTMLElement> {
    const main = await lookup(`sale=found&${query}`);
    await userEvent.click(await within(main).findByRole('button', { name: 'معاينة الإيصال' }));
    return screen.findByRole('dialog', { name: 'معاينة الإيصال' });
  }

  it('preview=ok shows the engine-shaped slip in the dialog', async () => {
    const dialog = await openPreview('preview=ok');
    expect(await within(dialog).findByRole('region', { name: 'الإيصال' })).toHaveTextContent(
      'Sale # TERM-01-2026-10-15-000042',
    );
  });

  it('preview=pending keeps the dialog loading', async () => {
    const dialog = await openPreview('preview=pending');
    expect(within(dialog).getByRole('status')).toHaveTextContent('جارٍ التحضير');
  });

  it.each(['preview=fail', 'reprint=fail'])('%s refuses the preview', async (query) => {
    const dialog = await openPreview(query);
    expect(await within(dialog).findByText('تعذّرت معاينة الإيصال')).toBeInTheDocument();
  });

  it('sale=noprint offers the preview but no reprint (AD-10)', async () => {
    const main = await lookup('sale=noprint');
    expect(await within(main).findByRole('button', { name: 'معاينة الإيصال' })).toBeInTheDocument();
    expect(
      within(main).queryByRole('button', { name: 'إعادة طباعة الإيصال' }),
    ).not.toBeInTheDocument();
  });
});
