import { describe, expect, it, vi } from 'vitest';

import { StuckShiftsHandler } from '../stuck-shifts-handler.js';
import { SessionManager } from '../session-manager.js';
import { createJwtHolder, type JwtHolder } from '../jwt-holder.js';
import type { BackendStuckShiftsResponse } from '../backend-client.js';
import { jwtWithExp } from './__helpers__/jwt-fixture.js';

/**
 * RT-358 (RT-247 plan §2.2, §2.4) — the stuck-shifts list with an expired
 * manager sign-in JWT:
 *   • never sends an empty bearer; no JWT held → `not_signed_in`;
 *   • expired `exp` → `reauth_required`, no request;
 *   • 401 → `reauth_required`; 403 / 5xx keep today's `invalid_input`;
 *   • a 401 on the marked retry ends that session (fail closed);
 *   • a locked or latched session → `state_invalid`, no request.
 */

const NOW_MS = Date.parse('2026-10-11T12:00:00.000Z');
const MONO = 7_000_000;
const EXPIRED = jwtWithExp(NOW_MS / 1000 - 60);
const VALID = jwtWithExp(NOW_MS / 1000 + 600);

function managerSession(sm = new SessionManager(), backend_session_id = 'be-1'): SessionManager {
  sm.create({
    operator_id: 'op-1',
    display_name: 'Manager',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id,
  });
  return sm;
}

function setup(opts: {
  jwt?: string | null;
  marked?: boolean;
  result?: BackendStuckShiftsResponse;
  sm?: SessionManager;
  onCall?: () => void;
}) {
  const sm = opts.sm ?? managerSession();
  const jwtHolder: JwtHolder = createJwtHolder();
  const jwt = opts.jwt === undefined ? VALID : opts.jwt;
  if (jwt !== null) {
    jwtHolder.set('be-1', jwt, opts.marked === true ? { reauthenticatedAtMs: MONO } : undefined);
  }
  const getStuckShifts = vi.fn(() => {
    opts.onCall?.();
    return Promise.resolve(opts.result ?? { kind: 'ok' as const, shifts: [] });
  });
  const cleared: string[] = [];
  const handler = new StuckShiftsHandler({
    sessionManager: sm,
    backendClient: { getStuckShifts },
    jwtHolder,
    clearEnvelope: (id) => cleared.push(id),
    nowMs: () => NOW_MS,
    monoNowMs: () => MONO,
  });
  return { sm, jwtHolder, getStuckShifts, cleared, handler };
}

describe('RT-358 StuckShiftsHandler — re-auth required', () => {
  it.each([
    ['no JWT held', null],
    ['an empty JWT held', ''],
  ])('%s → not_signed_in and no request (never an empty bearer)', async (_l, jwt) => {
    const { handler, getStuckShifts } = setup({ jwt });
    await expect(handler.listStuckShifts()).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    expect(getStuckShifts).not.toHaveBeenCalled();
  });

  it('an expired JWT → reauth_required and no request', async () => {
    const { handler, getStuckShifts } = setup({ jwt: EXPIRED });
    await expect(handler.listStuckShifts()).resolves.toEqual({
      kind: 'refused',
      category: 'reauth_required',
    });
    expect(getStuckShifts).not.toHaveBeenCalled();
  });

  it('a 401 → reauth_required; the session stays', async () => {
    const { handler, sm } = setup({ result: { kind: 'unauthenticated' } });
    await expect(handler.listStuckShifts()).resolves.toEqual({
      kind: 'refused',
      category: 'reauth_required',
    });
    expect(sm.getCurrent()).not.toBeNull();
  });

  it.each([[{ kind: 'forbidden' } as const], [{ kind: 'refused' } as const]])(
    '%o keeps today’s invalid_input',
    async (result) => {
      const { handler } = setup({ result });
      await expect(handler.listStuckShifts()).resolves.toEqual({
        kind: 'refused',
        category: 'invalid_input',
      });
    },
  );

  it('the marked retry is sent despite a past exp, and lists on success', async () => {
    const { handler, getStuckShifts, jwtHolder } = setup({ jwt: EXPIRED, marked: true });
    await expect(handler.listStuckShifts()).resolves.toEqual({ kind: 'stuck_shifts', shifts: [] });
    expect(getStuckShifts).toHaveBeenCalledWith('b1', EXPIRED);
    expect(jwtHolder.hasFreshMark('be-1', MONO)).toBe(false);
  });

  it('a 401 on the marked retry ends the session and clears its credentials', async () => {
    const { handler, sm, jwtHolder, cleared } = setup({
      marked: true,
      result: { kind: 'unauthenticated' },
    });
    await expect(handler.listStuckShifts()).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    expect(sm.getCurrent()).toBeNull();
    expect(jwtHolder.get('be-1')).toBeNull();
    expect(cleared).toEqual(['be-1']);
  });

  it.each([
    [
      'locked',
      (sm: SessionManager) => {
        sm.lock('2026-10-11T12:00:00.000Z');
      },
    ],
    [
      'latched',
      (sm: SessionManager) =>
        sm.latchAuthority(sm.getCurrent()?.id ?? '', 'terminal_session_terminated'),
    ],
  ])('a %s session → state_invalid and no request', async (_l, mutate) => {
    const sm = managerSession();
    mutate(sm);
    const { handler, getStuckShifts } = setup({ sm });
    await expect(handler.listStuckShifts()).resolves.toEqual({
      kind: 'refused',
      category: 'state_invalid',
    });
    expect(getStuckShifts).not.toHaveBeenCalled();
  });

  it('a session replaced while the request is in flight → not_signed_in, nothing listed', async () => {
    const sm = managerSession();
    const { handler } = setup({
      sm,
      result: { kind: 'ok', shifts: [] },
      onCall: () => {
        sm.end('signed_out');
        managerSession(sm, 'be-2');
      },
    });
    await expect(handler.listStuckShifts()).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
  });

  it('an unmarked 401 after a lock during the request → state_invalid, no prompt', async () => {
    const sm = managerSession();
    const { handler } = setup({
      sm,
      result: { kind: 'unauthenticated' },
      onCall: () => {
        sm.lock('2026-10-11T12:00:00.000Z');
      },
    });
    await expect(handler.listStuckShifts()).resolves.toEqual({
      kind: 'refused',
      category: 'state_invalid',
    });
    expect(sm.getCurrent()).not.toBeNull();
  });

  it('a late marked 401 after the session was replaced does not end the new one', async () => {
    const sm = managerSession();
    const { handler, jwtHolder, cleared } = setup({
      sm,
      marked: true,
      result: { kind: 'unauthenticated' },
      onCall: () => {
        sm.end('signed_out');
        managerSession(sm, 'be-2');
        jwtHolder.set('be-2', 'jwt-2');
      },
    });
    await expect(handler.listStuckShifts()).resolves.toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    expect(sm.getCurrent()?.backend_session_id).toBe('be-2');
    expect(jwtHolder.get('be-2')).toBe('jwt-2');
    expect(cleared).toEqual([]);
  });
});
