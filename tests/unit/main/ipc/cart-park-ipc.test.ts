/**
 * RT-440 (PK-2, spec 024 §3, §A4) — the `cart:park` / `listParked` /
 * `previewResume` / `resume` wire-up: each request is rebuilt from its
 * contract fields only, every id is bounded, and a malformed request refuses
 * generically without reaching main's handlers.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  asParkReq,
  asPreviewReq,
  asResumeReq,
  registerCartParkHandlers,
} from '../../../../src/main/ipc/cart-park.js';
import { CART_PARK_IPC_CHANNELS } from '../../../../src/shared/cart/channels.js';
import { isSaleChannel } from '../../../../src/main/ipc/sale-boundary-guard.js';
import { LOCKED_ALLOWED_CHANNELS } from '../../../../src/main/ipc/session-lock-guard.js';
import { isRefusedInRecoveryMode } from '../../../../src/main/ipc/recovery-mode-guard.js';
import type { ParkResume } from '../../../../src/main/cart/park/park-resume.js';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const TOKEN = 'a'.repeat(32);
const NO = { kind: 'refused', reason: 'no_session' };

function wired() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: (c: string, fn: Handler) => handlers.set(c, fn),
  } as unknown as IpcMain;
  const parkResume = {
    park: vi.fn(() => ({ kind: 'parked' })),
    listParked: vi.fn(() => ({ kind: 'parked_sales', items: [] })),
    previewResume: vi.fn(() => ({ kind: 'refused', reason: 'not_parked' })),
    resume: vi.fn(() => ({ kind: 'resumed', cart_id: 'c1' })),
  };
  registerCartParkHandlers(ipcMain, { parkResume: parkResume as unknown as ParkResume });
  const call = (channel: string, req?: unknown): unknown =>
    handlers.get(channel)?.({} as IpcMainInvokeEvent, req);
  return { handlers, parkResume, call };
}

describe('registerCartParkHandlers', () => {
  it('registers the four channels, all behind the lock, recovery and sale-boundary guards', () => {
    const { handlers } = wired();
    const channels = Object.values(CART_PARK_IPC_CHANNELS);
    expect([...handlers.keys()].sort()).toEqual([...channels].sort());
    for (const channel of channels) {
      expect(isSaleChannel(channel)).toBe(true);
      expect(isRefusedInRecoveryMode(channel)).toBe(true);
      expect(LOCKED_ALLOWED_CHANNELS.has(channel)).toBe(false);
    }
  });

  it('forwards fresh, contract-only requests', () => {
    const { parkResume, call } = wired();
    call(CART_PARK_IPC_CHANNELS.PARK, {
      cart_id: 'c1',
      idempotency_key: 'k',
      label: 'bag',
      owner: 'x',
    });
    call(CART_PARK_IPC_CHANNELS.LIST_PARKED, { operator_id: 'someone' });
    call(CART_PARK_IPC_CHANNELS.PREVIEW_RESUME, { cart_id: 'c1', tenant_id: 'x' });
    call(CART_PARK_IPC_CHANNELS.RESUME, {
      cart_id: 'c1',
      accept_changes: true,
      diff_token: TOKEN,
      current_cart: 'park',
      idempotency_key: 'k2',
      price: 1,
    });
    expect(parkResume.park).toHaveBeenCalledWith({
      cart_id: 'c1',
      idempotency_key: 'k',
      label: 'bag',
    });
    expect(parkResume.listParked).toHaveBeenCalledWith();
    expect(parkResume.previewResume).toHaveBeenCalledWith({ cart_id: 'c1' });
    expect(parkResume.resume).toHaveBeenCalledWith({
      cart_id: 'c1',
      accept_changes: true,
      diff_token: TOKEN,
      current_cart: 'park',
      idempotency_key: 'k2',
    });
  });

  it('refuses malformed requests generically without calling main', () => {
    const { parkResume, call } = wired();
    expect(call(CART_PARK_IPC_CHANNELS.PARK, null)).toEqual(NO);
    expect(call(CART_PARK_IPC_CHANNELS.PREVIEW_RESUME, { cart_id: '../x' })).toEqual(NO);
    expect(call(CART_PARK_IPC_CHANNELS.RESUME, { cart_id: 'c1' })).toEqual(NO);
    expect(parkResume.park).not.toHaveBeenCalled();
    expect(parkResume.previewResume).not.toHaveBeenCalled();
    expect(parkResume.resume).not.toHaveBeenCalled();
  });
});

describe('request validators', () => {
  it('asParkReq: bounded ids, an optional string label with a raw cap', () => {
    expect(asParkReq({ cart_id: 'c', idempotency_key: 'k' })).toEqual({
      cart_id: 'c',
      idempotency_key: 'k',
    });
    expect(asParkReq({ cart_id: 'c', idempotency_key: 'k', label: 7 })).toBeNull();
    expect(asParkReq({ cart_id: 'c', idempotency_key: 'k', label: 'x'.repeat(161) })).toBeNull();
    expect(asParkReq({ cart_id: 'c'.repeat(129), idempotency_key: 'k' })).toBeNull();
    expect(asParkReq('c')).toBeNull();
  });

  it('asPreviewReq: a bounded cart id only', () => {
    expect(asPreviewReq({ cart_id: 'c' })).toEqual({ cart_id: 'c' });
    expect(asPreviewReq({})).toBeNull();
    expect(asPreviewReq(undefined)).toBeNull();
  });

  it('asResumeReq: a hex token, a boolean acceptance and a closed current_cart', () => {
    const ok = {
      cart_id: 'c',
      accept_changes: false,
      diff_token: TOKEN,
      current_cart: 'keep',
      idempotency_key: 'k',
    };
    expect(asResumeReq(ok)).toEqual(ok);
    expect(asResumeReq({ ...ok, diff_token: 'NOT-HEX' })).toBeNull();
    expect(asResumeReq({ ...ok, diff_token: 7 })).toBeNull();
    expect(asResumeReq({ ...ok, accept_changes: 'yes' })).toBeNull();
    expect(asResumeReq({ ...ok, current_cart: 'merge' })).toBeNull();
    expect(asResumeReq({ ...ok, idempotency_key: '' })).toBeNull();
    expect(asResumeReq(null)).toBeNull();
  });
});
