import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CartBridgeHandlers, type ItemRefResolver } from '../../../../src/main/cart/cart-bridge.js';
import { bindCartStore } from '../../../../src/main/cart/cart-store.js';
import type { OperatorSessionRecord } from '../../../../src/main/operator/session-manager.js';
import { makeSqlJsHandle } from './__helpers__/sql-js-handle.js';

/**
 * T033 + T034 + T035 — `cart.lines.update`, `cart.lines.remove`, and
 * `cart.lines.setNote` persistence + version/forbidden-pattern guards.
 */

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..', '..');
const MIGRATIONS = [
  '0008_carts.sql',
  '0009_cart_action_outbox.sql',
  '0010_cart_lines.sql',
  '0011_cart_line_discount_placeholders.sql',
  '0050_carts_park.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function session(): OperatorSessionRecord {
  return {
    id: 'sess-mut',
    operator_id: 'cashier-1',
    display_name: 'Cashier One',
    role: 'cashier',
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    started_at: '2026-05-14T08:00:00.000Z',
    backend_session_id: 'b',
    last_activity_at: '2026-05-14T08:00:00.000Z',
  };
}

const resolver: ItemRefResolver = (item_ref) => {
  if (item_ref === 'SKU-A')
    return Promise.resolve({ kind: 'ok', display_name: 'A', unit_price_minor: 100 });
  return Promise.resolve({ kind: 'refused', reason: 'unknown_item' });
};

async function freshCartWithLine(): Promise<{
  db: SqlJsDatabase;
  handlers: CartBridgeHandlers;
  cart_id: string;
  line_id: string;
}> {
  const db = new SQL.Database();
  for (const sql of MIGRATIONS) db.run(sql);
  const handlers = new CartBridgeHandlers({
    getCurrentSession: () => session(),
    getTerminalId: () => 'terminal-test-380',
    cartStore: bindCartStore(makeSqlJsHandle(db)),
    resolveItemRef: resolver,
    clock: () => new Date('2026-05-14T10:00:00.000Z'),
  });
  const c = await handlers.create({ idempotency_key: 'c-1' });
  if (c.kind !== 'ok') throw new Error('create failed');
  const a = await handlers.linesAdd({
    cart_id: c.cart_id,
    item_ref: 'SKU-A',
    quantity: 1,
    idempotency_key: 'a-1',
  });
  if (a.kind !== 'ok') throw new Error('add failed');
  return { db, handlers, cart_id: c.cart_id, line_id: a.line_id };
}

describe('cart.lines.update — T033', () => {
  it('increment increases quantity and advances version', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'increment',
      delta: 2,
      version: 1,
      idempotency_key: 'u-1',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.version).toBe(2);
  });

  it('decrement decreases quantity and advances version', async () => {
    const f = await freshCartWithLine();
    // bump quantity to 3 first
    await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 3,
      version: 1,
      idempotency_key: 'u-pre',
    });
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'decrement',
      delta: 1,
      version: 2,
      idempotency_key: 'u-2',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.version).toBe(3);
  });

  it('set absolute replaces quantity', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 7,
      version: 1,
      idempotency_key: 'u-3',
    });
    expect(r.kind).toBe('ok');
  });

  it('refuses with stale_version when client version is behind', async () => {
    const f = await freshCartWithLine();
    await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 2,
      version: 1,
      idempotency_key: 'u-4',
    });
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 5,
      version: 1, // stale; current version is 2
      idempotency_key: 'u-5',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('stale_version');
  });

  it('set(0) delegates to remove (soft-removes the line)', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 0,
      version: 1,
      idempotency_key: 'u-6',
    });
    expect(r.kind).toBe('ok');
    const stmt = f.db.prepare('SELECT removed_at FROM cart_lines WHERE line_id = ?');
    stmt.bind([f.line_id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row['removed_at']).not.toBeNull();
  });
});

describe('cart.lines.remove — T034', () => {
  it('soft-sets removed_at (does NOT hard-delete the row)', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: f.line_id,
      version: 1,
      idempotency_key: 'r-1',
    });
    expect(r.kind).toBe('ok');
    const stmt = f.db.prepare('SELECT removed_at, line_id FROM cart_lines WHERE line_id = ?');
    stmt.bind([f.line_id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row['line_id']).toBe(f.line_id);
    expect(row['removed_at']).not.toBeNull();
  });

  it('replay with same idempotency_key is a no-op (FR-018)', async () => {
    const f = await freshCartWithLine();
    const r1 = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: f.line_id,
      version: 1,
      idempotency_key: 'r-2',
    });
    const r2 = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: f.line_id,
      version: 1,
      idempotency_key: 'r-2',
    });
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    const stmt = f.db.prepare(
      "SELECT COUNT(*) AS c FROM cart_action_outbox WHERE cart_id = ? AND action_kind = 'cart.line.remove'",
    );
    stmt.bind([f.cart_id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row['c']).toBe(1);
  });

  it('refuses with stale_version when client version is behind', async () => {
    const f = await freshCartWithLine();
    await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 2,
      version: 1,
      idempotency_key: 'r-3',
    });
    const r = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: f.line_id,
      version: 1, // stale
      idempotency_key: 'r-4',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('stale_version');
  });
});

