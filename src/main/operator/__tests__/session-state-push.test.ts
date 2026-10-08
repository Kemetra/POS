import { describe, expect, it, vi } from 'vitest';

import { SessionManager } from '../session-manager.js';
import { wireSessionStatePush } from '../session-state-push.js';
import type { SessionStateEvent } from '../../../shared/bridge-api.js';

/**
 * RT-117 (RT-116 §7.2) — the first main → renderer push primitive. Main tells
 * the renderer the moment the session locks, unlocks or ends, so the lock
 * screen appears immediately instead of waiting for a route read (RT-112 RC-2).
 *
 * Security: the payload carries ONLY the state — no session id, operator id,
 * role, name or credential.
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

describe('RT-117 wireSessionStatePush', () => {
  it('pushes locked, then active, then ended', () => {
    const sm = signedIn();
    const sent: SessionStateEvent[] = [];
    wireSessionStatePush({ sessionManager: sm, send: (e) => sent.push(e) });

    sm.lock('2026-10-01T10:10:00.000Z');
    sm.unlock('2026-10-01T10:11:00.000Z');
    sm.end('signed_out');

    expect(sent).toEqual([{ state: 'locked' }, { state: 'active' }, { state: 'ended' }]);
  });

  it('the payload carries the state only', () => {
    const sm = signedIn();
    const sent: SessionStateEvent[] = [];
    wireSessionStatePush({ sessionManager: sm, send: (e) => sent.push(e) });

    sm.lock('2026-10-01T10:10:00.000Z');

    expect(Object.keys(sent[0] ?? {})).toEqual(['state']);
  });

  it('a failing send does not break locking', () => {
    const sm = signedIn();
    const logError = vi.fn();
    wireSessionStatePush({
      sessionManager: sm,
      send: () => {
        throw new Error('window gone');
      },
      logError,
    });

    sm.lock('2026-10-01T10:10:00.000Z');

    expect(sm.isLocked()).toBe(true);
    expect(logError).toHaveBeenCalled();
  });
});
