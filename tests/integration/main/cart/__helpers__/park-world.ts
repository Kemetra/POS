/**
 * RT-440 (PK-2) — a terminal for the park / resume suites: every migration on
 * sql.js, the real cart bridge (fixture item resolver), the real park service,
 * a mutable session and clock, a scripted catalogue, and captured audit events
 * and log lines (for the label-privacy checks).
 */
import { vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import { freshGrantDb } from '../../../../../src/main/operator/__tests__/__helpers__/offline-grant-fixture.js';
import { makeSqlJsHandle } from '../../../../unit/main/cart/__helpers__/sql-js-handle.js';
import {
  CartBridgeHandlers,
  type ItemRefResolver,
} from '../../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../../src/main/cart/cart-store.js';
import { resolveItemRef } from '../../../../../src/main/cart/resolve-item-ref.js';
import {
  createParkResume,
  type ParkResume,
} from '../../../../../src/main/cart/park/park-resume.js';
import { bindParkStore } from '../../../../../src/main/cart/park/park-store.js';
import type { PriceAnswer } from '../../../../../src/main/cart/park/resume-diff.js';
import type { OperatorSessionRecord } from '../../../../../src/main/operator/session-manager.js';
import type { AuditEvent } from '../../../../../src/shared/audit/event-shape.js';
import type { DatabaseHandle } from '../../../../../src/main/db/client.js';

export const TENANT = 'tenant-1';
export const BRANCH = 'branch-1';
export const TERMINAL = 'term-1';
export const T0 = '2026-10-13T09:00:00.000Z';

/** The fixture resolver's catalogue (`resolve-item-ref.ts`). */
export const PARA = 'SKU-PARA-500'; // 150
export const IBUP = 'SKU-IBUP-400'; // 200
export const AMOX = 'SKU-AMOX-250'; // 450

export function sessionOf(
  operator_id: string,
  over: Partial<OperatorSessionRecord> = {},
): OperatorSessionRecord {
  return {
    id: `sess-${operator_id}-${crypto.randomUUID().slice(0, 8)}`,
    operator_id,
    display_name: operator_id,
    role: 'cashier',
    tenant_id: TENANT,
    branch_id: BRANCH,
    started_at: T0,
    backend_session_id: '',
    last_activity_at: T0,
    lock_state: 'active',
    locked_at: null,
    ...over,
  };
}

export interface ParkWorld {
  raw: SqlJsDatabase;
  handle: DatabaseHandle;
  audit: AuditEvent[];
  logs: string[];
  /** The session the bridges see; set it to switch operator or sign out. */
  session: OperatorSessionRecord | null;
  terminal: string | null;
  now: Date;
  /** The scripted catalogue; an item absent here answers its fixture price. */
  catalogue: Map<string, PriceAnswer>;
  cart: CartBridgeHandlers;
  parks: ParkResume;
  /** Build a cart bridge with another resolver (the commit-time race test). */
  cartWith(resolver: ItemRefResolver): CartBridgeHandlers;
}

export { initGrantSql as initParkSql } from '../../../../../src/main/operator/__tests__/__helpers__/offline-grant-fixture.js';

const FIXTURE_PRICES: Record<string, number> = { [PARA]: 150, [IBUP]: 200, [AMOX]: 450 };

export function createParkWorld(): ParkWorld {
  const raw = freshGrantDb();
  const handle = makeSqlJsHandle(raw);
  const capture = (level: string) =>
    vi.fn((...args: unknown[]) => {
      world.logs.push(`${level} ${JSON.stringify(args)}`);
    });
  const logger = { info: capture('info'), error: capture('error'), warn: capture('warn') };
  const bridge = (resolver: ItemRefResolver): CartBridgeHandlers =>
    new CartBridgeHandlers({
      getCurrentSession: () => world.session,
      getTerminalId: () => world.terminal,
      cartStore: bindCartStore(handle),
      resolveItemRef: resolver,
      clock: () => world.now,
      auditEmitter: { emit: (e: AuditEvent) => world.audit.push(e) } as never,
      logger: logger as never,
      cartPaymentStatus: () => 'none',
    });
  const world: ParkWorld = {
    raw,
    handle,
    audit: [],
    logs: [],
    session: null,
    terminal: TERMINAL,
    now: new Date(T0),
    catalogue: new Map(),
    cart: undefined as unknown as CartBridgeHandlers,
    parks: undefined as unknown as ParkResume,
    cartWith: bridge,
  };
  world.cart = bridge(resolveItemRef);
  world.parks = createParkResume({
    db: handle,
    store: bindParkStore(handle),
    cartStore: bindCartStore(handle),
    getCurrentSession: () => world.session,
    getTerminalId: () => world.terminal,
    auditEmitter: { emit: (e) => world.audit.push(e) },
    prices: (_tenant, item) =>
      world.catalogue.get(item) ?? { kind: 'price', unit_price_minor: FIXTURE_PRICES[item] ?? 0 },
    clock: () => world.now,
    logger: logger as never,
  });
  return world;
}

/** A new cart for the current session, with `items` added (quantity 1 each unless given). */
export async function openSale(
  world: ParkWorld,
  items: readonly (string | [string, number])[],
): Promise<string> {
  const created = await world.cart.create({ idempotency_key: crypto.randomUUID() });
  if (created.kind !== 'ok') throw new Error(`cart.create refused: ${created.reason}`);
  for (const item of items) {
    const [item_ref, quantity] = typeof item === 'string' ? [item, 1] : item;
    const added = await world.cart.linesAdd({
      cart_id: created.cart_id,
      item_ref,
      quantity,
      idempotency_key: crypto.randomUUID(),
    });
    if (added.kind !== 'ok') throw new Error(`cart.lines.add refused: ${added.reason}`);
  }
  return created.cart_id;
}

export function parkCart(world: ParkWorld, cart_id: string, label?: string): string {
  const key = crypto.randomUUID();
  const res = world.parks.park({
    cart_id,
    idempotency_key: key,
    ...(label === undefined ? {} : { label }),
  });
  if (res.kind !== 'parked') throw new Error(`cart.park refused: ${res.reason}`);
  return key;
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- test query helper: the caller names the row shape
export function row<T>(world: ParkWorld, sql: string, params: unknown[] = []): T | undefined {
  return (world.handle.prepare(sql) as { get(...p: unknown[]): T | undefined }).get(...params);
}

export function rows<T>(world: ParkWorld, sql: string, params: unknown[] = []): T[] {
  return (world.handle.prepare(sql) as { all(...p: unknown[]): T[] }).all(...params);
}

export function categories(world: ParkWorld): string[] {
  return world.audit.map((e) => e.action_category);
}

/** A payment attempt on `cart_id` for the current session (no tender lines). */
export function insertAttempt(
  world: ParkWorld,
  input: { cart_id: string; state: 'started' | 'settled'; id?: string },
): void {
  world.raw.run(
    `INSERT INTO payment_attempts (payment_attempt_id, tenant_id, branch_id, terminal_id,
       acting_operator_id, operator_session_id, envelope_handoff_action_id, envelope_cart_id,
       envelope_subtotal_minor, state, started_at, settled_at, last_action_id)
     VALUES (?, ?, ?, ?, ?, ?, 'h1', ?, 100, ?, ?, ?, 'a')`,
    [
      input.id ?? crypto.randomUUID(),
      TENANT,
      BRANCH,
      TERMINAL,
      world.session?.operator_id ?? 'nobody',
      world.session?.id ?? 'no-session',
      input.cart_id,
      input.state,
      T0,
      input.state === 'settled' ? T0 : null,
    ],
  );
}
