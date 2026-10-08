/**
 * RT-184 — `cart.void` never records a renderer-supplied
 * `attribution_operator_id` in its outbox row.
 *
 * `cart.void` is the pre-handoff void: any role may void a cart it can
 * mutate, no approval is involved, and a `frozen_handed_off` cart is refused
 * `frozen` (the audited post-handoff path is `cart.cancelPostHandoff`, which
 * already drops renderer attribution). So the request carries only
 * `{ cart_id, idempotency_key }`; main records the session operator as the
 * acting operator and no attribution. A scripted renderer can still put the
 * key on the wire (the preload forwards the object as-is), so these tests
 * smuggle it in and assert it is dropped at the IPC parser and never reaches
 * the `cart.void` outbox row.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { CartBridgeHandlers } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import { registerCartHandlers } from '../../../../src/main/ipc/cart.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import type { CartVoidRequest } from '../../../../src/shared/cart/bridge-types.js';
import { CART_IPC_CHANNELS } from '../../../../src/shared/cart/channels.js';
import type { Role } from '../../../../src/shared/operator/role.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

const __dirname0 = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname0, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

/** An operator id the renderer tries to have recorded on the void. */
const SMUGGLED_OPERATOR = 'mgr-chosen-by-renderer';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function makeSession(role: Role, operator_id: string): OperatorSessionRecord {
  return {
    id: `sess-${operator_id}`,
    operator_id,
    display_name: operator_id,
    role,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-10-04T08:00:00.000Z',
    backend_session_id: `b-${operator_id}`,
    last_activity_at: '2026-10-04T08:00:00.000Z',
  };
}

interface Fixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
}

async function newEditingCart(session: OperatorSessionRecord): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-rt-184',
    cartStore: bindCartStore(makeSqlJsHandle(db)),
    clock: () => new Date('2026-10-04T10:00:00.000Z'),
  });
  const created = await handlers.create({ idempotency_key: 'create-rt-184' });
  if (created.kind !== 'ok') throw new Error('create failed');
  db.run(`UPDATE carts SET state = 'editing' WHERE cart_id = ?`, [created.cart_id]);
  return { db, handlers, cart_id: created.cart_id };
}

function voidOutboxRows(f: Fixture): Record<string, unknown>[] {
  const stmt = f.db.prepare(
    "SELECT * FROM cart_action_outbox WHERE cart_id = ? AND action_kind = 'cart.void'",
  );
  stmt.bind([f.cart_id]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

describe.each(['cashier', 'manager', 'admin'] as const)(
  'RT-184 — %s session: a smuggled attribution never reaches the void outbox row',
  (role) => {
    it('voids the cart and records only the session operator', async () => {
      const f = await newEditingCart(makeSession(role, `${role}-1`));
      const res = await f.handlers.void({
        cart_id: f.cart_id,
        idempotency_key: 'void-rt-184',
        attribution_operator_id: SMUGGLED_OPERATOR,
      } as CartVoidRequest);

      expect(res).toEqual({ kind: 'ok' });
      const rows = voidOutboxRows(f);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['acting_operator_id']).toBe(`${role}-1`);
      expect(rows[0]?.['attribution_operator_id']).toBeNull();
      expect(JSON.stringify(rows)).not.toContain(SMUGGLED_OPERATOR);
    });
  },
);

describe('RT-184 — IPC parser drops attribution_operator_id on cart.void', () => {
  it('forwards a fresh request with only the contract fields', async () => {
    const registered = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
        registered.set(channel, fn);
      },
    } as unknown as IpcMain;
    const bridge = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => null,
    });
    const spy = vi.spyOn(bridge, 'void');
    registerCartHandlers(ipcMain, { handlers: bridge });

    const handler = registered.get(CART_IPC_CHANNELS.VOID);
    if (handler === undefined) throw new Error('missing VOID');
    await handler({} as IpcMainInvokeEvent, {
      cart_id: 'c',
      attribution_operator_id: SMUGGLED_OPERATOR,
      idempotency_key: 'k',
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toEqual({ cart_id: 'c', idempotency_key: 'k' });
  });
});
