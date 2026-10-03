import { describe, expect, it } from 'vitest';

import { SessionManager } from '../session-manager.js';
import { createJwtHolder } from '../jwt-holder.js';
import { createSaleSyncTokenReader } from '../sale-sync-token.js';

/**
 * RT-117 — owner concern Z3 (RT-116 §2.4): the interim manager/admin
 * self-unlock must not silently break or pause sale-sync authorization.
 *
 * Sale sync reads the operator ENVELOPE keyed on the current session's
 * backend_session_id. Lock and unlock keep the SAME session (same backend
 * session id) and never touch the envelope holder, so the drain keeps its
 * credential through a lock and after the unlock.
 */

function managerSignedIn(): { sm: SessionManager; holder: ReturnType<typeof createJwtHolder> } {
  const sm = new SessionManager();
  const holder = createJwtHolder();
  sm.create({
    operator_id: 'mgr-1',
    display_name: 'Manager',
    role: 'manager',
    tenant_id: 't1',
    branch_id: 'b1',
    backend_session_id: 'be-1',
    started_at: '2026-10-01T10:00:00.000Z',
  });
  holder.set('be-1', 'envelope-abc');
  return { sm, holder };
}

describe('RT-117 createSaleSyncTokenReader (Z3)', () => {
  it('returns the envelope for the current session', () => {
    const { sm, holder } = managerSignedIn();
    expect(createSaleSyncTokenReader(sm, holder)()).toBe('envelope-abc');
  });

  it('keeps the envelope while the session is locked', () => {
    const { sm, holder } = managerSignedIn();
    const read = createSaleSyncTokenReader(sm, holder);
    sm.lock('2026-10-01T10:10:00.000Z');
    expect(read()).toBe('envelope-abc');
  });

  it('still returns the same envelope after the manager unlocks', () => {
    const { sm, holder } = managerSignedIn();
    const read = createSaleSyncTokenReader(sm, holder);
    sm.lock('2026-10-01T10:10:00.000Z');
    sm.unlock('2026-10-01T10:12:00.000Z');
    expect(read()).toBe('envelope-abc');
  });

  it('returns null when no session exists', () => {
    const { sm, holder } = managerSignedIn();
    const read = createSaleSyncTokenReader(sm, holder);
    sm.end('signed_out');
    expect(read()).toBeNull();
  });
});
