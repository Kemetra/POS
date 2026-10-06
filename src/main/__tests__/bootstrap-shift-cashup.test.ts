import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-17 slice 3 part 3 — static guard on the composition root
 * (`src/main/index.ts` cannot be imported under vitest: it runs
 * `app.whenReady()` at load; same posture as `bootstrap-device-revocation`).
 *
 *  - The shift sync engine is registered behind `POS_PULSE_FEATURE_SHIFT_CASHUP`
 *    (default off) as a paired-only worker, with its stop in the worker
 *    registry (`registerShiftSync`, unit-tested in `compose-shift-sync.test.ts`).
 *  - It uses the sale-sync sources: the sendable device token (null unless
 *    paired, null once revoked), the current pairing's terminal, the live
 *    terminal resolver and the RT-215 detector.
 *  - No shift cash-up IPC is registered in this part (slice 4 owns the UI and
 *    its bridge).
 */

const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');

function count(pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe('main/index.ts wires the RT-17 shift sync engine', () => {
  it('registers the engine once, gated on the shift cash-up flag', () => {
    expect(count(/registerShiftSync\(/g)).toBe(1);
    expect(count(/startShiftSync\(/g)).toBe(1);
    expect(source).toMatch(
      /registerShiftSync\(\{\s*enabled: parseFeatureFlags\(process\.env\)\.shiftCashup,\s*pairedWorkers: pairedWorkersLatch,\s*workers: workerRegistry,/,
    );
  });

  it('uses the sale-sync device sources and the RT-215 detector', () => {
    expect(source).toMatch(
      /startShiftSync\(\{\s*db,\s*terminal,\s*client: \{\s*baseUrl: resolveApiBaseUrl\(\),\s*fetch: globalThis\.fetch\.bind\(globalThis\),\s*detector: deviceAuthDetector,\s*getDeviceToken: readSendableDeviceToken,\s*currentTerminalId: \(\) => pairingStore\.getCurrentTerminalId\(\),\s*\},\s*resolveTerminalId: createCurrentTerminalResolver\(\(\) => pairingStore\.getStatus\(\)\),\s*logger: mainLogger,\s*\}\)/,
    );
  });

  it('registers no shift cash-up IPC in this part', () => {
    expect(source).not.toMatch(/registerShift\w*Handlers/);
    expect(source).not.toMatch(/composeShiftCashupService/);
  });
});
