/**
 * RT-113 P2 (Codex P1 #1 / review F2 / Codex P1 4179617256) — the authority
 * latch at the cart.
 *
 * Once the cashier admission heartbeat learns the session lost its authority
 * (taken over elsewhere, account refused, device revoked), the session is
 * latched until it ends at its next safe point. While latched no NEW sale may
 * start: `cart.create` refuses `authority_conflict`, and so does adding a line
 * to an EMPTY cart (an empty cart is already a safe point; it must not become
 * a new sale under the old cart's id). Adding to the current, non-empty sale
 * stays allowed so it can complete.
 *
 * The safe point is re-checked after EVERY sale call at one choke point
 * (`createSaleBoundaryIpcMain`), so removing the final line ends the session
 * at once, before another item can be scanned.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore, type CartStore } from '../../../../src/main/cart/cart-store.js';
import { registerCartHandlers } from '../../../../src/main/ipc/cart.js';
import { createSaleBoundaryIpcMain } from '../../../../src/main/ipc/sale-boundary-guard.js';
import { CART_IPC_CHANNELS } from '../../../../src/shared/cart/channels.js';
import {
  SessionManager,
  type OperatorSessionRecord,
} from '../../../../src/main/operator/session-manager.js';
import { CashierAdmissionKeeper } from '../../../../src/main/operator/cashier-admission-keeper.js';
import {
  ADMITTED,
  FAKE_ADMISSION_ID,
  FAKE_USER_ID,
  fakeCashierAdmission,
} from '../../../../src/main/operator/__tests__/__helpers__/fake-cashier-admission.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname0, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const resolveItemRef = (): Promise<{
  kind: 'ok';
  display_name: string;
  unit_price_minor: number;
}> => Promise.resolve({ kind: 'ok', display_name: 'Item', unit_price_minor: 1_000 });

function cashierSession(): OperatorSessionRecord {
  return {
    id: 'sess-latch',
    operator_id: 'user_clerk_1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-04T08:00:00.000Z',
    backend_session_id: '',
    last_activity_at: '2026-10-04T08:00:00.000Z',
    lock_state: 'active',
    locked_at: null,
    authority: 'online_confirmed',
  };
}

function freshStore(): { db: SqlJsDatabase; store: CartStore } {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  return { db, store: bindCartStore(makeSqlJsHandle(db)) };
}

function build(session: OperatorSessionRecord): { handlers: CartBridgeHandlers } {
  const { store } = freshStore();
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-1',
    cartStore: store,
    resolveItemRef,
    clock: () => new Date('2026-10-04T10:00:00.000Z'),
  });
  return { handlers };
}

describe('cart under the authority latch (handler level)', () => {
  it('without a latch a new sale starts', async () => {
    const { handlers } = build(cashierSession());
    await expect(handlers.create({ idempotency_key: 'create-latch-0001' })).resolves.toMatchObject({
      kind: 'ok',
    });
  });

  it.each([
    'superseded_by_takeover',
    'account_disabled_mid_session',
    'terminal_session_terminated',
  ] as const)('latched (%s): cart.create refuses authority_conflict', async (cause) => {
    const session = cashierSession();
    session.authority_latch = cause;
    const { handlers } = build(session);
    await expect(handlers.create({ idempotency_key: 'create-latch-0002' })).resolves.toEqual({
      kind: 'refused',
      reason: 'authority_conflict',
    });
  });

  it('latched: adding a line to an EMPTY cart is refused; adding to the current sale is allowed', async () => {
    const session = cashierSession();
    const { handlers } = build(session);
    const empty = await handlers.create({ idempotency_key: 'create-latch-0003' });
    const current = await handlers.create({ idempotency_key: 'create-latch-0004' });
    if (empty.kind !== 'ok' || current.kind !== 'ok') throw new Error('create failed');
    const first = await handlers.linesAdd({
      cart_id: current.cart_id,
      item_ref: 'sku-1',
      quantity: 1,
      idempotency_key: 'add-latch-0001',
    });
    expect(first.kind).toBe('ok');

    session.authority_latch = 'superseded_by_takeover';
    await expect(
      handlers.linesAdd({
        cart_id: empty.cart_id,
        item_ref: 'sku-1',
        quantity: 1,
        idempotency_key: 'add-latch-0002',
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'authority_conflict' });
    await expect(
      handlers.linesAdd({
        cart_id: current.cart_id,
        item_ref: 'sku-2',
        quantity: 1,
        idempotency_key: 'add-latch-0003',
      }),
    ).resolves.toMatchObject({ kind: 'ok' });
  });

  it('latched: removing the final line then adding an item is refused (handler level)', async () => {
    const session = cashierSession();
    const { handlers } = build(session);
    const created = await handlers.create({ idempotency_key: 'create-latch-0006' });
    if (created.kind !== 'ok') throw new Error('create failed');
    const added = await handlers.linesAdd({
      cart_id: created.cart_id,
      item_ref: 'sku-1',
      quantity: 1,
      idempotency_key: 'add-latch-0004',
    });
    if (added.kind !== 'ok') throw new Error('add failed');
    session.authority_latch = 'account_disabled_mid_session';
    await expect(
      handlers.linesRemove({
        cart_id: created.cart_id,
        line_id: added.line_id,
        version: added.version,
        idempotency_key: 'remove-latch-0001',
      }),
    ).resolves.toMatchObject({ kind: 'ok' });
    await expect(
      handlers.linesAdd({
        cart_id: created.cart_id,
        item_ref: 'sku-2',
        quantity: 1,
        idempotency_key: 'add-latch-0005',
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'authority_conflict' });
  });

  it('latched: the current sale may still be voided', async () => {
    const session = cashierSession();
    const { db, store } = freshStore();
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session,
      getTerminalId: () => 'terminal-1',
      cartStore: store,
    });
    const created = await handlers.create({ idempotency_key: 'create-latch-0005' });
    if (created.kind !== 'ok') throw new Error('create failed');
    db.run(`UPDATE carts SET state = 'editing' WHERE cart_id = ?`, [created.cart_id]);
    session.authority_latch = 'superseded_by_takeover';
    await expect(
      handlers.void({ cart_id: created.cart_id, idempotency_key: 'void-latch-0001' }),
    ).resolves.toEqual({ kind: 'ok' });
  });
});

describe('Codex P1 4179617256 — removing the final line ends a latched session at once', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('latched cashier removes the final line, then adds an item: the add is refused and the session ended', async () => {
    const TTL_S = 600;
    const sessions = new SessionManager();
    const { store } = freshStore();
    const fake = fakeCashierAdmission({ ...ADMITTED, admission_ttl_seconds: TTL_S });
    const ends: (string | undefined)[] = [];
    sessions.onEnded((_r, cause) => ends.push(cause));

    // Safe point = the session's open cart has no active line (no tender here).
    const isAtSafePoint = (): boolean => {
      const s = sessions.getCurrent();
      const cart = s === null ? undefined : store.findDraftCartBySession(s.id);
      return cart === undefined || store.getActiveLines(cart.cart_id).length === 0;
    };
    const keeper = new CashierAdmissionKeeper({
      sessionManager: sessions,
      admission: fake.deps,
      isAtSafePoint,
    });

    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: (c: string, f: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
        handlers.set(c, f);
      },
    } as unknown as IpcMain;
    registerCartHandlers(
      createSaleBoundaryIpcMain(ipcMain, () => {
        keeper.recheckSafePoint();
      }),
      {
        handlers: new CartBridgeHandlers({
          getCurrentSession: () => sessions.getCurrent(),
          getTerminalId: () => 'terminal-1',
          cartStore: store,
          resolveItemRef,
        }),
      },
    );
    const invoke = async (c: string, req: unknown): Promise<unknown> =>
      await handlers.get(c)?.({} as IpcMainInvokeEvent, req);

    sessions.create({
      operator_id: 'user_clerk_1',
      display_name: 'Cashier',
      role: 'cashier',
      tenant_id: 'tenant-1',
      branch_id: 'branch-1',
      backend_session_id: '',
      cashier_admission: {
        user_id: FAKE_USER_ID,
        admission_id: FAKE_ADMISSION_ID,
        admission_ttl_seconds: TTL_S,
        offline_grace_seconds: 86_400,
      },
    });
    const created = (await invoke(CART_IPC_CHANNELS.CREATE, {
      idempotency_key: 'create-ipc-latch-0001',
    })) as { cart_id: string };
    const added = (await invoke(CART_IPC_CHANNELS.LINES_ADD, {
      cart_id: created.cart_id,
      item_ref: 'sku-1',
      quantity: 1,
      idempotency_key: 'add-ipc-latch-0001',
    })) as { line_id: string; version: number };

    // The heartbeat learns of a takeover mid-sale: latched, not ended.
    fake.setAdmit({ kind: 'active_elsewhere' });
    await vi.advanceTimersByTimeAsync((TTL_S * 1000) / 2);
    expect(sessions.getCurrent()?.authority_latch).toBe('superseded_by_takeover');
    expect(ends).toEqual([]);

    // Removing the final line reaches the safe point: the session ends at
    // once, inside the 5 s backstop window.
    await invoke(CART_IPC_CHANNELS.LINES_REMOVE, {
      cart_id: created.cart_id,
      line_id: added.line_id,
      version: added.version,
      idempotency_key: 'remove-ipc-latch-0001',
    });
    expect(ends).toEqual(['superseded_by_takeover']);

    // The next scan is refused: no session can start a new sale.
    const again = await invoke(CART_IPC_CHANNELS.LINES_ADD, {
      cart_id: created.cart_id,
      item_ref: 'sku-2',
      quantity: 1,
      idempotency_key: 'add-ipc-latch-0002',
    });
    expect(again).toMatchObject({ kind: 'refused' });
    keeper.stop();
  });
});
