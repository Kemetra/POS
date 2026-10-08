import { describe, expect, it } from 'vitest';

import { SessionManager } from '../session-manager.js';

/**
 * RT-117 (RT-116 contract §2.1–2.2) — LOCKED is a state of the EXISTING
 * session. Locking and unlocking never end the session, never mint a new
 * session id, and never fire the session-start / session-end lifecycle hooks
 * (those hooks run the stuck-attempt sweep — RT-116 M9).
 */

function signedIn(): SessionManager {
  const sm = new SessionManager();
  sm.create({
    operator_id: 'op-1',
    display_name: 'Cashier',
    role: 'cashier',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: '',
    started_at: '2026-10-01T10:00:00.000Z',
  });
  return sm;
}

describe('SessionManager lock state (RT-117 S1)', () => {
  it('a new session starts active', () => {
    const sm = signedIn();
    expect(sm.isLocked()).toBe(false);
    expect(sm.getCurrent()?.lock_state).toBe('active');
  });

  it('lock() keeps the same session and does not fire onEnded', () => {
    const sm = signedIn();
    const id = sm.getCurrent()?.id;
    let ended = 0;
    sm.onEnded(() => {
      ended += 1;
    });

    sm.lock('2026-10-01T10:10:00.000Z');

    expect(sm.isLocked()).toBe(true);
    expect(sm.getCurrent()?.id).toBe(id);
    expect(sm.getCurrent()?.locked_at).toBe('2026-10-01T10:10:00.000Z');
    expect(ended).toBe(0);
  });

  it('unlock() resumes the same session id without firing onStarted', () => {
    const sm = signedIn();
    const id = sm.getCurrent()?.id;
    let started = 0;
    sm.onStarted(() => {
      started += 1;
    });
    sm.lock('2026-10-01T10:10:00.000Z');

    sm.unlock('2026-10-01T10:12:00.000Z');

    expect(sm.isLocked()).toBe(false);
    expect(sm.getCurrent()?.id).toBe(id);
    expect(sm.getCurrent()?.locked_at).toBeNull();
    expect(sm.getCurrent()?.last_activity_at).toBe('2026-10-01T10:12:00.000Z');
    expect(started).toBe(0);
  });

  it('activity reported while locked is ignored', () => {
    const sm = signedIn();
    sm.lock('2026-10-01T10:10:00.000Z');
    const before = sm.getCurrent()?.last_activity_at;

    sm.noteActivity('2026-10-01T10:11:00.000Z');

    expect(sm.isLocked()).toBe(true);
    expect(sm.getCurrent()?.last_activity_at).toBe(before);
  });

  it('notifies lock-state subscribers on lock and unlock only', () => {
    const sm = signedIn();
    const seen: string[] = [];
    sm.onLockStateChanged((record) => {
      seen.push(record.lock_state);
    });

    sm.lock('2026-10-01T10:10:00.000Z');
    sm.lock('2026-10-01T10:10:30.000Z'); // already locked — no second event
    sm.unlock('2026-10-01T10:12:00.000Z');
    sm.unlock('2026-10-01T10:12:30.000Z'); // already active — no event

    expect(seen).toEqual(['locked', 'active']);
  });

  it('lock() and unlock() are no-ops without a session', () => {
    const sm = new SessionManager();
    sm.lock('2026-10-01T10:10:00.000Z');
    sm.unlock('2026-10-01T10:12:00.000Z');
    expect(sm.getCurrent()).toBeNull();
    expect(sm.isLocked()).toBe(false);
  });

  it('a throwing lock-state subscriber does not break lock()', () => {
    const sm = signedIn();
    sm.onLockStateChanged(() => {
      throw new Error('subscriber failure');
    });
    sm.lock('2026-10-01T10:10:00.000Z');
    expect(sm.isLocked()).toBe(true);
  });
});
