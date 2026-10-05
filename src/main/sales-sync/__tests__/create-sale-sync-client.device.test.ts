/**
 * RT-224 step 2 — the live client's device path (`postSaleAsCashier`).
 *
 * Backend-Core #709 (`sales.yaml` 1.5.0-draft): `captureSale` also accepts the
 * `device` scheme — `Authorization: Bearer <device token>` — with a body
 * `operatorUserId` (the `users.id` of the cashier who made the sale). With the
 * `operatorAuthorization` envelope the body MUST NOT carry `operatorUserId`.
 *
 * Device-path status mapping:
 *   401 → `device_unauthorized` (the device credential; the sale stays queued)
 *   403 → `refused` (an authenticated device whose cashier claim was refused)
 *   every other status → exactly the envelope path's mapping.
 * The envelope path's own 401/403 mapping (transient) is unchanged.
 */
import { describe, expect, it } from 'vitest';

import { createSaleSyncClient, toWireBody } from '../create-sale-sync-client.js';
import type { CaptureSalePayload } from '../capture-payload.js';

const BASE = 'https://example.invalid';
const ENVELOPE = 'opaque-pos-operator-envelope-abc';
const DEVICE_TOKEN = 'device-token-SECRET-xyz';
const USER = '0190a3c4-0000-7000-8000-00000000000a';
const SALE_REF = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b';

const PAYLOAD: CaptureSalePayload = {
  externalId: 'pos-pulse:handoff-1',
  sourceSystem: 'pos-pulse',
  tenantId: 't1',
  branchId: 'b1',
  terminalId: 'term-1',
  operatorId: 'op-1',
  occurredAt: '2026-06-09T10:00:00.000Z',
  totalMinor: 1000,
  lines: [
    {
      lineRef: 'l1',
      productRef: 'p1',
      lineName: 'Panadol',
      quantity: 1,
      unitPriceMinor: 1000,
      lineAmountMinor: 1000,
    },
  ],
};

interface Captured {
  url: string;
  init: RequestInit;
}

function fetchAnswering(
  status: number | 'reject',
  body: string | null = null,
  headers: Record<string, string> = {},
): {
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: String(input instanceof Request ? input.url : input), init: init ?? {} });
    if (status === 'reject') return Promise.reject(new Error('network down'));
    return Promise.resolve(new Response(body, { status, headers }));
  };
  return { fetchImpl, captured };
}

function client(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  device: string | null = DEVICE_TOKEN,
) {
  return createSaleSyncClient({
    baseUrl: BASE,
    fetch: fetchImpl,
    getOperatorToken: () => ENVELOPE,
    getDeviceToken: () => Promise.resolve(device),
    currentTerminalId: () => PAYLOAD.terminalId,
  });
}

const header = (c: Captured, name: string): string | null =>
  (c.init.headers as Record<string, string> | undefined)?.[name] ?? null;
/** The client always sends a JSON string body. */
const rawBody = (c: Captured): string => {
  if (typeof c.init.body !== 'string') throw new Error('expected a string body');
  return c.init.body;
};
const body = (c: Captured): Record<string, unknown> =>
  JSON.parse(rawBody(c)) as Record<string, unknown>;

