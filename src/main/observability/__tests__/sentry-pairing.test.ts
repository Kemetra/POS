import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createPairingService } from '../../pairing/service.js';
import { createPairingLog } from '../../pairing/log.js';
import { TransportError } from '../../pairing/network.js';
import type { PairingStore } from '../../pairing/store.js';
import type { Network } from '../../pairing/network.js';

/**
 * 002-terminal-pairing T064 (US6) — Sentry breadcrumb behaviour test.
 *
 * Requirements asserted here:
 *   - With mocked Sentry + DSN set: each pairing outcome adds exactly one
 *     breadcrumb with category="pairing" carrying `outcome` and HTTP
 *     `status` fields in `data`, and nothing else that could be a secret.
 *   - Breadcrumb data carries ONLY outcome and status — no pairing_code,
 *     no device_token, no request body, no response body.
 *   - Sentry is inert without a DSN (addBreadcrumb is a no-op in tests
 *     where the mock is cleared; the inertness guarantee is proven by
 *     initSentryMain tests in sentry-main.test.ts).
 *
 * T065 lands the implementation in service.ts.
 *
 * Security policy (Constitution VII + spec FR-10 / NFR-4):
 *   - The breadcrumb `data` object is schema-restricted: only `outcome`
 *     (category string) and `status` (integer or null) are permitted.
 */

// ─── Sentry mock ─────────────────────────────────────────────────────────────

vi.mock('@sentry/electron/main', () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureEvent: vi.fn(),
  init: vi.fn(),
}));

// ─── Harness helpers ─────────────────────────────────────────────────────────

function makeFakePairingLog(): ReturnType<typeof createPairingLog> {
  return () => {
    /* no-op in Sentry-focused tests */
  };
}

function makeStore(): PairingStore {
  return {
    persist: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
    getStatus: vi.fn(() => Promise.resolve({ kind: 'unpaired' as const })),
    getCurrentTerminalId: vi.fn(() => null),
  };
}

function makeNetwork(
  result:
    | { type: 'success' }
    | { type: 'failure'; status: number; code: string; retry_after_s?: number }
    | { type: 'transport'; timed_out: boolean },
): Network {
  return {
    pair: vi.fn(() => {
      if (result.type === 'success') {
        return Promise.resolve({
          ok: true as const,
          status: 200 as const,
          body: {
            device_token: 'opaque-token',
            tenant_id: 't1',
            branch_id: 'b1',
            terminal_id: 'term-1',
            terminal_label: 'Counter 1',
            // 6 new fields pinned 2026-05-28 from Data-Pulse-2 PR #388.
            branch_name: 'Test Branch',
            branch_address: '12 Test Road',
            tenant_tax_registration_id: '123456789',
            printer_vendor_id: '0x04B8',
            printer_product_id: '0x0202',
            printer_com_port: null,
          },
        });
      }
      if (result.type === 'transport') {
        return Promise.reject(
          new TransportError({
            timed_out: result.timed_out,
            reason: result.timed_out ? 'timeout' : 'fetch_failed',
          }),
        );
      }
      const envelope: {
        ok: false;
        status: number;
        body: { error: { code: string } };
        retry_after_s?: number;
      } = {
        ok: false,
        status: result.status,
        body: { error: { code: result.code } },
      };
      if (result.retry_after_s !== undefined) envelope.retry_after_s = result.retry_after_s;
      return Promise.resolve(envelope);
    }),
  };
}

