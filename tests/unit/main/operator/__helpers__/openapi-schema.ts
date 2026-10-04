/**
 * RT-113 P2 — validate a JSON value against a schema of the Backend-Core
 * contract of record for cashier admissions.
 *
 * The contract is vendored verbatim (YAML → JSON, no edits) as
 * `../__fixtures__/pos-cashier-admissions.openapi.json` from Kemetra/Backend-Core
 * `main` 5ad29f1, `packages/contracts/openapi/pos-cashier-admissions.openapi.yaml`
 * (git blob 556f1fe; BC1 #696, BC2 #697). It is a test fixture only: the
 * 004-era owner decision keeps operator-surface types hand-written in
 * `src/main/operator/*` rather than regenerating `src/shared/api-types.ts`, so
 * these tests are what binds the POS client to the contract.
 *
 * POS has no runtime JSON-Schema validator dependency, so this test helper
 * implements the subset the cashier-admissions contract uses: `$ref`,
 * `oneOf` (exactly one branch), `type`, `required`, `properties`,
 * `additionalProperties: false`, `enum`, `pattern`, `minLength`, `maxLength`,
 * `minimum`, `items` and `format` (`uuid`, `date-time`). An unsupported keyword
 * throws, so the helper can never pass a body silently.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

type Schema = Record<string, unknown>;

const CONTRACT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/pos-cashier-admissions.openapi.json',
);

/** The vendored contract document. */
export const cashierAdmissionsContract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as {
  info: { version: string };
  paths: Record<string, unknown>;
  components: { schemas: Record<string, Schema> };
};

/** Keywords that carry no validation meaning here. */
const ANNOTATIONS = new Set(['description', 'default', 'discriminator', 'title', 'nullable']);
const HANDLED = new Set([
  '$ref',
  'oneOf',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'enum',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'items',
  'format',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolve(ref: string): Schema {
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) throw new Error(`unsupported $ref ${ref}`);
  const found = cashierAdmissionsContract.components.schemas[ref.slice(prefix.length)];
  if (found === undefined) throw new Error(`unknown schema ${ref}`);
  return found;
}

function typeOk(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      throw new Error(`unsupported type ${type}`);
  }
}

function check(schema: Schema, value: unknown, at: string, errors: string[]): void {
  for (const key of Object.keys(schema)) {
    if (!HANDLED.has(key) && !ANNOTATIONS.has(key)) {
      throw new Error(`unsupported schema keyword "${key}" at ${at}`);
    }
  }
  if (typeof schema['$ref'] === 'string') {
    check(resolve(schema['$ref']), value, at, errors);
    return;
  }
  if (Array.isArray(schema['oneOf'])) {
    const matches = (schema['oneOf'] as Schema[]).filter((branch) => {
      const branchErrors: string[] = [];
      check(branch, value, at, branchErrors);
      return branchErrors.length === 0;
    });
    if (matches.length !== 1) errors.push(`${at}: matches ${matches.length} oneOf branches`);
    return;
  }
  if (typeof schema['type'] === 'string' && !typeOk(schema['type'], value)) {
    errors.push(`${at}: expected ${schema['type']}`);
    return;
  }
  if (Array.isArray(schema['enum']) && !(schema['enum'] as unknown[]).includes(value)) {
    errors.push(`${at}: not in enum`);
  }
  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
      errors.push(`${at}: shorter than minLength`);
    }
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
      errors.push(`${at}: longer than maxLength`);
    }
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern']).test(value)) {
      errors.push(`${at}: does not match pattern`);
    }
    if (schema['format'] === 'uuid' && !UUID.test(value)) errors.push(`${at}: not a uuid`);
    if (schema['format'] === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push(`${at}: not a date-time`);
    }
  }
  if (typeof value === 'number' && typeof schema['minimum'] === 'number') {
    if (value < schema['minimum']) errors.push(`${at}: below minimum`);
  }
  if (Array.isArray(value) && schema['items'] !== undefined) {
    value.forEach((item, i) => {
      check(schema['items'] as Schema, item, `${at}[${i}]`, errors);
    });
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema['properties'] ?? {}) as Record<string, Schema>;
    for (const req of (schema['required'] ?? []) as string[]) {
      if (!(req in obj)) errors.push(`${at}: missing required "${req}"`);
    }
    for (const [k, v] of Object.entries(obj)) {
      if (props[k] !== undefined) check(props[k], v, `${at}.${k}`, errors);
      else if (schema['additionalProperties'] === false) {
        errors.push(`${at}: unexpected property "${k}"`);
      }
    }
  }
}

/** Errors for `value` against `components.schemas[name]`; empty when valid. */
export function contractErrors(schemaName: string, value: unknown): string[] {
  const errors: string[] = [];
  check(resolve(`#/components/schemas/${schemaName}`), value, schemaName, errors);
  return errors;
}
