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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Errors = string[];
/** One keyword's check: push errors for `value` at `at`. */
type KeywordCheck = (schema: Schema, value: unknown, at: string, errors: Errors) => void;

function resolve(ref: string): Schema {
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) throw new Error(`unsupported $ref ${ref}`);
  const found = cashierAdmissionsContract.components.schemas[ref.slice(prefix.length)];
  if (found === undefined) throw new Error(`unknown schema ${ref}`);
  return found;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const TYPE_TESTS: Readonly<Record<string, (v: unknown) => boolean>> = {
  object: isPlainObject,
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: Number.isInteger,
  number: (v) => typeof v === 'number',
  boolean: (v) => typeof v === 'boolean',
};

function typeOk(type: string, value: unknown): boolean {
  const test = TYPE_TESTS[type];
  if (test === undefined) throw new Error(`unsupported type ${type}`);
  return test(value);
}

const FORMAT_TESTS: Readonly<Record<string, (v: string) => boolean>> = {
  uuid: (v) => UUID.test(v),
  'date-time': (v) => !Number.isNaN(Date.parse(v)),
};

// ── per-keyword checks (each applies only to the JS type it constrains) ────

const checkEnum: KeywordCheck = (schema, value, at, errors) => {
  if (!(schema['enum'] as unknown[]).includes(value)) errors.push(`${at}: not in enum`);
};

const checkMinLength: KeywordCheck = (schema, value, at, errors) => {
  if (typeof value === 'string' && value.length < (schema['minLength'] as number)) {
    errors.push(`${at}: shorter than minLength`);
  }
};

const checkMaxLength: KeywordCheck = (schema, value, at, errors) => {
  if (typeof value === 'string' && value.length > (schema['maxLength'] as number)) {
    errors.push(`${at}: longer than maxLength`);
  }
};

const checkPattern: KeywordCheck = (schema, value, at, errors) => {
  if (typeof value === 'string' && !new RegExp(schema['pattern'] as string).test(value)) {
    errors.push(`${at}: does not match pattern`);
  }
};

const checkFormat: KeywordCheck = (schema, value, at, errors) => {
  const test = FORMAT_TESTS[schema['format'] as string];
  if (typeof value !== 'string' || test === undefined) return;
  if (!test(value)) errors.push(`${at}: not a ${String(schema['format'])}`);
};

const checkMinimum: KeywordCheck = (schema, value, at, errors) => {
  if (typeof value === 'number' && value < (schema['minimum'] as number)) {
    errors.push(`${at}: below minimum`);
  }
};

const checkItems: KeywordCheck = (schema, value, at, errors) => {
  if (!Array.isArray(value)) return;
  value.forEach((item, i) => {
    check(schema['items'] as Schema, item, `${at}[${String(i)}]`, errors);
  });
};

const checkRequired: KeywordCheck = (schema, value, at, errors) => {
  if (!isPlainObject(value)) return;
  for (const req of schema['required'] as string[]) {
    if (!(req in value)) errors.push(`${at}: missing required "${req}"`);
  }
};

const checkProperties: KeywordCheck = (schema, value, at, errors) => {
  if (!isPlainObject(value)) return;
  const props = (schema['properties'] ?? {}) as Record<string, Schema>;
  const closed = schema['additionalProperties'] === false;
  for (const [k, v] of Object.entries(value)) {
    const propSchema = props[k];
    if (propSchema !== undefined) check(propSchema, v, `${at}.${k}`, errors);
    else if (closed) errors.push(`${at}: unexpected property "${k}"`);
  }
};

/** Keyword → check. `properties` also enforces `additionalProperties: false`. */
const KEYWORD_CHECKS: Readonly<Record<string, KeywordCheck>> = {
  enum: checkEnum,
  minLength: checkMinLength,
  maxLength: checkMaxLength,
  pattern: checkPattern,
  format: checkFormat,
  minimum: checkMinimum,
  items: checkItems,
  required: checkRequired,
  properties: checkProperties,
  additionalProperties: checkProperties,
};

/** Keywords handled before the table: they short-circuit the rest. */
const SHORT_CIRCUIT = new Set(['$ref', 'oneOf', 'type']);

function assertSupported(schema: Schema, at: string): void {
  for (const key of Object.keys(schema)) {
    const known = SHORT_CIRCUIT.has(key) || ANNOTATIONS.has(key) || key in KEYWORD_CHECKS;
    if (!known) throw new Error(`unsupported schema keyword "${key}" at ${at}`);
  }
}

function checkOneOf(branches: Schema[], value: unknown, at: string, errors: Errors): void {
  const matches = branches.filter((branch) => {
    const branchErrors: Errors = [];
    check(branch, value, at, branchErrors);
    return branchErrors.length === 0;
  });
  if (matches.length !== 1) errors.push(`${at}: matches ${String(matches.length)} oneOf branches`);
}

/** Run the table checks once each (`properties` and `additionalProperties` share one). */
function checkKeywords(schema: Schema, value: unknown, at: string, errors: Errors): void {
  const ran = new Set<KeywordCheck>();
  for (const key of Object.keys(schema)) {
    const run = KEYWORD_CHECKS[key];
    if (run === undefined || ran.has(run)) continue;
    ran.add(run);
    run(schema, value, at, errors);
  }
}

function check(schema: Schema, value: unknown, at: string, errors: Errors): void {
  assertSupported(schema, at);
  if (typeof schema['$ref'] === 'string') {
    check(resolve(schema['$ref']), value, at, errors);
    return;
  }
  if (Array.isArray(schema['oneOf'])) {
    checkOneOf(schema['oneOf'] as Schema[], value, at, errors);
    return;
  }
  if (typeof schema['type'] === 'string' && !typeOk(schema['type'], value)) {
    errors.push(`${at}: expected ${schema['type']}`);
    return;
  }
  checkKeywords(schema, value, at, errors);
}

/** Errors for `value` against `components.schemas[name]`; empty when valid. */
export function contractErrors(schemaName: string, value: unknown): string[] {
  const errors: string[] = [];
  check(resolve(`#/components/schemas/${schemaName}`), value, schemaName, errors);
  return errors;
}
