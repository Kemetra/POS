import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-17 (comments 10941 item 4 / 10948) — static guard on the composition root
 * (`src/main/index.ts` cannot be imported under vitest: it runs
 * `app.whenReady()` at load; same posture as `bootstrap-shift-cashup`).
 *
 * The sale-sync interval is scheduled through `scheduleSaleSync`
 * (unit-tested in `sales-sync/__tests__/schedule-sale-sync.test.ts`), and the
 * engine reads the same shutdown latch the stop sets (RT-198), so a send in
 * flight at shutdown writes nothing to the DB that closes right after. The stop
 * stays synchronous in the worker registry; the drain promise is not awaited.
 */

const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');

function count(pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe('main/index.ts wires the sale-sync shutdown latch', () => {
  it('schedules the sale-sync drain once, through scheduleSaleSync', () => {
    expect(count(/scheduleSaleSync\(/g)).toBe(1);
    expect(source).not.toMatch(/saleSyncEngine\.runTickOnce\(/);
    expect(source).not.toMatch(/clearInterval\(saleSyncInterval\)/);
  });

  it('shares one latch between the engine and the stop', () => {
    expect(count(/let saleSyncStopped = false;/g)).toBe(1);
    expect(source).toMatch(/createSaleSyncEngine\(\{[^]*?isStopped: \(\) => saleSyncStopped,/);
    expect(source).toMatch(
      /scheduleSaleSync\(\{\s*engine: saleSyncEngine,\s*latchStopped: \(\) => \{\s*saleSyncStopped = true;\s*\},/,
    );
  });

  it('bounds the drain by the sale-sync client request timeout (15 s)', () => {
    expect(source).toMatch(/const SALE_SYNC_DRAIN_TIMEOUT_MS = 15_000;/);
    expect(source).toMatch(/drainTimeoutMs: SALE_SYNC_DRAIN_TIMEOUT_MS,/);
  });

  it("registers a synchronous stop that does not await the drain, as 'sale-sync interval'", () => {
    expect(count(/workerRegistry\.register\('sale-sync interval'/g)).toBe(1);
    expect(source).toMatch(
      /workerRegistry\.register\('sale-sync interval', \(\) => \{\s*void stopSaleSync\(\);\s*\}\);/,
    );
  });
});
