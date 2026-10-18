import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * RT-700 (P-26-1) — the composition root wires the card-tender flag into every
 * `tender.apply` handler it builds. The handler refuses a card tender when the
 * reader is absent, so a missing wire would only fail closed; this guard keeps
 * the flag-on path reachable. (Importing `index.ts` needs the Electron globals,
 * so this is a source check, like `bootstrap-sale-boundary.test.ts`.)
 */

const INDEX_PATH = resolve(__dirname, '../index.ts');

describe('main/index.ts wires the card-tender flag (RT-700)', () => {
  const source = readFileSync(INDEX_PATH, 'utf-8');

  it('reads POS_PULSE_FEATURE_CARD_TENDER per call through the shared parser', () => {
    expect(source).toMatch(
      /const isCardTenderEnabled = \(\): boolean => parseFeatureFlags\(process\.env\)\.cardTender;/,
    );
  });

  it('passes the reader to every createTenderApplyHandler (cashier and manager recovery)', () => {
    const builds = source.match(/createTenderApplyHandler\(\{[^}]*\}\)/g) ?? [];
    expect(builds).toHaveLength(2);
    for (const build of builds) {
      expect(build).toMatch(/\bisCardTenderEnabled,/);
    }
  });
});
