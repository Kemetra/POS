/**
 * RT-217 — read the vendored Backend-Core OpenAPI files into an operation index
 * (method + path template + accepted credentials). Plain TypeScript, no YAML
 * dependency: it reads only the block-style structure Backend-Core's contracts use
 * (`paths` → path → method → `operationId` / `security`, root `security`, and
 * `components.securitySchemes`). Structure is found by indentation, so block-scalar
 * prose (always indented deeper than its key) can never be misread as a key.
 *
 * It fails loudly instead of guessing: every `operationId:` in a file must belong
 * to an extracted operation, and every security scheme must be declared and map
 * to a known POS credential kind. A Backend-Core formatting change therefore turns
 * the suite red at re-pin time rather than silently dropping operations.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The credentials a POS backend client can attach. */
export type CredentialKind = 'device' | 'operator-jwt' | 'operator-envelope' | 'none';

/**
 * Backend-Core security-scheme NAME → the POS credential that satisfies it. Every
 * scheme here is HTTP bearer (`Authorization: Bearer <token>`); the index checks
 * that too. A scheme missing from this map fails the suite: classify it here.
 *
 *   device                → the paired terminal's device token (read-down, cashier admissions)
 *   operator-identity     → the operator's provider-identity JWT (Clerk today)
 *   clerkJwt              → the legacy name of operator-identity
 *   operatorAuthorization → the opaque pos_operator envelope from sign-in / takeover
 */
export const SCHEME_CREDENTIAL: Readonly<Record<string, CredentialKind>> = {
  device: 'device',
  'operator-identity': 'operator-jwt',
  clerkJwt: 'operator-jwt',
  operatorAuthorization: 'operator-envelope',
};

export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'head',
  'options',
  'trace',
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ContractOperation {
  /** Vendored file, relative to `contracts/backend-core/openapi/`. */
  readonly file: string;
  readonly method: HttpMethod;
  /** Path template exactly as the contract declares it, e.g. `/api/pos/v1/sales/{saleRef}`. */
  readonly path: string;
  readonly operationId: string;
  /** Credentials any one of which satisfies the operation's `security`. */
  readonly accepts: ReadonlySet<CredentialKind>;
  /** Where the security came from: the operation, or the document root. */
  readonly securitySource: 'operation' | 'root' | 'none-declared';
}

interface Line {
  readonly no: number;
  readonly indent: number;
  readonly text: string;
}

const KEY = /^("[^"]*"|'[^']*'|[^\s:#][^:#]*?):(?:\s+(.*))?$/;

function toLines(source: string): Line[] {
  return source.split(/\r?\n/).flatMap((raw, i) => {
    const trimmed = raw.trimEnd();
    const text = trimmed.trimStart();
    if (text === '' || text.startsWith('#')) return [];
    return [{ no: i + 1, indent: trimmed.length - text.length, text }];
  });
}

function unquote(s: string): string {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
}

function stripComment(value: string): string {
  return value.replace(/\s+#.*$/, '').trim();
}

/** Parse `key: value` at a line; null when the line is not a mapping key. */
function keyOf(line: Line): { key: string; value: string } | null {
  const m = KEY.exec(line.text);
  if (m === null) return null;
  return { key: unquote(m[1] as string), value: stripComment(m[2] ?? '') };
}

/**
 * Read a `security:` value starting at `lines[i]` (the `security:` key line).
 * Returns the requirement alternatives, each an AND-set of scheme names
 * (`[]` → no requirement; `[[]]` → anonymous allowed).
 */
function readSecurity(lines: readonly Line[], i: number, where: string): string[][] {
  const head = lines[i] as Line;
  const inline = keyOf(head)?.value ?? '';
  if (inline === '[]') return [];
  if (inline !== '') throw new Error(`${where}: unsupported inline security "${inline}"`);
  const alternatives: string[][] = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    const line = lines[j] as Line;
    if (line.indent < head.indent) break;
    if (line.indent === head.indent && !line.text.startsWith('- ')) break;
    const item = line.text.startsWith('- ') ? line.text.slice(2).trim() : null;
    const body = item ?? line.text;
    if (item !== null) alternatives.push([]);
    const current = alternatives[alternatives.length - 1];
    if (current === undefined) throw new Error(`${where}: security entry outside a list item`);
    if (body === '{}') continue;
    const m = /^("[^"]*"|'[^']*'|[^\s:]+):\s*\[\s*\]$/.exec(body);
    if (m === null)
      throw new Error(`${where} line ${String(line.no)}: unsupported security "${body}"`);
    current.push(unquote(m[1] as string));
  }
  return alternatives;
}

interface ParsedFile {
  readonly ops: Array<{
    readonly file: string;
    readonly method: HttpMethod;
    readonly path: string;
    operationId: string;
    security: string[][] | null;
  }>;
  readonly rootSecurity: string[][] | null;
  readonly schemes: ReadonlyMap<string, { type: string; scheme: string }>;
  readonly operationIdCount: number;
}

