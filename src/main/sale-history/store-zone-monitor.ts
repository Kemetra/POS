/**
 * RT-553 (RT-545 S4) — compares the store zone Backend-Core reports on a
 * sale-history page with the zone this build fixes for every business day
 * (`STORE_TIME_ZONE`, RT-550). It only REPORTS: the zone in use never changes
 * and selling is never blocked.
 *
 * The flag lives in memory for the process lifetime (never persisted). It is
 * raised by a mismatching page, cleared by a later matching one, and left alone
 * by a page with no zone. One warning is logged when the flag is raised or the
 * mismatching zone changes — repeated pages stay silent.
 *
 * The reported zone comes from the server: it is surfaced (log and bridge) only
 * when it is a valid IANA name; anything else is flagged but never echoed.
 */
import type { Logger } from 'pino';

import type { SaleHistoryZoneStatus } from '../../shared/sale-history/types.js';
import { STORE_TIME_ZONE } from '../../shared/time/business-day.js';

export type StoreZoneVerdict = 'match' | 'mismatch' | 'absent';

/** Marker logged instead of a reported zone that is not a valid IANA name. */
const INVALID_ZONE_MARKER = 'invalid';

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Case-insensitive on purpose (IANA names are), and not canonicalised through
 * `resolvedOptions()`: link names such as `Egypt` resolve differently across
 * ICU builds, so only the zone's own name matches. No trimming: a zone with
 * stray whitespace is invalid and cannot be confirmed as the fixed zone.
 */
export function classifyStoreZone(reported: string | undefined): StoreZoneVerdict {
  if (typeof reported !== 'string' || reported.length === 0) return 'absent';
  if (!isValidZone(reported)) return 'mismatch';
  return reported.toLowerCase() === STORE_TIME_ZONE.toLowerCase() ? 'match' : 'mismatch';
}

export type StoreZoneStatus = Omit<SaleHistoryZoneStatus, 'kind'>;

export interface StoreZoneMonitor {
  /** Feeds the zone of a validated server page. */
  observe(reported: string | undefined): void;
  status(): StoreZoneStatus;
}

export interface StoreZoneMonitorDeps {
  readonly logger: Pick<Logger, 'warn'>;
}

type State =
  | { readonly status: 'unknown' | 'match' }
  | { readonly status: 'mismatch'; readonly reported: string | null };

/** The reported zone as it may be shown: an accepted zone name, or null. */
function shownZone(reported: string): string | null {
  return isValidZone(reported) ? reported : null;
}

export function createStoreZoneMonitor(deps: StoreZoneMonitorDeps): StoreZoneMonitor {
  let state: State = { status: 'unknown' };

  return {
    observe(reported) {
      const verdict = classifyStoreZone(reported);
      if (verdict === 'absent') return;
      if (verdict === 'match') {
        state = { status: 'match' };
        return;
      }
      const shown = shownZone(reported as string);
      const unchanged = state.status === 'mismatch' && state.reported === shown;
      state = { status: 'mismatch', reported: shown };
      if (unchanged) return;
      deps.logger.warn(
        { expected: STORE_TIME_ZONE, reported: shown ?? INVALID_ZONE_MARKER },
        'sale_history:store_timezone_mismatch',
      );
    },

    status() {
      return {
        status: state.status,
        expected: STORE_TIME_ZONE,
        reported: state.status === 'mismatch' ? state.reported : null,
      };
    },
  };
}
