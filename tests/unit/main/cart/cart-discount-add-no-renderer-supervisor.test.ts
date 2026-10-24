/**
 * RT-183 — `cart.discountPlaceholders.add` never records a renderer-supplied
 * approving supervisor.
 *
 * The add request no longer carries `attribution_operator_id` (spec 005
 * `contracts/bridge-api.md`, RT-28 revision). The approver is derived in main
 * from the authenticated operator session only:
 *   - manager / admin session → approves its own discount (RT-28 D2);
 *   - cashier session → ANY add (RT-608: no threshold) needs a consumed
 *     `cart.discount.manual` approval (`approval_id`); without one it is
 *     refused `manager_attribution_required`, whatever id the renderer sends.
 *
 * A scripted renderer can still put the key on the wire (the preload forwards
 * the object as-is), so these tests smuggle it in and assert it is ignored at
 * the IPC parser and never reaches the placeholder row, the outbox row or the
 * audit event.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import { registerCartHandlers } from '../../../../src/main/ipc/cart.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import type { AuditEmitter } from '../../../../src/main/audit/audit-emitter.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';
import type { CartDiscountPlaceholdersAddRequest } from '../../../../src/shared/cart/bridge-types.js';
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
  '0050_carts_park.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

/** An id the renderer tries to name as the approving supervisor. */
const SMUGGLED_SUPERVISOR = 'mgr-chosen-by-renderer';

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

const fixtureResolver: ItemRefResolver = () =>
  Promise.resolve({ kind: 'ok', display_name: 'Aspirin', unit_price_minor: 150 });

interface Fixture {
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  emitFn: ReturnType<typeof vi.fn>;
  cart_id: string;
  line_id: string;
  session: OperatorSessionRecord;
}

async function newCartWithLine(session: OperatorSessionRecord): Promise<Fixture> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const store = bindCartStore(makeSqlJsHandle(db));
  const emitFn = vi.fn();
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session,
    getTerminalId: () => 'terminal-rt-183',
    cartStore: store,
    resolveItemRef: fixtureResolver,
    clock: () => new Date('2026-10-04T10:00:00.000Z'),
    auditEmitter: { emit: emitFn } as unknown as AuditEmitter,
  });
  const created = await handlers.create({ idempotency_key: 'create-rt-183' });
  if (created.kind !== 'ok') throw new Error('create failed');
  const line = await handlers.linesAdd({
    cart_id: created.cart_id,
    item_ref: 'SKU-A',
    quantity: 1,
    idempotency_key: 'line-rt-183',
  });
  if (line.kind !== 'ok') throw new Error('linesAdd failed');
  return { db, handlers, emitFn, cart_id: created.cart_id, line_id: line.line_id, session };
}

/** The request a scripted renderer could send: the contract fields plus a supervisor id. */
function smuggledAdd(
  f: Fixture,
  placeholder_kind: string,
  idempotency_key: string,
): CartDiscountPlaceholdersAddRequest {
  return {
    cart_id: f.cart_id,
    line_id: f.line_id,
    placeholder_kind,
    reason_code: 'promotion',
    idempotency_key,
    attribution_operator_id: SMUGGLED_SUPERVISOR,
  } as CartDiscountPlaceholdersAddRequest;
}

