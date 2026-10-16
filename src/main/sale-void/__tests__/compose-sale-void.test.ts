/**
 * RT-530 — the composed void domain, from a manager approval to Backend-Core
 * and back, with a fake `fetch`: a void is requested with a real approval, held
 * until its sale has synced and its REQUESTER is signed in online, sent under
 * that requester's own envelope only (never another operator's, never a device
 * bearer), and a refusal by Backend-Core (for example its business day) stays visible.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  aeadSafeStorage,
  freshGrantDb,
  handleFor,
  initGrantSql,
} from '../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import { seedSale } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { createManagerPinStore, type ManagerPinStore } from '../../operator/manager-pin-store.js';
import {
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../../operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../../operator/session-manager.js';
import { createSaleSyncStateRepo } from '../../sales-sync/sale-sync-state-repo.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';
import { businessDayOf } from '../../../shared/time/business-day.js';
import {
  composeSaleVoid,
  scheduleSaleVoidSync,
  voidBusinessDay,
  type ComposedSaleVoid,
  type ComposeSaleVoidDeps,
} from '../compose-sale-void.js';

const TERMINAL = 'term-1';
const SCOPE = { tenantId: 'tenant-1', branchId: 'branch-1', terminalId: TERMINAL };
const MONA = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000a', pin: '246810' };
const OMAR = { userId: '0190f5a2-3b4c-7d8e-9f01-00000000000b', pin: '135790' };
const SALE_REF = '0190f5a2-7b3c-7d4e-8f90-0000000000c1';
const EVENT_REF = '0190f5a2-7b3c-7d4e-8f90-0000000000e1';
const T0 = '2026-06-07T10:30:00.000Z';
const TENDERS = JSON.stringify([{ tender_type: 'cash', amount_applied_minor: 1500 }]);

function session(id: string, userId: string): OperatorSessionRecord {
  return {
    id,
    operator_id: `op-${id}`,
    display_name: `Operator ${id}`,
    role: 'manager',
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    started_at: T0,
    backend_session_id: `b-${id}`,
    last_activity_at: T0,
    lock_state: 'active',
    locked_at: null,
    manager_user_id: userId,
  };
}

interface Posted {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

let raw: SqlJsDatabase;
let pins: ManagerPinStore;
let approvals: ManagerApprovalService;
let domain: ComposedSaleVoid;
let deps: ComposeSaleVoidDeps;
let current: OperatorSessionRecord | null;
let envelopes: Record<string, string>;
let clock: string;
let audit: AuditEvent[];
let posted: Posted[];
let answer: () => Response;
let enabled: boolean;
const ref: { domain: ComposedSaleVoid | null } = { domain: null };

beforeAll(async () => {
  await initGrantSql();
});

beforeEach(async () => {
  raw = freshGrantDb();
  const db = handleFor(raw);
  audit = [];
  posted = [];
  clock = T0;
  enabled = true;
  envelopes = { mona: 'envelope-of-mona', omar: 'envelope-of-omar' };
  answer = () =>
    new Response(JSON.stringify({ kind: 'void', eventRef: EVENT_REF, saleRef: SALE_REF }), {
      status: 201,
    });
  current = session('mona', MONA.userId);
  const emitter = { emit: (e: AuditEvent) => audit.push(e) };
  pins = createManagerPinStore({ db, safeStorage: aeadSafeStorage() });
  for (const [m, name] of [
    [MONA, 'Mona'],
    [OMAR, 'Omar'],
  ] as const) {
    await pins.enrol({
      scope: SCOPE,
      userId: m.userId,
      displayName: `${name} Manager`,
      sealed: await pins.seal(m.pin),
      now: T0,
      onlineAt: T0,
      guard: () => undefined,
    });
  }
  approvals = createManagerApprovalService({
    db,
    getSession: () => current,
    isSessionLocked: () => false,
    currentTerminalId: () => TERMINAL,
    managerPins: pins,
    resolvers: {
      'sale.void': (input) => ref.domain?.service.approvalSubject(input) ?? null,
    },
    auditEmitter: emitter,
    now: () => clock,
  });
  deps = {
    db,
    http: {
      baseUrl: 'https://api.example.test',
      fetch: ((url: string, init: RequestInit) => {
        posted.push({
          url,
          headers: init.headers as Record<string, string>,
          body: JSON.parse(init.body as string) as Record<string, unknown>,
        });
        return Promise.resolve(answer());
      }) as unknown as typeof fetch,
    },
    getOperatorEnvelope: () => (current === null ? null : (envelopes[current.id] ?? null)),
    getSession: () => current,
    getTerminalId: () => TERMINAL,
    isSessionLocked: () => false,
    isEnabled: () => enabled,
    approvals,
    auditSink: emitter,
    logger: { warn: () => undefined, error: () => undefined },
    now: () => clock,
    localDayOf: (iso) => iso.slice(0, 10),
  };
  domain = composeSaleVoid(deps);
  ref.domain = domain;
  seedSale(raw, { sale_id: 'sale-1', tender_lines_summary_json: TENDERS });
});

afterEach(() => {
  raw.close();
});

function managerRef(name: string): string {
  return (
    pins.list({ scope: SCOPE, now: T0 }).find((m) => m.displayName.startsWith(name))?.managerRef ??
    ''
  );
}

/** Mona requests the void of a sale (sale-1 by default) with Omar's approval. */
async function monaRequestsVoid(saleId = 'sale-1') {
  const granted = await approvals.request({
    action_kind: 'sale.void',
    subject_ref: saleId,
    reason_code: 'sale_void',
    approver_ref: managerRef('Omar'),
    pin: OMAR.pin,
  });
  if (granted.kind !== 'approved') throw new Error(`not approved: ${granted.reason}`);
  return domain.service.request({ sale_id: saleId, approval_id: granted.approvalId });
}

