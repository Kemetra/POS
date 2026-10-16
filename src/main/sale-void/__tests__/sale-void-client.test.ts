/**
 * RT-530 — the void client: one POST under the requester's envelope, with the
 * journaled bytes and key, and every Backend-Core answer mapped to a recorded,
 * refused or unknown outcome. `unknown` is never success.
 */
import { describe, expect, it, vi } from 'vitest';

import { createSaleVoidClient, classifyVoidRefusal } from '../sale-void-client.js';
import { buildVoidBody, buildVoidBodyJson } from '../sale-void-wire.js';
import {
  APPROVAL_A,
  APPROVER_USER,
  REQUESTER_USER,
  SALE_REF,
  newVoidEntry,
} from './__helpers__/sale-void-fixture.js';
import type { VoidEntry } from '../sale-void-repository.js';

const EVENT_REF = '0190f5a2-7b3c-7d4e-8f90-0000000000e1';
const ENVELOPE = 'envelope-secret-value';

function entryRow(): VoidEntry {
  const { now, ...rest } = newVoidEntry(1);
  return {
    ...rest,
    state: 'pending',
    refusalReason: null,
    voidRef: null,
    attemptCount: 0,
    lastAttemptAt: null,
    lastErrorCategory: null,
    confirmedAt: null,
    acknowledgedAt: null,
    requestedAt: now,
  };
}

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const REQUEST = {
  saleRef: SALE_REF,
  bodyJson: buildVoidBodyJson(entryRow(), SALE_REF),
  idempotencyKey: entryRow().externalId,
};

