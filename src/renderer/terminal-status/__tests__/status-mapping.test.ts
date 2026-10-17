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
import {
  SYNC_ATTENTION_AGE_MS,
  mapTerminalStatus,
  printerRow,
  rowText,
  syncAttentionDueAt,
} from '../status-mapping';
import { STATUS_COPY } from '../status-copy';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function snap(
  connection: ConnectionStateCode,
  sync: Partial<TerminalStatusSync> = {},
): TerminalStatusSnapshot {
  return {
    v: 1,
    connection,
    connectionSince: iso(NOW - 60_000),
    lastContactAt: connection === 'online' ? iso(NOW - 5_000) : null,
    sync: {
      pending: 0,
      heldPreviousPairing: 0,
      deadLetter: 0,
      oldestPendingAt: null,
      paused: null,
      lastSuccessAt: null,
      ...sync,
    },
  };
}

const pending = (n: number): Partial<TerminalStatusSync> => ({
  pending: n,
  oldestPendingAt: iso(NOW - HOUR),
});

describe('mapTerminalStatus — doc 24 §4.1 (U2…U7)', () => {
  it.each([
    // [label, snapshot, rule, connection tone, connection text, sync tone, sync text]
    [
      'U2 dead letter while online',
      snap('online', { deadLetter: 1 }),
      'U2',
      'success',
      'متصل',
      'danger',
      'تحتاج مراجعة',
    ],
    [
      'U2 dead letter while offline',
      snap('offline', { deadLetter: 2, ...pending(3) }),
      'U2',
      'warning',
      'غير متصل',
      'danger',
      'تحتاج مراجعة',
    ],
    [
      'U2 dead letter while checking',
      snap('checking', { deadLetter: 1 }),
      'U2',
      'neutral',
      'جارٍ التحقق من الاتصال',
      'danger',
      'تحتاج مراجعة',
    ],
    [
      'U2 oldest pending older than 24 h (D-6-5)',
      snap('online', { pending: 1, oldestPendingAt: iso(NOW - SYNC_ATTENTION_AGE_MS - 1) }),
      'U2',
      'success',
      'متصل',
      'danger',
      'تحتاج مراجعة',
    ],
    ['U3 offline, nothing pending', snap('offline'), 'U3', 'warning', 'غير متصل', null, null],
    [
      'U3 offline with pending → M-O2',
      snap('offline', pending(3)),
      'U3',
      'warning',
      'غير متصل',
      'info',
      '3 عمليات بانتظار الإرسال',
    ],
    [
      'U3 degraded shown as offline (D-6-2)',
      snap('degraded'),
      'U3',
      'warning',
      'غير متصل',
      null,
      null,
    ],
    [
      'U3 degraded with pending → M-O2',
      snap('degraded', pending(2)),
      'U3',
      'warning',
      'غير متصل',
      'info',
      '2 عمليات بانتظار الإرسال',
    ],
    [
      'U4 online, pending, not paused → S16',
      snap('online', pending(4)),
      'U4',
      'success',
      'متصل',
      'info',
      'جارٍ إرسال 4 عملية…',
    ],
    [
      'U5 online, pending, paused → M-O2 (D-6-6)',
      snap('online', { ...pending(2), paused: 'no_operator_credential' }),
      'U5',
      'success',
      'متصل',
      'info',
      '2 عمليات بانتظار الإرسال',
    ],
    ['U6 online, nothing pending → M-O4', snap('online'), 'U6', 'success', 'متصل', null, null],
    ['U7 checking', snap('checking'), 'U7', 'neutral', 'جارٍ التحقق من الاتصال', null, null],
    [
      'U7 checking with pending → M-O2, never «sending»',
      snap('checking', pending(1)),
      'U7',
      'neutral',
      'جارٍ التحقق من الاتصال',
      'info',
      '1 عمليات بانتظار الإرسال',
    ],
  ] as const)('%s', (_label, snapshot, rule, connTone, connText, syncTone, syncText) => {
    const view = mapTerminalStatus(snapshot, NOW);
    expect(view.rule).toBe(rule);
    expect(view.connection.tone).toBe(connTone);
    expect(rowText(view.connection)).toBe(connText);
    if (syncTone === null) {
      expect(view.sync).toBeNull();
    } else {
      expect(view.sync?.tone).toBe(syncTone);
      expect(view.sync === null ? null : rowText(view.sync)).toBe(syncText);
    }
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

  it('M-O4 «متصل» and M-O2 match doc 15', () => {
    expect(doc15).toContain(`| M-O4 | Healthy indicator | «${STATUS_COPY.online}»`);
    expect(doc15).toContain(`«‹n›${STATUS_COPY.waiting.after}»`);
  });

  it('S16 matches doc 15', () => {
    expect(doc15).toContain(`«${STATUS_COPY.sending.before}N${STATUS_COPY.sending.after}»`);
  });

  it('the U2, U3, checking and printer strings match doc 24', () => {
    expect(doc24).toContain(`Sync: «${STATUS_COPY.syncAttention}»`);
    expect(doc24).toContain(`Connection: «${STATUS_COPY.offline}»`);
    expect(doc24).toContain(`Connection: «${STATUS_COPY.checking}»`);
    expect(doc24).toContain(`(«${STATUS_COPY.printerFailed}»)`);
  });
});