function parseFile(file: string, source: string): ParsedFile {
  const lines = toLines(source);
  const ops: ParsedFile['ops'] = [];
  const schemes = new Map<string, { type: string; scheme: string }>();
  let rootSecurity: string[][] | null = null;
  let section: string | null = null;
  let currentPath: string | null = null;
  let currentOp: ParsedFile['ops'][number] | null = null;
  let inSchemes = false;
  let currentScheme: { name: string; type: string; scheme: string } | null = null;
  const flushScheme = (): void => {
    if (currentScheme !== null) schemes.set(currentScheme.name, currentScheme);
    currentScheme = null;
  };

  lines.forEach((line, i) => {
    const kv = keyOf(line);
    if (line.indent === 0) {
      flushScheme();
      section = kv?.key ?? null;
      currentPath = null;
      currentOp = null;
      inSchemes = false;
      if (section === 'security') rootSecurity = readSecurity(lines, i, `${file} root security`);
      return;
    }
    if (kv === null) return;

    if (section === 'paths') {
      if (line.indent === 2) {
        currentPath = kv.key;
        currentOp = null;
      } else if (line.indent === 4 && currentPath !== null) {
        const method = kv.key.toLowerCase();
        currentOp = (HTTP_METHODS as readonly string[]).includes(method)
          ? {
              file,
              method: method as HttpMethod,
              path: currentPath,
              operationId: '',
              security: null,
            }
          : null;
        if (currentOp !== null) ops.push(currentOp);
      } else if (line.indent === 6 && currentOp !== null) {
        const op: ParsedFile['ops'][number] = currentOp;
        if (kv.key === 'operationId') op.operationId = unquote(kv.value);
        if (kv.key === 'security') {
          op.security = readSecurity(lines, i, `${file} ${op.method} ${op.path}`);
        }
      }
    } else if (section === 'components') {
      if (line.indent === 2) {
        flushScheme();
        inSchemes = kv.key === 'securitySchemes';
      } else if (inSchemes && line.indent === 4) {
        flushScheme();
        currentScheme = { name: kv.key, type: '', scheme: '' };
      } else if (inSchemes && line.indent === 6 && currentScheme !== null) {
        const scheme: { name: string; type: string; scheme: string } = currentScheme;
        if (kv.key === 'type') scheme.type = unquote(kv.value);
        if (kv.key === 'scheme') scheme.scheme = unquote(kv.value).toLowerCase();
      }
    }
  });
  flushScheme();

  return {
    ops,
    rootSecurity,
    schemes,
    operationIdCount: lines.filter((l) => /^operationId:/.test(l.text)).length,
  };
}

/** Build the index for one vendored file. Throws on anything it cannot classify. */
export function indexContract(file: string, source: string): ContractOperation[] {
  const parsed = parseFile(file, source);
  if (parsed.ops.length === 0) throw new Error(`${file}: no operations found under paths`);
  if (parsed.operationIdCount !== parsed.ops.length) {
    throw new Error(
      `${file}: ${String(parsed.operationIdCount)} operationId(s) but ` +
        `${String(parsed.ops.length)} operation(s) extracted — the reader missed some structure`,
    );
  }
  return parsed.ops.map((op) => {
    const where = `${file} ${op.method.toUpperCase()} ${op.path}`;
    if (op.operationId === '') throw new Error(`${where}: missing operationId`);
    const security = op.security ?? parsed.rootSecurity ?? [];
    const accepts = new Set<CredentialKind>();
    for (const alternative of security) {
      if (alternative.length === 0) {
        accepts.add('none');
        continue;
      }
      if (alternative.length > 1) {
        throw new Error(`${where}: combined (AND) security ${alternative.join('+')} unsupported`);
      }
      const name = alternative[0] as string;
      const declared = parsed.schemes.get(name);
      if (declared === undefined) throw new Error(`${where}: undeclared security scheme "${name}"`);
      if (declared.type !== 'http' || declared.scheme !== 'bearer') {
        throw new Error(`${where}: scheme "${name}" is not HTTP bearer; extend the classifier`);
      }
      const kind = SCHEME_CREDENTIAL[name];
      if (kind === undefined) {
        throw new Error(
          `${where}: scheme "${name}" has no POS credential mapping (SCHEME_CREDENTIAL)`,
        );
      }
      accepts.add(kind);
    }
    if (security.length === 0) accepts.add('none');
    return {
      file: op.file,
      method: op.method,
      path: op.path,
      operationId: op.operationId,
      accepts,
      securitySource:
        op.security !== null
          ? 'operation'
          : parsed.rootSecurity !== null
            ? 'root'
            : 'none-declared',
    };
  });
}

/** Index every vendored file; the same method + path in two files is an error. */
export function indexVendoredContracts(
  openapiDir: string,
  files: readonly string[],
): ContractOperation[] {
  const all = files.flatMap((file) =>
    indexContract(file, readFileSync(path.join(openapiDir, ...file.split('/')), 'utf-8')),
  );
  const seen = new Map<string, string>();
  for (const op of all) {
    const key = `${op.method} ${op.path}`;
    const other = seen.get(key);
    if (other !== undefined) throw new Error(`${key} is declared in both ${other} and ${op.file}`);
    seen.set(key, op.file);
  }
  return all;
}

function templateRegex(template: string): RegExp {
  const escaped = template
    .split(/\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${escaped}$`);
}

/** Number of `{param}` segments; fewer is a more specific match. */
function paramCount(template: string): number {
  return (template.match(/\{[^}]+\}/g) ?? []).length;
}

/** Find the contract operation a concrete request path + method resolves to (most specific wins). */
export function matchOperation(
  ops: readonly ContractOperation[],
  method: HttpMethod,
  concretePath: string,
): ContractOperation | null {
  const candidates = ops
    .filter((op) => op.method === method && templateRegex(op.path).test(concretePath))
    .sort((a, b) => paramCount(a.path) - paramCount(b.path));
  return candidates[0] ?? null;
}

/** True when a concrete path is an instance of `template`. */
export function pathMatchesTemplate(template: string, concretePath: string): boolean {
  return templateRegex(template).test(concretePath);
}