describe('RT-224 step 2 — postSaleAsCashier request', () => {
  it('POSTs /api/pos/v1/sales with the device bearer, the idempotency key and operatorUserId', async () => {
    const { fetchImpl, captured } = fetchAnswering(201, JSON.stringify({ saleRef: SALE_REF }));
    const result = await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER);
    expect(result).toEqual({ kind: 'ok', saleRef: SALE_REF });
    expect(captured).toHaveLength(1);
    const req = captured[0] as Captured;
    expect(req.url).toBe(`${BASE}/api/pos/v1/sales`);
    expect(req.init.method).toBe('POST');
    expect(header(req, 'Authorization')).toBe(`Bearer ${DEVICE_TOKEN}`);
    expect(header(req, 'Idempotency-Key')).toBe(PAYLOAD.externalId);
    expect(body(req)).toEqual({ ...toWireBody(PAYLOAD, 'EGP'), operatorUserId: USER });
  });

  it('never puts the device token or the envelope in the body', async () => {
    const { fetchImpl, captured } = fetchAnswering(201, '{}');
    await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER);
    const raw = rawBody(captured[0] as Captured);
    expect(raw).not.toContain(DEVICE_TOKEN);
    expect(raw).not.toContain(ENVELOPE);
  });

  it('with no device token: no request, and the sale stays queued (no_connection)', async () => {
    for (const token of [null, '']) {
      const { fetchImpl, captured } = fetchAnswering(201, '{}');
      expect(await client(fetchImpl, token).postSaleAsCashier(PAYLOAD, USER)).toEqual({
        kind: 'no_connection',
      });
      expect(captured).toHaveLength(0);
    }
  });

  it('with no device-token reader wired at all: no request (no_connection)', async () => {
    const { fetchImpl, captured } = fetchAnswering(201, '{}');
    const c = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => ENVELOPE,
    });
    expect(await c.postSaleAsCashier(PAYLOAD, USER)).toEqual({ kind: 'no_connection' });
    expect(captured).toHaveLength(0);
  });
});

describe('RT-224 step 2 (Codex P2) — a device-token read failure never rejects', () => {
  it('getDeviceToken rejecting → no request, no_connection (the client never rejects)', async () => {
    const { fetchImpl, captured } = fetchAnswering(201, '{}');
    const c = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => ENVELOPE,
      getDeviceToken: () => Promise.reject(new Error('DPAPI failure')),
      currentTerminalId: () => PAYLOAD.terminalId,
    });
    await expect(c.postSaleAsCashier(PAYLOAD, USER)).resolves.toEqual({ kind: 'no_connection' });
    expect(captured).toHaveLength(0);
  });
});

describe('RT-224 step 2 (Codex P2 on 0020877) — the send is bound to the sale’s terminal', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function racingClient() {
    const { fetchImpl, captured } = fetchAnswering(201, '{}');
    let terminal: string | null = PAYLOAD.terminalId;
    let pending = deferred<string | null>();
    let tokenReads = 0;
    const changes: unknown[][] = [];
    const c = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => ENVELOPE,
      getDeviceToken: () => {
        tokenReads += 1;
        return pending.promise;
      },
      currentTerminalId: () => terminal,
      onDeviceTerminalChanged: (...args: unknown[]) => changes.push(args),
    });
    return {
      c,
      captured,
      changes,
      reads: () => tokenReads,
      rePair: (next: string) => {
        terminal = next;
      },
      resolveRead: (token: string | null) => {
        pending.resolve(token);
      },
      reArm: () => {
        pending = deferred<string | null>();
      },
    };
  }

  it('a re-pair while the token read is pending: no request, no_connection (never dead-lettered), reported once', async () => {
    const r = racingClient();
    const first = r.c.postSaleAsCashier(PAYLOAD, USER);
    await Promise.resolve();
    expect(r.reads()).toBe(1);
    r.rePair('term-NEW');
    r.resolveRead('new-device-token');
    expect(await first).toEqual({ kind: 'no_connection' });
    expect(r.captured).toHaveLength(0);
    // A second sale of the old pairing: still not sent, not reported again.
    r.reArm();
    r.resolveRead('new-device-token');
    expect(await r.c.postSaleAsCashier(PAYLOAD, USER)).toEqual({ kind: 'no_connection' });
    expect(r.captured).toHaveLength(0);
    expect(r.changes).toEqual([[]]);
  });

  it('the same terminal before and after the read: sent, and the report re-arms', async () => {
    const r = racingClient();
    r.resolveRead(DEVICE_TOKEN);
    expect((await r.c.postSaleAsCashier(PAYLOAD, USER)).kind).toBe('ok');
    expect(r.captured).toHaveLength(1);
    r.rePair('term-NEW');
    await r.c.postSaleAsCashier(PAYLOAD, USER);
    r.rePair(PAYLOAD.terminalId);
    await r.c.postSaleAsCashier(PAYLOAD, USER);
    r.rePair('term-NEWER');
    await r.c.postSaleAsCashier(PAYLOAD, USER);
    expect(r.changes).toEqual([[], []]);
    expect(r.captured).toHaveLength(2);
  });

  it('unpaired after the read (no current terminal) → not sent', async () => {
    const r = racingClient();
    const sent = r.c.postSaleAsCashier(PAYLOAD, USER);
    await Promise.resolve();
    r.rePair(null as unknown as string);
    r.resolveRead(DEVICE_TOKEN);
    expect(await sent).toEqual({ kind: 'no_connection' });
    expect(r.captured).toHaveLength(0);
  });

  it('no current-terminal reader wired → fail closed (not sent)', async () => {
    const { fetchImpl, captured } = fetchAnswering(201, '{}');
    const c = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => ENVELOPE,
      getDeviceToken: () => Promise.resolve(DEVICE_TOKEN),
    });
    expect(await c.postSaleAsCashier(PAYLOAD, USER)).toEqual({ kind: 'no_connection' });
    expect(captured).toHaveLength(0);
  });
});

