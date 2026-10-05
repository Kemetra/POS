import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-215 — static guard on the composition root (`src/main/index.ts` cannot be
 * imported under vitest: it runs `app.whenReady()` at load; same posture as
 * `bootstrap-wires-operator.test.ts`).
 *
 *  - The device token is read for sending ONLY through
 *    `createSendableDeviceTokenReader` (null once revoked): no direct
 *    `secretStore.get(DEVICE_TOKEN_KEY)` remains.
 *  - Exactly the device-bearer clients (cashier admissions, read-down) are built
 *    on the detector-observed fetch; no operator-credential client is.
 *  - The pairing service runs the recovery step, and the revocation flow is
 *    bound to the detector.
 */

const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8');

function count(pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe('main/index.ts wires RT-215 (device revoked + pairing recovery)', () => {
  it('never reads the device token for sending except through the sendable reader', () => {
    expect(count(/secretStore\.get\(\s*DEVICE_TOKEN_KEY\s*\)/g)).toBe(0);
    expect(source).toMatch(/createSendableDeviceTokenReader\(\{\s*pairingStore,/);
    expect(count(/getDeviceToken: readSendableDeviceToken/g)).toBe(3); // probe, admissions, read-down
    expect(source).toMatch(/\(await readSendableDeviceToken\(\)\) \?\? ''/); // sign-in attestation
  });

  it('builds exactly the two device-bearer clients on a fetch tagged with their own route + base (review F5)', () => {
    expect(source).toMatch(
      /const admissionsFetch = withDeviceAuthObservation\(\s*globalThis\.fetch\.bind\(globalThis\),\s*deviceAuthDetector,\s*\{ source: 'cashier_admissions', baseUrl: apiBaseUrl \},\s*\)/,
    );
    expect(count(/withDeviceAuthObservation\(/g)).toBe(2);
    expect(count(/fetch: admissionsFetch/g)).toBe(1);
    expect(source).toMatch(
      /createCashierAdmissionClient\(\{\s*baseUrl: apiBaseUrl,\s*fetch: admissionsFetch,/,
    );
    expect(source).toMatch(
      /createReadDownClient\(\{\s*baseUrl: catalogueApiBaseUrl,\s*\/\/[^\n]*\n\s*fetch: withDeviceAuthObservation\(globalThis\.fetch\.bind\(globalThis\), deviceAuthDetector, \{\s*source: 'read_down',\s*baseUrl: catalogueApiBaseUrl,\s*\}\),/,
    );
  });

  it('the confirmation call uses an UNOBSERVED admission client', () => {
    expect(source).toMatch(
      /probe: createRosterConfirmationProbe\(\s*createCashierAdmissionClient\(\{\s*baseUrl: apiBaseUrl,\s*fetch: globalThis\.fetch\.bind\(globalThis\),/,
    );
  });

  it('wraps the pairing service with the recovery step and binds the flow to the detector', () => {
    expect(source).toMatch(/withDeviceRevocationRecovery\(\s*createPairingService\(/);
    expect(source).toMatch(/deviceRevocation\.onConfirmed = \(source\) => \{/);
    expect(source).toMatch(/deviceRevocation\.onPaired = \(input\) =>/);
    expect(source).toMatch(
      /latchSession: \(\) => \{\s*cashierAdmissionKeeper\.latchCurrentSession\('terminal_session_terminated'\);/,
    );
    expect(source).toContain('PAIRING_PUSH_CHANNELS.STATUS_CHANGED');
  });

  it('stops the detector with the heartbeat on quit', () => {
    expect(source).toMatch(
      /workerRegistry\.register\('cashier admission heartbeat', \(\) => \{\s*cashierAdmissionKeeper\.stop\(\);[\s\S]{0,120}deviceAuthDetector\.stop\(\);/,
    );
  });

  it('Codex P1: every sign-in / takeover handler checks the pairing epoch; holders refuse while revoked', () => {
    for (const ctor of ['SignInHandler', 'CashierSignInHandler', 'TakeoverHandler']) {
      expect(source, ctor).toMatch(
        new RegExp(
          `new ${ctor}\\(\\{[^}]*pairingEpoch: \\(\\) => pairingStore\\.getPairingEpoch\\(\\),`,
        ),
      );
    }
    expect(source).toMatch(
      /const refuseWhileRevoked = \{ refuseWhile: \(\) => pairingStore\.isDeviceRevoked\(\) \};/,
    );
    expect(source).toContain('const operatorJwtHolder = createJwtHolder(refuseWhileRevoked);');
    expect(source).toContain('const operatorEnvelopeHolder = createJwtHolder(refuseWhileRevoked);');
  });

  it('review F2/F3: relaunch after a re-pair once the workers ran; no pairing while a session is alive', () => {
    expect(source).toMatch(/workersAlreadyStarted: \(\) => pairedWorkersLatch\.hasStarted\(\),/);
    expect(source).toMatch(/relaunch: \(\) => \{\s*app\.relaunch\(\);\s*app\.exit\(0\);\s*\}/);
    expect(source).toMatch(/hasSession: \(\) => deviceRevocation\.hasSession\(\),/);
    expect(source).toMatch(
      /deviceRevocation\.hasSession = \(\) => operatorSessionManager\.getCurrent\(\) !== null;/,
    );
    expect(source).toMatch(/isDeviceRevoked: \(\) => pairingStore\.isDeviceRevoked\(\),/);
  });

  it('review F4: the detector drives the offline grants through the #545 seam (never the store)', () => {
    expect(source).toContain('const deviceGrantHooks = deviceRevocationGrantHooks(offlineGrants);');
    expect(source).toMatch(/onSuspect: \(\) => \{\s*deviceGrantHooks\.onSuspect\(\);\s*\}/);
    expect(source).toMatch(
      /invalidateGrants: \(\) => \{\s*deviceGrantHooks\.onConfirmed\(\);\s*\}/,
    );
    expect(source).toContain('grantSeam: offlineGrants.seam,');
    expect(source).not.toContain('NOOP_OFFLINE_GRANT_SEAM');
  });

  it('no longer ends the session on a single device 401 (the RT-113 P2 immediate cascade is gone)', () => {
    expect(source).not.toContain('onDeviceRevoked');
    expect(source).not.toContain('notifyTerminalRevoked');
  });
});
