import { describe, expect, it } from 'vitest';

import { SessionManager } from '../session-manager.js';

/**
 * 004-operator-session T028 — session manager (in-memory).
 */

const FIXED_NOW = '2026-05-06T00:00:00.000Z';

function makeManager(): SessionManager {
  return new SessionManager();
}

describe('SessionManager', () => {
  it('starts with no current session', () => {
    expect(makeManager().getCurrent()).toBeNull();
  });

  it('create() sets a new session and getCurrent returns it', () => {
    const m = makeManager();
    const record = m.create({
      operator_id: 'op-1',
      display_name: 'Manager',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'be-1',
      started_at: FIXED_NOW,
    });
    expect(record.operator_id).toBe('op-1');
    expect(m.getCurrent()).toBe(record);
  });

  it('getCurrentBridgeView strips backend_session_id and last_activity_at', () => {
    const m = makeManager();
    m.create({
      operator_id: 'op-1',
      display_name: 'Manager',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'be-1',
      started_at: FIXED_NOW,
    });
    const view = m.getCurrentBridgeView();
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty('backend_session_id');
    expect(view).not.toHaveProperty('last_activity_at');
    expect(view?.operator_id).toBe('op-1');
  });

  it('end() clears the current session and returns the prior record', () => {
    const m = makeManager();
    m.create({
      operator_id: 'op-1',
      display_name: 'Manager',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'be-1',
    });
    const ended = m.end();
    expect(ended?.operator_id).toBe('op-1');
    expect(m.getCurrent()).toBeNull();
    expect(m.getCurrentBridgeView()).toBeNull();
    // Idempotent: ending again is a no-op.
    expect(m.end()).toBeNull();
  });

  it('noteActivity updates last_activity_at on the current record', () => {
    const m = makeManager();
    m.create({
      operator_id: 'op-1',
      display_name: 'Manager',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'be-1',
      started_at: FIXED_NOW,
    });
    const newer = '2026-05-06T00:05:00.000Z';
    m.noteActivity(newer);
    expect(m.getCurrent()?.last_activity_at).toBe(newer);
  });

  it('noteActivity is a no-op when no session is active', () => {
    const m = makeManager();
    expect(() => {
      m.noteActivity(FIXED_NOW);
    }).not.toThrow();
    expect(m.getCurrent()).toBeNull();
  });

  // #380 (F-007 part b) — onStarted is the symmetric counterpart of onEnded.
  // It is the single seam the cashier-PIN + manager/admin sign-in paths both
  // funnel through (both call create()), so the orphan-attempt sweep registered
  // here covers every sign-in role without per-handler wiring.
  describe('#380 onStarted — fires on session create', () => {
    it('invokes registered callbacks with the new record on create()', () => {
      const m = makeManager();
      const seen: string[] = [];
      m.onStarted((record) => seen.push(record.operator_id));
      m.create({
        operator_id: 'op-start',
        display_name: 'Manager',
        role: 'manager',
        tenant_id: 't1',
        branch_id: 'b1',
        backend_session_id: 'be-1',
        started_at: FIXED_NOW,
      });
      expect(seen).toEqual(['op-start']);
    });

    it('fires every registered callback in order', () => {
      const m = makeManager();
      const order: number[] = [];
      m.onStarted(() => order.push(1));
      m.onStarted(() => order.push(2));
      m.create({
        operator_id: 'op-1',
        display_name: 'M',
        role: 'manager',
        tenant_id: 't1',
        branch_id: 'b1',
        backend_session_id: 'be-1',
        started_at: FIXED_NOW,
      });
      expect(order).toEqual([1, 2]);
    });

    it('a throwing subscriber does not break create() (mirrors onEnded)', () => {
      const m = makeManager();
      m.onStarted(() => {
        throw new Error('subscriber boom');
      });
      let record;
      expect(() => {
        record = m.create({
          operator_id: 'op-1',
          display_name: 'M',
          role: 'manager',
          tenant_id: 't1',
          branch_id: 'b1',
          backend_session_id: 'be-1',
          started_at: FIXED_NOW,
        });
      }).not.toThrow();
      expect(record).toBeDefined();
      expect(m.getCurrent()).not.toBeNull();
    });
  });
});

