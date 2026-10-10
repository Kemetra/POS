import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { registerCartHandlers } from '../../../../src/main/ipc/cart.js';
import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import {
  createSessionLockGuardedIpcMain,
  SessionLockedError,
} from '../../../../src/main/ipc/session-lock-guard.js';
import { CART_IPC_CHANNELS } from '../../../../src/shared/cart/channels.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';

/**
 * RT-254 — `cart:undoLast` IPC boundary. Malformed or oversized identifiers
 * refuse generically and never reach the handler; a valid payload forwards
 * ONLY cart_id + target_action_id + idempotency_key — never an inverse kind,
 * line id, quantity or scope chosen by the renderer. While the session is
 * locked the channel is refused (not allowlisted); after unlock a retained
 * target succeeds only if it is still the cart's last action.
 */

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function fakeIpcMain(): { ipcMain: IpcMain; channels: Map<string, Handler> } {
  const channels = new Map<string, Handler>();
  const ipcMain = {
    handle: (name: string, fn: Handler) => {
      channels.set(name, fn);
    },
    on: () => ipcMain,
  } as unknown as IpcMain;
  return { ipcMain, channels };
}

function invoker(channels: Map<string, Handler>, channel: string) {
  const handler = channels.get(channel);
  if (handler === undefined) throw new Error(`${channel} not registered`);
  return (payload: unknown): Promise<unknown> =>
    Promise.resolve(handler({} as IpcMainInvokeEvent, payload));
}

const VALID = { cart_id: 'cart-1', target_action_id: 'add-1', idempotency_key: 'undo-1' };

describe('cart:undoLast IPC shape', () => {
  function wire() {
    const { ipcMain, channels } = fakeIpcMain();
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const undoLast = vi
      .spyOn(bridge, 'undoLast')
      .mockResolvedValue({ kind: 'ok', effect: 'removed', line_id: 'l', version: 2 });
    registerCartHandlers(ipcMain, { handlers: bridge });
    return { invoke: invoker(channels, CART_IPC_CHANNELS.UNDO_LAST), undoLast };
  }

  it('uses its own channel name', () => {
    expect(CART_IPC_CHANNELS.UNDO_LAST).toBe('cart:undoLast');
  });

  it.each([
    [null],
    [undefined],
    ['cart-1'],
    [{}],
    [{ ...VALID, cart_id: 42 }],
    [{ ...VALID, cart_id: '' }],
    [{ ...VALID, cart_id: 'x'.repeat(129) }],
    [{ ...VALID, target_action_id: '../etc' }],
    [{ ...VALID, target_action_id: undefined }],
    [{ ...VALID, idempotency_key: '<b>' }],
    [{ cart_id: 'cart-1', target_action_id: 'add-1' }],
  ])('refuses malformed payload %j generically without calling the handler', async (payload) => {
    const w = wire();
    expect(await w.invoke(payload)).toEqual({ kind: 'refused', reason: 'no_session' });
    expect(w.undoLast).not.toHaveBeenCalled();
  });

  it('forwards only the three request fields (renderer cannot choose the inverse)', async () => {
    const w = wire();
    await w.invoke({
      ...VALID,
      effect: 'restored',
      line_id: 'other-line',
      quantity: 99,
      tenant_id: 'evil-tenant',
    });
    expect(w.undoLast).toHaveBeenCalledOnce();
    expect(w.undoLast).toHaveBeenCalledWith(VALID);
  });
});

describe('cart:undoLast while the session is locked', () => {
  const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
  const MIGRATIONS = [
    '0008_carts.sql',
    '0009_cart_action_outbox.sql',
    '0010_cart_lines.sql',
    '0011_cart_line_discount_placeholders.sql',
    '0037_cart_action_outbox_return_to_sale.sql',
    '0045_cart_action_outbox_line_restore.sql',
  ].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

  let SQL: SqlJsStatic;
  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  const SESSION: OperatorSessionRecord = {
    id: 'sess-lock',
    operator_id: 'cashier-1',
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-10T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-10-10T08:00:00.000Z',
  };

  async function lockableCart() {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => SESSION,
      getTerminalId: () => 'terminal-1',
      cartStore: bindCartStore(makeSqlJsHandle(db)),
      resolveItemRef: () =>
        Promise.resolve({ kind: 'ok', display_name: 'A', unit_price_minor: 100 }),
      clock: () => new Date('2026-10-10T10:00:00.000Z'),
    });
    const c = await bridge.create({ idempotency_key: 'c-1' });
    if (c.kind !== 'ok') throw new Error('create');
    let locked = false;
    const { ipcMain, channels } = fakeIpcMain();
    registerCartHandlers(
      createSessionLockGuardedIpcMain(ipcMain, () => locked),
      {
        handlers: bridge,
      },
    );
    const outboxCount = (): unknown =>
      db.exec(`SELECT COUNT(*) FROM cart_action_outbox`)[0]?.values[0]?.[0];
    return {
      cart_id: c.cart_id,
      add: invoker(channels, CART_IPC_CHANNELS.LINES_ADD),
      undo: invoker(channels, CART_IPC_CHANNELS.UNDO_LAST),
      setLocked: (v: boolean) => {
        locked = v;
      },
      outboxCount,
    };
  }

  it('is refused while locked (no mutation), then the retained target succeeds after unlock', async () => {
    const t = await lockableCart();
    await t.add({ cart_id: t.cart_id, item_ref: 'SKU-A', quantity: 1, idempotency_key: 'a-1' });
    const req = { cart_id: t.cart_id, target_action_id: 'a-1', idempotency_key: 'u-1' };

    t.setLocked(true);
    const before = t.outboxCount();
    await expect(t.undo(req)).rejects.toBeInstanceOf(SessionLockedError);
    expect(t.outboxCount()).toBe(before);

    t.setLocked(false);
    expect(await t.undo(req)).toMatchObject({ kind: 'ok', effect: 'removed' });
  });

  it('after unlock a retained target that is no longer current is refused', async () => {
    const t = await lockableCart();
    await t.add({ cart_id: t.cart_id, item_ref: 'SKU-A', quantity: 1, idempotency_key: 'a-1' });
    await t.add({ cart_id: t.cart_id, item_ref: 'SKU-B', quantity: 1, idempotency_key: 'b-1' });
    t.setLocked(true);
    t.setLocked(false);
    expect(
      await t.undo({ cart_id: t.cart_id, target_action_id: 'a-1', idempotency_key: 'u-1' }),
    ).toEqual({ kind: 'refused', reason: 'undo_not_available' });
  });
});
