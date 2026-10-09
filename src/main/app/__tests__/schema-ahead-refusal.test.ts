import { describe, expect, it } from 'vitest';

import { describeSchemaAheadRefusal } from '../schema-ahead-refusal.js';

/**
 * RT-320 — the operator-facing refusal shown when an older POS build is started
 * on a database a newer build has migrated (ADR-0006 rule 2).
 */
describe('describeSchemaAheadRefusal', () => {
  it('gives an Arabic title and an Arabic-first body', () => {
    const refusal = describeSchemaAheadRefusal(['0045_future']);
    expect(refusal.title).toMatch(/[؀-ۿ]/);
    expect(refusal.body.split('\n')[0]).toMatch(/[؀-ۿ]/);
  });

  it('tells support which migrations the build does not know', () => {
    const refusal = describeSchemaAheadRefusal(['0045_future', '0046_later']);
    expect(refusal.body).toContain('0045_future, 0046_later');
  });

  it('does not suggest reinstalling an older version', () => {
    const refusal = describeSchemaAheadRefusal(['0045_future']);
    expect(refusal.body).toMatch(/newer/i);
    expect(refusal.body).not.toMatch(/downgrade|older version/i);
  });
});
