/**
 * 011 T051 (RED) — `sales:syncStatus` IPC registration (read-only, §A4).
 *
 * The whole sale-sync bridge surface is a SINGLE read-only channel. This test
 * locks the §A4 contract:
 *   • exactly one channel is registered: `sales:syncStatus` — NO write/trigger channel;
 *   • it returns `{ pending, heldPreviousPairing, deadLetter, payloadDivergence, lastSuccessAt, paused }`
 *     from the injected reader (RT-221 adds `heldPreviousPairing`; RT-224 adds the
 *     closed-set `paused` reason),
 *     scoped to the resolved device principal (request carries no scope — INP-1);
 *   • the response carries no token / PII / raw error (P7) — only counts + a timestamp.
 */
import { describe, expect, it } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerSalesSyncHandlers } from '../sales-sync.js';
import { SALES_SYNC_IPC_CHANNELS } from '../../../shared/sales-sync/channels.js';
import { SALE_SYNC_PAUSED_REASONS } from '../../sales-sync/sale-sync-engine.js';
import type { SaleSyncStatusSnapshot } from '../../sales-sync/sale-sync-status-reader.js';

function fakeIpcMain(): {
  ipcMain: IpcMain;
  invoke: (channel: string, request: unknown) => Promise<unknown>;
  channels: () => string[];
} {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>
  >();
  const ipcMain = {
    handle(channel: string, fn: (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>) {
      handlers.set(channel, fn);
    },
  } as unknown as IpcMain;
  return {
    ipcMain,
    invoke: (channel, request) => {
      const fn = handlers.get(channel);
      if (fn === undefined) throw new Error(`no handler for ${channel}`);
      return fn({} as IpcMainInvokeEvent, request);
    },
    channels: () => [...handlers.keys()],
  };
}

const STATUS: SaleSyncStatusSnapshot = {
  pending: 3,
  heldPreviousPairing: 2,
  deadLetter: 1,
  payloadDivergence: 1,
  lastSuccessAt: '2026-06-07T10:00:00.000Z',
  paused: 'no_operator_credential',
};

/**
 * RT-224: `paused` is a closed-set reason code (`no_operator_credential`), not a
 * credential. Check it against the closed set, then scan the rest of the payload
 * for credential-shaped substrings — the code's own wording must not mask a leak.
 */
function withoutClosedSetPaused(res: Record<string, unknown>): Record<string, unknown> {
  expect([null, ...SALE_SYNC_PAUSED_REASONS]).toContain(res['paused']);
  return Object.fromEntries(Object.entries(res).filter(([key]) => key !== 'paused'));
}

function deps() {
  return {
    readStatus: () => STATUS,
  };
}

describe('T051 — sales:syncStatus IPC (read-only)', () => {
  it('registers exactly one channel — the status read, no write/trigger', () => {
    const { ipcMain, channels } = fakeIpcMain();
    registerSalesSyncHandlers(ipcMain, deps());
    expect(channels()).toEqual([SALES_SYNC_IPC_CHANNELS.SYNC_STATUS]);
  });

  it('returns the reader counts on invoke', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    registerSalesSyncHandlers(ipcMain, deps());
    const res = await invoke(SALES_SYNC_IPC_CHANNELS.SYNC_STATUS, {});
    expect(res).toEqual(STATUS);
  });

  it('RT-221: an async reader (live pairing status) is awaited; held count crosses as a number', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    registerSalesSyncHandlers(ipcMain, { readStatus: () => Promise.resolve(STATUS) });
    const res = (await invoke(SALES_SYNC_IPC_CHANNELS.SYNC_STATUS, {})) as SaleSyncStatusSnapshot;
    expect(res).toEqual(STATUS);
    expect(res.heldPreviousPairing).toBe(2);
  });

  it('RT-224: the paused reason crosses the bridge unchanged (paused and not paused)', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    let paused: SaleSyncStatusSnapshot['paused'] = 'no_operator_credential';
    registerSalesSyncHandlers(ipcMain, { readStatus: () => ({ ...STATUS, paused }) });
    const first = (await invoke(SALES_SYNC_IPC_CHANNELS.SYNC_STATUS, {})) as SaleSyncStatusSnapshot;
    expect(first.paused).toBe('no_operator_credential');
    paused = null;
    const second = (await invoke(
      SALES_SYNC_IPC_CHANNELS.SYNC_STATUS,
      {},
    )) as SaleSyncStatusSnapshot;
    expect(second.paused).toBeNull();
  });

  it('response carries no token / secret-shaped field', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    registerSalesSyncHandlers(ipcMain, deps());
    const res = (await invoke(SALES_SYNC_IPC_CHANNELS.SYNC_STATUS, {})) as Record<string, unknown>;
    const serialized = JSON.stringify(withoutClosedSetPaused(res)).toLowerCase();
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('bearer');
    expect(serialized).not.toContain('operator');
    expect(Object.keys(res).sort()).toEqual([
      'deadLetter',
      'heldPreviousPairing',
      'lastSuccessAt',
      'paused',
      'payloadDivergence',
      'pending',
    ]);
  });

  it('T050 (016): no credential — opaque envelope or otherwise — crosses the bridge', async () => {
    // 016 (P7/P8/§A4 re-check): the sale-sync credential is now the OPAQUE
    // pos_operator envelope (D5). The read-only status channel must STILL carry no
    // credential of any shape — the envelope (like the Clerk JWT before it) is read
    // in-process only and never returned through any bridge-facing value. The
    // surface remains a single read channel (no write/trigger handler), and the
    // payload is counts + a timestamp only.
    const { ipcMain, invoke, channels } = fakeIpcMain();
    registerSalesSyncHandlers(ipcMain, deps());
    // Single read-only channel — no write/trigger handler exists.
    expect(channels()).toEqual([SALES_SYNC_IPC_CHANNELS.SYNC_STATUS]);
    const res = (await invoke(SALES_SYNC_IPC_CHANNELS.SYNC_STATUS, {})) as Record<string, unknown>;
    const serialized = JSON.stringify(withoutClosedSetPaused(res)).toLowerCase();
    // Opaque-credential-shaped substrings must not appear.
    for (const forbidden of ['envelope', 'authorization', 'jwt', 'secret', 'credential']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
