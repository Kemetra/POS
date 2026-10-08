// @vitest-environment node
import { PassThrough } from 'stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';

import { createPairingLog } from '../main/pairing/log.js';
import { createPairingService } from '../main/pairing/service.js';
import { TransportError } from '../main/pairing/network.js';
import type { PairingStore } from '../main/pairing/store.js';
import type { Network } from '../main/pairing/network.js';

/**
 * 002-terminal-pairing T062 (US6) — cross-process redaction test.
 *
 * Drives all 8 outcome categories through the service and asserts that:
 *   1. The captured pino stream contains zero substring matches for
 *      the submitted pairing_code and any returned device_token.
 *   2. All Sentry.addBreadcrumb and Sentry.captureException invocations
 *      contain zero substring matches for the pairing_code and device_token.
 *
 * This test is the load-bearing FR-9 / FR-10 / NFR-4 contract.
 * DO NOT relax these assertions. If any assertion fails, tighten the
 * source (pairingLog schema, service.ts, Sentry wiring) — never the test.
 *
 * Vitest environment: node (not happy-dom) — this test runs main-process
 * code with a real pino PassThrough stream and no DOM dependency.
 */

// ─── Sentry mock ─────────────────────────────────────────────────────────────
// vi.mock is hoisted above imports by Vitest.

vi.mock('@sentry/electron/main', () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureEvent: vi.fn(),
  init: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SUBMITTED_CODE = 'SUPER-SECRET-PAIR-CODE-XYZ-9999';
const RETURNED_TOKEN = 'opaque-device-token-LEAKED-abcdef';

const SUCCESS_BODY = {
  device_token: RETURNED_TOKEN,
  tenant_id: 'tenant-A',
  branch_id: 'branch-B',
  terminal_id: 'terminal-C',
  terminal_label: 'Counter 1',
};

interface Streams {
  lines: () => string[];
}

function makeCapturingPinoLogger(): { logger: ReturnType<typeof pino>; streams: Streams } {
  const stream = new PassThrough();
  const buf: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => buf.push(chunk));

  const logger = pino(
    {
      level: 'info',
      redact: {
        paths: [
          'pairing_code',
          '*.pairing_code',
          '*.*.pairing_code',
          '*.*.*.pairing_code',
          'device_token',
          '*.device_token',
          '*.*.device_token',
          '*.*.*.device_token',
        ],
      },
    },
    stream,
  );

  return {
    logger,
    streams: {
      lines: () => {
        const text = Buffer.concat(buf).toString('utf8');
        return text.split('\n').filter((l) => l.length > 0);
      },
    },
  };
}

function makeStore(opts: { withPriorState?: boolean } = {}): PairingStore {
  const priorPaired = opts.withPriorState
    ? {
        kind: 'paired' as const,
        tenant_id: 'prior-tenant',
        branch_id: 'prior-branch',
        terminal_id: 'prior-terminal',
        terminal_label: 'Prior Counter',
        paired_at: 1700000000,
      }
    : ({ kind: 'unpaired' } as const);

  return {
    persist: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
    getStatus: vi.fn(() => Promise.resolve(priorPaired)),
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
        return Promise.resolve({ ok: true as const, status: 200 as const, body: SUCCESS_BODY });
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

async function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function assertNoSecretIn(haystack: string, context: string): void {
  if (haystack.includes(SUBMITTED_CODE)) {
    throw new Error(`[T062] pairing_code leaked in ${context}: "${SUBMITTED_CODE}" found`);
  }
  if (haystack.includes(RETURNED_TOKEN)) {
    throw new Error(`[T062] device_token leaked in ${context}: "${RETURNED_TOKEN}" found`);
  }
}

// ─── Test matrix ──────────────────────────────────────────────────────────────

describe('T062 — cross-process redaction: pino stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const scenarios: Array<{
    label: string;
    network: () => Network;
    withPriorState?: boolean;
  }> = [
    { label: 'success', network: () => makeNetwork({ type: 'success' }) },
    {
      label: 'invalid_code',
      network: () => makeNetwork({ type: 'failure', status: 400, code: 'INVALID_CODE' }),
    },
    {
      label: 'expired_code',
      network: () => makeNetwork({ type: 'failure', status: 410, code: 'EXPIRED_CODE' }),
    },
    {
      label: 'already_paired',
      network: () => makeNetwork({ type: 'failure', status: 409, code: 'ALREADY_PAIRED' }),
    },
    {
      label: 'branch_mismatch',
      network: () => makeNetwork({ type: 'failure', status: 409, code: 'BRANCH_MISMATCH' }),
      withPriorState: true,
    },
    {
      label: 'rate_limited',
      network: () =>
        makeNetwork({ type: 'failure', status: 429, code: 'RATE_LIMITED', retry_after_s: 30 }),
    },
    {
      label: 'network_error (non-timeout)',
      network: () => makeNetwork({ type: 'transport', timed_out: false }),
    },
    {
      label: 'network_error (timeout)',
      network: () => makeNetwork({ type: 'transport', timed_out: true }),
    },
  ];

  for (const scenario of scenarios) {
    it(`pino stream: outcome "${scenario.label}" — no pairing_code or device_token in any log line`, async () => {
      const { logger, streams } = makeCapturingPinoLogger();
      const pairingLog = createPairingLog(logger);
      const store = makeStore({ withPriorState: scenario.withPriorState });
      const network = scenario.network();

      const service = createPairingService({
        store,
        network,
        pairingLog,
        clock: () => new Date('2026-05-04T12:00:00.000Z'),
      });

      await service.submit(SUBMITTED_CODE);
      await flush();

      const allLines = streams.lines().join('\n');

      assertNoSecretIn(allLines, `pino stream (outcome="${scenario.label}")`);
    });
  }
});

