/**
 * RT-113 P1.2 — the offline grant wiring: the cashier-admission seam.
 * `admitted` writes or refreshes the grant for the pairing scope; a 403
 * (`forbidden`) and `active_elsewhere` (`superseded`, OD6) invalidate that
 * user; every device 401 invalidates every grant (OD5); results are bound to
 * the pairing that sent them (Codex P1 4181552524) and dropped after a later
 * invalidation (rev545 F-2); the audit carries `{reason}` only (OD10).
 * Shared harness: `__helpers__/offline-grant-wiring-harness.ts`.
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { AUDIT_ACTION_CATEGORIES } from '../../../shared/audit/event-shape.js';
import type { CashierAdmittedEvent } from '../cashier-admission.js';
import { scopeFromPairingStatus } from '../offline-grant-wiring.js';
import {
  BRANCH,
  DISPLAY_NAME,
  EPOCH,
  OPERATOR,
  SENSITIVE_VALUES,
  T0,
  TENANT,
  TERMINAL,
  USER,
  admitted,
  rows,
  scope,
} from './__helpers__/offline-grant-fixture.js';
import {
  USER_2,
  OPERATOR_2,
  CATEGORY,
  g,
  logCalls,
  audits,
  wiring,
  refusal,
  admit,
  admitBoth,
  invalidate,
  body,
  auditOf,
  installWiringHarness,
} from './__helpers__/offline-grant-wiring-harness.js';

installWiringHarness();

describe('the audit category (OD10)', () => {
  it('operator.offline_grant.invalidated is in the closed audit catalogue', () => {
    expect(AUDIT_ACTION_CATEGORIES).toContain(CATEGORY);
  });
});

describe('admitted writes or refreshes the grant (D3)', () => {
  it('writes a grant bound to the pairing scope (tenant, branch, terminal, epoch)', () => {
    admit();
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
    expect(body()).toMatchObject({
      tenant_id: TENANT,
      branch_id: BRANCH,
      terminal_id: TERMINAL,
      pairing_epoch: EPOCH,
      user_id: USER,
    });
    expect(audits).toEqual([]);
  });

  it('a refresh resets the counter', () => {
    admit();
    wiring.consumeOfflineUse(USER, T0);
    wiring.consumeOfflineUse(USER, T0);
    expect(body()['offline_admissions_used']).toBe(2);
    admit();
    expect(body()['offline_admissions_used']).toBe(0);
  });

  it('writes nothing while the terminal is not paired', () => {
    wiring.setScope(null);
    admit();
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('scope_mismatch'));
  });

  it('grace 0 invalidates the grant and audits grace_disabled (OD8)', () => {
    admit();
    admit({ offline_grace_seconds: 0 });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(audits.map(auditOf)).toEqual([{ reason: 'grace_disabled', operator: OPERATOR }]);
  });

  it('a malformed admitted event invalidates the grant and audits refresh_failed', () => {
    admit();
    admit({ received_at: 'not a time' });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(audits.map(auditOf)).toEqual([{ reason: 'refresh_failed', operator: OPERATOR }]);
  });
});

describe('an admission result is bound to the pairing that sent it (Codex P1 4181552524)', () => {
  it('a result for a request sent before a re-pair writes no grant for the new pairing', () => {
    const sentUnder = wiring.seam.pairingGeneration?.();
    wiring.onPairingChange('repair');
    wiring.setScope(scope({ terminal_id: 'terminal-new', pairing_epoch: EPOCH + 1 }));
    wiring.seam.onCashierAdmitted(admitted({ pairing_generation: sentUnder }));
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_missing'));
    expect(JSON.stringify(logCalls)).toContain('operator.offline_grant.stale_result');
  });

  it('a result for a request sent before an unpair-and-pair writes nothing either', () => {
    const sentUnder = wiring.seam.pairingGeneration?.();
    wiring.onPairingChange('unpair');
    wiring.setScope(null);
    wiring.onPairingChange('repair');
    wiring.setScope(scope());
    wiring.seam.onCashierAdmitted(admitted({ pairing_generation: sentUnder }));
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
  });

  it('an admitted event that does not say which pairing sent it is dropped (fail closed)', () => {
    wiring.seam.onCashierAdmitted(admitted());
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
  });

  // Codex P2 4182060617, decided (coordinator): invalidations are NOT filtered
  // by pairing. A stale refusal only removes offline authority (fail closed);
  // dropping it could drop a real refusal. The next `admitted` restores it.
  it.each([
    { reason: 'refused', user_id: USER },
    { reason: 'active_elsewhere', user_id: USER },
    { reason: 'device_unauthorized' },
  ] as const)(
    "a stale %o from pairing A after a re-pair to B removes B's grant; the next admitted under B restores it",
    (stale) => {
      wiring.onPairingChange('repair');
      wiring.setScope(scope({ terminal_id: 'terminal-b', pairing_epoch: EPOCH + 1 }));
      admit();
      expect(wiring.evaluate(USER, T0).admissible).toBe(true);
      // The answer to a request sent under pairing A lands now.
      invalidate(stale);
      expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
      admit();
      expect(wiring.evaluate(USER, T0).admissible).toBe(true);
      expect(body()).toMatchObject({ terminal_id: 'terminal-b', pairing_epoch: EPOCH + 1 });
    },
  );

  it('a result for the current pairing is written', () => {
    const sentUnder = wiring.seam.pairingGeneration?.();
    wiring.seam.onCashierAdmitted(
      admitted({
        pairing_generation: sentUnder,
        invalidation_seq: wiring.seam.invalidationSeq?.(),
      }),
    );
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
  });
});

describe('a late admitted never resurrects a grant invalidated after its request was sent (rev545 F-2)', () => {
  /** What a request records when it is SENT. */
  function sent(): Partial<CashierAdmittedEvent> {
    return {
      pairing_generation: wiring.seam.pairingGeneration?.(),
      invalidation_seq: wiring.seam.invalidationSeq?.(),
    };
  }

  it('probe F: a 403 for U after the request was sent drops its late admitted', () => {
    admit();
    const inFlight = sent();
    invalidate({ reason: 'refused', user_id: USER });
    wiring.seam.onCashierAdmitted(admitted(inFlight));
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(body()['invalidated']).toMatchObject({ reason: 'forbidden' });
    expect(JSON.stringify(logCalls)).toContain('operator.offline_grant.superseded_result');
  });

  it.each([
    { reason: 'active_elsewhere', user_id: USER },
    { reason: 'device_unauthorized' },
  ] as const)('%o after the request was sent drops its late admitted too', (inv) => {
    admit();
    const inFlight = sent();
    invalidate(inv);
    wiring.seam.onCashierAdmitted(admitted(inFlight));
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
  });

  it("another user's invalidation does not drop U's admitted", () => {
    admit({ user_id: USER_2, operator_id: OPERATOR_2 });
    const inFlight = sent();
    invalidate({ reason: 'refused', user_id: USER_2 });
    wiring.seam.onCashierAdmitted(admitted(inFlight));
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
  });

  it('a request sent after the invalidation is written (the next admitted restores)', () => {
    admit();
    invalidate({ reason: 'refused', user_id: USER });
    wiring.seam.onCashierAdmitted(admitted(sent()));
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
  });

  it('an admitted that does not say when it was sent is dropped (fail closed)', () => {
    wiring.seam.onCashierAdmitted(
      admitted({ pairing_generation: wiring.seam.pairingGeneration?.() }),
    );
    expect(rows(g.raw, 'cashier_offline_grants')).toEqual([]);
  });
});

