/**
 * 005-sales-cart T054 — Cross-process redaction: payload_json key.
 *
 * Defence-in-depth: `payload_json` is the column name used in
 * `cart_action_outbox` to store the serialised action payload. If a
 * future contributor logs a raw outbox row (e.g., for debugging), the
 * pino redaction layer must scrub `payload_json` before it hits the
 * log file, because the column value may contain note content or
 * attribution data that already survived the bridge-side scrubPayloadForOutbox
 * filter.
 *
 * This test is the load-bearing guarantee that `payload_json` is
 * included in CART_REDACTED_KEYS in `src/main/logging/logger.ts`.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

import { createLogger, type PinoRollFactory } from '../../src/main/logging/logger.js';

const SENTINEL = 'LEAKED-PAYLOAD-JSON-T054-VALUE';

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

async function makeLogger() {
  const { factory, read } = makeCapturingFactory();
  const logger = await createLogger({
    process: 'main',
    appVersion: '0.1.0-t054',
    logsDir: '/tmp/x-t054',
    pinoRollFactory: factory,
  });
  return { logger, read };
}

describe('T054 — payload_json redaction (cart outbox defence-in-depth)', () => {
  it('redacts payload_json at top level', async () => {
    const { logger, read } = await makeLogger();
    logger.info({ payload_json: SENTINEL }, 'cart:outbox:debug');
    await flush();
    expect(read()).not.toContain(SENTINEL);
  });

  it('redacts payload_json nested one level', async () => {
    const { logger, read } = await makeLogger();
    logger.info({ outbox: { payload_json: SENTINEL } }, 'cart:outbox:debug');
    await flush();
    expect(read()).not.toContain(SENTINEL);
  });

  it('redacts payload_json nested two levels', async () => {
    const { logger, read } = await makeLogger();
    logger.info({ cart: { action: { payload_json: SENTINEL } } }, 'cart:outbox:debug');
    await flush();
    expect(read()).not.toContain(SENTINEL);
  });

  it('redacts payload_json nested three levels', async () => {
    const { logger, read } = await makeLogger();
    logger.info({ a: { b: { c: { payload_json: SENTINEL } } } }, 'cart:outbox:debug');
    await flush();
    expect(read()).not.toContain(SENTINEL);
  });

  it('preserves cart_id and action_kind alongside payload_json redaction', async () => {
    const { logger, read } = await makeLogger();
    logger.info(
      {
        cart_id: 'cart-visible-uuid',
        action_kind: 'cart.line.add',
        payload_json: SENTINEL,
      },
      'cart:outbox:debug',
    );
    await flush();
    const text = read();
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain('cart-visible-uuid');
    expect(text).toContain('cart.line.add');
  });
});
