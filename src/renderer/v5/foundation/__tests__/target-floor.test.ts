import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RT-241 — every control inside a message keeps the 44×44 floor (P14). The R-dev
 * run measured the drawer notice's «تم» at 38×44: a short Arabic label left its
 * inline size under the floor. A source tripwire; the runtime metric in the
 * capture report is the real proof.
 */
const css = readFileSync(resolve(__dirname, '../messages.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

describe('message actions keep the 44px target floor', () => {
  it('banner and notice action buttons declare both a 44px block and inline minimum', () => {
    const rule = /\.v5-banner__actions button,\s*\.v5-notice__action button\s*\{([^}]*)\}/.exec(
      css,
    );
    expect(rule, 'the shared action-button rule').not.toBeNull();
    expect(rule?.[1]).toMatch(/min-block-size:\s*44px/);
    expect(rule?.[1]).toMatch(/min-inline-size:\s*44px/);
  });
});
