/**
 * RT-217 — POS ↔ Backend-Core contract conformance (fast, offline, blocking).
 *
 * Checks every Backend-Core call the POS makes against the Backend-Core OpenAPI
 * contracts vendored in `contracts/backend-core/` (pinned to one Backend-Core
 * commit by `contracts/backend-core/PIN`; refresh with `npm run contracts:repin`):
 *
 *   1. the snapshot is exactly what Backend-Core published at the pinned commit;
 *   2. the client registry is complete: no `fetch` call site, client method or
 *      Backend-Core path literal in `src/` escapes it (`source-scan.ts`);
 *   3. each call's endpoint (method + path template) exists in the snapshot;
 *   4. the credential each call actually sends satisfies the route's `security`.
 *
 * Violations on `main` today are listed in `known-violations.ts` with their Jira
 * tickets; the observed set must equal that list exactly (`conformance.ts`), so any
 * new violation fails and a fixed one must be removed from the list.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BACKEND_CORE_OPENAPI_ROOT, gitBlobSha, parsePin } from '../../../scripts/contracts-pin.js';
import {
  BASE_URL,
  CLIENT_CALLS,
  CLIENT_MODULES,
  NON_BACKEND_CORE_TRANSPORTS,
  SENTINEL,
  type ClientCall,
  type ClientModule,
} from './client-registry.js';
import {
  diffAgainstKnown,
  observe,
  recordingFetch,
  violationsFor,
  type ObservedRequest,
} from './conformance.js';
import { KNOWN_VIOLATIONS } from './known-violations.js';
import { indexVendoredContracts, pathMatchesTemplate } from './openapi-index.js';
import { scanSrc, type ModuleScan } from './source-scan.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'contracts', 'backend-core');
const OPENAPI_DIR = path.join(SNAPSHOT_DIR, 'openapi');
const PIN = parsePin(readFileSync(path.join(SNAPSHOT_DIR, 'PIN'), 'utf-8'));
const VENDORED = { dir: OPENAPI_DIR, files: PIN.files.map((f) => f.path) };

function listVendored(dir: { readonly path: string; readonly prefix: string }): string[] {
  return readdirSync(dir.path, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? listVendored({ path: path.join(dir.path, e.name), prefix: `${dir.prefix}${e.name}/` })
      : [`${dir.prefix}${e.name}`],
  );
}

const countLine = (m: { readonly module: string; readonly fetchCallSites: number }): string =>
  `${m.module}: ${String(m.fetchCallSites)}`;

const callsOf = (mod: ClientModule): ClientCall[] =>
  CLIENT_CALLS.filter((c) => c.module === mod.module);

const methodName = (call: ClientCall): string => call.id.split('.').pop() ?? '';

function uncoveredLiterals(entry: [string, ModuleScan]): string[] {
  const [module, scan] = entry;
  const external = NON_BACKEND_CORE_TRANSPORTS.some((m) => m.module === module);
  const covers = (literal: string): boolean =>
    !external &&
    CLIENT_CALLS.some((c) => c.module === module && c.pathTemplate.startsWith(literal));
  return scan.apiLiterals.filter((literal) => !covers(literal)).map((l) => `${module}: ${l}`);
}

function expectRequestMatches(call: ClientCall, req: ObservedRequest): void {
  expect(req.url.origin).toBe(new URL(BASE_URL).origin);
  expect(req.method).toBe(call.method);
  expect(
    pathMatchesTemplate({ template: call.pathTemplate, concrete: req.url.pathname }),
    `${req.url.pathname} is not an instance of ${call.pathTemplate}`,
  ).toBe(true);
  for (const token of Object.values(SENTINEL)) {
    expect(req.url.href, 'a credential must never travel in the URL').not.toContain(token);
  }
}

describe('Backend-Core contract snapshot (contracts/backend-core)', () => {
  it('is pinned to one Backend-Core commit', () => {
    expect(PIN.repo).toBe('Kemetra/Backend-Core');
    expect(PIN.source).toBe(BACKEND_CORE_OPENAPI_ROOT);
    expect(PIN.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('holds exactly the pinned files, byte-identical to Backend-Core (git blob SHA)', () => {
    expect(listVendored({ path: OPENAPI_DIR, prefix: '' }).sort()).toEqual(
      [...VENDORED.files].sort(),
    );
    for (const file of PIN.files) {
      const bytes = readFileSync(path.join(OPENAPI_DIR, ...file.path.split('/')));
      expect(gitBlobSha(bytes), `${file.path} was edited after the pin`).toBe(file.blobSha);
    }
  });

  it('indexes every operation and classifies every security scheme', () => {
    const ops = indexVendoredContracts(VENDORED);
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) expect(op.accepts.size, op.operationId).toBeGreaterThan(0);
  });
});

describe('POS Backend-Core client registry is complete', () => {
  const scans = scanSrc({ root: REPO_ROOT });

  it('registers every module that calls fetch, with its exact call-site count', () => {
    const found = [...scans]
      .filter(([, scan]) => scan.fetchCallSites > 0)
      .map(([module, scan]) => countLine({ module, fetchCallSites: scan.fetchCallSites }))
      .sort();
    const declared = [...CLIENT_MODULES, ...NON_BACKEND_CORE_TRANSPORTS].map(countLine).sort();
    expect(
      found,
      'a module calls fetch but is not in CLIENT_MODULES / NON_BACKEND_CORE_TRANSPORTS ' +
        '(tests/contract/backend-core/client-registry.ts), or its call-site count changed',
    ).toEqual(declared);
  });

  it('covers every Backend-Core path literal in src/ with a registered call', () => {
    const uncovered = [...scans].flatMap(uncoveredLiterals);
    expect(uncovered, 'register these calls in client-registry.ts').toEqual([]);
  });

  it('registers one call per fetch call site for function-style clients', () => {
    for (const mod of CLIENT_MODULES.filter((m) => m.surface === undefined)) {
      expect(callsOf(mod), mod.module).toHaveLength(mod.fetchCallSites);
    }
  });

  it('registers every method of every factory-built client', () => {
    for (const mod of CLIENT_MODULES) {
      if (mod.surface === undefined) continue;
      const methods = Object.keys(mod.surface(recordingFetch().fetch)).sort();
      const names = callsOf(mod).map(methodName).sort();
      expect(names, `${mod.module}: register every client method`).toEqual(methods);
    }
  });

  it('names real exports for function-style clients', async () => {
    for (const mod of CLIENT_MODULES.filter((m) => m.surface === undefined)) {
      const url = pathToFileURL(path.join(REPO_ROOT, mod.module)).href;
      const exported = (await import(url)) as Record<string, unknown>;
      for (const call of callsOf(mod)) {
        expect(typeof exported[call.id], `${mod.module} exports ${call.id}`).toBe('function');
      }
    }
  });

  it('keeps registry ids unique and every registered module present', () => {
    const ids = CLIENT_CALLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mod of [...CLIENT_MODULES, ...NON_BACKEND_CORE_TRANSPORTS]) {
      expect(existsSync(path.join(REPO_ROOT, mod.module)), mod.module).toBe(true);
    }
    const modules = CLIENT_MODULES.map((m) => m.module);
    for (const call of CLIENT_CALLS) expect(modules, call.id).toContain(call.module);
  });

  it('points every known violation at a registered call and a ticket', () => {
    const ids = CLIENT_CALLS.map((c) => c.id);
    for (const known of KNOWN_VIOLATIONS) {
      expect(ids, `known violation ${known.call}`).toContain(known.call);
      expect(known.tickets.length, `${known.call} needs a ticket or TODO-ticket`).toBeGreaterThan(
        0,
      );
    }
  });
});

describe('POS Backend-Core clients conform to the pinned contract', () => {
  const ops = indexVendoredContracts(VENDORED);

  it.each(CLIENT_CALLS.map((c) => [c.id, c] as const))(
    '%s sends the registered request',
    async (_id, call) => {
      const { requests } = await observe(call);
      expect(requests.length, 'the client made no request').toBeGreaterThan(0);
      for (const req of requests) expectRequestMatches(call, req);
    },
  );

  it('has exactly the known, ticketed violations — no new ones, none stale', async () => {
    const observations = await Promise.all(CLIENT_CALLS.map(observe));
    const found = observations.flatMap((obs) => violationsFor(obs, ops));
    expect(
      diffAgainstKnown(found, KNOWN_VIOLATIONS),
      `contract pinned at Backend-Core ${PIN.commit}. Unexpected = a new contract ` +
        'violation (fix the client, or file a ticket and list it in known-violations.ts). ' +
        'Stale = a listed violation no longer occurs (delete its entry).',
    ).toEqual({ unexpected: [], stale: [] });
  });
});
