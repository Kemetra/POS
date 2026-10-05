/**
 * RT-113 P1.2 — the offline grant wiring: the pairing wrapper. Every persist
 * and clear purges the grants (OD4); every re-pair gets a new epoch (F4,
 * Codex P1 4181552529); a failed persist or clear rebinds the scope.
 * Uses the REAL `createPairingStore` over the same sql.js database.
 * Shared harness: `__helpers__/offline-grant-wiring-harness.ts`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { bindPairingStoreDb, createPairingStore, type PairingStore } from '../../pairing/store.js';
import { OFFLINE_GRANT_CLOCK_TICK_MS, withOfflineGrantPairing } from '../offline-grant-wiring.js';
import {
  BRANCH,
  OPERATOR,
  T0,
  TENANT,
  TERMINAL,
  USER,
  admitted,
  grantBlob,
  rows,
  scope,
} from './__helpers__/offline-grant-fixture.js';
import {
  OPERATOR_2,
  g,
  audits,
  store,
  wiring,
  makeWiring,
  refusal,
  current,
  admit,
  admitBoth,
  body,
  breakable,
  TOKEN_KEY,
  memorySecretStore,
  pairInput,
  installWiringHarness,
} from './__helpers__/offline-grant-wiring-harness.js';

installWiringHarness();

// ── The pairing purge (OD4) and a new epoch on every re-pair (F4) ───────────

describe('withOfflineGrantPairing — purge on every pairing change (OD4) and a new epoch (F4)', () => {
  let inner: PairingStore;
  let pairing: PairingStore;

  async function currentEpoch(): Promise<number> {
    const s = await pairing.getStatus();
    if (s.kind !== 'paired') throw new Error('not paired');
    return s.paired_at;
  }

  /** Write an old sealed body back into U's row (F1-style replay). */
  function writeBack(oldBody: Buffer): void {
    g.raw.run(
      `INSERT INTO cashier_offline_grants (tenant_id, branch_id, terminal_id, user_id, sealed_body, sealed_at)
       VALUES (?, ?, ?, ?, ?, 'x')`,
      [TENANT, BRANCH, TERMINAL, USER, oldBody],
    );
  }

  /**
   * F4 / Codex P1 4181552529: pair, grant U, keep U's sealed body; optionally
   * delete the clock mark and unpair; re-pair in the SAME paired_at second;
   * write the old body back.
   */
  async function replayAfterSameSecondRepair(opts: {
    deleteMark: boolean;
    unpair: boolean;
  }): Promise<void> {
    await pairing.persist(pairInput());
    admit();
    expect(wiring.evaluate(USER, T0).admissible).toBe(true); // precondition: a real grant
    const oldBody = grantBlob(g.raw);
    if (opts.deleteMark) g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    if (opts.unpair) await pairing.clear();
    await pairing.persist(pairInput()); // the same paired_at second
    writeBack(oldBody);
  }

  beforeEach(() => {
    inner = createPairingStore({
      secretStore: memorySecretStore(),
      db: bindPairingStoreDb(g.handle),
      deviceTokenKey: TOKEN_KEY,
    });
    pairing = withOfflineGrantPairing(inner, wiring);
    wiring.setScope(null);
  });

  it('persist purges every grant, audits each grant of the old scope (repair) and binds the new scope', async () => {
    await pairing.persist(pairInput());
    admitBoth();
    store.upsertFromAdmitted(scope({ terminal_id: 'terminal-old' }), admitted());
    expect(rows(g.raw, 'cashier_offline_grants')).toHaveLength(3);

    await pairing.persist(pairInput({ terminal_id: 'terminal-new' }));
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    // Codex P2 4183628413: the terminal-old grant (another scope) is audited by
    // the purge too; P1.2 before this fix deleted it silently.
    expect(
      audits.map((a) => [a.payload['reason'], a.acting_operator_id, a.originating_terminal_id]),
    ).toEqual(
      expect.arrayContaining([
        ['repair', OPERATOR, TERMINAL],
        ['repair', OPERATOR_2, TERMINAL],
        ['repair', OPERATOR, 'terminal-old'],
      ]),
    );
    expect(audits).toHaveLength(3);
    admit();
    expect(body()).toMatchObject({
      terminal_id: 'terminal-new',
      pairing_epoch: await currentEpoch(),
    });
  });

  it('clear purges every grant, audits unpair and unbinds the scope', async () => {
    await pairing.persist(pairInput());
    admitBoth();
    await pairing.clear();
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(audits.map((a) => a.payload['reason'])).toEqual(['unpair', 'unpair']);
    expect((await pairing.getStatus()).kind).toBe('unpaired');
    admit();
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
  });

  it('every re-pair gets a new epoch, even with the same paired_at second', async () => {
    await pairing.persist(pairInput());
    const first = await currentEpoch();
    await pairing.clear();
    await pairing.persist(pairInput());
    const second = await currentEpoch();
    await pairing.persist(pairInput());
    const third = await currentEpoch();
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('F4: purge, re-pair with the same paired_at, and an old body written back is not admissible', async () => {
    await replayAfterSameSecondRepair({ deleteMark: false, unpair: true });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('scope_mismatch'));
    expect(wiring.consumeOfflineUse(USER, T0)).toEqual(refusal('scope_mismatch'));
  });

  it('Codex P1 4181552529: a deleted mark, then unpair and a same-second re-pair: an old body written back is no proof', async () => {
    await replayAfterSameSecondRepair({ deleteMark: true, unpair: true });
    expect(wiring.evaluate(USER, T0).admissible).toBe(false);
    expect(wiring.consumeOfflineUse(USER, T0).admissible).toBe(false);
  });

  it('Codex P1 4181552529: a deleted mark, then a same-second re-pair over the old pairing', async () => {
    await replayAfterSameSecondRepair({ deleteMark: true, unpair: false });
    expect(wiring.evaluate(USER, T0).admissible).toBe(false);
  });

  it('rev545 F-5: scope lost while paired (re-read threw), mark deleted, clear and a same-second re-pair: an old body is refused', async () => {
    await pairing.persist(pairInput());
    admit();
    const oldBody = grantBlob(g.raw);
    // A re-pair whose persist fails, and whose status re-read throws: the
    // grants are purged and the wiring no longer knows the (still paired) scope.
    let statusThrows = false;
    const flaky: PairingStore = {
      ...inner,
      getStatus: () => (statusThrows ? Promise.reject(new Error('dpapi')) : inner.getStatus()),
      persist: () => {
        statusThrows = true;
        return Promise.reject(new Error('disk full'));
      },
    };
    await expect(withOfflineGrantPairing(flaky, wiring).persist(pairInput())).rejects.toThrow(
      'disk full',
    );
    statusThrows = false;
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('scope_mismatch'));
    expect((await inner.getStatus()).kind).toBe('paired');
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    await pairing.clear();
    await pairing.persist(pairInput()); // the same paired_at second
    writeBack(oldBody);
    expect(wiring.evaluate(USER, T0).admissible).toBe(false);
  });

  it('a deleted mark and a failed purge: the re-pair epoch is still above the replaced pairing', async () => {
    await pairing.persist(pairInput());
    const first = await currentEpoch();
    admit();
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    const b = breakable();
    b.broken.add('purgeAll');
    const w = makeWiring({ store: b.store });
    w.setScope(scope({ pairing_epoch: first }));
    const p = withOfflineGrantPairing(inner, w);
    await p.persist(pairInput());
    const s2 = await p.getStatus();
    expect(s2.kind === 'paired' && s2.paired_at).toBeGreaterThan(first);
    w.stop();
  });

  it('no grant, a deleted mark, unpair and a same-second re-pair: the epoch still moves', async () => {
    await pairing.persist(pairInput());
    const first = await currentEpoch();
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    await pairing.clear();
    await pairing.persist(pairInput());
    expect(await currentEpoch()).toBeGreaterThan(first);
  });

  it('F4 without a clear: a re-pair over the old pairing in the same second', async () => {
    await replayAfterSameSecondRepair({ deleteMark: false, unpair: false });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('scope_mismatch'));
  });

  it('a failed purge refuses every user until the tick retries it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await pairing.persist(pairInput());
    admit();
    const b = breakable();
    b.broken.add('purgeAll');
    const w = makeWiring({ store: b.store });
    const p = withOfflineGrantPairing(inner, w);
    await p.persist(pairInput());
    w.start();
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    w.seam.onCashierAdmitted(current(w));
    expect(w.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    b.broken.clear();
    vi.advanceTimersByTime(OFFLINE_GRANT_CLOCK_TICK_MS);
    // The retried purge lifts the tombstone (and, fail closed, takes the fresh grant too).
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    w.seam.onCashierAdmitted(current(w));
    expect(w.evaluate(USER, T0).admissible).toBe(true);
    w.stop();
  });

  it('a failed persist rethrows and re-reads the scope from the pairing store', async () => {
    await pairing.persist(pairInput());
    const failing: PairingStore = {
      ...inner,
      persist: () => Promise.reject(new Error('disk full')),
    };
    const p = withOfflineGrantPairing(failing, wiring);
    await expect(p.persist(pairInput({ terminal_id: 'terminal-new' }))).rejects.toThrow(
      'disk full',
    );
    admit();
    expect(body()).toMatchObject({ terminal_id: TERMINAL });
  });

  it('Codex P2 4183175505: a failed clear rethrows and rebinds the scope (still paired); the purge stands', async () => {
    const db = bindPairingStoreDb(g.handle);
    const stuck = createPairingStore({
      secretStore: memorySecretStore(),
      db: {
        ...db,
        deleteAssignment: () => {
          throw new Error('SQLITE_BUSY');
        },
      },
      deviceTokenKey: TOKEN_KEY,
    });
    const p = withOfflineGrantPairing(stuck, wiring);
    await p.persist(pairInput());
    admit();
    await expect(p.clear()).rejects.toThrow('SQLITE_BUSY');
    expect((await stuck.getStatus()).kind).toBe('paired');
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]); // purged: fails closed
    admit();
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
  });

  it("Codex P1 4184710216: unpair's purge fails, clear succeeds, a same-second re-pair before the tick: an old sealed grant is refused", async () => {
    await pairing.persist(pairInput());
    admit();
    const first = await currentEpoch();
    const oldBody = grantBlob(g.raw);
    // An empty grant table and no clock mark: the store holds no evidence.
    g.raw.run('DELETE FROM cashier_offline_grants');
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    const b = breakable();
    const w = makeWiring({ store: b.store });
    w.setScope(scope({ pairing_epoch: first }));
    const p = withOfflineGrantPairing(inner, w);
    b.broken.add('purgeAll');
    await p.clear(); // the purge fails and is held; clear itself succeeds
    b.broken.clear();
    await p.persist(pairInput()); // the same paired_at second, before any tick
    const s2 = await p.getStatus();
    expect(s2.kind === 'paired' && s2.paired_at).toBeGreaterThan(first);
    writeBack(oldBody);
    expect(w.evaluate(USER, T0).admissible).toBe(false);
    w.stop();
  });

  it('Codex P1 4184710216: while the purge is still held, the re-pair reservation stays above the cleared epoch', async () => {
    await pairing.persist(pairInput());
    const first = await currentEpoch();
    g.raw.run('DELETE FROM cashier_offline_clock_hwm');
    const b = breakable();
    const w = makeWiring({ store: b.store });
    w.setScope(scope({ pairing_epoch: first }));
    const p = withOfflineGrantPairing(inner, w);
    b.broken.add('purgeAll');
    await p.clear();
    await p.persist(pairInput()); // the purge fails again: still held
    const s2 = await p.getStatus();
    expect(s2.kind === 'paired' && s2.paired_at).toBeGreaterThan(first);
    w.stop();
  });

  it('passes every other method through to the pairing store', async () => {
    await pairing.persist(pairInput());
    expect(pairing.getCurrentTerminalId()).toBe(TERMINAL);
    expect(await pairing.getStatus()).toEqual(await inner.getStatus());
  });
});
