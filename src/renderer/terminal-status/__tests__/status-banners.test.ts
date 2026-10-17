/**
 * RT-605 (VN-S6 S6-4) — which status banners the `V5OperationalNotices` stack
 * shows (doc 24 §4.3): the sync-attention banner M-O3 (U2) and the offline
 * banner M-O1 (U3). The two are independent stack entries, so both show when
 * both hold. The 24 h line is the S6-3 rule (`SYNC_ATTENTION_AGE_MS`), reused.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerminalStatusSync } from '../../../shared/terminal-status/types';
import { STATUS_NOW as NOW, iso, snap } from './__helpers__/snapshot';
import { SYNC_ATTENTION_AGE_MS, mapStatusBanners, mapTerminalStatus } from '../status-mapping';
import { BANNER_COPY } from '../status-copy';

const HOUR = 60 * 60 * 1000;

const aged = (n: number): Partial<TerminalStatusSync> => ({
  pending: n,
  oldestPendingAt: iso(NOW - SYNC_ATTENTION_AGE_MS - 1),
});
const fresh = (n: number): Partial<TerminalStatusSync> => ({
  pending: n,
  oldestPendingAt: iso(NOW - HOUR),
});

describe('mapStatusBanners — doc 24 §4.3', () => {
  it.each([
    ['no snapshot yet', null, { attention: null, offline: false }],
    ['online, idle', snap('online'), { attention: null, offline: false }],
    ['checking', snap('checking', fresh(2)), { attention: null, offline: false }],
    ['online, sending', snap('online', fresh(3)), { attention: null, offline: false }],
    ['offline', snap('offline'), { attention: null, offline: true }],
    ['degraded, shown as offline (D-6-2)', snap('degraded'), { attention: null, offline: true }],
    ['offline with pending', snap('offline', fresh(3)), { attention: null, offline: true }],
    ['dead letter', snap('online', { deadLetter: 2 }), { attention: 2, offline: false }],
    ['oldest pending > 24 h', snap('online', aged(4)), { attention: 4, offline: false }],
    ['offline + dead letter', snap('offline', { deadLetter: 1 }), { attention: 1, offline: true }],
    ['degraded + aged', snap('degraded', aged(2)), { attention: 2, offline: true }],
  ] as const)('%s', (_label, snapshot, expected) => {
    expect(mapStatusBanners(snapshot, NOW)).toEqual(expected);
  });

  it('counts dead letters, plus the pending sales once the oldest is past 24 h', () => {
    expect(mapStatusBanners(snap('online', { deadLetter: 2, ...fresh(5) }), NOW).attention).toBe(2);
    expect(mapStatusBanners(snap('online', { deadLetter: 2, ...aged(5) }), NOW).attention).toBe(7);
  });

  it('keeps a pending sale exactly 24 h old out of attention (older than N, not equal)', () => {
    const atLine = snap('online', {
      pending: 1,
      oldestPendingAt: iso(NOW - SYNC_ATTENTION_AGE_MS),
    });
    expect(mapStatusBanners(atLine, NOW).attention).toBeNull();
  });

  it('does not count sales held from a previous pairing (D-6-4)', () => {
    expect(mapStatusBanners(snap('online', { heldPreviousPairing: 3 }), NOW).attention).toBeNull();
  });

  it('agrees with the indicator: attention exactly when the rule is U2', () => {
    const cases = [
      snap('online'),
      snap('offline', fresh(1)),
      snap('online', { deadLetter: 1 }),
      snap('checking', aged(1)),
      snap('online', { pending: 1, oldestPendingAt: iso(NOW - SYNC_ATTENTION_AGE_MS) }),
    ];
    for (const s of cases) {
      expect(mapStatusBanners(s, NOW).attention !== null).toBe(
        mapTerminalStatus(s, NOW).rule === 'U2',
      );
    }
  });
});

describe('banner copy — verbatim from doc 15 (D-6-11)', () => {
  const doc15 = readFileSync(
    resolve(__dirname, '../../../../docs/design/vnext/15-vnext-freeze-package.md'),
    'utf8',
  );

  it('M-O1 matches doc 15', () => {
    expect(doc15).toContain(`| M-O1 | Offline | «${BANNER_COPY.offline}» | warning |`);
  });

  it('M-O3 matches doc 15, around the count', () => {
    expect(doc15).toContain(
      `| M-O3 | Sync needs attention (manager) | «${BANNER_COPY.syncAttention.before}‹n›${BANNER_COPY.syncAttention.after}» | danger |`,
    );
  });

  it('adds no list of online-only actions (D-6-9)', () => {
    expect(Object.keys(BANNER_COPY).sort()).toEqual(['offline', 'syncAttention']);
  });
});
