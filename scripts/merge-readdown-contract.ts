/**
 * #349 — merge the DP-2 read-down contract into the pinned OpenAPI snapshot.
 *
 * Pure transform (snapshot, readDown) -> newSnapshot:
 *   1. Drop the stale catalogue paths (/api/v1/pos/catalog/products + /stock) —
 *      the wrong-domain pharmacy-era surface, served by nothing (404 on preprod).
 *   2. Add the read-down paths (/api/pos/v1/catalog/snapshot + /deltas).
 *   3. Merge EVERY read-down `components.*` sub-object (schemas, parameters,
 *      responses, securitySchemes) — the read-down PATHS `$ref` all of these
 *      (`#/components/parameters/BranchId`, `#/components/responses/Unauthorized`,
 *      etc.), so merging only `schemas` would leave dangling refs and break
 *      codegen. On a name COLLISION within a section, KEEP the snapshot's entry
 *      and skip read-down's (the existing platform definitions win; read-down's
 *      colliding names — e.g. `Error` — are the same canonical shapes used
 *      verbatim, and read-down `$ref`s stay valid because the ref strings are
 *      identical).
 *
 * The CLI driver (main, below) reads scripts/openapi-snapshot.json +
 * scripts/.readdown-source.yaml and writes the merged snapshot back. The pure
 * transform is exported for unit testing.
 */

type ComponentBag = Record<string, unknown>;

export interface OpenApiDoc {
  paths: Record<string, unknown>;
  components: {
    schemas: ComponentBag;
    parameters?: ComponentBag;
    responses?: ComponentBag;
    securitySchemes?: ComponentBag;
    [k: string]: ComponentBag | undefined;
  };
  [k: string]: unknown;
}

/** Stale pharmacy-era catalogue paths replaced by the read-down surface. */
const STALE_PATHS = ['/api/v1/pos/catalog/products', '/api/v1/pos/catalog/stock'];

/**
 * Merge one components sub-bag (e.g. schemas): snapshot entries win on collision
 * (skip the read-down entry of the same name). Pure — returns a new object.
 */
function mergeBag(
  snapshotBag: ComponentBag | undefined,
  readDownBag: ComponentBag | undefined,
): ComponentBag | undefined {
  if (readDownBag === undefined) return snapshotBag;
  const merged: ComponentBag = { ...snapshotBag };
  for (const [name, def] of Object.entries(readDownBag)) {
    if (name in merged) continue; // collision → keep snapshot's, skip read-down's
    merged[name] = def;
  }
  return merged;
}

/**
 * Merge the read-down contract into the snapshot. Pure — does not mutate inputs.
 */
export function mergeReadDown(snapshot: OpenApiDoc, readDown: OpenApiDoc): OpenApiDoc {
  const stale = new Set(STALE_PATHS);
  // Rebuild paths without the stale catalogue entries (no dynamic delete).
  const paths: Record<string, unknown> = Object.fromEntries(
    Object.entries(snapshot.paths).filter(([p]) => !stale.has(p)),
  );
  for (const [p, def] of Object.entries(readDown.paths)) paths[p] = def;

  // Merge every components sub-bag present in either doc (schemas, parameters,
  // responses, securitySchemes, …) so no read-down $ref is left dangling.
  const sectionNames = new Set<string>([
    ...Object.keys(snapshot.components),
    ...Object.keys(readDown.components),
  ]);
  const components: OpenApiDoc['components'] = { schemas: {} };
  for (const section of sectionNames) {
    const merged = mergeBag(snapshot.components[section], readDown.components[section]);
    if (merged !== undefined) components[section] = merged;
  }

  return { ...snapshot, paths, components };
}

// --- CLI driver (runs only when invoked directly) ---------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// js-yaml ships no bundled types and @types/js-yaml is not a dependency; type the
// one function we use at the import boundary so the parse is type-safe downstream.
import jsYaml from 'js-yaml';

const loadYaml = (jsYaml as { load: (src: string) => unknown }).load;

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(SCRIPTS_DIR, 'openapi-snapshot.json');
const READDOWN_YAML_PATH = path.join(SCRIPTS_DIR, '.readdown-source.yaml');

function main(): void {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as OpenApiDoc;
  const readDown = loadYaml(readFileSync(READDOWN_YAML_PATH, 'utf8')) as OpenApiDoc;
  const merged = mergeReadDown(snapshot, readDown);
  // The committed snapshot is single-line minified JSON; match that exactly so
  // the diff is the content change, not a reformat. Trailing newline.
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(merged) + '\n', 'utf8');
  console.log('[merge-readdown] snapshot updated');
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) main();
