/**
 * RT-217 — POS ↔ Backend-Core contract conformance (fast, offline, blocking).
 *
 * Checks every Backend-Core call the POS makes against the Backend-Core OpenAPI
 * contracts vendored in `contracts/backend-core/` (pinned to one Backend-Core
 * commit by `contracts/backend-core/PIN`; refresh with `npm run contracts:repin`):
 *
 *   1. the snapshot is exactly what Backend-Core published at the pinned commit;
 *   2. the client registry is complete: no `fetch` call site, client method or
 *      Backend-Core path literal in `src/` escapes it;
 *   3. each call's endpoint (method + path template) exists in the snapshot;
 *   4. the credential each call actually sends satisfies the route's `security`.
 *
 * Violations on `main` today are listed in `known-violations.ts` with their Jira
 * tickets; the observed set must equal that list exactly, so any new violation
 * fails and a fixed one must be removed from the list.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { gitBlobSha, parsePin, BACKEND_CORE_OPENAPI_ROOT } from '../../../scripts/contracts-pin.js';
import {
  BASE_URL,
  CLIENT_CALLS,
  CLIENT_MODULES,
  NON_BACKEND_CORE_TRANSPORTS,
  SENTINEL,
  type ClientCall,
  type FetchLike,
} from './client-registry.js';
import { KNOWN_VIOLATIONS } from './known-violations.js';
import {
  indexVendoredContracts,
  pathMatchesTemplate,
  type ContractOperation,
  type CredentialKind,
} from './openapi-index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'contracts', 'backend-core');
const OPENAPI_DIR = path.join(SNAPSHOT_DIR, 'openapi');
const PIN = parsePin(readFileSync(path.join(SNAPSHOT_DIR, 'PIN'), 'utf-8'));

// ─── Static scan of src/ ─────────────────────────────────────────────────────

interface ModuleScan {
  readonly fetchCallSites: number;
  readonly apiLiterals: readonly string[];
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Counts calls of an injected transport — `fetch(…)`, `fetchImpl(…)` or `x.fetch(…)` —
 * and collects every string/template fragment naming a Backend-Core path (`/api/…`).
 * Comments are not AST nodes, so prose can neither satisfy nor fail the scan.
 */
function scanModule(file: string): ModuleScan {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let fetchCallSites = 0;
  const apiLiterals: string[] = [];
  const visit = (node: ts.Node): void => {
    // Type-level code cannot send a request (e.g. the generated `api-types.ts`
    // keys its interfaces by path); only runtime values are scanned.
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeNode(node)) {
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) && (callee.text === 'fetch' || callee.text === 'fetchImpl')) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch')
      ) {
        fetchCallSites += 1;
      }
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const m of node.text.matchAll(/\/api\/[^\s'"`?#]*/g)) apiLiterals.push(m[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { fetchCallSites, apiLiterals };
}

function scanSrc(): Map<string, ModuleScan> {
  const scans = new Map<string, ModuleScan>();
  for (const file of listSourceFiles(path.join(REPO_ROOT, 'src'))) {
    const scan = scanModule(file);
    if (scan.fetchCallSites > 0 || scan.apiLiterals.length > 0) {
      scans.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), scan);
    }
  }
  return scans;
}

// ─── Driving a client ────────────────────────────────────────────────────────

interface ObservedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
}

function recordingFetch(): { fetch: FetchLike; requests: ObservedRequest[] } {
  const requests: ObservedRequest[] = [];
  const fetch: FetchLike = (input, init) => {
    const url =
      input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toLowerCase();
    requests.push({ method, url, headers: new Headers(init?.headers) });
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  };
  return { fetch, requests };
}

type SentCredential = CredentialKind | `unrecognised (${string})`;

function sentCredential(headers: Headers): SentCredential {
  const auth = headers.get('authorization');
  if (auth === null) return 'none';
  const token = /^Bearer (.+)$/.exec(auth)?.[1];
  const kind = (Object.keys(SENTINEL) as Array<keyof typeof SENTINEL>).find(
    (k) => SENTINEL[k] === token,
  );
  return kind ?? `unrecognised (${auth.split(' ')[0] ?? ''})`;
}

