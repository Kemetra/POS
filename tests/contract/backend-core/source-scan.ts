/**
 * RT-217 — static scan of `src/` for Backend-Core transport use, so the client
 * registry cannot silently fall behind the code.
 *
 * Per module it counts calls of an injected transport — `fetch(…)`, `fetchImpl(…)`
 * or `x.fetch(…)` — and collects every runtime string / template fragment naming a
 * Backend-Core path (`/api/…`). It walks the TypeScript AST: comments are not nodes,
 * so prose can neither satisfy nor fail the scan, and type-level code (which cannot
 * send a request, e.g. the generated `api-types.ts` keyed by path) is skipped.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface ModuleScan {
  readonly fetchCallSites: number;
  readonly apiLiterals: readonly string[];
}

interface Accumulator {
  fetchCallSites: number;
  readonly apiLiterals: string[];
}

type Handler = (node: ts.Node, acc: Accumulator) => void;

const TRANSPORT_NAMES: ReadonlySet<string> = new Set(['fetch', 'fetchImpl']);
const API_PATH = /\/api\/[^\s'"`?#]*/g;
const TYPE_LEVEL: ReadonlyArray<(node: ts.Node) => boolean> = [
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isTypeNode,
];

/** The callee's own name: `fetch` in `fetch(…)` and in `deps.fetch(…)`. */
function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  return callee.name.text === 'fetch' ? 'fetch' : null;
}

const countTransportCall: Handler = (node, acc) => {
  const name = calleeName((node as ts.CallExpression).expression);
  if (name !== null && TRANSPORT_NAMES.has(name)) acc.fetchCallSites += 1;
};

const collectApiPaths: Handler = (node, acc) => {
  for (const match of (node as ts.LiteralLikeNode).text.matchAll(API_PATH)) {
    acc.apiLiterals.push(match[0]);
  }
};

const HANDLERS: Partial<Record<ts.SyntaxKind, Handler>> = {
  [ts.SyntaxKind.CallExpression]: countTransportCall,
  [ts.SyntaxKind.StringLiteral]: collectApiPaths,
  [ts.SyntaxKind.NoSubstitutionTemplateLiteral]: collectApiPaths,
  [ts.SyntaxKind.TemplateHead]: collectApiPaths,
  [ts.SyntaxKind.TemplateMiddle]: collectApiPaths,
  [ts.SyntaxKind.TemplateTail]: collectApiPaths,
};

function visit(node: ts.Node, acc: Accumulator): void {
  if (TYPE_LEVEL.some((isTypeLevel) => isTypeLevel(node))) return;
  HANDLERS[node.kind]?.(node, acc);
  ts.forEachChild(node, (next) => {
    visit(next, acc);
  });
}

export function scanModule(file: { readonly path: string }): ModuleScan {
  const source = ts.createSourceFile(
    file.path,
    readFileSync(file.path, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const acc: Accumulator = { fetchCallSites: 0, apiLiterals: [] };
  visit(source, acc);
  return acc;
}

const SOURCE_FILE = /\.tsx?$/;
const NOT_PRODUCTION = /\.(test|d)\.tsx?$/;

function listSourceFiles(dir: { readonly path: string }): string[] {
  return readdirSync(dir.path, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir.path, entry.name);
    if (entry.isDirectory())
      return entry.name === '__tests__' ? [] : listSourceFiles({ path: full });
    return SOURCE_FILE.test(entry.name) && !NOT_PRODUCTION.test(entry.name) ? [full] : [];
  });
}

const isRelevant = (scan: ModuleScan): boolean =>
  scan.fetchCallSites > 0 || scan.apiLiterals.length > 0;

/** Scan `<repo>/src`, keyed by repo-relative POSIX path; modules with no hits are omitted. */
export function scanSrc(repo: { readonly root: string }): Map<string, ModuleScan> {
  const scans = new Map<string, ModuleScan>();
  for (const file of listSourceFiles({ path: path.join(repo.root, 'src') })) {
    const scan = scanModule({ path: file });
    if (isRelevant(scan)) {
      scans.set(path.relative(repo.root, file).split(path.sep).join('/'), scan);
    }
  }
  return scans;
}
