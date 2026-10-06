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
 *  - RT-17 slice 4 part 1: the shift cash-up IPC is registered only with the
 *    flag on (`registerShiftCashupIpc`, unit-tested in `ipc/shift-cashup`),
 *    on the lock-guarded ipcMain, over the live operator session.
 *  - Part 2: the same registration carries the RT-215 pairing epoch (the
 *    revocation-aware re-check, F2), the live manager identity for the
 *    manager PIN enrolment, the session-start hook that refreshes a manager's
 *    last online sign-in (round 1 P2-1), and safeStorage for the PIN seal; a re-pair purges
 *    the other terminals' manager PIN records with the cashier ones.
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

  it('registers the shift cash-up IPC once, only with the flag on, on the lock-guarded ipcMain', () => {
    expect(count(/registerShiftCashupIpc\(/g)).toBe(1);
    expect(source).not.toMatch(/registerShiftCashupHandlers\(/);
    expect(source).toMatch(
      /registerShiftCashupIpc\(\{\s*enabled: parseFeatureFlags\(process\.env\)\.shiftCashup,\s*ipcMain: guardedIpcMain,\s*db,\s*isEnabled: \(\) => parseFeatureFlags\(process\.env\)\.shiftCashup,/,
    );
  });

  it('gates every shift call on the live operator session on the paired terminal', () => {
    expect(source).toMatch(
      /registerShiftCashupIpc\(\{[^}]*getSession: \(\) =>\s*resolveSessionScope\(\s*operatorSessionManager\.getCurrent\(\),\s*pairingStore\.getCurrentTerminalId\(\),\s*\),\s*isSessionLocked: \(\) => operatorSessionManager\.getCurrent\(\)\?\.lock_state === 'locked',\s*pairedScope: async \(\) => pairedShiftScope\(await pairingStore\.getStatus\(\)\),/,
    );
  });

  it('wires the pairing epoch, the manager identity and the PIN seal (part 2)', () => {
    expect(source).toMatch(
      /registerShiftCashupIpc\(\{[^}]*pairedScope: async \(\) => pairedShiftScope\(await pairingStore\.getStatus\(\)\),\s*pairingEpoch: \(\) => pairingStore\.getPairingEpoch\(\),\s*getManager: \(\) => managerIdentityOf\(operatorSessionManager\.getCurrent\(\)\),\s*onSessionStarted: \(listener\) => \{\s*operatorSessionManager\.onStarted\(listener\);\s*\},\s*currentTerminalId: \(\) => pairingStore\.getCurrentTerminalId\(\),\s*safeStorage,/,
    );
  });

  it('purges the other terminals’ manager PIN records on a re-pair, with the cashier ones', () => {
    expect(source).toMatch(
      /purgeOtherTerminalPins: \(terminalId\) =>\s*purgeOtherTerminalPinRecords\(db, terminalId\) \+\s*purgeOtherTerminalManagerPinRecords\(db, terminalId\),/,
    );
  });
});
