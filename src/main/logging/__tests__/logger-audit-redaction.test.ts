import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';

import { createLogger, type PinoRollFactory } from '../logger.js';
import { FORBIDDEN_PAYLOAD_KEYS } from '../../../shared/audit/forbidden-keys.js';

/**
 * 004-operator-session T050 — pino redaction defence-in-depth for
 * audit-event forbidden payload field names.
 *
 * The audit emitter (T046) refuses any payload tree containing one of
 * `FORBIDDEN_PAYLOAD_KEYS` at insertion time (PR-1 / FR-027). This test
 * covers the *belt-and-braces* layer: even if a future contributor logs
 * a request / response object somewhere outside the audit emitter that
 * happens to contain one of these key names, the value MUST be scrubbed
 * by the base pino redaction list.
 *
 * Coverage:
 *   - every FORBIDDEN_PAYLOAD_KEYS name is redacted at the top level
 *   - same names are redacted at one and two levels of nesting
 *     (matching the existing wildcard depth `*.*.<key>`)
 *   - nesting reaches the `audit.event.payload.<field>` shape that the
 *     bridge handler would emit if a caller accidentally logged a raw
 *     audit event
 *   - non-sensitive structural fields (`event_id`, `tenant_id`,
 *     `branch_id`, `acting_operator_id`, `action_category`) remain
 *     visible — the redaction list MUST NOT scrub the audit envelope
 *     itself, only credential fragments inside the payload.
 *
 * If any assertion fails, tighten the SOURCE — never the test.
 */

const APP_VERSION = '0.1.0-t050';
const SENTINEL = 'LEAKED-SECRET-VALUE-T050-XYZ';

function makeCapturingFactory(): { factory: PinoRollFactory; read: () => string } {
  const stream = new PassThrough();
  const buf: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => buf.push(chunk));
  const factory: PinoRollFactory = () => Promise.resolve(stream);
  return {
    factory,
    read: () => Buffer.concat(buf).toString('utf8'),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function makeLoggerForTest() {
  const { factory, read } = makeCapturingFactory();
  const logger = await createLogger({
    process: 'main',
    appVersion: APP_VERSION,
    logsDir: '/tmp/x-t050',
    pinoRollFactory: factory,
  });
  return { logger, read };
}

describe('createLogger — audit-event forbidden-key redaction (T050)', () => {
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    it(`redacts top-level forbidden key '${key}'`, async () => {
      const { logger, read } = await makeLoggerForTest();
      logger.info({ [key]: SENTINEL }, 'audit:debug-trace');
      await flush();
      expect(read()).not.toContain(SENTINEL);
    });

    it(`redacts forbidden key '${key}' nested one level deep`, async () => {
      const { logger, read } = await makeLoggerForTest();
      logger.info({ payload: { [key]: SENTINEL } }, 'audit:debug-trace');
      await flush();
      expect(read()).not.toContain(SENTINEL);
    });

    it(`redacts forbidden key '${key}' nested two levels deep (audit.payload.<key>)`, async () => {
      const { logger, read } = await makeLoggerForTest();
      // Mirrors the realistic shape an accidental
      // `logger.info({ audit: event }, ...)` call would emit, where
      // `event.payload[key]` is the forbidden field.
      logger.info({ audit: { payload: { [key]: SENTINEL } } }, 'audit:debug-trace');
      await flush();
      expect(read()).not.toContain(SENTINEL);
    });
  }

  it('audit envelope structural fields remain visible (redaction is targeted, not blanket)', async () => {
    // Sanity: the FR-025 mandatory-five attributes plus envelope keys
    // are NOT credentials and MUST stay readable in logs. If a future
    // contributor adds one of these to the redaction list by accident,
    // this test catches it.
    const { logger, read } = await makeLoggerForTest();
    logger.info(
      {
        event_id: 'evt-t050-0001',
        tenant_id: 'tenant-A',
        branch_id: 'branch-1',
        originating_terminal_id: 'term-1',
        acting_operator_id: 'clerk-user-1',
        action_category: 'shift.open',
        created_at: '2026-05-07T10:00:00.000Z',
      },
      'audit:event-emitted',
    );
    await flush();

    const text = read();
    expect(text).toContain('evt-t050-0001');
    expect(text).toContain('tenant-A');
    expect(text).toContain('branch-1');
    expect(text).toContain('term-1');
    expect(text).toContain('clerk-user-1');
    expect(text).toContain('shift.open');
    expect(text).toContain('2026-05-07T10:00:00.000Z');
  });

  it('redacts pos_operator_envelope at every wildcard depth (016 review MEDIUM)', async () => {
    // 016-operator-envelope-adoption (review MEDIUM): the opaque pos_operator
    // ENVELOPE (#559) is an unstructured bearer secret. It is never intentionally
    // logged, but a contributor who logs a sign-in / takeover success object
    // directly would leak it. It MUST be scrubbed at the logger layer (P7),
    // at the same wildcard depths as every other operator credential key.
    for (const shape of [
      { pos_operator_envelope: SENTINEL },
      { operator: { pos_operator_envelope: SENTINEL } },
      { audit: { operator: { pos_operator_envelope: SENTINEL } } },
    ]) {
      const { logger, read } = await makeLoggerForTest();
      logger.info(shape, 'operator:debug-trace');
      await flush();
      expect(read()).not.toContain(SENTINEL);
    }
  });

  it('combined payload — credential keys scrubbed while clean keys pass through', async () => {
    // Realistic shape: an audit `shift.forced_close` payload merged with
    // a stray credential field. The credential MUST be scrubbed; the
    // clean structural keys (`shift_id`, `forced_close_reason`,
    // `annotation`) MUST remain.
    const { logger, read } = await makeLoggerForTest();
    logger.info(
      {
        payload: {
          shift_id: 'shift-T050',
          forced_close_reason: 'cashier_no_show',
          annotation: 'manager closed at 18:05',
          // credential leak — MUST be scrubbed
          password_hash: SENTINEL,
        },
      },
      'audit:forced-close',
    );
    await flush();

    const text = read();
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain('shift-T050');
    expect(text).toContain('cashier_no_show');
    expect(text).toContain('manager closed at 18:05');
  });
});