describe('RT-224 step 2 (Codex P2 on 988a238) — token and terminal come from one pairing', () => {
  /**
   * `PairingStore.persist` writes the new device token, then (after ONE await)
   * the new terminal row. Model a re-pair that advances one step at each of the
   * client's awaits: step `s` (new token) lands in slot `sAt`, step `r` (new
   * terminal) in the same or the next slot. Slot 0 is before the send starts;
   * slot i is the client's i-th await; NEVER = after the request. The token is
   * read either when the read is called or when it resolves.
   */
  type ReadAt = 'call' | 'resolve';
  const NEVER = 99;

  async function sendDuringRePair(readAt: ReadAt, sAt: number, rAt: number) {
    const store = { token: 'old-device-token', terminal: PAYLOAD.terminalId };
    const steps: Array<{ at: number; run: () => void }> = [
      { at: sAt, run: () => (store.token = 'new-device-token') },
      { at: rAt, run: () => (store.terminal = 'term-NEW') },
    ];
    const advance = (slot: number) => {
      for (const step of steps) if (step.at === slot) step.run();
    };
    let slot = 0;
    advance(0);
    const { fetchImpl, captured } = fetchAnswering(201, '{}');
    const c = createSaleSyncClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      getOperatorToken: () => ENVELOPE,
      getDeviceToken: async () => {
        const atCall = store.token;
        await Promise.resolve();
        slot += 1;
        advance(slot);
        return readAt === 'call' ? atCall : store.token;
      },
      currentTerminalId: () => store.terminal,
    });
    const result = await c.postSaleAsCashier(PAYLOAD, USER);
    const sentTokens = captured.map((req) => header(req, 'Authorization'));
    return { result, sentTokens };
  }

  const schedules: Array<[ReadAt, number, number]> = [];
  for (const readAt of ['call', 'resolve'] as const) {
    for (let sAt = 0; sAt <= 3; sAt += 1) {
      for (const rAt of [sAt, sAt + 1, NEVER]) {
        // `r` follows `s` by at most one await (persist's single await) — except
        // NEVER, which models a re-pair starting after the send was decided.
        if (rAt === NEVER && sAt < 3) continue;
        schedules.push([readAt, sAt, rAt]);
      }
    }
  }

  it.each(schedules)(
    'read at %s, new token at slot %i, new terminal at slot %i: never sends the new token for the old terminal’s sale',
    async (readAt, sAt, rAt) => {
      const { result, sentTokens } = await sendDuringRePair(readAt, sAt, rAt);
      expect(sentTokens).not.toContain('Bearer new-device-token');
      if (sentTokens.length === 0) expect(result).toEqual({ kind: 'no_connection' });
    },
  );

  it.each<[string, Array<string | null>]>([
    ['rotated', ['device-token-A', 'device-token-B']],
    ['removed (e.g. revoked / unpaired)', ['device-token-A', null]],
  ])(
    'the device credential is %s between the two reads (same terminal): not sent, never dead-lettered',
    async (_label, tokens) => {
      const { fetchImpl, captured } = fetchAnswering(201, '{}');
      const queue = [...tokens];
      const c = createSaleSyncClient({
        baseUrl: BASE,
        fetch: fetchImpl,
        getOperatorToken: () => ENVELOPE,
        getDeviceToken: () => Promise.resolve(queue.shift() ?? null),
        currentTerminalId: () => PAYLOAD.terminalId,
      });
      expect(await c.postSaleAsCashier(PAYLOAD, USER)).toEqual({ kind: 'no_connection' });
      expect(captured).toHaveLength(0);
    },
  );

  it('no re-pair: sent once with the token', async () => {
    const { result, sentTokens } = await sendDuringRePair('resolve', NEVER, NEVER);
    expect(result.kind).toBe('ok');
    expect(sentTokens).toEqual(['Bearer old-device-token']);
  });
});