describe('SessionManager — RT-113 P2 cashier admission fields (10763 §3)', () => {
  const ADMISSION = {
    user_id: '0192f6a0-1b2c-7d3e-8f40-123456789abc',
    admission_id: '0192f6a0-aaaa-7bbb-8ccc-000000000001',
    admission_ttl_seconds: 43_200,
    offline_grace_seconds: 86_400,
    admission_generation: 'gen-signin-0001',
  };

  function createCashier(m: SessionManager): ReturnType<SessionManager['create']> {
    return m.create({
      operator_id: 'user_clerk_1',
      display_name: 'Cashier',
      role: 'cashier',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: '',
      cashier_admission: ADMISSION,
    });
  }

  it('an admitted cashier session carries user_id, admission and authority online_confirmed', () => {
    const record = createCashier(makeManager());
    expect(record).toMatchObject({
      user_id: ADMISSION.user_id,
      admission_id: ADMISSION.admission_id,
      admission_ttl_seconds: 43_200,
      offline_grace_seconds: 86_400,
      admission_generation: 'gen-signin-0001',
      authority: 'online_confirmed',
    });
  });

  it('a session created without an admission carries no admission fields', () => {
    const record = makeManager().create({
      operator_id: 'op-1',
      display_name: 'Manager',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: 'be-1',
    });
    expect(record.authority).toBeUndefined();
    expect(record.admission_id).toBeUndefined();
    expect(record.admission_generation).toBeUndefined();
    expect(record.user_id).toBeUndefined();
  });

  it('the renderer bridge view never carries the admission fields (main-only, Constitution VII)', () => {
    const m = makeManager();
    createCashier(m);
    const view = m.getCurrentBridgeView() as unknown as Record<string, unknown>;
    for (const field of [
      'user_id',
      'admission_id',
      'authority',
      'admission_ttl_seconds',
      'offline_grace_seconds',
      'admission_generation',
    ]) {
      expect(view).not.toHaveProperty(field);
    }
    // RT-219: the generation is main-only; it never reaches the renderer.
    expect(JSON.stringify(view)).not.toContain(ADMISSION.admission_generation);
  });

  it('renewAdmission updates the current session only when the id matches', () => {
    const m = makeManager();
    const record = createCashier(m);
    expect(
      m.renewAdmission('another-session', {
        admission_id: 'x',
        admission_ttl_seconds: 1,
        offline_grace_seconds: 1,
        admission_generation: 'gen-other',
      }),
    ).toBe(false);
    expect(record.admission_id).toBe(ADMISSION.admission_id);
    expect(record.admission_generation).toBe(ADMISSION.admission_generation);
    expect(
      m.renewAdmission(record.id, {
        admission_id: 'new-id',
        admission_ttl_seconds: 600,
        offline_grace_seconds: 3_600,
        admission_generation: 'gen-renewed-0002',
      }),
    ).toBe(true);
    expect(m.getCurrent()).toMatchObject({
      admission_id: 'new-id',
      admission_ttl_seconds: 600,
      offline_grace_seconds: 3_600,
      admission_generation: 'gen-renewed-0002',
      authority: 'online_confirmed',
    });
  });

  it('RT-219: a renewal of the SAME admission_id still replaces the generation', () => {
    const m = makeManager();
    const record = createCashier(m);
    m.renewAdmission(record.id, {
      admission_id: ADMISSION.admission_id,
      admission_ttl_seconds: 43_200,
      offline_grace_seconds: 86_400,
      admission_generation: 'gen-heartbeat-0002',
    });
    expect(m.getCurrent()?.admission_id).toBe(ADMISSION.admission_id);
    expect(m.getCurrent()?.admission_generation).toBe('gen-heartbeat-0002');
  });

  it('renewAdmission is a no-op without a current session', () => {
    expect(
      makeManager().renewAdmission('s', {
        admission_id: 'x',
        admission_ttl_seconds: 1,
        offline_grace_seconds: 1,
        admission_generation: 'gen-x',
      }),
    ).toBe(false);
  });
});

describe('SessionManager — RT-113 P2 authority latch (Codex P1 #1 / review F1-F2)', () => {
  function cashier(m: SessionManager): ReturnType<SessionManager['create']> {
    return m.create({
      operator_id: 'user_clerk_1',
      display_name: 'Cashier',
      role: 'cashier',
      tenant_id: 't1',
      branch_id: 'b1',
      backend_session_id: '',
    });
  }

  it('latches the current session only, keeps the first cause, and is main-only', () => {
    const m = makeManager();
    const record = cashier(m);
    expect(m.latchAuthority('other', 'superseded_by_takeover')).toBe(false);
    expect(record.authority_latch).toBeUndefined();
    expect(m.latchAuthority(record.id, 'account_disabled_mid_session')).toBe(true);
    expect(m.latchAuthority(record.id, 'superseded_by_takeover')).toBe(true);
    expect(m.getCurrent()?.authority_latch).toBe('account_disabled_mid_session');
    expect(m.getCurrentBridgeView()).not.toHaveProperty('authority_latch');
  });

  it('a new session starts unlatched', () => {
    const m = makeManager();
    const first = cashier(m);
    m.latchAuthority(first.id, 'superseded_by_takeover');
    m.end('superseded_by_takeover');
    expect(cashier(m).authority_latch).toBeUndefined();
  });
});