describe('invalidation per outcome (D4, OD5, OD6)', () => {
  beforeEach(() => {
    admitBoth();
  });

  it('a 403 (`refused`) invalidates THAT user only, reason forbidden', () => {
    invalidate({ reason: 'refused', user_id: USER });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate(USER_2, T0).admissible).toBe(true);
    expect(body()['invalidated']).toMatchObject({ reason: 'forbidden' });
    expect(audits.map(auditOf)).toEqual([{ reason: 'forbidden', operator: OPERATOR }]);
  });

  it('active_elsewhere invalidates that user only, reason superseded (OD6)', () => {
    invalidate({ reason: 'active_elsewhere', user_id: USER_2 });
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate(USER, T0).admissible).toBe(true);
    expect(body(USER_2)['invalidated']).toMatchObject({ reason: 'superseded' });
    expect(audits.map(auditOf)).toEqual([{ reason: 'superseded', operator: OPERATOR_2 }]);
  });

  it('a device 401 invalidates ALL grants, one audit event per grant (OD5, OD10)', () => {
    invalidate({ reason: 'device_unauthorized' });
    expect(wiring.evaluate(USER, T0)).toEqual(refusal('grant_invalidated'));
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
    expect(audits.map(auditOf)).toEqual(
      expect.arrayContaining([
        { reason: 'device_unauthorized', operator: OPERATOR },
        { reason: 'device_unauthorized', operator: OPERATOR_2 },
      ]),
    );
    expect(audits).toHaveLength(2);
  });

  it('a second invalidation of the same grant audits nothing more', () => {
    invalidate({ reason: 'refused', user_id: USER });
    invalidate({ reason: 'device_unauthorized' });
    expect(audits.map(auditOf)).toEqual([
      { reason: 'forbidden', operator: OPERATOR },
      { reason: 'device_unauthorized', operator: OPERATOR_2 },
    ]);
  });
});

