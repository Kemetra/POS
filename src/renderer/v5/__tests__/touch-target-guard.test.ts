import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * RT-652 — the 44px touch-target guard for context-sized V5 buttons.
 *
 * `.v5-live-btn` carries colour, border and font, but no size of its own. It
 * reaches the 44px target only through a context rule: `.v5-live-dialog button`
 * (every v5 Dialog panel), or a container rule such as `.v5-live-state button`.
 * Used anywhere else it renders as a ~22px pill (the RT-652 audit).
 *
 * This guard reads every production `.tsx` under `src/renderer` and finds each
 * JSX `<button>`, `<a>` or `<Link>` whose className names a context-sized class.
 * The control passes when one of these holds:
 *  - a JSX ancestor in the same file is the v5 `<Dialog>` (it renders
 *    `.v5-live-dialog`), or
 *  - a stylesheet rule outside any at-rule matches the control (by its own
 *    classes or its tag) with only its ancestors' classes in front, and sets
 *    `min-block-size`, `block-size`, `min-height` or `height` to 44px or more.
 *    A link (`<a>`, `<Link>`) also needs a matching rule that takes it out of
 *    `display: inline`, since a block size does nothing to an inline box.
 *
 * The check is static and conservative: a control whose ancestors live in
 * another file (a prop rendered by a child) fails until a rule names it.
 * Known offenders are listed below with the issue that owns the fix; a test
 * pins that each one still fails, so the list cannot go stale silently.
 */

const RENDERER = resolve(__dirname, '../..');
const REPO = resolve(RENDERER, '../..');
const TARGET_PX = 44;

/** Classes that carry no size of their own and depend on a context rule. */
const CONTEXT_SIZED: ReadonlySet<string> = new Set(['v5-live-btn']);

/** The v5 Dialog panel's classes (foundation/Dialog.tsx). */
const DIALOG_CLASSES = ['v5-dialog', 'v5-live-dialog'];

/**
 * Known undersized controls, marked known-failing (RT-652 acceptance: never
 * skipped silently). Remove an entry once its fix lands; the pin test fails
 * when an entry passes.
 */
const KNOWN_UNDERSIZED: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'src/renderer/v5/void/SaleVoidNotice.tsx',
    reason:
      'RT-670: the void attention banner link «v5-live-btn v5-live-btn--primary» has no ' +
      'size rule in .v5-void-banner',
  },
];

// ── files ───────────────────────────────────────────────────────────────

interface Source {
  readonly path: string;
  readonly text: string;
}

interface FileQuery {
  readonly dir: string;
  readonly ext: '.css' | '.tsx';
}

const TEST_PATH = /[\\/]__tests__[\\/]|\.test\.tsx?$/;

/** Every file with the extension under the directory, node_modules aside. */
function filesUnder(query: FileQuery): string[] {
  return readdirSync(query.dir, { recursive: true, encoding: 'utf-8' })
    .filter((rel) => !rel.includes('node_modules') && extname(rel) === query.ext)
    .map((rel) => join(query.dir, rel));
}

function readSource(path: string): Source {
  return { path, text: readFileSync(path, 'utf-8') };
}

// ── stylesheet rules ────────────────────────────────────────────────────

interface Compound {
  readonly tag: string | null;
  readonly classes: readonly string[];
  readonly other: boolean; // attribute, id or pseudo parts this guard does not model
}

interface Selector {
  /** The compound the rule styles; null for a pseudo-element or an empty selector. */
  readonly target: Compound | null;
  readonly context: readonly Compound[];
}

interface Rule {
  readonly selectors: readonly Selector[];
  readonly sizePx: number;
  readonly boxed: boolean;
}