describe('cart.lines.setNote — T035', () => {
  it('accepts a note ≤ 200 chars', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'No substitutions',
      version: 1,
      idempotency_key: 'n-1',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.version).toBe(2);
  });

  it('refuses note > 200 chars with note_too_long', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'x'.repeat(201),
      version: 1,
      idempotency_key: 'n-2',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('note_too_long');
  });

  it('refuses note matching a forbidden pattern (credential-like fragment)', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'pin 1234',
      version: 1,
      idempotency_key: 'n-3',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('note_forbidden_pattern');
  });

  it('refuses note matching a card-number-shaped fragment', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'paid 4111111111111111',
      version: 1,
      idempotency_key: 'n-4',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('note_forbidden_pattern');
  });

  it('refuses with stale_version when client version is behind', async () => {
    const f = await freshCartWithLine();
    await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 2,
      version: 1,
      idempotency_key: 'n-pre',
    });
    const r = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'ok',
      version: 1, // stale
      idempotency_key: 'n-5',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('stale_version');
  });

  it('accepts null to clear an existing note', async () => {
    const f = await freshCartWithLine();
    await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'temporary',
      version: 1,
      idempotency_key: 'n-6',
    });
    const r = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: null,
      version: 2,
      idempotency_key: 'n-7',
    });
    expect(r.kind).toBe('ok');
  });

  it('outbox payload_json stores note_length only, never the note content', async () => {
    const f = await freshCartWithLine();
    await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'sensitive-marker-T035',
      version: 1,
      idempotency_key: 'n-8',
    });
    const stmt = f.db.prepare(
      "SELECT payload_json FROM cart_action_outbox WHERE action_kind = 'cart.line.note_set' AND cart_id = ?",
    );
    stmt.bind([f.cart_id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row['payload_json']).not.toContain('sensitive-marker-T035');
  });

  it('replay with same idempotency_key returns the original outcome', async () => {
    const f = await freshCartWithLine();
    const r1 = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'replay-me',
      version: 1,
      idempotency_key: 'n-replay',
    });
    const r2 = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'replay-me',
      version: 1,
      idempotency_key: 'n-replay',
    });
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    if (r1.kind === 'ok' && r2.kind === 'ok') expect(r2.version).toBe(r1.version);
  });

  it('refuses replay of an idempotency_key originally used for a different action kind', async () => {
    const f = await freshCartWithLine();
    const SHARED = 'mismatch-key';
    await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 3,
      version: 1,
      idempotency_key: SHARED,
    });
    const r = await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'X',
      version: 2,
      idempotency_key: SHARED,
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('idempotency_payload_mismatch');
  });
});

describe('linesRemove — additional idempotency / soft-remove paths', () => {
  it('replay of remove key with mismatched action_kind refuses with idempotency_payload_mismatch', async () => {
    const f = await freshCartWithLine();
    const SHARED = 'rem-mismatch';
    await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 2,
      version: 1,
      idempotency_key: SHARED,
    });
    const r = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: f.line_id,
      version: 2,
      idempotency_key: SHARED,
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('idempotency_payload_mismatch');
  });

  it('remove on an already-soft-removed line is an idempotent no-op (returns ok)', async () => {
    const f = await freshCartWithLine();
    await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: f.line_id,
      version: 1,
      idempotency_key: 'rem-once',
    });
    // Second remove with a DIFFERENT idempotency_key — line already removed_at.
    const r = await f.handlers.linesRemove({
      cart_id: f.cart_id,
      line_id: f.line_id,
      version: 2,
      idempotency_key: 'rem-twice',
    });
    expect(r.kind).toBe('ok');
  });
});

describe('linesUpdate — idempotency replay paths', () => {
  it('replay of an update with the same key returns the current version', async () => {
    const f = await freshCartWithLine();
    const KEY = 'upd-replay';
    const r1 = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 4,
      version: 1,
      idempotency_key: KEY,
    });
    const r2 = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 4,
      version: 1,
      idempotency_key: KEY,
    });
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    if (r1.kind === 'ok' && r2.kind === 'ok') expect(r2.version).toBe(r1.version);
  });

  it('replay of an update key originally used for note_set refuses with idempotency_payload_mismatch', async () => {
    const f = await freshCartWithLine();
    const SHARED = 'upd-mis';
    await f.handlers.linesSetNote({
      cart_id: f.cart_id,
      line_id: f.line_id,
      note: 'first',
      version: 1,
      idempotency_key: SHARED,
    });
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 2,
      version: 2,
      idempotency_key: SHARED,
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('idempotency_payload_mismatch');
  });
});

