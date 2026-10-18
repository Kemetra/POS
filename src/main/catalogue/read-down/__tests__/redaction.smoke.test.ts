// @vitest-environment node
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import pino, { type Logger } from 'pino';

import { FORBIDDEN_PAYLOAD_KEYS } from '../../../../shared/audit/forbidden-keys.js';
import type { SellableCatalogRow } from '../map-sellable-row.js';
import type { TickOutcome } from '../read-down-driver.js';

/**
 * 010 T018 — read-down cross-process redaction smoke (NFR-3 / P7 / P11; §A4 RED-1).
 *
 * Two load-bearing guarantees for the read-down's diagnostic surface:
 *
 *   1. The device token authenticating the read-down (`Authorization: Bearer
 *      <device_token>`, plan AD-7) and any forbidden key are SCRUBBED by the
 *      centralized pino redaction (derived from `FORBIDDEN_PAYLOAD_KEYS`) even
 *      when nested inside a read-down-shaped diagnostic object — so a future
 *      contributor who logs a request/response/config directly cannot leak one.
 *      `device_token` / `token` / `secret` are already in the append-only list
 *      (forbidden-keys.ts) — this test pins that they cover the read-down surface.
 *
 *   2. The driver's `TickOutcome` (what a read-down diagnostic would log) carries
 *      ONLY status + counts — NO raw `SellableCatalogRow` body, no per-record
 *      content, no token. Logging the full outcome emits no snapshot row values.
 *
 * NOTE (§A4 RED-1 deferral): the read-down modules currently wire NO logger
 * (verified: zero console/logger calls in src/main/catalogue/read-down/*.ts), so
 * the control is satisfied vacuously today. This smoke pins the invariant so that
 * WHEN diagnostic logging is wired, a leak is caught. The deferral is recorded in
 * the post-implementation §A4 review.
 *
 * If any assertion fails, tighten the SOURCE (the outcome surface or the
 * redaction list) — never the test.
 */

const REDACTION_PATHS: string[] = FORBIDDEN_PAYLOAD_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `*.*.*.${key}`,
]);

function makeCapturingLogger(): { logger: Logger; lines: () => string[] } {
  const stream = new PassThrough();
  const buf: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => buf.push(chunk));
  const logger = pino({ level: 'info', redact: { paths: REDACTION_PATHS } }, stream);
  return {
    logger,
    lines: () =>
      Buffer.concat(buf)
        .toString('utf8')
        .split('\n')
        .filter((l) => l.length > 0),
  };
}

describe('T018 — read-down redaction smoke', () => {
  it('scrubs the device token + every forbidden key from a read-down-shaped diagnostic', () => {
    const { logger, lines } = makeCapturingLogger();
    const sentinel = 'LEAKED-DEVICE-TOKEN-DO-NOT-PRINT';

    // Simulate a careless read-down diagnostic that nests forbidden field names
    // (incl. the device token used for Authorization) alongside tick status.
    const leaky: Record<string, unknown> = {
      msg: 'read-down tick diagnostic',
      tick: { outcome: 'succeeded', productsWritten: 2 },
      request: {},
    };
    for (const key of FORBIDDEN_PAYLOAD_KEYS) {
      (leaky.request as Record<string, unknown>)[key] = sentinel;
    }
    logger.info(leaky, 'read-down diagnostic');

    const text = lines().join('\n');
    expect(text).not.toContain(sentinel);
  });

  it('the driver TickOutcome carries no raw snapshot row content', () => {
    // The shape a read-down diagnostic logs. It is status + counts only — there
    // is no field that could hold a SellableCatalogRow (name/sku/price/aliases).
    const outcome: TickOutcome = {
      outcome: 'succeeded',
      productsWritten: 3,
      recordsRejected: 0,
      failureCategory: null,
    };

    const { logger, lines } = makeCapturingLogger();
    logger.info({ tick: outcome }, 'read-down tick complete');
    const text = lines().join('\n');

    // A representative snapshot row's content must NOT be representable in / leak
    // through the outcome surface.
    const row: SellableCatalogRow = {
      product_id: 'p-secret',
      sku: 'SKU-SECRET-VALUE',
      name: 'CONFIDENTIAL-PRODUCT-NAME',
      aliases: ['BARCODE-SECRET'],
      price: { amount: '99.99', currency_code: 'EGP' },
      tax_category: 'standard',
      active: true,
      row_cursor: 'cur-secret',
    };
    expect(text).not.toContain(row.name);
    expect(text).not.toContain(row.sku);
    expect(text).not.toContain('99.99');
    // The outcome object exposes no key that holds row content.
    expect(Object.keys(outcome).sort()).toEqual([
      'failureCategory',
      'outcome',
      'productsWritten',
      'recordsRejected',
    ]);
  });
});