function markSaleSynced(saleId = 'sale-1'): void {
  createSaleSyncStateRepo(handleFor(raw)).markSynced({
    saleId,
    tenantId: SCOPE.tenantId,
    branchId: SCOPE.branchId,
    now: T0,
    serverSaleRef: SALE_REF,
  });
}

function listed() {
  return domain.service.list();
}

describe('a void flows from the approval to Backend-Core under the requester envelope', () => {
  it('sends the approved void under the requester envelope, and confirms it', async () => {
    markSaleSynced();
    expect(await monaRequestsVoid()).toMatchObject({ kind: 'requested' });
    await domain.sync.tick();
    expect(posted).toHaveLength(1);
    const call = posted[0];
    expect(call?.url).toBe(`https://api.example.test/api/pos/v1/sales/${SALE_REF}/void`);
    expect(call?.headers['Authorization']).toBe('Bearer envelope-of-mona');
    expect(call?.headers['Idempotency-Key']).toMatch(/^pos-pulse-void:/);
    expect(call?.body).toMatchObject({
      sourceSystem: 'pos-pulse',
      businessDate: '2026-06-07',
      approval: {
        action: 'sale.void',
        saleRef: SALE_REF,
        amount: '15.00',
        requesterUserId: MONA.userId,
        approverUserId: OMAR.userId,
        policyVersion: 'rt114-2026-10-07',
      },
    });
    await expect(listed()).resolves.toMatchObject({
      voids: [{ state: 'confirmed', waiting_for: null }],
    });
    expect(audit.map((e) => e.action_category)).toEqual([
      'manager_approval.granted',
      'sale.void.requested',
      'sale.void.confirmed',
    ]);
  });

  it('holds the void while another operator is signed in, and says who it waits for', async () => {
    markSaleSynced();
    await monaRequestsVoid();
    current = session('omar', OMAR.userId);
    await domain.sync.tick();
    expect(posted).toHaveLength(0);
    await expect(listed()).resolves.toMatchObject({
      voids: [
        {
          state: 'pending',
          waiting_for: 'requester_sign_in',
          requester_display_name: 'Operator mona',
        },
      ],
    });
    // The requester signs back in: it goes out under HER envelope.
    current = session('mona', MONA.userId);
    await domain.sync.tick();
    expect(posted.map((p) => p.headers['Authorization'])).toEqual(['Bearer envelope-of-mona']);
  });

  it('holds the void when the requester has no envelope (not online), and while the sale has not synced', async () => {
    expect(await monaRequestsVoid()).toMatchObject({ void: { waiting_for: 'sale_sync' } });
    await domain.sync.tick();
    expect(posted).toHaveLength(0);
    markSaleSynced();
    envelopes = {};
    await domain.sync.tick();
    expect(posted).toHaveLength(0);
    await expect(listed()).resolves.toMatchObject({
      voids: [{ waiting_for: 'requester_sign_in' }],
    });
    envelopes = { mona: 'envelope-of-mona' };
    await domain.sync.tick();
    expect(posted).toHaveLength(1);
  });

  it('never sends anything but the void route, and never a device credential', async () => {
    markSaleSynced();
    await monaRequestsVoid();
    await domain.sync.tick();
    for (const call of posted) {
      expect(call.url).toMatch(/\/api\/pos\/v1\/sales\/[0-9a-f-]{36}\/void$/);
      expect(Object.keys(call.headers).sort()).toEqual([
        'Authorization',
        'Content-Type',
        'Idempotency-Key',
      ]);
      expect(call.headers['Authorization']).toMatch(/^Bearer envelope-of-/);
    }
  });

  it('when Backend-Core refuses it for its business day, the refusal is visible and terminal, never retried or dropped', async () => {
    markSaleSynced();
    await monaRequestsVoid();
    clock = '2026-06-08T09:00:00.000Z';
    answer = () =>
      new Response(JSON.stringify({ error: { code: 'void_outside_business_day' } }), {
        status: 422,
      });
    await domain.sync.tick();
    await expect(listed()).resolves.toMatchObject({
      voids: [
        { state: 'refused', refusal_reason: 'void_outside_business_day', needs_attention: true },
      ],
    });
    await domain.sync.tick();
    expect(posted).toHaveLength(1);
    expect(audit.map((e) => e.action_category)).toContain('sale.void.refused');
    const refused = await listed();
    const id = refused.kind === 'list' ? (refused.voids[0]?.void_id ?? '') : '';
    await domain.service.acknowledge({ void_id: id });
    await expect(listed()).resolves.toMatchObject({
      voids: [{ state: 'refused', needs_attention: false }],
    });
  });

  it('a lost answer keeps the void queued and replays the same request', async () => {
    markSaleSynced();
    await monaRequestsVoid();
    answer = () => new Response('', { status: 503 });
    await domain.sync.tick();
    await expect(listed()).resolves.toMatchObject({ voids: [{ state: 'unknown' }] });
    answer = () =>
      new Response(JSON.stringify({ kind: 'void', eventRef: EVENT_REF, saleRef: SALE_REF }), {
        status: 200,
      });
    clock = '2026-06-07T10:31:00.000Z';
    await domain.sync.tick();
    expect(posted).toHaveLength(2);
    expect(posted[1]?.body).toEqual(posted[0]?.body);
    expect(posted[1]?.headers['Idempotency-Key']).toBe(posted[0]?.headers['Idempotency-Key']);
    await expect(listed()).resolves.toMatchObject({ voids: [{ state: 'confirmed' }] });
  });
});

