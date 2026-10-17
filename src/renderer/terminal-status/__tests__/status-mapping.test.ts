/**
 * RT-604 (VN-S6 S6-3) — the doc 24 §4.1 composite mapping, as a parametrised
 * table. Main sends facts; this pure function turns them into the indicator's
 * rows. The rule column is the banner precedence (first match wins), which
 * S6-4 consumes; the indicator always shows connection and sync separately.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ConnectionStateCode,
  TerminalStatusSnapshot,
  TerminalStatusSync,
} from '../../../shared/terminal-status/types';
import { STATUS_NOW as NOW, iso, snap } from './__helpers__/snapshot';
import {
  SYNC_ATTENTION_AGE_MS,
  mapTerminalStatus,
  type IndicatorRow,
  printerRow,
  rowText,
  syncAttentionDueAt,
} from '../status-mapping';
import { STATUS_COPY } from '../status-copy';

const HOUR = 60 * 60 * 1000;

const pending = (n: number): Partial<TerminalStatusSync> => ({
  pending: n,
  oldestPendingAt: iso(NOW - HOUR),
});

describe('mapTerminalStatus — doc 24 §4.1 (U2…U7)', () => {
  // Each row: the snapshot, the rule, and the expected rows as `tone · text`.
  interface Case {
    readonly label: string;
    readonly snapshot: TerminalStatusSnapshot;
    readonly rule: string;
    readonly connection: string;
    readonly sync: string | null;
  }
  const ONLINE = 'success · متصل';
  const OFFLINE = 'warning · غير متصل';
  const CHECKING = 'neutral · جارٍ التحقق من الاتصال';
  const ATTENTION = 'danger · تحتاج مراجعة';
  const cases: Case[] = [
    {
      label: 'U2 dead letter while online',
      snapshot: snap('online', { deadLetter: 1 }),
      rule: 'U2',
      connection: ONLINE,
      sync: ATTENTION,
    },
    {
      label: 'U2 dead letter while offline',
      snapshot: snap('offline', { deadLetter: 2, ...pending(3) }),
      rule: 'U2',
      connection: OFFLINE,
      sync: ATTENTION,
    },
    {
      label: 'U2 dead letter while checking',
      snapshot: snap('checking', { deadLetter: 1 }),
      rule: 'U2',
      connection: CHECKING,
      sync: ATTENTION,
    },
    {
      label: 'U2 oldest pending older than 24 h (D-6-5)',
      snapshot: snap('online', {
        pending: 1,
        oldestPendingAt: iso(NOW - SYNC_ATTENTION_AGE_MS - 1),
      }),
      rule: 'U2',
      connection: ONLINE,
      sync: ATTENTION,
    },
    {
      label: 'U3 offline, nothing pending',
      snapshot: snap('offline'),
      rule: 'U3',
      connection: OFFLINE,
      sync: null,
    },
    {
      label: 'U3 offline with pending → M-O2',
      snapshot: snap('offline', pending(3)),
      rule: 'U3',
      connection: OFFLINE,
      sync: 'info · 3 عمليات بانتظار الإرسال',
    },
    {
      label: 'U3 degraded shown as offline (D-6-2)',
      snapshot: snap('degraded'),
      rule: 'U3',
      connection: OFFLINE,
      sync: null,
    },
    {
      label: 'U3 degraded with pending → M-O2',
      snapshot: snap('degraded', pending(2)),
      rule: 'U3',
      connection: OFFLINE,
      sync: 'info · عمليتان بانتظار الإرسال',
    },
    {
      label: 'U4 online, pending, not paused → S16',
      snapshot: snap('online', pending(4)),
      rule: 'U4',
      connection: ONLINE,
      sync: 'info · جارٍ إرسال 4 عمليات…',
    },
    {
      label: 'U5 online, pending, paused → M-O2 (D-6-6)',
      snapshot: snap('online', { ...pending(2), paused: 'no_operator_credential' }),
      rule: 'U5',
      connection: ONLINE,
      sync: 'info · عمليتان بانتظار الإرسال',
    },
    {
      label: 'U6 online, nothing pending → M-O4',
      snapshot: snap('online'),
      rule: 'U6',
      connection: ONLINE,
      sync: null,
    },
    {
      label: 'U7 checking',
      snapshot: snap('checking'),
      rule: 'U7',
      connection: CHECKING,
      sync: null,
    },
    {
      label: 'U7 checking with pending → M-O2, never «sending»',
      snapshot: snap('checking', pending(1)),
      rule: 'U7',
      connection: CHECKING,
      sync: 'info · عملية واحدة بانتظار الإرسال',
    },
  ];

  const describeRow = (row: IndicatorRow | null): string | null =>
    row === null ? null : `${row.tone} · ${rowText(row)}`;

  it.each(cases)('$label', (c) => {
    const view = mapTerminalStatus(c.snapshot, NOW);
    expect(view.rule).toBe(c.rule);
    expect(describeRow(view.connection)).toBe(c.connection);
    expect(describeRow(view.sync)).toBe(c.sync);
  });

  it('starts at checking, never online, before the first snapshot', () => {
    const view = mapTerminalStatus(null, NOW);
    expect(view.rule).toBe('U7');
    expect(view.connection.tone).toBe('neutral');
    expect(rowText(view.connection)).toBe(STATUS_COPY.checking);
    expect(view.sync).toBeNull();
  });

  it('never says «sending» unless the terminal is online and not paused', () => {
    const states: ConnectionStateCode[] = ['checking', 'offline', 'degraded'];
    for (const c of states) {
      for (const paused of [null, 'no_operator_credential'] as const) {
        const view = mapTerminalStatus(snap(c, { ...pending(5), paused }), NOW);
        expect(view.sync === null ? '' : rowText(view.sync)).not.toContain('جارٍ إرسال');
      }
    }
    const paused = mapTerminalStatus(
      snap('online', { ...pending(5), paused: 'no_operator_credential' }),
      NOW,
    );
    expect(paused.sync === null ? '' : rowText(paused.sync)).not.toContain('جارٍ إرسال');
  });

  it('keeps a pending sale exactly 24 h old out of attention (older than N, not equal)', () => {
    const view = mapTerminalStatus(
      snap('online', { pending: 1, oldestPendingAt: iso(NOW - SYNC_ATTENTION_AGE_MS) }),
      NOW,
    );
    expect(view.rule).toBe('U4');
  });

  it('counts only this terminal’s pending sales (D-6-4); held-previous-pairing alone shows no sync row', () => {
    const view = mapTerminalStatus(snap('online', { heldPreviousPairing: 3 }), NOW);
    expect(view.rule).toBe('U6');
    expect(view.sync).toBeNull();
  });

  it('uses the count-aware form for 1 and 2: words, no separate number (RT-646)', () => {
    const one = mapTerminalStatus(snap('online', pending(1)), NOW).sync;
    expect(one).toEqual({
      tone: 'info',
      before: 'جارٍ إرسال عملية واحدة…',
      count: null,
      after: '',
    });
    const two = mapTerminalStatus(snap('offline', pending(2)), NOW).sync;
    expect(two === null ? null : rowText(two)).toBe('عمليتان بانتظار الإرسال');
  });

  it('carries the count as a separate number, so it can be isolated LTR with Western digits', () => {
    const view = mapTerminalStatus(snap('online', pending(12)), NOW);
    expect(view.sync?.count).toBe(12);
    expect(view.sync?.before).toBe('جارٍ إرسال ');
    expect(view.sync?.after).toBe(' عملية…');
  });
});

describe('syncAttentionDueAt — when an ageing pending sale needs a human', () => {
  it('is the oldest pending time plus 24 h', () => {
    const oldest = NOW - HOUR;
    expect(syncAttentionDueAt(snap('online', { pending: 1, oldestPendingAt: iso(oldest) }))).toBe(
      oldest + SYNC_ATTENTION_AGE_MS,
    );
  });

  it('is null with nothing pending, with no snapshot, or when a dead letter already decides it', () => {
    expect(syncAttentionDueAt(null)).toBeNull();
    expect(syncAttentionDueAt(snap('online'))).toBeNull();
    expect(syncAttentionDueAt(snap('online', { ...pending(1), deadLetter: 1 }))).toBeNull();
  });
});

describe('printerRow — D-6-7', () => {
  it('shows «فشل آخر إيصال» only while the last print failed', () => {
    const row = printerRow(true);
    expect(row?.tone).toBe('warning');
    expect(row === null ? null : rowText(row)).toBe('فشل آخر إيصال');
  });

  it('shows no printer row otherwise, and never «جاهز»', () => {
    expect(printerRow(false)).toBeNull();
    expect(JSON.stringify(STATUS_COPY)).not.toContain('جاهز');
  });
});

describe('status copy — verbatim from the frozen sources', () => {
  const doc15 = readFileSync(
    resolve(__dirname, '../../../../docs/design/vnext/15-vnext-freeze-package.md'),
    'utf8',
  );
  const doc24 = readFileSync(
    resolve(__dirname, '../../../../docs/design/vnext/24-vn-s6-connection-sync-signal.md'),
    'utf8',
  );

  it('M-O4 «متصل» matches doc 15 (M-O2 and S16 are checked against §5.1 in counted-copy)', () => {
    expect(doc15).toContain(`| M-O4 | Healthy indicator | «${STATUS_COPY.online}»`);
  });

  it('the U2, U3, checking and printer strings match doc 24', () => {
    expect(doc24).toContain(`Sync: «${STATUS_COPY.syncAttention}»`);
    expect(doc24).toContain(`Connection: «${STATUS_COPY.offline}»`);
    expect(doc24).toContain(`Connection: «${STATUS_COPY.checking}»`);
    expect(doc24).toContain(`(«${STATUS_COPY.printerFailed}»)`);
  });
});