describe('RT-224 step 2 — the envelope request is unchanged', () => {
  it('postSale carries the envelope and NO operatorUserId', async () => {
    const { fetchImpl, captured } = fetchAnswering(201, '{}');
    await client(fetchImpl).postSale(PAYLOAD);
    const req = captured[0] as Captured;
    expect(header(req, 'Authorization')).toBe(`Bearer ${ENVELOPE}`);
    expect('operatorUserId' in body(req)).toBe(false);
    expect(body(req)).toEqual(toWireBody(PAYLOAD, 'EGP'));
  });

  it.each([401, 403])('an envelope %s is still transient (unchanged)', async (status) => {
    const { fetchImpl } = fetchAnswering(status);
    expect(await client(fetchImpl).postSale(PAYLOAD)).toEqual({ kind: 'transient' });
  });
});

describe('RT-224 step 2 — device-path status mapping', () => {
  it('403 → refused (a per-sale refusal, never device-revoked)', async () => {
    const { fetchImpl } = fetchAnswering(403, JSON.stringify({ code: 'refused' }));
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({ kind: 'refused' });
  });

  it('403 with any body (or none) → refused: the status alone decides', async () => {
    const { fetchImpl } = fetchAnswering(403, 'not json');
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({ kind: 'refused' });
  });

  it('401 → device_unauthorized', async () => {
    const { fetchImpl } = fetchAnswering(401);
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({
      kind: 'device_unauthorized',
    });
  });

  it.each<[number, unknown]>([
    [400, { kind: 'permanent' }],
    [422, { kind: 'permanent' }],
    [500, { kind: 'transient' }],
    [503, { kind: 'transient' }],
  ])('%s → %j (same as the envelope path)', async (status, expected) => {
    const { fetchImpl } = fetchAnswering(status);
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual(expected);
  });

  it('409 → divergent with the closed-set code', async () => {
    const { fetchImpl } = fetchAnswering(
      409,
      JSON.stringify({ error: { code: 'idempotency_key_conflict' } }),
    );
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({
      kind: 'divergent',
      errorCode: 'idempotency_key_conflict',
    });
  });

  it('200 replay → ok with the saleRef', async () => {
    const { fetchImpl } = fetchAnswering(200, JSON.stringify({ saleRef: SALE_REF }));
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({
      kind: 'ok',
      saleRef: SALE_REF,
    });
  });

  it('425 → transient with Retry-After', async () => {
    const { fetchImpl } = fetchAnswering(425, null, { 'Retry-After': '2' });
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({
      kind: 'transient',
      retryAfterMs: 2000,
    });
  });

  it('a transport fault → no_connection', async () => {
    const { fetchImpl } = fetchAnswering('reject');
    expect(await client(fetchImpl).postSaleAsCashier(PAYLOAD, USER)).toEqual({
      kind: 'no_connection',
    });
  });
});
