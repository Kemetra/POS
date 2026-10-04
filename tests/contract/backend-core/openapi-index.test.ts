/**
 * RT-217 — the OpenAPI reader and PIN format behind the conformance suite. The
 * reader must classify what it understands and fail loudly on what it does not.
 */
import { describe, expect, it } from 'vitest';
import { formatPin, gitBlobSha, parsePin } from '../../../scripts/contracts-pin.js';
import { indexContract, matchOperation } from './openapi-index.js';

const SCHEMES = `components:
  securitySchemes:
    device:
      type: http
      scheme: bearer
    operator-identity:
      type: http
      scheme: bearer
      bearerFormat: JWT
`;

function doc(paths: string, extra = SCHEMES): string {
  return `openapi: 3.1.0\npaths:\n${paths}${extra}`;
}

describe('indexContract', () => {
  it('reads operation security, `security: []` and the root fallback', () => {
    const ops = indexContract(
      'x.yaml',
      doc(
        `  /a:
    get:
      operationId: getA
      description: >
        Prose that mentions
        security: and operationId: is not structure.
      security:
        - device: []
    post:
      operationId: postA
      security: []
  "/b/{id}":
    parameters:
      - name: id
    put:
      operationId: putB
`,
        `${SCHEMES}security:\n  - operator-identity: []\n`,
      ),
    );
    expect(
      ops.map((o) => [o.operationId, o.method, o.path, [...o.accepts], o.securitySource]),
    ).toEqual([
      ['getA', 'get', '/a', ['device'], 'operation'],
      ['postA', 'post', '/a', ['none'], 'operation'],
      ['putB', 'put', '/b/{id}', ['operator-jwt'], 'root'],
    ]);
  });

  it('accepts any of several alternatives, and `{}` as anonymous', () => {
    const [op] = indexContract(
      'x.yaml',
      doc(
        `  /a:\n    get:\n      operationId: a\n      security:\n        - device: []\n        - {}\n`,
      ),
    );
    expect([...(op?.accepts ?? [])].sort()).toEqual(['device', 'none']);
  });

  it.each([
    ['an undeclared scheme', `        - nope: []\n`, /undeclared security scheme "nope"/],
    [
      'an AND requirement',
      `        - device: []\n          operator-identity: []\n`,
      /combined \(AND\)/,
    ],
  ])('fails on %s', (_name, security, error) => {
    expect(() =>
      indexContract(
        'x.yaml',
        doc(`  /a:\n    get:\n      operationId: a\n      security:\n${security}`),
      ),
    ).toThrow(error);
  });

  it('fails on a declared scheme with no POS credential mapping', () => {
    const extra = `${SCHEMES}    partnerKey:\n      type: http\n      scheme: bearer\n`;
    expect(() =>
      indexContract(
        'x.yaml',
        doc(
          `  /a:\n    get:\n      operationId: a\n      security:\n        - partnerKey: []\n`,
          extra,
        ),
      ),
    ).toThrow(/no POS credential mapping/);
  });

  it('fails when an operationId sits outside the structure it reads', () => {
    expect(() =>
      indexContract(
        'x.yaml',
        doc(
          `  /a:\n    get:\n      operationId: a\n      security: []\n  /b:\n   get:\n    operationId: b\n`,
        ),
      ),
    ).toThrow(/2 operationId\(s\) but 1 operation\(s\)/);
  });

  it('matches the most specific template', () => {
    const ops = indexContract(
      'x.yaml',
      doc(
        `  /s/{ref}:\n    get:\n      operationId: one\n      security: []\n  /s/roster:\n    get:\n      operationId: roster\n      security: []\n`,
      ),
    );
    expect(matchOperation(ops, 'get', '/s/roster')?.operationId).toBe('roster');
    expect(matchOperation(ops, 'get', '/s/123')?.operationId).toBe('one');
    expect(matchOperation(ops, 'post', '/s/123')).toBeNull();
  });
});

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

  it('hashes like git hash-object', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(new TextEncoder().encode('hello\n'))).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });
});
