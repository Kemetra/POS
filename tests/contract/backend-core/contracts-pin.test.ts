/**
 * RT-217 — the contracts PIN format and the re-pin argument grammar
 * (`scripts/contracts-pin.ts`).
 */
import { describe, expect, it } from 'vitest';
import { formatPin, gitBlobSha, parsePin, parseRepinArgs } from '../../../scripts/contracts-pin.js';

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

  it('hashes like git hash-object', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(new TextEncoder().encode('hello\n'))).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });
});