interface Observation {
  readonly call: ClientCall;
  readonly requests: readonly ObservedRequest[];
}

async function observe(call: ClientCall): Promise<Observation> {
  const { fetch, requests } = recordingFetch();
  await call.invoke(fetch);
  return { call, requests };
}

// ─── Conformance ─────────────────────────────────────────────────────────────

interface Violation {
  readonly call: string;
  readonly kind: 'credential-mismatch' | 'endpoint-missing';
  readonly sent?: SentCredential;
  readonly detail: string;
}

function violationsFor(obs: Observation, ops: readonly ContractOperation[]): Violation[] {
  const { call } = obs;
  const label = `${call.method.toUpperCase()} ${call.pathTemplate}`;
  const op = ops.find((o) => o.method === call.method && o.path === call.pathTemplate);
  if (op === undefined) {
    return [
      {
        call: call.id,
        kind: 'endpoint-missing',
        detail: `${label} is not in the pinned Backend-Core contracts`,
      },
    ];
  }
  return [...new Set(obs.requests.map((r) => sentCredential(r.headers)))]
    .filter((sent) => !op.accepts.has(sent as CredentialKind))
    .map((sent) => ({
      call: call.id,
      kind: 'credential-mismatch' as const,
      sent,
      detail: `${label} sends ${sent}; ${op.file} (${op.operationId}) requires ${[...op.accepts].join(' | ')}`,
    }));
}

const violationKey = (v: { call: string; kind: string; sent?: string | undefined }): string =>
  `${v.call} | ${v.kind}${v.sent === undefined ? '' : ` | sends ${v.sent}`}`;

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Backend-Core contract snapshot (contracts/backend-core)', () => {
  it('is pinned to one Backend-Core commit', () => {
    expect(PIN.repo).toBe('Kemetra/Backend-Core');
    expect(PIN.source).toBe(BACKEND_CORE_OPENAPI_ROOT);
    expect(PIN.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('holds exactly the pinned files, byte-identical to Backend-Core (git blob SHA)', () => {
    const listed = (dir: string, prefix = ''): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? listed(path.join(dir, e.name), `${prefix}${e.name}/`)
          : [`${prefix}${e.name}`],
      );
    expect(listed(OPENAPI_DIR).sort()).toEqual(PIN.files.map((f) => f.path).sort());
    for (const file of PIN.files) {
      const bytes = readFileSync(path.join(OPENAPI_DIR, ...file.path.split('/')));
      expect(gitBlobSha(bytes), `${file.path} was edited after the pin`).toBe(file.blobSha);
    }
  });

  it('indexes every operation and classifies every security scheme', () => {
    const ops = indexVendoredContracts(
      OPENAPI_DIR,
      PIN.files.map((f) => f.path),
    );
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) expect(op.accepts.size, op.operationId).toBeGreaterThan(0);
  });
});

