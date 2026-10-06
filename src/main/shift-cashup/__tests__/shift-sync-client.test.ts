/**
 * RT-17 slice 3 part 2 — `createShiftSyncClient`: the device-path sender of the
 * shift outbox (`pos-shifts.openapi.yaml` 1.1.0-draft).
 *
 *   • The STORED request bytes and the STORED Idempotency-Key are sent as they
 *     are, with the paired terminal's device bearer, on the path of the fact's
 *     kind and shift id.
 *   • The HTTP answer maps onto a closed outcome union: 2xx synced, 425 / 429 /
 *     5xx / transport retried (honouring `Retry-After`), 400 / 404 / 409 / 422
 *     dead-lettered with the contract code, 403 `cashier_claim_refused`, 401
 *     `device_unauthorized` (never a dead letter).
 *   • A fact is sent only under its own terminal's device token; an envelope
 *     repair row is never sent with the device bearer.
 *   • Every answer is reported to the RT-215 device-401 detector.
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  freshSalesSyncDb,
  handleFor,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createShiftCashupRepo, type QueuedShiftFact } from '../shift-cashup-repo.js';
import {
  createShiftSyncClient,
  SHIFT_SYNC_DEVICE_SOURCE,
  shiftFactPath,
  type CreateShiftSyncClientDeps,
  type ShiftSyncClient,
  type ShiftSyncResult,
} from '../shift-sync-client.js';
import { S1, SCOPE, wholeShiftFacts } from './__helpers__/shift-sync-fixture.js';

const BASE = 'https://backend-core.example.invalid';
const DEVICE_TOKEN = 'device-token-under-test';
const TERMINAL = SCOPE.terminalId;

let db: SqlJsDatabase;
let OPEN_FACT: QueuedShiftFact;
let MOVEMENT_FACT: QueuedShiftFact;
let CLOSE_FACT: QueuedShiftFact;

beforeAll(async () => {
  await initSalesSyncSql();
  db = freshSalesSyncDb();
  [OPEN_FACT, MOVEMENT_FACT, CLOSE_FACT] = wholeShiftFacts({
    repo: createShiftCashupRepo(handleFor(db)),
  }) as [QueuedShiftFact, QueuedShiftFact, QueuedShiftFact];
});

afterAll(() => {
  db.close();
});

interface Sent {
  url: string;
  init: RequestInit;
}

type Answer = Response | 'reject';

interface Harness {
  client: ShiftSyncClient;
  sent: Sent[];
  observe: ReturnType<typeof vi.fn>;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function harness(
  input: { answer?: Answer; deps?: Partial<CreateShiftSyncClientDeps> } = {},
): Harness {
  const sent: Sent[] = [];
  const answer = input.answer ?? new Response('{}', { status: 201 });
  const observe = vi.fn();
  const client = createShiftSyncClient({
    baseUrl: BASE,
    fetch: (req, init) => {
      sent.push({ url: urlOf(req), init: init ?? {} });
      return answer === 'reject' ? Promise.reject(new Error('offline')) : Promise.resolve(answer);
    },
    detector: { observe },
    getDeviceToken: () => Promise.resolve(DEVICE_TOKEN),
    currentTerminalId: () => TERMINAL,
    nowMs: () => Date.parse('2026-10-05T16:00:00.000Z'),
    ...input.deps,
  });
  return { client, sent, observe };
}

/** Send `fact` through the client method of its kind. */
function sendFact(client: ShiftSyncClient, fact: QueuedShiftFact): Promise<ShiftSyncResult> {
  const input = { terminalId: TERMINAL, fact };
  const send = {
    open: () => client.openShift(input),
    movement: () => client.recordCashMovement(input),
    close: () => client.closeShift(input),
  }[fact.factKind];
  return send();
}

function errorBody(code: string): string {
  return JSON.stringify({ error: { code, message: 'refused', request_id: S1 } });
}

