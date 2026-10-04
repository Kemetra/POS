/**
 * 011 T051 (RED) — `sales:syncStatus` IPC registration (read-only, §A4).
 *
 * The whole sale-sync bridge surface is a SINGLE read-only channel. This test
 * locks the §A4 contract:
 *   • exactly one channel is registered: `sales:syncStatus` — NO write/trigger channel;
 *   • it returns `{ pending, deadLetter, payloadDivergence, lastSuccessAt }` from the injected reader,
 *     scoped to the resolved device principal (request carries no scope — INP-1);
 *   • the response carries no token / PII / raw error (P7) — only counts + a timestamp.
 */
import { describe, expect, it } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerSalesSyncHandlers } from '../sales-sync.js';
import { SALES_SYNC_IPC_CHANNELS } from '../../../shared/sales-sync/channels.js';
import type { SaleSyncStatusCounts } from '../../sales-sync/sale-sync-state-repo.js';

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

const STATUS: SaleSyncStatusCounts = {
  pending: 3,
  deadLetter: 1,
  payloadDivergence: 1,
  lastSuccessAt: '2026-06-07T10:00:00.000Z',
};

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

  it('response carries no token / secret-shaped field', async () => {
    const { ipcMain, invoke } = fakeIpcMain();
    registerSalesSyncHandlers(ipcMain, deps());
    const res = (await invoke(SALES_SYNC_IPC_CHANNELS.SYNC_STATUS, {})) as Record<string, unknown>;
    const serialized = JSON.stringify(res).toLowerCase();
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('bearer');
    expect(serialized).not.toContain('operator');
    expect(Object.keys(res).sort()).toEqual([
      'deadLetter',
      'lastSuccessAt',
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
    const serialized = JSON.stringify(res).toLowerCase();
    // Opaque-credential-shaped substrings must not appear.
    for (const forbidden of ['envelope', 'authorization', 'jwt', 'secret', 'credential']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
