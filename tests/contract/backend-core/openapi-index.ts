/**
 * RT-217 — read the vendored Backend-Core OpenAPI files into an operation index
 * (method + path template + accepted credentials). Plain TypeScript, no YAML
 * dependency: `yaml-tree.ts` outlines the block structure and this module walks
 * only `paths` → path → method → `operationId` / `security`, the root `security`,
 * and `components.securitySchemes`.
 *
 * It fails loudly instead of guessing: every `operationId:` in a file must belong
 * to an extracted operation, and every security scheme must be declared, HTTP
 * bearer, and mapped to a POS credential kind. A Backend-Core formatting change
 * therefore turns the suite red at re-pin time rather than silently dropping
 * operations.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildTree, child, toLines, type SourceText, type YamlNode } from './yaml-tree.js';

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

/** A method + path pair: a template (`/sales/{saleRef}`) or a concrete request path. */
export interface EndpointRef {
  readonly method: HttpMethod;
  readonly path: string;
}

export interface ContractOperation extends EndpointRef {
  /** Vendored file, relative to `contracts/backend-core/openapi/`. */
  readonly file: string;
  readonly operationId: string;
  /** Credentials any one of which satisfies the operation's `security`. */
  readonly accepts: ReadonlySet<CredentialKind>;
  /** Where the security came from: the operation, the document root, or neither. */
  readonly securitySource: 'operation' | 'root' | 'none-declared';
}

/** An OR-list of AND-sets of scheme names; `[]` = no requirement, `[[]]` = anonymous. */
type SecurityRequirements = readonly (readonly string[])[];

interface Scheme {
  readonly type: string;
  readonly scheme: string;
}

interface Document {
  readonly source: SourceText;
  readonly root: YamlNode;
  readonly schemes: ReadonlyMap<string, Scheme>;
  readonly rootSecurity: SecurityRequirements | null;
}

interface RawOperation {
  readonly doc: Document;
  readonly where: string;
  readonly ref: EndpointRef;
  readonly node: YamlNode;
}

/** Error context: what is being read, e.g. `sales.yaml POST /api/pos/v1/sales`. */
interface Context {
  readonly where: string;
}

const isHttpMethod = (node: YamlNode): boolean =>
  (HTTP_METHODS as readonly (string | null)[]).includes(node.key);

function fail(ctx: Context, message: string): never {
  throw new Error(`${ctx.where}: ${message}`);
}

// ─── security ────────────────────────────────────────────────────────────────

/** One AND-set from a list item: `- a: []` (+ continuation keys) or `- {}`. */
function requirementOf(item: YamlNode, ctx: Context): string[] {
  if (item.key === null && item.value === '{}') return [];
  const entries = [item, ...item.children];
  const malformed = entries.find((e) => e.key === null || e.value !== '[]');
  if (malformed !== undefined) {
    fail(ctx, `line ${String(malformed.line.no)}: unsupported security "${malformed.line.text}"`);
  }
  return entries.map((e) => e.key as string);
}

function readSecurity(node: YamlNode, ctx: Context): SecurityRequirements {
  if (node.value === '[]') return [];
  if (node.value !== '') fail(ctx, `unsupported inline security "${node.value}"`);
  if (!node.children.every((c) => c.item)) fail(ctx, 'security entry outside a list item');
  return node.children.map((item) => requirementOf(item, ctx));
}

function readSecurityAt(node: YamlNode | undefined, ctx: Context): SecurityRequirements | null {
  return node === undefined ? null : readSecurity(node, ctx);
}

// ─── document ────────────────────────────────────────────────────────────────

function toScheme(node: YamlNode): [string, Scheme] {
  const type = child(node, 'type')?.value ?? '';
  const scheme = (child(node, 'scheme')?.value ?? '').toLowerCase();
  return [node.key ?? '', { type, scheme }];
}

function readSchemes(root: YamlNode): Map<string, Scheme> {
  const components = child(root, 'components');
  const declared = components === undefined ? undefined : child(components, 'securitySchemes');
  return new Map((declared?.children ?? []).map(toScheme));
}

function readDocument(source: SourceText): Document {
  const root = buildTree(source);
  return {
    source,
    root,
    schemes: readSchemes(root),
    rootSecurity: readSecurityAt(child(root, 'security'), {
      where: `${source.name} root security`,
    }),
  };
}

function operationsUnder(doc: Document, pathNode: YamlNode): RawOperation[] {
  return pathNode.children.filter(isHttpMethod).map((node) => {
    const ref = { method: node.key as HttpMethod, path: pathNode.key ?? '' };
    const where = `${doc.source.name} ${ref.method.toUpperCase()} ${ref.path}`;
    return { doc, where, ref, node };
  });
}

function rawOperations(doc: Document): RawOperation[] {
  const paths = child(doc.root, 'paths')?.children ?? [];
  return paths.flatMap((pathNode) => operationsUnder(doc, pathNode));
}

// ─── classification ──────────────────────────────────────────────────────────