const SIZE_DECL =
  /(?:^|[\s;])(?:min-)?(?:block-size|height)\s*:\s*(?:var\(\s*--[\w-]+\s*,\s*)?(\d+(?:\.\d+)?)px/g;
const BOX_DISPLAY =
  /(?:^|[\s;])display\s*:\s*(?:inline-flex|inline-block|inline-grid|flex|grid|block)\b/;

function compound(text: string): Compound {
  const tag = /^[a-z][\w-]*/i.exec(text)?.[0]?.toLowerCase() ?? null;
  return {
    tag,
    classes: [...text.matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? ''),
    other: /[[#:]/.test(text),
  };
}

function parseSelector(text: string): Selector {
  const parts = text
    .replace(/\s*[>+~]\s*/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(compound);
  const target = text.includes('::') ? null : (parts.pop() ?? null);
  return { target, context: parts };
}

function toRule(declaration: { readonly selector: string; readonly body: string }): Rule {
  const sizes = [...declaration.body.matchAll(SIZE_DECL)].map((m) => Number(m[1]));
  return {
    selectors: declaration.selector.split(',').map(parseSelector),
    sizePx: Math.max(0, ...sizes),
    boxed: BOX_DISPLAY.test(declaration.body),
  };
}

type Block = 'rule' | 'layer' | 'skip';

interface Token {
  readonly text: string;
  readonly delim: string;
}

/** A block is skipped inside a rule or a non-`@layer` at-rule, and is itself one when it opens such an at-rule. */
function blockKind(prelude: string, open: readonly Block[]): Block {
  if (open.some((b) => b !== 'layer')) return 'skip';
  if (!prelude.startsWith('@')) return 'rule';
  return prelude.startsWith('@layer') ? 'layer' : 'skip';
}

/** Collects top-level rules (and rules inside `@layer`), skipping every other at-rule. */
class RuleCollector {
  readonly rules: Rule[] = [];
  private readonly open: Block[] = [];
  private selector = '';
  private body = '';

  feed(token: Token): void {
    if (token.delim === '{') this.openBlock(token);
    else if (token.delim === '}') this.closeBlock(token);
    else this.body += token.text + token.delim;
  }

  private openBlock(token: Token): void {
    const prelude = token.text.trim();
    this.open.push(blockKind(prelude, this.open));
    this.selector = prelude;
    this.body = '';
  }

  private closeBlock(token: Token): void {
    if (this.open.pop() === 'rule') {
      this.rules.push(toRule({ selector: this.selector, body: this.body + token.text }));
    }
    this.body = '';
  }
}

function parseRules(sheet: Source): Rule[] {
  const parts = sheet.text.replace(/\/\*[\s\S]*?\*\//g, '').split(/([{};])/);
  const collector = new RuleCollector();
  for (let i = 0; i < parts.length; i += 2) {
    collector.feed({ text: parts[i] ?? '', delim: parts[i + 1] ?? '' });
  }
  return collector.rules;
}

// ── matching a control ──────────────────────────────────────────────────

interface Control {
  readonly tag: 'button' | 'a';
  readonly classes: readonly string[];
  readonly ancestorClasses: ReadonlySet<string>;
}

/** The selector's last compound names the control itself (by tag or own classes). */
function namesControl(target: Compound, control: Control): boolean {
  if (target.other) return false;
  if (target.tag === null && target.classes.length === 0) return false;
  const tagOk = target.tag === null || target.tag === control.tag;
  return tagOk && target.classes.every((c) => control.classes.includes(c));
}

/** Whether one selector applies to the control, as far as static JSX can tell. */
function selectorApplies(selector: Selector, control: Control): boolean {
  if (selector.target === null || !namesControl(selector.target, control)) return false;
  return selector.context.every((p) => p.classes.every((c) => control.ancestorClasses.has(c)));
}

function meetsTarget(control: Control, rules: readonly Rule[]): boolean {
  const applying = rules.filter((r) => r.selectors.some((s) => selectorApplies(s, control)));
  const sized = applying.some((r) => r.sizePx >= TARGET_PX);
  const boxed = control.tag === 'button' || applying.some((r) => r.boxed);
  return sized && boxed;
}

// ── JSX controls ────────────────────────────────────────────────────────

type JsxLike = ts.JsxElement | ts.JsxSelfClosingElement;

const CONTROL_TAGS = new Map<string, Control['tag']>([
  ['button', 'button'],
  ['a', 'a'],
  ['Link', 'a'],
]);

function isJsxLike(node: ts.Node): node is JsxLike {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function openingOf(node: JsxLike): ts.JsxOpeningLikeElement {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function tagName(node: JsxLike): string {
  return openingOf(node).tagName.getText();
}

function childrenOf(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  node.forEachChild((child) => {
    out.push(child);
  });
  return out;
}

/** The text of every string and template-literal piece under the node. */
function literalTexts(node: ts.Node): string[] {
  const own = ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) ? [node.text] : [];
  return [...own, ...childrenOf(node).flatMap(literalTexts)];
}

function isClassName(attribute: ts.JsxAttributeLike): attribute is ts.JsxAttribute {
  return ts.isJsxAttribute(attribute) && attribute.name.getText() === 'className';
}

/** Every class-like word in the element's `className` string and template parts. */
function classesOf(node: JsxLike): string[] {
  const initializer = openingOf(node).attributes.properties.find(isClassName)?.initializer;
  if (initializer === undefined) return [];
  return literalTexts(initializer)
    .flatMap((t) => t.split(/\s+/))
    .filter((c) => /^[\w-]+$/.test(c));
}

function jsxAncestorsOf(node: ts.Node): JsxLike[] {
  const out: JsxLike[] = [];
  for (let p = node.parent; !ts.isSourceFile(p); p = p.parent) {
    if (isJsxLike(p)) out.push(p);
  }
  return out;
}

function jsxElementsIn(node: ts.Node): JsxLike[] {
  const own = isJsxLike(node) ? [node] : [];
  return [...own, ...childrenOf(node).flatMap(jsxElementsIn)];
}

interface Found {
  readonly line: number;
  readonly control: Control;
  readonly inDialog: boolean;
}

function toFound(node: JsxLike): Found | null {
  const tag = CONTROL_TAGS.get(tagName(node));
  const classes = classesOf(node);
  if (tag === undefined || !classes.some((c) => CONTEXT_SIZED.has(c))) return null;
  const ancestors = jsxAncestorsOf(node);
  const inDialog = ancestors.some((p) => tagName(p) === 'Dialog');
  const ancestorClasses = new Set([
    ...ancestors.flatMap(classesOf),
    ...(inDialog ? DIALOG_CLASSES : []),
  ]);
  const { line } = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
  return { line: line + 1, control: { tag, classes, ancestorClasses }, inDialog };
}

function contextSizedControls(source: Source): Found[] {
  const file = ts.createSourceFile(
    source.path,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  return jsxElementsIn(file)
    .map(toFound)
    .filter((f): f is Found => f !== null);
}

// ── the tree ────────────────────────────────────────────────────────────

const RULES = filesUnder({ dir: RENDERER, ext: '.css' }).map(readSource).flatMap(parseRules);
const PRODUCTION_TSX = filesUnder({ dir: RENDERER, ext: '.tsx' })
  .filter((path) => !TEST_PATH.test(path))
  .map(readSource);

function repoPath(source: Source): string {
  return relative(REPO, source.path).replace(/\\/g, '/');
}

function undersized(source: Source): string[] {
  return contextSizedControls(source)
    .filter((f) => !f.inDialog && !meetsTarget(f.control, RULES))
    .map((f) => `${repoPath(source)}:${String(f.line)} (${f.control.classes.join(' ')})`);
}

function sheet(text: string): Rule[] {
  return parseRules({ path: 'probe.css', text });
}

function probe(text: string): Found[] {
  return contextSizedControls({ path: 'probe.tsx', text });
}

describe('RT-652 touch-target guard — context-sized V5 buttons', () => {
  it('scans a real tree with real rules', () => {
    expect(PRODUCTION_TSX.length).toBeGreaterThan(100);
    expect(RULES.length).toBeGreaterThan(500);
    const users = PRODUCTION_TSX.filter((s) => contextSizedControls(s).length > 0);
    expect(users.length).toBeGreaterThan(3);
  });

  it('the v5 Dialog panel still sizes its buttons to 44px', () => {
    const control: Control = {
      tag: 'button',
      classes: ['v5-live-btn'],
      ancestorClasses: new Set(DIALOG_CLASSES),
    };
    expect(meetsTarget(control, RULES)).toBe(true);
  });

  it('v5-live-btn has no size of its own, so a bare use is undersized', () => {
    const bare: Control = { tag: 'button', classes: ['v5-live-btn'], ancestorClasses: new Set() };
    expect(meetsTarget(bare, RULES)).toBe(false);
  });

  it('flags a v5-live-btn outside a dialog with no size rule, and passes one inside <Dialog>', () => {
    const outside = probe(
      '<div className="v5-probe"><button className="v5-live-btn">x</button></div>',
    );
    const [first] = outside;
    expect(outside).toHaveLength(1);
    expect(first?.inDialog).toBe(false);
    expect(first !== undefined && meetsTarget(first.control, RULES)).toBe(false);

    const inside = probe(
      '<Dialog label="x"><div><button className="v5-live-btn">x</button></div></Dialog>',
    );
    expect(inside[0]?.inDialog).toBe(true);
  });

  it('reads classes from template literals, and maps <Link> to a link', () => {
    const [link] = probe('<Link className={`v5-live-btn ${tone}`} to="/x">x</Link>');
    expect(link?.control.tag).toBe('a');
    expect(link?.control.classes).toEqual(['v5-live-btn']);
  });

  it('a link needs a box display as well as a size', () => {
    const link: Control = {
      tag: 'a',
      classes: ['v5-live-btn'],
      ancestorClasses: new Set(['probe']),
    };
    expect(meetsTarget(link, sheet('.probe a { min-block-size: 44px; }'))).toBe(false);
    expect(
      meetsTarget(link, sheet('.probe a { display: inline-flex; min-block-size: 44px; }')),
    ).toBe(true);
  });

  it('ignores size rules inside @media, and reads var() fallbacks', () => {
    const control: Control = { tag: 'button', classes: ['x'], ancestorClasses: new Set() };
    expect(
      meetsTarget(control, sheet('@media (min-width: 1px) { .x { min-height: 44px; } }')),
    ).toBe(false);
    expect(meetsTarget(control, sheet('@layer c { .x { min-block-size: var(--t, 44px); } }'))).toBe(
      true,
    );
  });

  it('every v5-live-btn outside a v5 Dialog has a 44px size rule (known offenders aside)', () => {
    const known = new Set(KNOWN_UNDERSIZED.map((k) => k.file));
    const offenders = PRODUCTION_TSX.filter((s) => !known.has(repoPath(s))).flatMap(undersized);
    expect(offenders).toEqual([]);
  });

  it.each(KNOWN_UNDERSIZED)('known-failing: $file is still undersized — $reason', ({ file }) => {
    // When this fails, the fix landed (RT-670): delete the entry from KNOWN_UNDERSIZED.
    expect(undersized(readSource(join(REPO, file))).length).toBeGreaterThan(0);
  });
});