describe('T062 — cross-process redaction: Sentry breadcrumbs and captureException', () => {
  let addBreadcrumbMock: ReturnType<typeof vi.fn>;
  let captureExceptionMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const sentry = await import('@sentry/electron/main');
    addBreadcrumbMock = sentry.addBreadcrumb as ReturnType<typeof vi.fn>;
    captureExceptionMock = sentry.captureException as ReturnType<typeof vi.fn>;
    vi.clearAllMocks();
  });

  const scenarios: Array<{
    label: string;
    network: () => Network;
    withPriorState?: boolean;
  }> = [
    { label: 'success', network: () => makeNetwork({ type: 'success' }) },
    {
      label: 'invalid_code',
      network: () => makeNetwork({ type: 'failure', status: 400, code: 'INVALID_CODE' }),
    },
    {
      label: 'expired_code',
      network: () => makeNetwork({ type: 'failure', status: 410, code: 'EXPIRED_CODE' }),
    },
    {
      label: 'already_paired',
      network: () => makeNetwork({ type: 'failure', status: 409, code: 'ALREADY_PAIRED' }),
    },
    {
      label: 'branch_mismatch',
      network: () => makeNetwork({ type: 'failure', status: 409, code: 'BRANCH_MISMATCH' }),
      withPriorState: true,
    },
    {
      label: 'rate_limited',
      network: () =>
        makeNetwork({ type: 'failure', status: 429, code: 'RATE_LIMITED', retry_after_s: 30 }),
    },
    {
      label: 'network_error (non-timeout)',
      network: () => makeNetwork({ type: 'transport', timed_out: false }),
    },
    {
      label: 'network_error (timeout)',
      network: () => makeNetwork({ type: 'transport', timed_out: true }),
    },
  ];

  for (const scenario of scenarios) {
    it(`Sentry: outcome "${scenario.label}" — no pairing_code or device_token in any breadcrumb or captureException`, async () => {
      const { logger } = makeCapturingPinoLogger();
      const pairingLog = createPairingLog(logger);
      const store = makeStore({ withPriorState: scenario.withPriorState });
      const network = scenario.network();

      const service = createPairingService({
        store,
        network,
        pairingLog,
        clock: () => new Date('2026-05-04T12:00:00.000Z'),
      });

      await service.submit(SUBMITTED_CODE);
      await flush();

      // Collect all Sentry calls and serialize them for secret-scanning.
      const breadcrumbCalls = addBreadcrumbMock.mock.calls;
      const captureExceptionCalls = captureExceptionMock.mock.calls;

      const allSentryPayload = JSON.stringify({ breadcrumbCalls, captureExceptionCalls });
      assertNoSecretIn(allSentryPayload, `Sentry calls (outcome="${scenario.label}")`);
    });
  }

  it('Sentry: each outcome adds exactly one breadcrumb with category="pairing"', async () => {
    // This assertion will fail (RED) until T065 wires addBreadcrumb in service.ts.
    const { logger } = makeCapturingPinoLogger();
    const pairingLog = createPairingLog(logger);

    const outcomes = [
      makeNetwork({ type: 'success' }),
      makeNetwork({ type: 'failure', status: 400, code: 'INVALID_CODE' }),
      makeNetwork({ type: 'failure', status: 410, code: 'EXPIRED_CODE' }),
      makeNetwork({ type: 'failure', status: 409, code: 'ALREADY_PAIRED' }),
      makeNetwork({ type: 'failure', status: 409, code: 'BRANCH_MISMATCH' }),
      makeNetwork({ type: 'failure', status: 429, code: 'RATE_LIMITED', retry_after_s: 30 }),
      makeNetwork({ type: 'transport', timed_out: false }),
      makeNetwork({ type: 'transport', timed_out: true }),
    ];

    for (const network of outcomes) {
      vi.clearAllMocks();
      const store = makeStore();
      const service = createPairingService({
        store,
        network,
        pairingLog,
        clock: () => new Date('2026-05-04T12:00:00.000Z'),
      });
      await service.submit(SUBMITTED_CODE);

      // T065 will add addBreadcrumb; until then this test fails (RED).
      expect(addBreadcrumbMock).toHaveBeenCalledTimes(1);
      const call = addBreadcrumbMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(call?.['category']).toBe('pairing');
      // Breadcrumb data must only carry outcome and status — no secrets.
      const data = call?.['data'] as Record<string, unknown> | undefined;
      expect(data).toBeDefined();
      expect(typeof data?.['outcome']).toBe('string');
      assertNoSecretIn(JSON.stringify(call), 'breadcrumb');
    }
  });
});