describe('the composition defaults and failure paths', () => {
  it('dates the void on the store business day and the default currency when none is given', async () => {
    const { localDayOf: pinnedDay, ...defaults } = deps;
    expect(pinnedDay).toBeDefined(); // the other tests pin a day; this one drops it
    domain = composeSaleVoid(defaults);
    ref.domain = domain;
    markSaleSynced();
    await expect(monaRequestsVoid()).resolves.toMatchObject({ kind: 'requested' });
    const requested = audit.find((e) => e.action_category === 'sale.void.requested');
    expect(requested?.payload).toMatchObject({
      business_date: businessDayOf(T0),
      currency_code: 'EGP',
    });
  });

  it('a failing seller lookup is logged and does not block the request (Backend-Core still refuses a seller approver)', async () => {
    const warn = vi.fn();
    domain = composeSaleVoid({ ...deps, logger: { warn, error: () => undefined } });
    ref.domain = domain;
    raw.run('DROP TABLE audit_events');
    await expect(monaRequestsVoid()).resolves.toMatchObject({ kind: 'requested' });
    expect(warn).toHaveBeenCalledWith({}, 'sale_void:seller_lookup_failed');
  });

  it('logs a send pass that rejects unexpectedly, and keeps the schedule', async () => {
    vi.useFakeTimers();
    try {
      const error = vi.fn();
      const tick = vi.fn(() => Promise.reject(new Error('boom')));
      const stop = scheduleSaleVoidSync({
        sync: { tick, drain: () => Promise.resolve() },
        stopDomain: () => undefined,
        intervalMs: 5_000,
        drainTimeoutMs: 1_000,
        logger: { error },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(tick).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(
        { err: expect.any(Error) as unknown },
        'sale_void_sync:tick_unexpected',
      );
      await stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('voidBusinessDay', () => {
  it('is the store business day (Africa/Cairo) of the instant', () => {
    // Summer time (UTC+3): 21:30Z is 00:30 the next day in Cairo.
    expect(voidBusinessDay('2026-06-07T21:30:00.000Z')).toBe('2026-06-08');
    expect(voidBusinessDay('2026-12-31T21:59:59.000Z')).toBe('2026-12-31');
  });

  it('marks an unreadable instant so it never matches a real day', () => {
    expect(voidBusinessDay('not-a-date')).toBe('invalid:not-a-date');
  });
});

// RT-552 (RT-545 S3) — the void day is the store business day of
// `finalized_at`, whatever the process or Windows zone: Backend-Core refuses a
// void whose `businessDate` is not the sale's `business_date` (422
// `void_outside_business_day`).
describe.each(['UTC', 'America/New_York', 'Africa/Cairo'])(
  'RT-552 — the void business day under TZ=%s',
  (zone) => {
    let savedTz: string | undefined;
    let n = 0;

    beforeEach(() => {
      savedTz = process.env.TZ;
      process.env.TZ = zone;
      const { localDayOf: pinned, ...defaults } = deps;
      expect(pinned).toBeDefined(); // the other tests pin a day; these use the default
      domain = composeSaleVoid(defaults);
      ref.domain = domain;
    });

    afterEach(() => {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    });

    /** Seeds a sale finalized at `finalized_at`; returns its id. */
    function saleFinalizedAt(finalized_at: string): string {
      n += 1;
      const sale_id = `sale-tz-${String(n)}`;
      seedSale(raw, { sale_id, finalized_at, tender_lines_summary_json: TENDERS });
      return sale_id;
    }

    async function ineligibleAt(finalized_at: string, now: string): Promise<unknown> {
      const saleId = saleFinalizedAt(finalized_at);
      clock = now;
      const found = await domain.service.lookup({ sale_number: `SN-${saleId}` });
      return found.kind === 'sale' ? found.sale.ineligible : found;
    }

    it('really runs in that process zone', () => {
      // 2026-01-15T23:30Z is the 15th in New York, the 16th in Cairo, the 15th in UTC.
      const local = new Date('2026-01-15T23:30:00.000Z').getDate();
      expect(local).toBe(zone === 'Africa/Cairo' ? 16 : 15);
    });

    it.each([
      // [case, finalized_at, now, expected]
      [
        'winter: across Cairo midnight',
        '2026-01-15T21:59:59.000Z',
        '2026-01-15T22:00:00.000Z',
        'not_same_day',
      ],
      [
        'winter: just before Cairo midnight',
        '2026-01-15T21:30:00.000Z',
        '2026-01-15T21:59:59.000Z',
        null,
      ],
      [
        'winter: just after Cairo midnight',
        '2026-01-15T22:00:00.000Z',
        '2026-01-15T22:30:00.000Z',
        null,
      ],
      [
        'summer: across Cairo midnight',
        '2026-07-15T20:59:59.000Z',
        '2026-07-15T21:00:00.000Z',
        'not_same_day',
      ],
      [
        'summer: just before Cairo midnight',
        '2026-07-15T20:30:00.000Z',
        '2026-07-15T20:59:59.000Z',
        null,
      ],
      // 23:30Z on D-1 is Cairo 01:30 on D: voidable on Cairo D, not on D+1.
      [
        '23:30Z on D-1, on Cairo day D',
        '2026-01-14T23:30:00.000Z',
        '2026-01-15T10:00:00.000Z',
        null,
      ],
      [
        '23:30Z on D-1, on Cairo day D+1',
        '2026-01-14T23:30:00.000Z',
        '2026-01-15T22:30:00.000Z',
        'not_same_day',
      ],
    ])('%s', async (_case, finalized_at, now, expected) => {
      await expect(ineligibleAt(finalized_at, now)).resolves.toBe(expected);
    });

    it('sends the Cairo business day of finalized_at near midnight', async () => {
      // Summer: finalized 00:30 Cairo on 06-08 (21:30Z on 06-07), voided 10 minutes later.
      const saleId = saleFinalizedAt('2026-06-07T21:30:00.000Z');
      clock = '2026-06-07T21:40:00.000Z';
      markSaleSynced(saleId);
      await expect(monaRequestsVoid(saleId)).resolves.toMatchObject({ kind: 'requested' });
      const requested = audit.find((e) => e.action_category === 'sale.void.requested');
      expect(requested?.payload).toMatchObject({ business_date: '2026-06-08' });
      // The same day goes out on the wire to Backend-Core.
      await domain.sync.tick();
      expect(posted).toHaveLength(1);
      expect(posted[0]?.body).toMatchObject({ businessDate: '2026-06-08' });
    });
  },
);

describe('the domain gates and shutdown', () => {
  it('refuses every call with the flag off', async () => {
    enabled = false;
    await expect(domain.service.list()).resolves.toEqual({
      kind: 'refused',
      reason: 'feature_disabled',
    });
  });

  it('an unpaired terminal (no terminal id) has no session and sends nothing', async () => {
    markSaleSynced();
    await monaRequestsVoid();
    domain = composeSaleVoid({ ...deps, getTerminalId: () => null });
    await expect(domain.service.list()).resolves.toEqual({
      kind: 'refused',
      reason: 'no_session',
    });
    await domain.sync.tick();
    expect(posted).toHaveLength(0);
  });

  it('after stop, calls answer void_unavailable and no send starts', async () => {
    markSaleSynced();
    await monaRequestsVoid();
    domain.stop();
    await expect(domain.service.list()).resolves.toEqual({
      kind: 'refused',
      reason: 'void_unavailable',
    });
    expect(await domain.sync.tick()).toBeNull();
    expect(posted).toHaveLength(0);
  });

  it('schedules a send now and on an interval, and the stopper latches the domain and drains', async () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn(() => Promise.resolve(null));
      const stopDomain = vi.fn();
      const stop = scheduleSaleVoidSync({
        sync: { tick, drain: () => Promise.resolve() },
        stopDomain,
        intervalMs: 5_000,
        drainTimeoutMs: 1_000,
        logger: { error: () => undefined },
      });
      expect(tick).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tick).toHaveBeenCalledTimes(3);
      await stop();
      expect(stopDomain).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(tick).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
