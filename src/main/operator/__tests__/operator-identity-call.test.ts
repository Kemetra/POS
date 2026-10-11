import { describe, expect, it, vi } from 'vitest';

import { OperatorIdentityCall, snapshotOf } from '../operator-identity-call.js';
import { SessionManager } from '../session-manager.js';
import { createJwtHolder, REAUTH_MARK_TTL_MS } from '../jwt-holder.js';
import { jwtWithExp } from './__helpers__/jwt-fixture.js';

/**
 * RT-358 (RT-247 plan §2.1, §2.4) — the shared rules for a request that
 * presents the held operator-identity JWT:
 *   • the session is re-checked (same, unlocked, not latched) before sending;
 *   • an `exp` already past is refused `reauth_required` without sending,
 *     unless the JWT carries the one-shot "just re-authenticated" mark;
 *   • the mark is consumed BEFORE the request is sent;
 *   • a 401 maps to `reauth_required`, or, on the marked request, ends that
 *     session only (fail closed) and clears that session's credentials.
 */

const NOW_MS = Date.parse('2026-10-11T12:00:00.000Z');
const MONO = 5_000_000;
const EXPIRED = jwtWithExp(NOW_MS / 1000 - 60);
const VALID = jwtWithExp(NOW_MS / 1000 + 600);

function managerSession(sm: SessionManager, backend_session_id = 'be-1'): void {
  sm.create({
    operator_id: 'op-1',
    display_name: 'Manager',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id,
  });
}

function setup(jwt: string | null = VALID) {
  const sm = new SessionManager();
  managerSession(sm);
  const jwtHolder = createJwtHolder();
  const envelopeHolder = createJwtHolder();
  if (jwt !== null) jwtHolder.set('be-1', jwt);
  envelopeHolder.set('be-1', 'envelope-1');
  const call = new OperatorIdentityCall({
    sessionManager: sm,
    jwtHolder,
    clearEnvelope: (id) => {
      envelopeHolder.clear(id);
    },
    nowMs: () => NOW_MS,
    monoNowMs: () => MONO,
  });
  const snap = snapshotOf(sm.getCurrent() ?? fail());
  return { sm, jwtHolder, envelopeHolder, call, snap };
}

function fail(): never {
  throw new Error('no session');
}

describe('OperatorIdentityCall.prepare', () => {
  it('sends a valid JWT, unmarked', () => {
    const { call, snap } = setup(VALID);
    expect(call.prepare(snap)).toEqual({ kind: 'send', jwt: VALID, marked: false });
  });

  it('sends a JWT with no readable exp (unknown is not expired)', () => {
    const { call, snap } = setup('opaque');
    expect(call.prepare(snap)).toEqual({ kind: 'send', jwt: 'opaque', marked: false });
  });

  it('refuses reauth_required for an expired JWT without the mark', () => {
    const { call, snap } = setup(EXPIRED);
    expect(call.prepare(snap)).toEqual({ kind: 'refused', category: 'reauth_required' });
  });

  it('refuses not_signed_in when no JWT is held', () => {
    const { call, snap } = setup(null);
    expect(call.prepare(snap)).toEqual({ kind: 'refused', category: 'not_signed_in' });
  });

  it('fast clock: a marked JWT that looks expired is still sent, and the mark is consumed', () => {
    const { call, snap, jwtHolder } = setup(null);
    jwtHolder.set('be-1', EXPIRED, { reauthenticatedAtMs: MONO - 10 });
    expect(call.prepare(snap)).toEqual({ kind: 'send', jwt: EXPIRED, marked: true });
    expect(jwtHolder.hasFreshMark('be-1', MONO)).toBe(false);
    // Without the mark the same JWT is refused again, nothing sent.
    expect(call.prepare(snap)).toEqual({ kind: 'refused', category: 'reauth_required' });
  });

  it('a stale mark (older than the TTL) is treated as absent', () => {
    const { call, snap, jwtHolder } = setup(null);
    jwtHolder.set('be-1', EXPIRED, { reauthenticatedAtMs: MONO - REAUTH_MARK_TTL_MS });
    expect(call.prepare(snap)).toEqual({ kind: 'refused', category: 'reauth_required' });
  });

  it('refuses state_invalid on a locked session and keeps the mark', () => {
    const { call, snap, sm, jwtHolder } = setup(null);
    jwtHolder.set('be-1', VALID, { reauthenticatedAtMs: MONO });
    sm.lock('2026-10-11T12:00:00.000Z');
    expect(call.prepare(snap)).toEqual({ kind: 'refused', category: 'state_invalid' });
    expect(jwtHolder.hasFreshMark('be-1', MONO)).toBe(true);
  });

  it('refuses state_invalid on a latched session', () => {
    const { call, snap, sm } = setup(VALID);
    sm.latchAuthority(snap.id, 'terminal_session_terminated');
    expect(call.prepare(snap)).toEqual({ kind: 'refused', category: 'state_invalid' });
  });

  it('refuses not_signed_in when the session ended or was replaced', () => {
    const { call, snap, sm } = setup(VALID);
    sm.end('signed_out');
    expect(call.prepare(snap)).toEqual({ kind: 'refused', category: 'not_signed_in' });
    managerSession(sm, 'be-1');
    expect(call.prepare(snap)).toEqual({ kind: 'refused', category: 'not_signed_in' });
  });
});