function declaredScheme(op: RawOperation, name: string): Scheme {
  const declared = op.doc.schemes.get(name);
  if (declared === undefined) fail(op, `undeclared security scheme "${name}"`);
  if (`${declared.type}/${declared.scheme}` !== 'http/bearer') {
    fail(op, `scheme "${name}" is not HTTP bearer; extend the classifier`);
  }
  return declared;
}

function credentialOf(op: RawOperation, requirement: readonly string[]): CredentialKind {
  if (requirement.length === 0) return 'none';
  if (requirement.length > 1) {
    fail(op, `combined (AND) security ${requirement.join('+')} unsupported`);
  }
  const name = requirement[0] as string;
  declaredScheme(op, name);
  const kind = SCHEME_CREDENTIAL[name];
  if (kind === undefined) {
    fail(op, `scheme "${name}" has no POS credential mapping (SCHEME_CREDENTIAL)`);
  }
  return kind;
}

interface SecurityLevels {
  readonly own: SecurityRequirements | null;
  readonly root: SecurityRequirements | null;
}

function securitySourceOf(levels: SecurityLevels): ContractOperation['securitySource'] {
  if (levels.own !== null) return 'operation';
  return levels.root !== null ? 'root' : 'none-declared';
}

function acceptedCredentials(op: RawOperation, levels: SecurityLevels): Set<CredentialKind> {
  const security = levels.own ?? levels.root ?? [];
  if (security.length === 0) return new Set(['none']);
  return new Set(security.map((requirement) => credentialOf(op, requirement)));
}

function operationIdOf(op: RawOperation): string {
  const id = child(op.node, 'operationId')?.value ?? '';
  if (id === '') fail(op, 'missing operationId');
  return id;
}

function toOperation(op: RawOperation): ContractOperation {
  const levels = { own: readSecurityAt(child(op.node, 'security'), op), root: op.doc.rootSecurity };
  return {
    ...op.ref,
    file: op.doc.source.name,
    operationId: operationIdOf(op),
    accepts: acceptedCredentials(op, levels),
    securitySource: securitySourceOf(levels),
  };
}

function assertAllOperationsRead(doc: Document, ops: readonly RawOperation[]): void {
  const declared = toLines(doc.source).filter((l) => l.text.startsWith('operationId:')).length;
  if (ops.length === 0) throw new Error(`${doc.source.name}: no operations found under paths`);
  if (declared === ops.length) return;
  throw new Error(
    `${doc.source.name}: ${String(declared)} operationId(s) but ${String(ops.length)} ` +
      'operation(s) extracted — the reader missed some structure',
  );
}

/** Build the index for one vendored file. Throws on anything it cannot classify. */
export function indexContract(source: SourceText): ContractOperation[] {
  const doc = readDocument(source);
  const ops = rawOperations(doc);
  assertAllOperationsRead(doc, ops);
  return ops.map(toOperation);
}

export interface VendoredContracts {
  /** Absolute path of `contracts/backend-core/openapi`. */
  readonly dir: string;
  /** Pinned files, relative to `dir`. */
  readonly files: readonly string[];
}

const endpointKey = (ref: EndpointRef): string => `${ref.method} ${ref.path}`;

function assertNoDuplicates(ops: readonly ContractOperation[]): void {
  const seen = new Map<string, string>();
  for (const op of ops) {
    const other = seen.get(endpointKey(op));
    if (other !== undefined) {
      throw new Error(`${endpointKey(op)} is declared in both ${other} and ${op.file}`);
    }
    seen.set(endpointKey(op), op.file);
  }
}

function readVendored(contracts: VendoredContracts): SourceText[] {
  return contracts.files.map((name) => ({
    name,
    text: readFileSync(path.join(contracts.dir, ...name.split('/')), 'utf-8'),
  }));
}

/** Index every vendored file; the same method + path in two files is an error. */
export function indexVendoredContracts(contracts: VendoredContracts): ContractOperation[] {
  const all = readVendored(contracts).flatMap(indexContract);
  assertNoDuplicates(all);
  return all;
}

// ─── matching ────────────────────────────────────────────────────────────────

/** A path template paired with a concrete request path. */
export interface PathPair {
  readonly template: string;
  readonly concrete: string;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const PARAM = /\{[^}]+\}/g;

/** True when `concrete` is an instance of `template`. */
export function pathMatchesTemplate(pair: PathPair): boolean {
  const pattern = pair.template
    .split(PARAM)
    .map((literal) => literal.replace(REGEX_SPECIAL, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${pattern}$`).test(pair.concrete);
}

const paramCount = (op: ContractOperation): number => (op.path.match(PARAM) ?? []).length;

/** The contract operation a concrete request resolves to (the most specific template wins). */
export function matchOperation(
  ops: readonly ContractOperation[],
  request: EndpointRef,
): ContractOperation | null {
  const candidates = ops
    .filter((op) => op.method === request.method)
    .filter((op) => pathMatchesTemplate({ template: op.path, concrete: request.path }))
    .sort((a, b) => paramCount(a) - paramCount(b));
  return candidates[0] ?? null;
}
