/**
 * RT-498 (VN-S10 S10-1) — the DEV-only one-frame harness: its query
 * parameters, its in-memory bridges, and that it renders the real AppRouter
 * inside the one v5 frame. Same contract as the cashiers and recovery proof
 * tests, so the harness meets the per-file coverage floor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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
  it('defaults to a manager on the dashboard with no banner and two stuck shifts', () => {
    window.location.hash = '#/dev/one-frame-proof';
    expect(readOneFrameProofParams()).toEqual(DEFAULTS);
  });

  it('reads path, role, banner and shifts', () => {
    window.location.hash =
      '#/dev/one-frame-proof?path=%2Fapp%2Fmanager%2Fstuck-shifts&role=cashier&banner=printer&shifts=none';
    expect(readOneFrameProofParams()).toEqual({
      path: '/app/manager/stuck-shifts',
      role: 'cashier',
      banner: 'printer',
      shifts: 'none',
    });
  });

  it('ignores unknown values and any path outside /app', () => {
    window.location.hash = '#/dev/one-frame-proof?path=%2Fpairing&role=root&banner=x&shifts=x';
    expect(readOneFrameProofParams()).toEqual(DEFAULTS);
  });
});

describe('OneFrameProof — the in-memory bridges', () => {
  it('the operator bridge lists two stuck shifts, or none', async () => {
    const some = await operatorBridge(DEFAULTS).listStuckShifts();
    expect(some.kind === 'stuck_shifts' && some.shifts.map((s) => s.shift_id)).toEqual([
      'shift-1',
      'shift-2',
    ]);
    const none = await operatorBridge({ ...DEFAULTS, shifts: 'none' }).listStuckShifts();
    expect(none).toEqual({ kind: 'stuck_shifts', shifts: [] });
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