describe('OperatorIdentityCall.onUnauthenticated', () => {
  it('an unmarked 401 on the still-current session → reauth_required; nothing ends', () => {
    const { call, snap, sm, jwtHolder } = setup(VALID);
    expect(call.onUnauthenticated(snap, false)).toEqual({
      kind: 'refused',
      category: 'reauth_required',
    });
    expect(sm.getCurrent()?.id).toBe(snap.id);
    expect(jwtHolder.get('be-1')).toBe(VALID);
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
  ])('an unmarked 401 after the session %s in flight → state_invalid, no prompt', (_l, mutate) => {
    const { call, snap, sm } = setup(VALID);
    mutate(sm);
    expect(call.onUnauthenticated(snap, false)).toEqual({
      kind: 'refused',
      category: 'state_invalid',
    });
    expect(sm.getCurrent()?.id).toBe(snap.id);
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
  ])(
    'a marked 401 after the session %s in flight → state_invalid; nothing ended or cleared',
    (_l, mutate) => {
      const { call, snap, sm, jwtHolder, envelopeHolder } = setup(VALID);
      mutate(sm);
      expect(call.onUnauthenticated(snap, true)).toEqual({
        kind: 'refused',
        category: 'state_invalid',
      });
      expect(sm.getCurrent()?.id).toBe(snap.id);
      expect(jwtHolder.get('be-1')).toBe(VALID);
      expect(envelopeHolder.get('be-1')).toBe('envelope-1');
    },
  );

  it('a marked 401 ends that session and clears its JWT, mark and envelope', () => {
    const { call, snap, sm, jwtHolder, envelopeHolder } = setup(VALID);
    const ended = vi.fn();
    sm.onEnded(ended);

    expect(call.onUnauthenticated(snap, true)).toEqual({
      kind: 'refused',
      category: 'not_signed_in',
    });
    expect(sm.getCurrent()).toBeNull();
    expect(sm.getLastEndCause()).toBe('account_disabled_mid_session');
    expect(ended).toHaveBeenCalledTimes(1);
    expect(jwtHolder.get('be-1')).toBeNull();
    expect(envelopeHolder.get('be-1')).toBeNull();
  });

  it.each([true, false])(
    'a late 401 (marked=%s) after the session was replaced touches nothing',
    (marked) => {
      const { call, snap, sm, jwtHolder, envelopeHolder } = setup(VALID);
      sm.end('signed_out');
      managerSession(sm, 'be-2');
      jwtHolder.set('be-2', 'jwt-2', { reauthenticatedAtMs: MONO });
      envelopeHolder.set('be-2', 'envelope-2');
      const replacement = sm.getCurrent();
      const ended = vi.fn();
      sm.onEnded(ended);

      expect(call.onUnauthenticated(snap, marked)).toEqual({
        kind: 'refused',
        category: 'not_signed_in',
      });
      expect(sm.getCurrent()).toBe(replacement);
      expect(ended).not.toHaveBeenCalled();
      expect(jwtHolder.get('be-2')).toBe('jwt-2');
      expect(jwtHolder.hasFreshMark('be-2', MONO)).toBe(true);
      expect(envelopeHolder.get('be-2')).toBe('envelope-2');
    },
  );
});
