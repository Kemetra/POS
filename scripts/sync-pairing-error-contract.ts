/**
 * RT-307 — sync the legacy snapshot's pairing error schema from the pinned
 * Backend-Core contract.
 *
 * `scripts/openapi-snapshot.json` carries a hand-authored fallback for the pairing
 * operation whose `TerminalPairErrorResponse` was the obsolete flat `{code, message}`
 * shape. Backend-Core publishes the canonical `{error:{code,message,request_id}}`
 * envelope (`components.schemas.Error` in the vendored
 * `contracts/backend-core/openapi/pos-terminal-pairing.openapi.yaml`).
 *
 * Pure transform (snapshot, pinnedError) -> newSnapshot: replaces ONLY the body of
 * `TerminalPairErrorResponse` (name kept so every `$ref` stays valid). Paths, the 422
 * mapping and every other schema are untouched.
 *
 *   tsx scripts/sync-pairing-error-contract.ts && npm run codegen:api
 */

export interface OpenApiDoc {
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown>; [k: string]: unknown };
  [k: string]: unknown;
}

export const SNAPSHOT_SCHEMA_NAME = 'TerminalPairErrorResponse';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * OpenAPI 3.1 expresses nullability as `type: [T, 'null']`; the pinned YAML uses the
 * 3.0 `nullable: true` keyword, which openapi-typescript ignores under 3.1. Rewrite it
 * so the generated type is `T | null`. Pure — returns a new tree.
 */
export function normalizeNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeNullable);
  if (!isRecord(node)) return node;
  const entries = Object.entries(node)
    .filter(([k]) => k !== 'nullable')
    .map(([k, v]): [string, unknown] => [k, normalizeNullable(v)]);
  const out: Record<string, unknown> = Object.fromEntries(entries);
  if (node.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

/** True when the pinned schema is the canonical `{ error: {...} }` envelope. */
function isErrorEnvelope(schema: unknown): boolean {
  return isRecord(schema) && isRecord(schema.properties) && 'error' in schema.properties;
}

export function syncPairingError(snapshot: OpenApiDoc, pinnedError: unknown): OpenApiDoc {
  if (!isErrorEnvelope(pinnedError)) {
    throw new Error('pinned Error schema is not the canonical {error:{...}} envelope');
  }
  if (!(SNAPSHOT_SCHEMA_NAME in snapshot.components.schemas)) {
    throw new Error(`snapshot has no ${SNAPSHOT_SCHEMA_NAME} schema to replace`);
  }
  return {
    ...snapshot,
    components: {
      ...snapshot.components,
      schemas: {
        ...snapshot.components.schemas,
        [SNAPSHOT_SCHEMA_NAME]: normalizeNullable(pinnedError),
      },
    },
  };
}

// --- CLI driver (runs only when invoked directly) ---------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsYaml from 'js-yaml';

const loadYaml = (jsYaml as { load: (src: string) => unknown }).load;
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = path.join(SCRIPTS_DIR, 'openapi-snapshot.json');
export const PINNED_PAIRING_PATH = path.join(
  SCRIPTS_DIR,
  '..',
  'contracts',
  'backend-core',
  'openapi',
  'pos-terminal-pairing.openapi.yaml',
);

export function loadPinnedPairingError(): unknown {
  const doc = loadYaml(readFileSync(PINNED_PAIRING_PATH, 'utf8')) as OpenApiDoc;
  return doc.components.schemas.Error;
}

function main(): void {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as OpenApiDoc;
  const next = syncPairingError(snapshot, loadPinnedPairingError());
  // Committed snapshot is single-line minified JSON + trailing newline.
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(next) + '\n', 'utf8');
  console.log('[sync-pairing-error] snapshot updated');
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) main();
