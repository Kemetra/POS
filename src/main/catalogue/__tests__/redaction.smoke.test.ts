// @vitest-environment node
import { PassThrough } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import pino, { type Logger } from 'pino';

import { FORBIDDEN_PAYLOAD_KEYS } from '../../../shared/audit/forbidden-keys.js';
import { createCatalogueBridge } from '../catalogue-bridge.js';
import { createProductRepo } from '../product-repo.js';
import type { OperatorSessionForCatalogue } from '../require-catalogue-session.js';
import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
  seedBarcode,
  seedProduct,
} from './__helpers__/catalogue-fixture.js';

/**
 * 009 T029 — cross-process redaction smoke for `catalogue.*` (extends the
 * project chain: 002 pairing → 004 operator → 005 cart → 008 sales).
 *
 * NFR-7 / contracts/bridge-api.md §Redaction: a `catalogue.*` payload logged for
 * diagnostics MUST carry no credential fragment and no product field beyond the
 * permitted display snapshot, and the refusal `reason` is logged but never
 * echoed verbatim. Two guarantees, both load-bearing:
 *
 *   1. The centralized pino redaction (`logger.ts` REDACTION_PATHS, derived from
 *      `FORBIDDEN_PAYLOAD_KEYS`) scrubs every forbidden key even when it is
 *      nested inside a `catalogue.*`-shaped object — so a future contributor who
 *      logs a request/response directly cannot leak one.
 *   2. The bridge's own response/snapshot surface (the data actually returned to
 *      the renderer for the `one` result) contains NONE of the forbidden keys —
 *      `ProductSnapshotDisplay` is a display-only allowlist (name/price/flags/
 *      sku/barcode), never a credential or PII surface.
 *
 * If any assertion fails, tighten the SOURCE (the snapshot surface or the
 * redaction list) — never the test.
 */

const SESSION: OperatorSessionForCatalogue = {
  role: 'cashier',
  operator_id: 'op-1',
  operator_session_id: 'sess-1',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
};

// The production redaction path set, mirrored from logger.ts: every forbidden
// key at the reachable wildcard depths.
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

beforeAll(async () => {
  await initCatalogueSql();
});

describe('T029 — catalogue.* cross-process redaction smoke', () => {
  it('scrubs every forbidden key when a catalogue-shaped payload is logged directly', () => {
    const { logger, lines } = makeCapturingLogger();

    // Simulate a careless contributor logging a request/response object that
    // happens to nest forbidden field names alongside the catalogue payload.
    const sentinel = 'LEAKED-SENSITIVE-VALUE-DO-NOT-PRINT';
    const leakyPayload: Record<string, unknown> = {
      msg: 'catalogue.lookupBarcode diagnostic',
      response: { kind: 'one', product: { product_id: 'p-1', display_name_ar: 'بنادول' } },
    };
    for (const key of FORBIDDEN_PAYLOAD_KEYS) {
      (leakyPayload.response as Record<string, unknown>)[key] = sentinel;
    }
    logger.info(leakyPayload, 'catalogue diagnostic');

    const text = lines().join('\n');
    expect(text).not.toContain(sentinel);
  });

  it('the catalogue snapshot returned for a `one` result carries no forbidden key', async () => {
    const db = freshCatalogueDb();
    seedProduct(db, { product_id: 'p-1', name_ar: 'بنادول', price_minor: 1500 });
    seedBarcode(db, { product_id: 'p-1', barcode: '6221000000001' });
    const bridge = createCatalogueBridge({
      getCurrentSession: () => SESSION,
      productRepo: createProductRepo(handleFor(db)),
    });

    const r = await bridge.lookupBarcode({ barcode: '6221000000001' });
    expect(r.kind).toBe('one');
    if (r.kind === 'one') {
      const snapshotKeys = Object.keys(r.product);
      for (const forbidden of FORBIDDEN_PAYLOAD_KEYS) {
        expect(snapshotKeys, `snapshot must not expose forbidden key "${forbidden}"`).not.toContain(
          forbidden,
        );
      }
    }
    db.close();
  });

  it('logging the full catalogue `one` response does not emit any forbidden key value', async () => {
    const db = freshCatalogueDb();
    seedProduct(db, {
      product_id: 'p-1',
      name_ar: 'بنادول',
      name_en: 'Panadol',
      price_minor: 1500,
    });
    seedBarcode(db, { product_id: 'p-1', barcode: '6221000000001' });
    const bridge = createCatalogueBridge({
      getCurrentSession: () => SESSION,
      productRepo: createProductRepo(handleFor(db)),
    });
    const { logger, lines } = makeCapturingLogger();

    const r = await bridge.lookupBarcode({ barcode: '6221000000001' });
    logger.info({ response: r }, 'catalogue.lookupBarcode result');

    // The display fields (names/price/sku/barcode) are legitimately present;
    // the assertion is that none of the forbidden KEY names appear in the line.
    const text = lines().join('\n');
    for (const forbidden of FORBIDDEN_PAYLOAD_KEYS) {
      expect(text, `forbidden key "${forbidden}" must not appear`).not.toContain(`"${forbidden}":`);
    }
    db.close();
  });
});
