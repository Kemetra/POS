import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

import { ReauthHandler } from '../reauth-handler.js';
import { OnlineCredentialVerifier } from '../online-credential-verifier.js';
import { SessionManager } from '../session-manager.js';
import { SessionUnlockHandler } from '../session-unlock-handler.js';
import { createJwtHolder } from '../jwt-holder.js';
import {
  createManagerPinEnrollment,
  managerIdentityOf,
  ManagerPinRefusedError,
  MANAGER_ENROL_STEP_UP_MS,
} from '../manager-pin-enrollment.js';
import type { ClerkExchangeResult } from '../clerk-client.js';

/**
 * RT-358 (RT-247 plan §2.3, §4):
 *   • Q1 = no — a successful re-auth does NOT reopen the 2-minute manager-PIN
 *     enrolment step-up: enrolment more than 2 minutes after the original
 *     sign-in is still refused `reauth_required`, through the real admission.
 *   • Redaction — the identifier, password and exchanged JWT never reach a log
 *     line or a returned value on the re-auth and online-unlock paths.
 */

const IDENTIFIER = 'manager.secret@example.test';
const PASSWORD = 'Pa55-word-secret';
const FRESH_JWT = 'eyJ.fresh-jwt-secret.sig';

function managerSession(): SessionManager {
  const sm = new SessionManager();
  sm.create({
    operator_id: 'mgr-1',
    display_name: 'Manager',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: 'be-1',
    manager_user_id: '44444444-4444-7444-8444-444444444444',
  });
  return sm;
}

function ok(operator_id = 'mgr-1'): ClerkExchangeResult {
  return { kind: 'ok', jwt: FRESH_JWT, operator_id, display_name: 'M', role: 'manager' };
}

function capturingLogger(): { logger: Logger; lines: unknown[][] } {
  const lines: unknown[][] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args);
  };
  const logger = { info: record, warn: record, error: record, debug: record } as unknown as Logger;
  return { logger, lines };
}

describe('RT-358 Q1 = no — re-auth never reopens the manager-PIN enrolment step-up', () => {
  it('enrolment > 2 min after sign-in is still refused reauth_required after a successful re-auth', async () => {
    const sm = managerSession();
    const current = sm.getCurrent();
    if (current === null) throw new Error('no session');
    const signedInAt = '2026-10-11T08:00:00.000Z';
    current.manager_signed_in_at = signedInAt;
    const now = new Date(Date.parse(signedInAt) + MANAGER_ENROL_STEP_UP_MS + 60_000).toISOString();

    const reauth = new ReauthHandler({
      sessionManager: sm,
      verifier: new OnlineCredentialVerifier({ clerk: { exchange: () => Promise.resolve(ok()) } }),
      jwtHolder: createJwtHolder(),
      isDeviceRevoked: () => false,
    });
    await expect(
      reauth.reauthenticate({ identifier: IDENTIFIER, password: PASSWORD }),
    ).resolves.toEqual({ kind: 'reauthenticated' });

    const seal = vi.fn();
    const enrollment = createManagerPinEnrollment({
      isEnabled: () => true,
      getManager: () => managerIdentityOf(sm.getCurrent()),
      isSessionLocked: () => sm.isLocked(),
      pairedScope: () => Promise.resolve({ tenantId: 't1', branchId: 'b1', terminalId: 'term-1' }),
      pairingEpoch: () => 'epoch-1',
      store: { seal, enrol: vi.fn() },
      now: () => now,
    });

    const attempt = enrollment.enroll({ managerPin: '582917' });
    await expect(attempt).rejects.toBeInstanceOf(ManagerPinRefusedError);
    await expect(attempt).rejects.toMatchObject({ reason: 'reauth_required' });
    expect(seal).not.toHaveBeenCalled();
  });
});

describe('RT-358 redaction — re-auth and online unlock', () => {
  const SECRETS = [IDENTIFIER, PASSWORD, FRESH_JWT];

  it('re-auth: no identifier, password or JWT in any log line or result', async () => {
    const { logger, lines } = capturingLogger();
    const outcomes: unknown[] = [];
    for (const answer of [ok(), ok('someone-else'), { kind: 'refused' } as const]) {
      const handler = new ReauthHandler({
        sessionManager: managerSession(),
        verifier: new OnlineCredentialVerifier({
          clerk: { exchange: () => Promise.resolve(answer) },
        }),
        jwtHolder: createJwtHolder(),
        isDeviceRevoked: () => false,
        logger,
      });
      outcomes.push(await handler.reauthenticate({ identifier: IDENTIFIER, password: PASSWORD }));
    }

    expect(lines.length).toBeGreaterThan(0);
    const logged = JSON.stringify(lines);
    const returned = JSON.stringify(outcomes);
    for (const secret of SECRETS) {
      expect(logged).not.toContain(secret);
      expect(returned).not.toContain(secret);
    }
  });

  it('online unlock that stores the JWT: no identifier, password or JWT in any log line or result', async () => {
    const { logger, lines } = capturingLogger();
    const outcomes: unknown[] = [];
    for (const answer of [ok(), ok('someone-else')]) {
      const sm = managerSession();
      sm.lock('2026-10-11T12:00:00.000Z');
      const handler = new SessionUnlockHandler({
        sessionManager: sm,
        verifyCashierPin: () => Promise.resolve(null),
        clerk: { exchange: () => Promise.resolve(answer) },
        jwtHolder: createJwtHolder(),
        isDeviceRevoked: () => false,
        logger,
      });
      outcomes.push(
        await handler.unlock({
          method: 'online_credential',
          identifier: IDENTIFIER,
          password: PASSWORD,
        }),
      );
    }

    expect(lines.length).toBeGreaterThan(0);
    const logged = JSON.stringify(lines);
    const returned = JSON.stringify(outcomes);
    for (const secret of SECRETS) {
      expect(logged).not.toContain(secret);
      expect(returned).not.toContain(secret);
    }
  });
});
