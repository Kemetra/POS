/**
 * 011 T024 (RED) — `SaleSyncClient` seam + test fake.
 *
 * The engine depends only on the `SaleSyncClient` interface (DI). The concrete
 * HTTP client is gated on #349; tests inject `createFakeSaleSyncClient`, which
 * returns scripted `SaleSyncResult`s. Contract:
 *   • the fake yields the scripted results in order, then repeats the last one;
 *   • `postSale` NEVER rejects (transport faults are mapped to the union);
 *   • the fake records the payloads it was called with (for assertions).
 */
import { describe, expect, it } from 'vitest';

import { createFakeSaleSyncClient } from '../sale-sync-client-types.js';
import type { CaptureSalePayload } from '../capture-payload.js';

function payload(over: Partial<CaptureSalePayload> = {}): CaptureSalePayload {
  return {
    externalId: 'pos-pulse:handoff-abc',
    sourceSystem: 'pos-pulse',
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    terminalId: 'term-1',
    operatorId: 'op-1',
    occurredAt: '2026-06-07T10:00:00.000Z',
    totalMinor: 1500,
    lines: [],
    ...over,
  };
}

describe('T024 — SaleSyncClient fake', () => {
  it('yields scripted results in order', async () => {
    const client = createFakeSaleSyncClient([{ kind: 'transient' }, { kind: 'ok', saleRef: null }]);
    expect((await client.postSale(payload())).kind).toBe('transient');
    expect((await client.postSale(payload())).kind).toBe('ok');
  });

  it('repeats the last scripted result once the script is exhausted', async () => {
    const client = createFakeSaleSyncClient([{ kind: 'ok', saleRef: null }]);
    expect((await client.postSale(payload())).kind).toBe('ok');
    expect((await client.postSale(payload())).kind).toBe('ok');
  });

  it('defaults to ok when no script is given', async () => {
    const client = createFakeSaleSyncClient();
    expect((await client.postSale(payload())).kind).toBe('ok');
  });

  it('never rejects', async () => {
    const client = createFakeSaleSyncClient([{ kind: 'permanent' }]);
    await expect(client.postSale(payload())).resolves.toBeDefined();
  });

  it('records the payloads it was called with', async () => {
    const client = createFakeSaleSyncClient([
      { kind: 'ok', saleRef: null },
      { kind: 'ok', saleRef: null },
    ]);
    await client.postSale(payload({ externalId: 'a' }));
    await client.postSale(payload({ externalId: 'b' }));
    expect(client.calls.map((c) => c.externalId)).toEqual(['a', 'b']);
  });
});
