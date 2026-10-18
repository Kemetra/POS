/**
 * RT-217 — the contracts PIN format and the re-pin argument grammar
 * (`scripts/contracts-pin.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  decideBranchAction,
  diffPins,
  formatPin,
  gitBlobSha,
  parsePin,
  parseRepinArgs,
  planPrState,
  renderRepinPrBody,
  summarizeTestLog,
  type ContractsPin,
} from '../../../scripts/contracts-pin.js';

describe('contracts PIN', () => {
  it('round-trips and rejects unsafe paths', () => {
    const pin = {
      repo: 'Kemetra/Backend-Core',
      commit: 'a'.repeat(40),
      source: 'packages/contracts/openapi',
      files: [{ path: 'pos-sales/sales.yaml', blobSha: 'b'.repeat(40) }],
    };
    expect(parsePin(formatPin(pin))).toEqual(pin);
    expect(() =>
      parsePin(formatPin({ ...pin, files: [{ path: '../x.yaml', blobSha: 'b'.repeat(40) }] })),
    ).toThrow(/unsafe/);
  });

  const SHA = 'c'.repeat(40);
  const valid = `repo: R\ncommit: ${SHA}\nsource: S\nfile: a.yaml ${SHA}\n`;

  it.each([
    ['an unknown key', `${valid}colour: blue\n`, /unknown key "colour"/],
    ['an unparseable line', `${valid}just words\n`, /unparseable line/],
    ['a malformed file line', `${valid}file: b.yaml\n`, /malformed file line/],
    ['a short commit', valid.replace(SHA, 'abc'), /commit must be a full SHA/],
    ['a missing repo', valid.replace('repo: R\n', ''), /repo is required/],
    ['a missing source', valid.replace('source: S\n', ''), /source is required/],
    ['no files', valid.replace(`file: a.yaml ${SHA}\n`, ''), /no files pinned/],
    ['a duplicate file', `${valid}file: a.yaml ${SHA}\n`, /duplicate file entry/],
    ['an absolute path', valid.replace('a.yaml', '/a.yaml'), /unsafe.*absolute/],
    ['a backslash path', valid.replace('a.yaml', 'x\\a.yaml'), /unsafe.*backslash/],
    ['a non-OpenAPI file', valid.replace('a.yaml', 'a.txt'), /unsafe.*not \.yaml/],
  ])('rejects %s', (_name, text, error) => {
    expect(() => parsePin(text)).toThrow(error);
  });

  it('parses re-pin arguments', () => {
    expect(parseRepinArgs([])).toEqual({ ref: 'main', add: [], remove: [] });
    expect(
      parseRepinArgs(['--ref', 'abc', '--add', 'a.yaml', '--add', 'b.yaml', '--remove', 'c.yaml']),
    ).toEqual({
      ref: 'abc',
      add: ['a.yaml', 'b.yaml'],
      remove: ['c.yaml'],
    });
    expect(() => parseRepinArgs(['--nope', 'x'])).toThrow(/unknown argument "--nope"/);
    expect(() => parseRepinArgs(['--add'])).toThrow(/--add needs a value/);
    expect(() => parseRepinArgs(['--add', '--ref'])).toThrow(/--add needs a value/);
  });

  it('reads a value after any run of spaces or tabs, keeping inner spaces', () => {
    const text = `repo:\t  R\ncommit:   ${SHA}\nsource:  packages/x  y\nfile:  a.yaml ${SHA}\n`;
    expect(parsePin(text)).toEqual({
      repo: 'R',
      commit: SHA,
      source: 'packages/x  y',
      files: [{ path: 'a.yaml', blobSha: SHA }],
    });
    expect(() => parsePin(`repo:R\n${valid}`)).toThrow(/unparseable line/);
  });

  it('hashes like git hash-object', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(new TextEncoder().encode('hello\n'))).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });
});

// ─── RT-676: scheduled repin helpers ─────────────────────────────────────────

const BOT = 'kemetra-contracts-bot[bot]';

function pinOf(commit: string, files: Record<string, string>): ContractsPin {
  return {
    repo: 'Kemetra/Backend-Core',
    commit: commit.repeat(40).slice(0, 40),
    source: 'packages/contracts/openapi',
    files: Object.entries(files).map(([path, sha]) => ({ path, blobSha: sha.repeat(40) })),
  };
}

describe('diffPins', () => {
  it('reports changed, added and removed files by blob SHA', () => {
    const before = pinOf('a', { 'a.yaml': '1', 'b.yaml': '2', 'c.yaml': '3' });
    const after = pinOf('b', { 'a.yaml': '1', 'b.yaml': '9', 'd.yaml': '4' });
    expect(diffPins(before, after)).toEqual({
      changed: ['b.yaml'],
      added: ['d.yaml'],
      removed: ['c.yaml'],
    });
  });

  it('is empty when no file changed, even if the commit moved', () => {
    const before = pinOf('a', { 'a.yaml': '1' });
    const after = pinOf('b', { 'a.yaml': '1' });
    expect(diffPins(before, after)).toEqual({ changed: [], added: [], removed: [] });
  });
});

describe('decideBranchAction', () => {
  it("pushes when all commits are the bot's", () => {
    expect(decideBranchAction([BOT, BOT], BOT)).toBe('push');
  });

  it("comments when any commit is a human's", () => {
    expect(decideBranchAction([BOT, 'ahmed'], BOT)).toBe('comment');
  });

  it('pushes when the branch has no commits ahead', () => {
    expect(decideBranchAction([], BOT)).toBe('push');
  });

  it('comments when an author login is null (unlinked email)', () => {
    expect(decideBranchAction([null], BOT)).toBe('comment');
  });
});

describe('renderRepinPrBody', () => {
  const before = pinOf('a', { 'a.yaml': '1', 'b.yaml': '2' });
  const after = pinOf('b', { 'a.yaml': '5', 'c.yaml': '3' });
  const diff = diffPins(before, after);

  it('includes the compare URL and both commits', () => {
    const body = renderRepinPrBody({ before, after, diff, conformance: 'pass' });
    expect(body).toContain(
      `https://github.com/Kemetra/Backend-Core/compare/${before.commit}...${after.commit}`,
    );
    expect(body).toContain(before.commit.slice(0, 7));
    expect(body).toContain(after.commit.slice(0, 7));
    expect(body).toContain('a.yaml');
    expect(body).toContain('c.yaml');
    expect(body).toContain('b.yaml');
  });

  it('includes the failure summary when conformance fails', () => {
    const body = renderRepinPrBody({
      before,
      after,
      diff,
      conformance: 'fail',
      failureSummary: 'FAIL pos-shifts: field x missing',
    });
    expect(body).toContain('FAIL pos-shifts: field x missing');
    expect(body).toMatch(/contracts-break/);
    expect(renderRepinPrBody({ before, after, diff, conformance: 'pass' })).not.toMatch(
      /contracts-break/,
    );
  });
});

describe('summarizeTestLog', () => {
  it('strips colour codes and keeps only the tail of a long log', () => {
    const esc = String.fromCharCode(27);
    expect(
      summarizeTestLog(`${esc}[31mFAIL${esc}[39m x
`),
    ).toBe('FAIL x');
    const long = `${'x'.repeat(10_000)}END`;
    const out = summarizeTestLog(long);
    expect(out.length).toBeLessThan(4100);
    expect(out.endsWith('END')).toBe(true);
  });
});

describe('planPrState', () => {
  const L = 'contracts-break';

  it('drafts and labels a ready PR when conformance fails', () => {
    expect(planPrState({ isDraft: false, labels: [] }, L, true)).toEqual({
      draft: true,
      ready: false,
      addLabel: true,
      removeLabel: false,
    });
  });

  it('changes nothing for an already drafted, labelled PR that still fails', () => {
    expect(planPrState({ isDraft: true, labels: [L] }, L, true)).toEqual({
      draft: false,
      ready: false,
      addLabel: false,
      removeLabel: false,
    });
  });

  it('marks ready and unlabels a bot-drafted PR once conformance passes', () => {
    expect(planPrState({ isDraft: true, labels: [L] }, L, false)).toEqual({
      draft: false,
      ready: true,
      addLabel: false,
      removeLabel: true,
    });
  });

  it("does not label a human's draft on fail, so a later pass leaves it a draft", () => {
    const onFail = planPrState({ isDraft: true, labels: [] }, L, true);
    expect(onFail).toEqual({ draft: false, ready: false, addLabel: false, removeLabel: false });
    expect(planPrState({ isDraft: true, labels: [] }, L, false).ready).toBe(false);
  });

  it("leaves a human's own draft (no label) alone on pass", () => {
    expect(planPrState({ isDraft: true, labels: [] }, L, false)).toEqual({
      draft: false,
      ready: false,
      addLabel: false,
      removeLabel: false,
    });
  });
});