function clientWith(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(fetchImpl);
  const client = createSaleVoidClient({
    baseUrl: 'https://api.example.test/',
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

describe('void wire body', () => {
  it('carries the bound evidence with the sale total as an exact decimal', () => {
    expect(buildVoidBody(entryRow(), SALE_REF)).toEqual({
      sourceSystem: 'pos-pulse',
      externalId: entryRow().externalId,
      businessDate: '2026-06-07',
      approval: {
        approvalId: APPROVAL_A,
        action: 'sale.void',
        saleRef: SALE_REF,
        amount: '15.00',
        requesterUserId: REQUESTER_USER,
        approverUserId: APPROVER_USER,
        policyVersion: 'rt114-2026-10-07',
        approvedAt: '2026-06-07T10:05:00.000Z',
      },
    });
  });

  it('is byte-identical on every build', () => {
    expect(buildVoidBodyJson(entryRow(), SALE_REF)).toBe(buildVoidBodyJson(entryRow(), SALE_REF));
  });

  it('carries no secret-shaped key', () => {
    const text = buildVoidBodyJson(entryRow(), SALE_REF);
    for (const forbidden of ['pin', 'envelope', 'token', 'password']) {
      expect(text.toLowerCase()).not.toContain(`"${forbidden}"`);
    }
  });
});

describe('void client request', () => {
  it('POSTs the journaled bytes to the sale void route with the key and the requester envelope', async () => {
    const { client, fetchMock } = clientWith(() =>
      Promise.resolve(answer(201, { kind: 'void', eventRef: EVENT_REF, saleRef: SALE_REF })),
    );
    await client.recordVoid(REQUEST, ENVELOPE);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.example.test/api/pos/v1/sales/${SALE_REF}/void`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(REQUEST.bodyJson);
    expect(init.headers).toMatchObject({
      'Idempotency-Key': REQUEST.idempotencyKey,
      Authorization: `Bearer ${ENVELOPE}`,
    });
  });

  it.each([null, ''])('sends nothing without an envelope (%j)', async (envelope) => {
    const { client, fetchMock } = clientWith(() => Promise.reject(new Error('must not be called')));
    expect(await client.recordVoid(REQUEST, envelope)).toEqual({
      kind: 'unknown',
      category: 'no_credential',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed sale reference without a request', async () => {
    const { client, fetchMock } = clientWith(() => Promise.reject(new Error('must not be called')));
    expect(await client.recordVoid({ ...REQUEST, saleRef: 'not-a-uuid' }, ENVELOPE)).toEqual({
      kind: 'refused',
      reason: 'sale_not_found',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('void client outcomes', () => {
  const recorded = { kind: 'void', eventRef: EVENT_REF, saleRef: SALE_REF };

  it('201 is recorded; 200 and the replay header are replays', async () => {
    const created = clientWith(() => Promise.resolve(answer(201, recorded)));
    expect(await created.client.recordVoid(REQUEST, ENVELOPE)).toEqual({
      kind: 'recorded',
      replayed: false,
      eventRef: EVENT_REF,
    });
    const ok = clientWith(() => Promise.resolve(answer(200, recorded)));
    expect(await ok.client.recordVoid(REQUEST, ENVELOPE)).toMatchObject({ replayed: true });
    const header = clientWith(() =>
      Promise.resolve(answer(201, recorded, { 'Idempotent-Replayed': 'true' })),
    );
    expect(await header.client.recordVoid(REQUEST, ENVELOPE)).toMatchObject({ replayed: true });
  });

  it.each([
    ['another sale', { ...recorded, saleRef: '0190f5a2-7b3c-7d4e-8f90-0000000000c2' }],
    ['not a void', { ...recorded, kind: 'refund' }],
    ['no event reference', { kind: 'void', saleRef: SALE_REF }],
    ['not an object', 'ok'],
  ])('a 2xx answer for %s is unknown, never success', async (_label, body) => {
    const { client } = clientWith(() => Promise.resolve(answer(201, body)));
    expect(await client.recordVoid(REQUEST, ENVELOPE)).toEqual({
      kind: 'unknown',
      category: 'unreadable_answer',
    });
  });

  it.each([
    [403, 'void_approval_required'],
    [403, 'void_requester_mismatch'],
    [403, 'void_requester_not_eligible'],
    [403, 'void_self_approval'],
    [403, 'void_approver_not_eligible'],
    [422, 'void_approval_invalid'],
    [422, 'void_outside_business_day'],
    [409, 'already_reversed'],
  ])('%i %s is a terminal refusal with that code', async (status, code) => {
    const { client } = clientWith(() => Promise.resolve(answer(status, { error: { code } })));
    expect(await client.recordVoid(REQUEST, ENVELOPE)).toEqual({ kind: 'refused', reason: code });
  });

  it.each([
    [400, 'validation_error', 'validation_error'],
    [404, 'not_found', 'sale_not_found'],
    [409, 'conflict', 'conflict'],
    [409, 'idempotency_key_conflict', 'conflict'],
    [422, 'something_else', 'validation_error'],
  ])('%i %s maps to %s', async (status, code, reason) => {
    const { client } = clientWith(() => Promise.resolve(answer(status, { error: { code } })));
    expect(await client.recordVoid(REQUEST, ENVELOPE)).toEqual({ kind: 'refused', reason });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'server_error'],
    [429, 'server_error'],
    [500, 'server_error'],
    [503, 'server_error'],
  ])('%i proves nothing: unknown (%s), the void stays queued', async (status, category) => {
    const { client } = clientWith(() =>
      Promise.resolve(answer(status, { error: { code: 'refused' } })),
    );
    expect(await client.recordVoid(REQUEST, ENVELOPE)).toEqual({ kind: 'unknown', category });
  });

  it('a network failure or timeout is unknown (no_connection)', async () => {
    const { client } = clientWith(() => Promise.reject(new Error('ECONNRESET')));
    expect(await client.recordVoid(REQUEST, ENVELOPE)).toEqual({
      kind: 'unknown',
      category: 'no_connection',
    });
  });

  it('classifyVoidRefusal returns null for an answer that proves nothing', () => {
    expect(classifyVoidRefusal(500, null)).toBeNull();
    expect(classifyVoidRefusal(403, 'refused')).toBeNull();
    expect(classifyVoidRefusal(401, 'void_self_approval')).toBeNull();
  });
});
