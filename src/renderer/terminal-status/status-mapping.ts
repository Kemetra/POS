import type { TerminalStatusSnapshot } from '../../shared/terminal-status/types';
import { STATUS_COPY } from './status-copy';

/**
 * RT-604 (VN-S6 S6-3) — doc 24 §4.1 as a pure function: main sends facts, the
 * renderer derives the indicator. `rule` is the banner precedence (U2 … U7,
 * first match wins) for S6-4; the indicator always shows connection and sync
 * as separate rows.
 *
 * U1 (not paired / revoked) has no row here: the indicator lives only in the
 * v5 frame, which the router mounts only for a paired, signed-in terminal, and
 * the RT-215 recovery route replaces it on revocation.
 */

/** D-6-5 = b: a pending sale older than N = 24 h needs a human. */
export const SYNC_ATTENTION_AGE_MS = 24 * 60 * 60 * 1000;

/** The freeze 15 §4 status roles, plus neutral for «checking» (no dot colour). */
export type IndicatorTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';

export interface IndicatorRow {
  readonly tone: IndicatorTone;
  /** Copy before the count (the whole text when there is no count). */
  readonly before: string;
  /** Rendered as an isolated LTR run with Western digits. */
  readonly count: number | null;
  readonly after: string;
}

export type StatusRule = 'U2' | 'U3' | 'U4' | 'U5' | 'U6' | 'U7';

export interface TerminalStatusView {
  readonly rule: StatusRule;
  readonly connection: IndicatorRow;
  /** Null when nothing is pending and nothing needs attention. */
  readonly sync: IndicatorRow | null;
}

function textRow(tone: IndicatorTone, text: string): IndicatorRow {
  return { tone, before: text, count: null, after: '' };
}

function countRow(copy: { before: string; after: string }, count: number): IndicatorRow {
  return { tone: 'info', before: copy.before, count, after: copy.after };
}

/** The row as one string (tests, and anywhere a plain name is needed). */
export function rowText(row: IndicatorRow): string {
  return `${row.before}${row.count === null ? '' : String(row.count)}${row.after}`;
}

/** When the oldest pending sale was queued (ms), or null with nothing pending. */
function oldestPendingMs(snapshot: TerminalStatusSnapshot): number | null {
  const { pending, oldestPendingAt } = snapshot.sync;
  if (pending === 0) return null;
  return oldestPendingAt === null ? null : Date.parse(oldestPendingAt);
}

/** The oldest pending sale is older than N = 24 h (D-6-5). */
function isAged(snapshot: TerminalStatusSnapshot, nowMs: number): boolean {
  const oldest = oldestPendingMs(snapshot);
  return oldest !== null && nowMs - oldest > SYNC_ATTENTION_AGE_MS;
}

function needsAttention(snapshot: TerminalStatusSnapshot, nowMs: number): boolean {
  return snapshot.sync.deadLetter > 0 || isAged(snapshot, nowMs);
}

function connectionRow(snapshot: TerminalStatusSnapshot | null): IndicatorRow {
  switch (snapshot?.connection) {
    case 'online':
      return textRow('success', STATUS_COPY.online);
    case 'offline':
    case 'degraded':
      return textRow('warning', STATUS_COPY.offline);
    default:
      return textRow('neutral', STATUS_COPY.checking);
  }
}

/**
 * S16 «sending» only when the terminal is online and the drain is not paused;
 * otherwise M-O2 «waiting» (D-6-6), which is true in every other state.
 */
function syncRow(snapshot: TerminalStatusSnapshot, attention: boolean): IndicatorRow | null {
  if (attention) return textRow('danger', STATUS_COPY.syncAttention);
  const { pending, paused } = snapshot.sync;
  if (pending === 0) return null;
  const sending = snapshot.connection === 'online' && paused === null;
  return countRow(sending ? STATUS_COPY.sending : STATUS_COPY.waiting, pending);
}

function ruleFor(snapshot: TerminalStatusSnapshot, attention: boolean): StatusRule {
  if (attention) return 'U2';
  const { connection, sync } = snapshot;
  if (connection === 'offline' || connection === 'degraded') return 'U3';
  if (connection === 'checking') return 'U7';
  if (sync.pending === 0) return 'U6';
  return sync.paused === null ? 'U4' : 'U5';
}

/** No snapshot yet reads as `checking`, never `online` (doc 24 §2.4). */
export function mapTerminalStatus(
  snapshot: TerminalStatusSnapshot | null,
  nowMs: number,
): TerminalStatusView {
  if (snapshot === null) return { rule: 'U7', connection: connectionRow(null), sync: null };
  const attention = needsAttention(snapshot, nowMs);
  return {
    rule: ruleFor(snapshot, attention),
    connection: connectionRow(snapshot),
    sync: syncRow(snapshot, attention),
  };
}

/** The notices-stack banners (doc 24 §4.3); both show when both hold. */
export interface StatusBanners {
  /** M-O3's ‹n›, or null when nothing needs a human (U2 does not hold). */
  readonly attention: number | null;
  /** M-O1: `offline`, or `degraded` shown as offline (D-6-2). */
  readonly offline: boolean;
}

/**
 * RT-605 (VN-S6 S6-4) — which status banners show. Attention is the same U2
 * test the indicator uses. Its count is the dead letters, plus every pending
 * sale once the oldest has passed 24 h (they wait behind it). No snapshot
 * shows nothing, never a guess.
 */
export function mapStatusBanners(
  snapshot: TerminalStatusSnapshot | null,
  nowMs: number,
): StatusBanners {
  if (snapshot === null) return { attention: null, offline: false };
  const { connection, sync } = snapshot;
  const offline = connection === 'offline' || connection === 'degraded';
  if (!needsAttention(snapshot, nowMs)) return { attention: null, offline };
  const waiting = isAged(snapshot, nowMs) ? sync.pending : 0;
  return { attention: sync.deadLetter + waiting, offline };
}

/**
 * When the oldest pending sale will pass the 24 h line, so the view can be
 * re-derived once at that moment instead of polling. Null when nothing is
 * pending or a dead letter already decides attention.
 */
export function syncAttentionDueAt(snapshot: TerminalStatusSnapshot | null): number | null {
  if (snapshot === null || snapshot.sync.deadLetter > 0) return null;
  const oldest = oldestPendingMs(snapshot);
  return oldest === null ? null : oldest + SYNC_ATTENTION_AGE_MS;
}

/** D-6-7 = a: a row only while the last print failed; never «جاهز». */
export function printerRow(lastPrintFailed: boolean): IndicatorRow | null {
  return lastPrintFailed ? textRow('warning', STATUS_COPY.printerFailed) : null;
}
