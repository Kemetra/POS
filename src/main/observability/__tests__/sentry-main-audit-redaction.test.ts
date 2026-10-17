import { describe, it, expect } from 'vitest';
import type { ErrorEvent } from '@sentry/electron/main';

import { scrubEvent } from '../sentry-main.js';
import { FORBIDDEN_PAYLOAD_KEYS } from '../../../shared/audit/forbidden-keys.js';

/**
 * 004-operator-session T050, reworked by RT-634 (OBS-5).
 *
 * The denylist scrubber became an allowlist REBUILD (OBS-1 contract §3.1):
 * `extra`, `contexts`, `tags`, `user`, `request` and breadcrumbs never leave
 * the process, at any depth, whatever their key names. Every audit-forbidden
 * field is therefore proven absent in every bag a caller could reach.
 *
 * If any assertion fails, tighten the SOURCE — never the test.
 */

function asEvent(partial: Record<string, unknown>): ErrorEvent {
  return partial as unknown as ErrorEvent;
}

const SENTINEL = 'LEAKED-SECRET-VALUE-T050-SENTRY-MAIN';
const EXCEPTION = { values: [{ type: 'Error', value: 'kept' }] };

describe('scrubEvent — audit-event forbidden keys never leave the process', () => {
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    it(`drops '${key}' from extra, contexts, tags, user and breadcrumbs`, () => {
      const cleaned = scrubEvent(
        asEvent({
          exception: EXCEPTION,
          extra: { [key]: SENTINEL, audit: { event: { payload: { [key]: SENTINEL } } } },
          contexts: { audit: { [key]: SENTINEL } },
          tags: { [key]: SENTINEL },
          user: { [key]: SENTINEL },
          breadcrumbs: [{ data: { [key]: SENTINEL } }],
        }),
      );
      expect(cleaned).not.toBeNull();
      expect(JSON.stringify(cleaned)).not.toContain(SENTINEL);
    });
  }
});