function getFirstBreadcrumb(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const arg: unknown = mock.mock.calls[0]?.[0];
  if (typeof arg !== 'object' || arg === null) {
    throw new Error('No breadcrumb call was captured');
  }
  return arg as Record<string, unknown>;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Sentry pairing breadcrumbs — T064', () => {
  let addBreadcrumbMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const sentry = await import('@sentry/electron/main');
    addBreadcrumbMock = sentry.addBreadcrumb as ReturnType<typeof vi.fn>;
    vi.clearAllMocks();
  });

  // ── per-outcome: one breadcrumb per submit ─────────────────────────────────

  it('success: adds exactly one breadcrumb with category="pairing"', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'success' }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(getFirstBreadcrumb(addBreadcrumbMock)['category']).toBe('pairing');
  });

  it('invalid_code: adds exactly one breadcrumb with category="pairing"', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'failure', status: 400, code: 'INVALID_CODE' }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(getFirstBreadcrumb(addBreadcrumbMock)['category']).toBe('pairing');
  });

  it('expired_code: adds exactly one breadcrumb with category="pairing"', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'failure', status: 410, code: 'EXPIRED_CODE' }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(getFirstBreadcrumb(addBreadcrumbMock)['category']).toBe('pairing');
  });

  it('already_paired: adds exactly one breadcrumb with category="pairing"', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'failure', status: 409, code: 'ALREADY_PAIRED' }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(getFirstBreadcrumb(addBreadcrumbMock)['category']).toBe('pairing');
  });

  it('branch_mismatch: adds exactly one breadcrumb with category="pairing"', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'failure', status: 409, code: 'BRANCH_MISMATCH' }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(getFirstBreadcrumb(addBreadcrumbMock)['category']).toBe('pairing');
  });

  it('rate_limited: adds exactly one breadcrumb with category="pairing"', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({
        type: 'failure',
        status: 429,
        code: 'RATE_LIMITED',
        retry_after_s: 30,
      }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(getFirstBreadcrumb(addBreadcrumbMock)['category']).toBe('pairing');
  });

  it('network_error: adds exactly one breadcrumb with category="pairing"', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'transport', timed_out: false }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(getFirstBreadcrumb(addBreadcrumbMock)['category']).toBe('pairing');
  });

  it('unknown_error: adds exactly one breadcrumb with category="pairing"', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'failure', status: 500, code: 'UNKNOWN_BACKEND_ERROR' }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(getFirstBreadcrumb(addBreadcrumbMock)['category']).toBe('pairing');
  });

  // ── breadcrumb data shape ─────────────────────────────────────────────────

  it('breadcrumb data contains outcome field matching the resolved outcome', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'success' }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    const crumb = getFirstBreadcrumb(addBreadcrumbMock);
    const data = crumb['data'] as Record<string, unknown>;
    expect(typeof data['outcome']).toBe('string');
    expect(data['outcome']).toBe('success');
  });

  it('breadcrumb data for HTTP failure contains the HTTP status code', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'failure', status: 400, code: 'INVALID_CODE' }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    const data = getFirstBreadcrumb(addBreadcrumbMock)['data'] as Record<string, unknown>;
    expect(data['status']).toBe(400);
  });

  it('breadcrumb data for transport failure has status null (no HTTP status)', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'transport', timed_out: false }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    const data = getFirstBreadcrumb(addBreadcrumbMock)['data'] as Record<string, unknown>;
    expect(data['status']).toBeNull();
  });

  // ── no secret fields in breadcrumb ────────────────────────────────────────

  it('breadcrumb contains no pairing_code (submitted secret)', async () => {
    const SECRET = 'MY-SECRET-PAIR-CODE-7777';
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'failure', status: 400, code: 'INVALID_CODE' }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit(SECRET);

    expect(JSON.stringify(addBreadcrumbMock.mock.calls)).not.toContain(SECRET);
  });

  it('breadcrumb contains no device_token (returned secret)', async () => {
    const service = createPairingService({
      store: makeStore(),
      network: makeNetwork({ type: 'success' }),
      pairingLog: makeFakePairingLog(),
      clock: () => new Date('2026-05-04T12:00:00.000Z'),
    });
    await service.submit('CODE');

    expect(JSON.stringify(addBreadcrumbMock.mock.calls)).not.toContain('opaque-token');
  });
});