describe('the audit event carries {reason} only, attributed to the grant operator (OD10)', () => {
  it('has the full envelope, a null session and shift, and no grant field', () => {
    admit();
    invalidate({ reason: 'refused', user_id: USER });
    expect(audits).toEqual([
      {
        event_id: 'evt-1',
        tenant_id: TENANT,
        branch_id: BRANCH,
        originating_terminal_id: TERMINAL,
        acting_operator_id: OPERATOR,
        session_id: null,
        shift_id: null,
        action_category: CATEGORY,
        created_at: T0.toISOString(),
        approving_supervisor_id: null,
        payload: { reason: 'forbidden' },
      },
    ]);
  });

  it('no grant body field or name reaches an audit event or a log line', () => {
    admitBoth();
    invalidate({ reason: 'refused', user_id: USER });
    invalidate({ reason: 'active_elsewhere', user_id: USER_2 });
    admit();
    invalidate({ reason: 'device_unauthorized' });
    admit({ offline_grace_seconds: 0 });
    wiring.onPairingChange('repair');
    expect(audits.length).toBeGreaterThan(2);
    const audited = JSON.stringify(audits.map((a) => a.payload));
    const envelopes = JSON.stringify(audits);
    for (const v of [DISPLAY_NAME, USER, USER_2, 'adm-SENTINEL-0d42', '2026-10-05T08:00:00.000Z']) {
      expect(envelopes).not.toContain(v);
    }
    for (const a of audits) expect(Object.keys(a.payload)).toEqual(['reason']);
    expect(audited).not.toContain(OPERATOR);
    const logged = JSON.stringify(logCalls);
    for (const v of [...SENSITIVE_VALUES, USER_2, OPERATOR_2]) expect(logged).not.toContain(v);
  });
});

describe('every device 401 invalidates, not only the first (Codex P1 4183383053)', () => {
  it('a grant written between two 401s is invalidated by the second; a late admitted sent before it is dropped', () => {
    admit();
    invalidate({ reason: 'device_unauthorized' });
    admit({ user_id: USER_2, operator_id: OPERATOR_2 }); // an online sign-in between the 401s
    expect(wiring.evaluate(USER_2, T0).admissible).toBe(true);
    const inFlight = {
      pairing_generation: wiring.seam.pairingGeneration?.(),
      invalidation_seq: wiring.seam.invalidationSeq?.(),
    };
    invalidate({ reason: 'device_unauthorized' }); // the confirming 401
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
    wiring.seam.onCashierAdmitted(
      admitted({ user_id: USER_2, operator_id: OPERATOR_2, ...inFlight }),
    );
    expect(wiring.evaluate(USER_2, T0)).toEqual(refusal('grant_invalidated'));
  });
});

describe('scopeFromPairingStatus', () => {
  it('takes the scope and epoch from a paired status, null otherwise', () => {
    expect(
      scopeFromPairingStatus({
        kind: 'paired',
        tenant_id: TENANT,
        branch_id: BRANCH,
        terminal_id: TERMINAL,
        terminal_label: 'Till 1',
        paired_at: EPOCH,
      }),
    ).toEqual(scope());
    expect(scopeFromPairingStatus({ kind: 'unpaired' })).toBeNull();
    expect(scopeFromPairingStatus({ kind: 'invalid', reason: 'decrypt_failed' })).toBeNull();
  });
});