describe('linesUpdate — decrement-past-zero with delta delegates to remove (FR-016)', () => {
  it('decrement with delta > current quantity → line soft-removed', async () => {
    const f = await freshCartWithLine();
    // Bump to 2 first.
    await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: 2,
      version: 1,
      idempotency_key: 'dpz-pre',
    });
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'decrement',
      delta: 5, // exceeds current quantity
      version: 2,
      idempotency_key: 'dpz-1',
    });
    expect(r.kind).toBe('ok');
    const stmt = f.db.prepare('SELECT removed_at FROM cart_lines WHERE line_id = ?');
    stmt.bind([f.line_id]);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row['removed_at']).not.toBeNull();
  });

  it('decrement with invalid delta (zero) refuses with stale_version', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'decrement',
      delta: 0,
      version: 1,
      idempotency_key: 'badd-1',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('stale_version');
  });

  it('increment with invalid delta refuses with stale_version', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'increment',
      delta: -1,
      version: 1,
      idempotency_key: 'badi-1',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('stale_version');
  });

  it('set with missing absolute refuses with stale_version', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      version: 1,
      idempotency_key: 'bads-1',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('stale_version');
  });

  it('updates with unknown line_id refuse wrong_owner', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: 'nope',
      op: 'set',
      absolute: 2,
      version: 1,
      idempotency_key: 'unk-1',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('wrong_owner');
  });
});

describe('linesUpdate — overflow refused via LineSubtotalError', () => {
  it('refuses when quantity × unit_price_minor would exceed MAX_SAFE_INTEGER', async () => {
    const f = await freshCartWithLine();
    // unit_price_minor=100 (fixture). Set quantity to a value whose product overflows.
    const huge = Math.floor(Number.MAX_SAFE_INTEGER / 50); // 100 × huge > MAX_SAFE_INTEGER
    const r = await f.handlers.linesUpdate({
      cart_id: f.cart_id,
      line_id: f.line_id,
      op: 'set',
      absolute: huge,
      version: 1,
      idempotency_key: 'overflow',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('stale_version');
  });
});

describe('S2 stub handlers still gate before refusing not_implemented', () => {
  it('discountPlaceholders.add succeeds for a valid cart (T068 implemented)', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.discountPlaceholdersAdd({
      cart_id: f.cart_id,
      line_id: f.line_id,
      placeholder_kind: 'percent_5',
      idempotency_key: 'd-1',
    });
    expect(r.kind).toBe('ok');
  });

  it('discountPlaceholders.remove refuses when placeholder does not exist (T069 implemented)', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.discountPlaceholdersRemove({
      cart_id: f.cart_id,
      placeholder_id: 'nonexistent-ph',
      idempotency_key: 'd-2',
    });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('wrong_owner');
  });

  it('void returns ok for an editing cart (T067 implemented)', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.void({ cart_id: f.cart_id, idempotency_key: 'v-1' });
    expect(r.kind).toBe('ok');
  });

  it('handoff succeeds for an editing cart with active lines (T086 implemented)', async () => {
    const f = await freshCartWithLine();
    const r = await f.handlers.handoff({
      cart_id: f.cart_id,
      per_line_versions: [],
      idempotency_key: 'h-1',
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.envelope.envelope_version).toBe('v1');
  });

  it('stub handlers refuse no_session when not signed in (S2 DB path)', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session(),
      getTerminalId: () => 'terminal-test-380',
      cartStore: (await import('../../../../src/main/cart/cart-store.js')).bindCartStore(
        makeSqlJsHandle(db),
      ),
      resolveItemRef: resolver,
      clock: () => new Date('2026-05-14T10:00:00.000Z'),
    });
    const c = await handlers.create({ idempotency_key: 'sx-c' });
    if (c.kind !== 'ok') throw new Error('create failed');

    // Swap to no-session for the stub gates.
    const signedOut = new CartBridgeHandlers({
      getCurrentSession: () => null,
      getTerminalId: () => 'terminal-test-380',
      cartStore: (await import('../../../../src/main/cart/cart-store.js')).bindCartStore(
        makeSqlJsHandle(db),
      ),
    });
    const v = await signedOut.void({ cart_id: c.cart_id, idempotency_key: 'sx-v' });
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') expect(v.reason).toBe('no_session');

    const h = await signedOut.handoff({
      cart_id: c.cart_id,
      per_line_versions: [],
      idempotency_key: 'sx-h',
    });
    expect(h.kind).toBe('refused');
    if (h.kind === 'refused') expect(h.reason).toBe('no_session');
  });

  it('stub handlers refuse wrong_owner when cart_id is unknown (S2 DB path)', async () => {
    const db = new SQL.Database();
    for (const sql of MIGRATIONS) db.run(sql);
    const handlers = new CartBridgeHandlers({
      getCurrentSession: () => session(),
      getTerminalId: () => 'terminal-test-380',
      cartStore: (await import('../../../../src/main/cart/cart-store.js')).bindCartStore(
        makeSqlJsHandle(db),
      ),
    });
    const r = await handlers.void({ cart_id: 'nope', idempotency_key: 'k' });
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toBe('wrong_owner');
  });
});