function selectAll(db: SqlJsDatabase, sql: string, cart_id: string): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  stmt.bind([cart_id]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

const placeholders = (f: Fixture): Record<string, unknown>[] =>
  selectAll(f.db, 'SELECT * FROM cart_line_discount_placeholders WHERE cart_id = ?', f.cart_id);
const discountOutbox = (f: Fixture): Record<string, unknown>[] =>
  selectAll(
    f.db,
    "SELECT * FROM cart_action_outbox WHERE cart_id = ? AND action_kind = 'cart.discount_placeholder.add'",
    f.cart_id,
  );

describe('RT-183 — cashier session cannot assert a supervisor', () => {
  it.each([['manual_pct_20'], ['manual_pct_5']])(
    'refuses a %s add that names a supervisor, writing nothing (no threshold)',
    async (kind) => {
      const f = await newCartWithLine(makeSession('cashier', 'cashier-1'));
      const res = await f.handlers.discountPlaceholdersAdd(smuggledAdd(f, kind, 'dp-1'));

      expect(res).toEqual({ kind: 'refused', reason: 'manager_attribution_required' });
      expect(placeholders(f)).toHaveLength(0);
      expect(discountOutbox(f)).toHaveLength(0);
      expect(f.emitFn).not.toHaveBeenCalled();
    },
  );
});

describe.each(['manager', 'admin'] as const)(
  'RT-183 — %s session approves only as itself (RT-28 D2)',
  (role) => {
    it('records the session operator, never the renderer-supplied id', async () => {
      const f = await newCartWithLine(makeSession(role, `${role}-1`));
      const res = await f.handlers.discountPlaceholdersAdd(smuggledAdd(f, 'manual_pct_20', 'dp-3'));

      expect(res).toEqual({
        kind: 'ok',
        placeholder_id: 'dp-3',
        requires_manager_attribution: true,
      });
      const [row] = placeholders(f);
      expect(row?.['attribution_operator_id']).toBe(`${role}-1`);
      const [outbox] = discountOutbox(f);
      expect(outbox?.['acting_operator_id']).toBe(`${role}-1`);
      expect(outbox?.['attribution_operator_id']).toBe(`${role}-1`);

      expect(f.emitFn).toHaveBeenCalledOnce();
      const event = f.emitFn.mock.calls[0]?.[0] as AuditEvent;
      expect(event.action_category).toBe('cart.discount.manager_authorized');
      expect(event.acting_operator_id).toBe(`${role}-1`);
      expect(event.approving_supervisor_id).toBe(`${role}-1`);
      expect(JSON.stringify(event)).not.toContain(SMUGGLED_SUPERVISOR);
    });

    it('applies an add without any attribution field', async () => {
      const f = await newCartWithLine(makeSession(role, `${role}-1`));
      const res = await f.handlers.discountPlaceholdersAdd({
        cart_id: f.cart_id,
        line_id: f.line_id,
        placeholder_kind: 'manual_pct_20',
        reason_code: 'promotion',
        idempotency_key: 'dp-4',
      });

      expect(res.kind).toBe('ok');
      const event = f.emitFn.mock.calls[0]?.[0] as AuditEvent;
      expect(event.approving_supervisor_id).toBe(`${role}-1`);
    });
  },
);

/** The registered `cart.discountPlaceholders.add` IPC handler, with a spy on the bridge. */
function registerAddHandler() {
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
  const spy = vi.spyOn(bridge, 'discountPlaceholdersAdd');
  registerCartHandlers(ipcMain, { handlers: bridge });
  const handler = registered.get(CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_ADD);
  if (handler === undefined) throw new Error('missing DISCOUNT_PLACEHOLDERS_ADD');
  return { handler, spy };
}

describe('RT-183 — IPC parser drops attribution_operator_id', () => {
  it('forwards a fresh request without the renderer-supplied supervisor', async () => {
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
    const spy = vi.spyOn(bridge, 'discountPlaceholdersAdd');
    registerCartHandlers(ipcMain, { handlers: bridge });

    const handler = registered.get(CART_IPC_CHANNELS.DISCOUNT_PLACEHOLDERS_ADD);
    if (handler === undefined) throw new Error('missing DISCOUNT_PLACEHOLDERS_ADD');
    await handler({} as IpcMainInvokeEvent, {
      cart_id: 'c',
      line_id: 'l',
      placeholder_kind: 'manual_pct_20',
      attribution_operator_id: SMUGGLED_SUPERVISOR,
      idempotency_key: 'k',
    });

    expect(spy).toHaveBeenCalledOnce();
    const forwarded = spy.mock.calls[0]?.[0];
    expect(forwarded).toEqual({
      cart_id: 'c',
      line_id: 'l',
      placeholder_kind: 'manual_pct_20',
      idempotency_key: 'k',
    });
    expect(forwarded).not.toHaveProperty('attribution_operator_id');
  });

  it('RT-608: forwards a bounded approval_id and refuses a malformed one', async () => {
    const { handler, spy } = registerAddHandler();
    const base = {
      cart_id: 'c',
      line_id: 'l',
      placeholder_kind: 'manual_pct_20',
      idempotency_key: 'k',
    };

    await handler({} as IpcMainInvokeEvent, { ...base, approval_id: 'appr-1' });
    expect(spy.mock.calls[0]?.[0]).toEqual({ ...base, approval_id: 'appr-1' });

    for (const bad of [42, '', 'has space', 'x'.repeat(129), { id: 'appr' }]) {
      await expect(
        handler({} as IpcMainInvokeEvent, { ...base, approval_id: bad }),
      ).resolves.toMatchObject({ kind: 'refused' });
    }
    expect(spy).toHaveBeenCalledOnce();
  });

  it('RT-854: forwards a string reason_code (main validates the list) and refuses a non-string one', async () => {
    const { handler, spy } = registerAddHandler();
    const base = {
      cart_id: 'c',
      line_id: 'l',
      placeholder_kind: 'manual_pct_10',
      idempotency_key: 'k',
    };

    await handler({} as IpcMainInvokeEvent, { ...base, reason_code: 'promotion' });
    expect(spy.mock.calls[0]?.[0]).toEqual({ ...base, reason_code: 'promotion' });
    // An unknown string still reaches main, which refuses it `invalid_payload`.
    await handler({} as IpcMainInvokeEvent, { ...base, reason_code: 'other' });
    expect(spy.mock.calls[1]?.[0]).toEqual({ ...base, reason_code: 'other' });

    for (const bad of [42, null, { code: 'promotion' }, ['promotion']]) {
      await expect(
        handler({} as IpcMainInvokeEvent, { ...base, reason_code: bad }),
      ).resolves.toMatchObject({ kind: 'refused' });
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