function answer(input: { status: number; body?: string; headers?: HeadersInit }): Response {
  return new Response(input.body ?? null, { status: input.status, headers: input.headers ?? {} });
}

describe('shiftFactPath', () => {
  it.each([
    ['open', '/api/pos/v1/shifts'],
    ['movement', `/api/pos/v1/shifts/${S1}/cash-movements`],
    ['close', `/api/pos/v1/shifts/${S1}/close`],
  ] as const)('%s → %s', (factKind, path) => {
    expect(shiftFactPath({ factKind, shiftId: S1 })).toBe(path);
  });

  it('encodes the shift id as one path segment', () => {
    expect(shiftFactPath({ factKind: 'close', shiftId: 'a/b?c' })).toBe(
      '/api/pos/v1/shifts/a%2Fb%3Fc/close',
    );
  });
});

describe('createShiftSyncClient — the request', () => {
  it.each([
    ['open', () => OPEN_FACT, '/api/pos/v1/shifts'],
    ['movement', () => MOVEMENT_FACT, `/api/pos/v1/shifts/${S1}/cash-movements`],
    ['close', () => CLOSE_FACT, `/api/pos/v1/shifts/${S1}/close`],
  ] as const)(
    '%s: POSTs the stored bytes and key with the device bearer',
    async (_k, fact, path) => {
      const { client, sent } = harness();
      await sendFact(client, fact());
      expect(sent).toHaveLength(1);
      const [req] = sent as [Sent];
      expect(req.url).toBe(`${BASE}${path}`);
      expect(req.init.method).toBe('POST');
      expect(req.init.body).toBe(fact().requestBody);
      const headers = new Headers(req.init.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${DEVICE_TOKEN}`);
      expect(headers.get('Idempotency-Key')).toBe(fact().idempotencyKey);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(req.init.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it('drops a trailing slash from the base URL', async () => {
    const { client, sent } = harness({ deps: { baseUrl: `${BASE}/` } });
    await sendFact(client, OPEN_FACT);
    expect(sent[0]?.url).toBe(`${BASE}/api/pos/v1/shifts`);
  });

  it('never puts the device token in the URL or the body', async () => {
    const { client, sent } = harness();
    await sendFact(client, CLOSE_FACT);
    expect(sent[0]?.url).not.toContain(DEVICE_TOKEN);
    expect(sent[0]?.init.body).toBe(CLOSE_FACT.requestBody);
    expect(CLOSE_FACT.requestBody).not.toContain(DEVICE_TOKEN);
  });
});

describe('createShiftSyncClient — outcome mapping', () => {
  const REPLAYED = { 'Idempotent-Replayed': 'true' };

  it.each([
    ['201 first record', answer({ status: 201 }), { kind: 'ok' }],
    ['200 natural-key replay', answer({ status: 200, headers: REPLAYED }), { kind: 'ok' }],
    ['201 key replay', answer({ status: 201, headers: REPLAYED }), { kind: 'ok' }],
    ['500', answer({ status: 500 }), { kind: 'transient' }],
    ['503', answer({ status: 503 }), { kind: 'transient' }],
    ['204 (unexpected 2xx)', answer({ status: 204 }), { kind: 'transient' }],
    ['304 (unexpected 3xx)', answer({ status: 304 }), { kind: 'transient' }],
    [
      '425 + Retry-After',
      answer({ status: 425, headers: { 'Retry-After': '2' } }),
      { kind: 'transient', retryAfterMs: 2_000 },
    ],
    [
      '429 + Retry-After',
      answer({ status: 429, headers: { 'Retry-After': '7' } }),
      { kind: 'transient', retryAfterMs: 7_000 },
    ],
    [
      '429 + HTTP-date Retry-After',
      answer({ status: 429, headers: { 'Retry-After': 'Mon, 05 Oct 2026 16:00:30 GMT' } }),
      { kind: 'transient', retryAfterMs: 30_000 },
    ],
    ['429 without Retry-After', answer({ status: 429 }), { kind: 'transient' }],
    [
      '503 + Retry-After (not honoured)',
      answer({ status: 503, headers: { 'Retry-After': '60' } }),
      { kind: 'transient' },
    ],
    [
      '401',
      answer({ status: 401, body: errorBody('unauthorized') }),
      { kind: 'device_unauthorized' },
    ],
    [
      '403 (any body)',
      answer({ status: 403, body: errorBody('shift_closed') }),
      { kind: 'rejected', reason: 'cashier_claim_refused' },
    ],
  ] as const)('%s', async (_name, response, expected) => {
    const { client } = harness({ answer: response });
    await expect(sendFact(client, CLOSE_FACT)).resolves.toEqual(expected);
  });

  it.each([
    [400, 'validation_error', 'validation_error'],
    [400, 'idempotency_key_malformed', 'rejected'],
    [400, 'idempotency_key_required', 'rejected'],
    [404, 'shift_not_found', 'shift_not_found'],
    [409, 'idempotency_key_conflict', 'idempotency_key_conflict'],
    [409, 'shift_payload_conflict', 'shift_payload_conflict'],
    [409, 'shift_already_open', 'shift_already_open'],
    [409, 'shift_closed', 'shift_closed'],
    [422, 'shift_cashup_inconsistent', 'shift_cashup_inconsistent'],
    [422, 'currency_mismatch', 'currency_mismatch'],
    [422, 'refund_ref_invalid', 'refund_ref_invalid'],
    [409, 'something_new', 'rejected'],
    [404, 'shift_closed', 'rejected'],
    [422, 'shift_not_found', 'rejected'],
    [410, 'gone', 'rejected'],
  ] as const)('%i %s → dead letter %s', async (status, code, reason) => {
    const { client } = harness({ answer: answer({ status, body: errorBody(code) }) });
    await expect(sendFact(client, CLOSE_FACT)).resolves.toEqual({ kind: 'rejected', reason });
  });

  it.each([
    ['not JSON', '<html>'],
    ['no error envelope', '{"code":"shift_closed"}'],
    ['a non-string code', '{"error":{"code":409}}'],
    ['an array', '[]'],
    ['empty', ''],
  ])('a 409 whose body is %s → dead letter `rejected`', async (_n, body) => {
    const { client } = harness({ answer: answer({ status: 409, body }) });
    await expect(sendFact(client, CLOSE_FACT)).resolves.toEqual({
      kind: 'rejected',
      reason: 'rejected',
    });
  });

  it('an unreadable refusal body → dead letter `rejected`', async () => {
    const response = answer({ status: 422, body: errorBody('refund_ref_invalid') });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('reset'));
    const { client } = harness({ answer: response });
    await expect(sendFact(client, CLOSE_FACT)).resolves.toEqual({
      kind: 'rejected',
      reason: 'rejected',
    });
  });

  it('a transport fault (offline, DNS, timeout) → no_connection', async () => {
    const { client } = harness({ answer: 'reject' });
    await expect(sendFact(client, CLOSE_FACT)).resolves.toEqual({ kind: 'no_connection' });
  });

  it('a failing clock leaves the normal backoff in charge (never rejects)', async () => {
    const { client } = harness({
      answer: answer({ status: 429, headers: { 'Retry-After': 'Mon, 05 Oct 2026 16:00:30 GMT' } }),
      deps: {
        nowMs: () => {
          throw new Error('clock');
        },
      },
    });
    await expect(sendFact(client, CLOSE_FACT)).resolves.toEqual({ kind: 'transient' });
  });
});

describe('createShiftSyncClient — never sent', () => {
  const ENVELOPE_ROW = (): QueuedShiftFact => ({ ...CLOSE_FACT, authPath: 'envelope' });

  it.each([
    ['an envelope repair row', () => ENVELOPE_ROW(), 'envelope_path'],
    [
      'a fact of another kind',
      () => ({ ...MOVEMENT_FACT, factKind: 'open' as const }),
      'kind_mismatch',
    ],
  ] as const)('%s → not_sent %s, no request', async (_n, fact, reason) => {
    const { client, sent } = harness();
    const result = await client.closeShift({ terminalId: TERMINAL, fact: fact() });
    expect(result).toEqual({ kind: 'not_sent', reason });
    expect(sent).toEqual([]);
  });

  it.each([
    ['null', () => Promise.resolve(null)],
    ['empty', () => Promise.resolve('')],
    ['a failing read', () => Promise.reject(new Error('dpapi'))],
  ] as const)('a device token that is %s → not_sent, no request', async (_n, read) => {
    const { client, sent } = harness({ deps: { getDeviceToken: read } });
    await expect(sendFact(client, OPEN_FACT)).resolves.toEqual({
      kind: 'not_sent',
      reason: 'no_device_credential',
    });
    expect(sent).toEqual([]);
  });

  /** A terminal read that answers `reads` in order, then repeats the last. */
  function terminalReads(reads: ReadonlyArray<string | null>): () => string | null {
    const queue = [...reads];
    return () => (queue.length > 1 ? (queue.shift() ?? null) : (queue[0] ?? null));
  }

  it.each([
    ['another terminal from the start', ['term-2']],
    ['unpaired', [null]],
    ['a re-pair during the token read', [TERMINAL, 'term-2']],
    ['a re-pair right before the request', [TERMINAL, TERMINAL, 'term-2']],
  ] as const)('%s → not_sent terminal_changed, no request', async (_n, reads) => {
    const { client, sent } = harness({ deps: { currentTerminalId: terminalReads(reads) } });
    await expect(sendFact(client, OPEN_FACT)).resolves.toEqual({
      kind: 'not_sent',
      reason: 'terminal_changed',
    });
    expect(sent).toEqual([]);
  });

  it('a failing terminal read → not_sent terminal_changed', async () => {
    const { client, sent } = harness({
      deps: {
        currentTerminalId: () => {
          throw new Error('pairing store');
        },
      },
    });
    await expect(sendFact(client, OPEN_FACT)).resolves.toMatchObject({ kind: 'not_sent' });
    expect(sent).toEqual([]);
  });

  it('a token that changes between the two reads (a re-pair) → not sent', async () => {
    const tokens = ['token-a', 'token-b'];
    const { client, sent } = harness({
      deps: { getDeviceToken: () => Promise.resolve(tokens.shift() ?? null) },
    });
    await expect(sendFact(client, OPEN_FACT)).resolves.toEqual({
      kind: 'not_sent',
      reason: 'terminal_changed',
    });
    expect(sent).toEqual([]);
  });
});

describe('createShiftSyncClient — RT-215 device-401 observation', () => {
  it('tags the shift sync device path with the existing `sale_sync` source', () => {
    expect(SHIFT_SYNC_DEVICE_SOURCE).toBe('sale_sync');
  });

  it.each([401, 201, 403, 409, 500])('reports a %i answer to the detector', async (status) => {
    const { client, observe } = harness({ answer: answer({ status }) });
    await sendFact(client, MOVEMENT_FACT);
    expect(observe).toHaveBeenCalledExactlyOnceWith('sale_sync', status);
  });

  it('reports nothing for a transport fault or a request never sent', async () => {
    const offline = harness({ answer: 'reject' });
    await sendFact(offline.client, MOVEMENT_FACT);
    const tokenless = harness({ deps: { getDeviceToken: () => Promise.resolve(null) } });
    await sendFact(tokenless.client, MOVEMENT_FACT);
    expect(offline.observe).not.toHaveBeenCalled();
    expect(tokenless.observe).not.toHaveBeenCalled();
  });

  it('a throwing detector never breaks the send', async () => {
    const { client } = harness({
      answer: answer({ status: 201 }),
      deps: {
        detector: {
          observe: () => {
            throw new Error('detector');
          },
        },
      },
    });
    await expect(sendFact(client, MOVEMENT_FACT)).resolves.toEqual({ kind: 'ok' });
  });
});
