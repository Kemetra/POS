/**
 * RT-217 — the OpenAPI reader behind the conformance suite. It must classify what
 * it understands and fail loudly on what it does not.
 */
import { describe, expect, it } from 'vitest';
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

function doc(paths: string, extra = SCHEMES): { name: string; text: string } {
  return { name: 'x.yaml', text: `openapi: 3.1.0\npaths:\n${paths}${extra}` };
}

describe('indexContract', () => {
  it('reads operation security, `security: []` and the root fallback', () => {
    const ops = indexContract(
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
      indexContract(doc(`  /a:\n    get:\n      operationId: a\n      security:\n${security}`)),
    ).toThrow(error);
  });

  it('fails on a declared scheme with no POS credential mapping', () => {
    const extra = `${SCHEMES}    partnerKey:\n      type: http\n      scheme: bearer\n`;
    expect(() =>
      indexContract(
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
        doc(
          `  /a:\n    get:\n      operationId: a\n      security: []\n`,
          `webhooks:\n  saleCaptured:\n    post:\n      operationId: b\n${SCHEMES}`,
        ),
      ),
    ).toThrow(/2 operationId\(s\) but 1 operation\(s\)/);
  });

  it('reads any consistent indentation, not only two spaces', () => {
    const [op] = indexContract(
      doc(`  /a:\n   get:\n    operationId: a\n    security:\n    - device: []\n`),
    );
    expect([op?.operationId, [...(op?.accepts ?? [])]]).toEqual(['a', ['device']]);
  });

  it('names the file and route when a security entry is malformed', () => {
    expect(() =>
      indexContract(doc(`  /a:\n    get:\n      operationId: a\n      security: device\n`)),
    ).toThrow(/^x\.yaml GET \/a: unsupported inline security "device"$/);
  });

  it('matches the most specific template', () => {
    const ops = indexContract(
      doc(
        `  /s/{ref}:\n    get:\n      operationId: one\n      security: []\n  /s/roster:\n    get:\n      operationId: roster\n      security: []\n`,
      ),
    );
    expect(matchOperation(ops, { method: 'get', path: '/s/roster' })?.operationId).toBe('roster');
    expect(matchOperation(ops, { method: 'get', path: '/s/123' })?.operationId).toBe('one');
    expect(matchOperation(ops, { method: 'post', path: '/s/123' })).toBeNull();
  });
});
