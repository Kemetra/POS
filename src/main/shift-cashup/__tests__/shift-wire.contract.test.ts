/**
 * RT-17 slice 3 — the stored shift bodies against the PINNED Backend-Core
 * contract (`contracts/backend-core/openapi/pos-shifts.openapi.yaml`,
 * 1.1.0-draft at Backend-Core `8d9ba99`; refresh with `npm run contracts:repin`).
 *
 * The POS has no JSON-Schema validator on its dependency tree (adding one is a
 * gated package change), so this reads the vendored YAML with the RT-217
 * outline reader and checks, for each request schema the POS builds:
 *   • the schema is strict (`additionalProperties: false`);
 *   • every key the POS sends is a declared property (no mass-assignment);
 *   • every required property is sent;
 *   • every string value matches its declared `pattern` (amounts, currency),
 *     `enum`, `format: uuid` (lower case) or `format: date-time`.
 * A re-pin that adds a required field, drops a property or tightens a pattern
 * fails here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildTree,
  child,
  type YamlNode,
} from '../../../../tests/contract/backend-core/yaml-tree.js';
import {
  buildCashMovementRequest,
  buildCloseShiftRequest,
  buildOpenShiftRequest,
} from '../shift-wire.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CONTRACT = path.join(REPO_ROOT, 'contracts/backend-core/openapi/pos-shifts.openapi.yaml');
const ROOT = buildTree({ name: 'pos-shifts', text: readFileSync(CONTRACT, 'utf-8') });

function at(node: YamlNode | undefined, key: string): YamlNode {
  const found = node === undefined ? undefined : child(node, key);
  if (found === undefined) throw new Error(`pos-shifts contract: missing "${key}"`);
  return found;
}

const SCHEMAS = at(at(ROOT, 'components'), 'schemas');

/** A flow list `[a, b]` or a block list `- a` as strings. */
function listOf(node: YamlNode): string[] {
  if (node.value.startsWith('[')) {
    return node.value
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return node.children.filter((c) => c.item).map((c) => c.value);
}

/** Resolve a property node through one `$ref` (or an `allOf` of refs) to its constraints. */
function constraintsOf(prop: YamlNode): YamlNode[] {
  const ref = child(prop, '$ref');
  if (ref !== undefined) return constraintsOf(at(SCHEMAS, ref.value.split('/').pop() ?? ''));
  const allOf = child(prop, 'allOf');
  if (allOf === undefined) return [prop];
  return allOf.children.flatMap((item) => {
    const itemRef = item.key === '$ref' ? item.value : child(item, '$ref')?.value;
    if (itemRef !== undefined) return constraintsOf(at(SCHEMAS, itemRef.split('/').pop() ?? ''));
    return [item];
  });
}

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function checkScalar(constraint: YamlNode, value: unknown): void {
  const pattern = child(constraint, 'pattern');
  if (pattern !== undefined) expect(String(value)).toMatch(new RegExp(pattern.value));
  const format = child(constraint, 'format')?.value;
  if (format === 'uuid') expect(String(value)).toMatch(UUID_LOWER);
  if (format === 'date-time') expect(String(value)).toMatch(DATE_TIME);
  const enumNode = child(constraint, 'enum');
  if (enumNode !== undefined) expect(listOf(enumNode)).toContain(value);
}

function checkValue(prop: YamlNode, value: unknown): void {
  for (const constraint of constraintsOf(prop)) {
    const items = child(constraint, 'items');
    if (items !== undefined && Array.isArray(value)) {
      for (const item of value) checkScalar(items, item);
    } else {
      checkScalar(constraint, value);
    }
  }
}

function conformsTo(schemaName: string, body: string): void {
  const schema = at(SCHEMAS, schemaName);
  expect(at(schema, 'additionalProperties').value).toBe('false');
  const properties = at(schema, 'properties');
  const sent = JSON.parse(body) as Record<string, unknown>;
  const declared = properties.children.map((c) => c.key);
  expect(declared).toEqual(expect.arrayContaining(Object.keys(sent)));
  expect(Object.keys(sent)).toEqual(expect.arrayContaining(listOf(at(schema, 'required'))));
  for (const [key, value] of Object.entries(sent)) checkValue(at(properties, key), value);
}

const SHIFT = '0192F5A2-3B4C-7D8E-9F01-23456789AB01';
const USER = '0190F5A2-3B4C-7D8E-9F01-23456789ABCD';

describe('stored shift bodies conform to the pinned pos-shifts contract', () => {
  it('pins pos-shifts 1.1.0-draft', () => {
    expect(at(at(ROOT, 'info'), 'version').value).toBe('1.1.0-draft');
  });

  it('openShift body → OpenShiftRequest', () => {
    const { request } = buildOpenShiftRequest({
      shiftId: SHIFT,
      openedAt: '2026-10-05T08:00:00.000Z',
      openingUserId: USER,
      currencyCode: 'EGP',
      openingFloatMinor: 50_000,
    });
    conformsTo('OpenShiftRequest', request.body);
  });

  it('recordCashMovement body → RecordCashMovementRequest', () => {
    const { request } = buildCashMovementRequest({
      fact: {
        movementId: '0192F5A2-3B4C-7D8E-9F01-23456789AB02',
        shiftId: SHIFT,
        kind: 'pay_in',
        amountMinor: 5,
        reasonCode: 'float_top_up',
        note: 'Coins',
        occurredAt: '2026-10-05T09:00:00.000Z',
        operatorUserId: USER,
      },
      currencyCode: 'EGP',
    });
    conformsTo('RecordCashMovementRequest', request.body);
  });

  it('closeShift body → CloseShiftRequest', () => {
    const { request } = buildCloseShiftRequest({
      fact: {
        shiftId: SHIFT,
        closedAt: '2026-10-05T16:00:00.000Z',
        closingUserId: USER,
        openingFloatMinor: 50_000,
        cashSalesTotalMinor: 245_000,
        cashRefundsTotalMinor: 7_500,
        payInTotalMinor: 5,
        payOutTotalMinor: 12_000,
        expectedCashMinor: 275_505,
        countedCashMinor: 275_000,
        varianceMinor: -505,
        saleCount: 37,
        cashRefundReturnRefs: ['0192F5A2-3B4C-7D8E-9F01-23456789AB03'],
        varianceApprovedByUserId: '0190F5A2-3B4C-7D8E-9F01-23456789ABCE',
      },
      currencyCode: 'EGP',
    });
    conformsTo('CloseShiftRequest', request.body);
  });

  it('the Idempotency-Key matches the contract header grammar', () => {
    const header = at(at(at(at(ROOT, 'components'), 'parameters'), 'IdempotencyKey'), 'schema');
    const { request } = buildOpenShiftRequest({
      shiftId: SHIFT,
      openedAt: '2026-10-05T08:00:00.000Z',
      openingUserId: USER,
      currencyCode: 'EGP',
      openingFloatMinor: 0,
    });
    // The pattern is a double-quoted YAML scalar: `\\x21` is the regex `\x21`.
    const pattern = at(header, 'pattern').value.replace(/\\\\/g, '\\');
    expect(request.idempotencyKey).toMatch(new RegExp(pattern));
    expect(request.idempotencyKey).toMatch(/^[\x21-\x7E]{16,128}$/);
  });
});