describe('POS Backend-Core client registry is complete', () => {
  const scans = scanSrc();
  const registered = new Map(CLIENT_MODULES.map((m) => [m.module, m]));
  const external = new Map(NON_BACKEND_CORE_TRANSPORTS.map((m) => [m.module, m]));

  it('registers every module that calls fetch, with its exact call-site count', () => {
    const found = [...scans]
      .filter(([, scan]) => scan.fetchCallSites > 0)
      .map(([module, scan]) => `${module}: ${String(scan.fetchCallSites)}`)
      .sort();
    const declared = [...CLIENT_MODULES, ...NON_BACKEND_CORE_TRANSPORTS]
      .map((m) => `${m.module}: ${String(m.fetchCallSites)}`)
      .sort();
    expect(
      found,
      'a module calls fetch but is not in CLIENT_MODULES / NON_BACKEND_CORE_TRANSPORTS ' +
        '(tests/contract/backend-core/client-registry.ts), or its call-site count changed',
    ).toEqual(declared);
  });

  it('covers every Backend-Core path literal in src/ with a registered call', () => {
    const uncovered: string[] = [];
    for (const [module, scan] of scans) {
      for (const literal of scan.apiLiterals) {
        const covered =
          !external.has(module) &&
          CLIENT_CALLS.some((c) => c.module === module && c.pathTemplate.startsWith(literal));
        if (!covered) uncovered.push(`${module}: ${literal}`);
      }
    }
    expect(uncovered, 'register these calls in client-registry.ts').toEqual([]);
  });

  it('registers every method of every factory-built client', () => {
    for (const mod of CLIENT_MODULES) {
      const calls = CLIENT_CALLS.filter((c) => c.module === mod.module);
      if (mod.surface === undefined) {
        expect(calls, `${mod.module}: one registered call per fetch call site`).toHaveLength(
          mod.fetchCallSites,
        );
        continue;
      }
      const methods = Object.keys(mod.surface(recordingFetch().fetch)).sort();
      const names = calls.map((c) => c.id.split('.').pop() ?? '').sort();
      expect(names, `${mod.module}: register every client method`).toEqual(methods);
    }
  });

  it('names real exports for function-style clients', async () => {
    for (const mod of CLIENT_MODULES.filter((m) => m.surface === undefined)) {
      const exported = (await import(
        pathToFileURL(path.join(REPO_ROOT, mod.module)).href
      )) as Record<string, unknown>;
      for (const call of CLIENT_CALLS.filter((c) => c.module === mod.module)) {
        expect(typeof exported[call.id], `${mod.module} exports ${call.id}`).toBe('function');
      }
    }
  });

  it('keeps registry ids unique and known violations pointing at registered calls', () => {
    const ids = CLIENT_CALLS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const module of [...registered.keys(), ...external.keys()]) {
      expect(existsSync(path.join(REPO_ROOT, module)), module).toBe(true);
    }
    for (const call of CLIENT_CALLS) expect(registered.has(call.module), call.id).toBe(true);
    for (const known of KNOWN_VIOLATIONS) {
      expect(ids, `known violation ${known.call}`).toContain(known.call);
      expect(known.tickets.length, `${known.call} needs a ticket or TODO-ticket`).toBeGreaterThan(
        0,
      );
    }
  });
});

describe('POS Backend-Core clients conform to the pinned contract', () => {
  const ops = indexVendoredContracts(
    OPENAPI_DIR,
    PIN.files.map((f) => f.path),
  );

  it.each(CLIENT_CALLS.map((c) => [c.id, c] as const))(
    '%s sends the registered request',
    async (_id, call) => {
      const { requests } = await observe(call);
      expect(requests.length, 'the client made no request').toBeGreaterThan(0);
      for (const req of requests) {
        expect(req.url.origin).toBe(new URL(BASE_URL).origin);
        expect(req.method).toBe(call.method);
        expect(
          pathMatchesTemplate(call.pathTemplate, req.url.pathname),
          `${req.url.pathname} is not an instance of ${call.pathTemplate}`,
        ).toBe(true);
        for (const token of Object.values(SENTINEL)) {
          expect(req.url.href, 'a credential must never travel in the URL').not.toContain(token);
        }
      }
    },
  );

  it('has exactly the known, ticketed violations — no new ones, none stale', async () => {
    const observations = await Promise.all(CLIENT_CALLS.map(observe));
    const found = observations.flatMap((obs) => violationsFor(obs, ops));
    const foundKeys = found.map(violationKey).sort();
    const knownKeys = KNOWN_VIOLATIONS.map(violationKey).sort();
    const unexpected = found.filter((v) => !knownKeys.includes(violationKey(v)));
    const stale = KNOWN_VIOLATIONS.filter((k) => !foundKeys.includes(violationKey(k)));
    expect(
      {
        unexpected: unexpected.map((v) => `${violationKey(v)} — ${v.detail}`),
        stale: stale.map(violationKey),
      },
      `contract pinned at Backend-Core ${PIN.commit}. Unexpected = a new contract ` +
        'violation (fix the client, or file a ticket and list it in known-violations.ts). ' +
        'Stale = a listed violation no longer occurs (delete its entry).',
    ).toEqual({ unexpected: [], stale: [] });
  });
});
