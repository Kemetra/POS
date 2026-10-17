import { readdirSync, readFileSync, statSync } from 'node:fs';
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
const CONTEXT_SIZED = ['v5-live-btn'] as const;

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
      'the void attention banner link «v5-live-btn v5-live-btn--primary» has no size rule ' +
      'in .v5-void-banner (void-banner follow-up; RT-654 recomposed only the void screen)',
  },
];

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

const isTest = (path: string): boolean => /[\\/]__tests__[\\/]|\.test\.tsx?$/.test(path);

// ── stylesheet rules ────────────────────────────────────────────────────

interface Rule {
  readonly selector: string;
  readonly body: string;
}

/** Top-level rules (and rules inside `@layer`), skipping every other at-rule. */
function parseRules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const stack: boolean[] = []; // true when the open block is a skipped at-rule (or inside one)
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      const prelude = source.slice(start, i).trim();
      const insideSkipped = stack.includes(true);
      const atRule = prelude.startsWith('@');
      stack.push(insideSkipped || (atRule && !prelude.startsWith('@layer')));
      if (!atRule && !insideSkipped) {
        const end = source.indexOf('}', i);
        const body = source.slice(i + 1, end);
        if (!body.includes('{')) {
          rules.push({ selector: prelude, body });
          stack.pop();
          i = end;
        }
      }
      start = i + 1;
    } else if (ch === '}') {
      stack.pop();
      start = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      start = i + 1;
    }
  }
  return rules;
}

function sizePx(body: string): number {
  let best = 0;
  const pattern =
    /(?:^|[\s;])(?:min-)?(?:block-size|height)\s*:\s*(?:var\(\s*--[\w-]+\s*,\s*)?(\d+(?:\.\d+)?)px/g;
  for (const match of body.matchAll(pattern)) best = Math.max(best, Number(match[1]));
  return best;
}

function setsBoxDisplay(body: string): boolean {
  return /(?:^|[\s;])display\s*:\s*(?:inline-flex|inline-block|inline-grid|flex|grid|block)\b/.test(
    body,
  );
}

interface Compound {
  readonly tag: string | null;
  readonly classes: readonly string[];
  readonly other: boolean; // attribute, id or pseudo parts this guard does not model
}

function compound(text: string): Compound {
  const tag = /^[a-z][\w-]*/i.exec(text)?.[0]?.toLowerCase() ?? null;
  const classes = [...text.matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? '');
  const other = /[[#:]/.test(text);
  return { tag: tag === null || tag === '*' ? null : tag, classes, other };
}

interface Control {
  readonly tag: 'button' | 'a';
  readonly classes: readonly string[];
  readonly ancestorClasses: ReadonlySet<string>;
}

/** Whether one selector of a rule applies to the control, as far as static JSX can tell. */
function selectorApplies(selector: string, control: Control): boolean {
  if (selector.includes('::')) return false;
  const parts = selector
    .replace(/\s*[>+~]\s*/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(compound);
  const last = parts.pop();
  if (last === undefined || last.other) return false;
  if (last.tag === null && last.classes.length === 0) return false;
  if (last.tag !== null && last.tag !== control.tag) return false;
  if (!last.classes.every((c) => control.classes.includes(c))) return false;
  return parts.every((p) => p.classes.every((c) => control.ancestorClasses.has(c)));
}

function meetsTarget(control: Control, rules: readonly Rule[]): boolean {
  const applying = rules.filter((r) =>
    r.selector.split(',').some((s) => selectorApplies(s.trim(), control)),
  );
  const sized = applying.some((r) => sizePx(r.body) >= TARGET_PX);
  const boxed = control.tag === 'button' || applying.some((r) => setsBoxDisplay(r.body));
  return sized && boxed;
}

// ── JSX controls ────────────────────────────────────────────────────────

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.tagName.getText();
}

/** Every class-like word in the element's `className` string and template parts. */
function classesOf(node: ts.JsxElement | ts.JsxSelfClosingElement): string[] {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const attr = opening.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === 'className',
  );
  if (attr?.initializer === undefined) return [];
  const texts: string[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) texts.push(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
      texts.push(n.text);
    n.forEachChild(collect);
  };
  collect(attr.initializer);
  return texts.flatMap((t) => t.split(/\s+/)).filter((c) => /^[\w-]+$/.test(c));
}

function ancestorsOf(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  for (let p = node; !ts.isSourceFile(p); p = p.parent) out.push(p.parent);
  return out;
}

interface Found {
  readonly line: number;
  readonly control: Control;
  readonly inDialog: boolean;
}

function contextSizedControls(fileName: string, source: string): Found[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: Found[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = tagName(node);
      const classes = classesOf(node);
      const tag = name === 'button' ? 'button' : name === 'a' || name === 'Link' ? 'a' : null;
      if (tag !== null && classes.some((c) => (CONTEXT_SIZED as readonly string[]).includes(c))) {
        const ancestorClasses = new Set<string>();
        let inDialog = false;
        for (const p of ancestorsOf(node)) {
          if (!ts.isJsxElement(p) && !ts.isJsxSelfClosingElement(p)) continue;
          if (tagName(p) === 'Dialog') {
            inDialog = true;
            for (const c of DIALOG_CLASSES) ancestorClasses.add(c);
          }
          for (const c of classesOf(p)) ancestorClasses.add(c);
        }
        const { line } = file.getLineAndCharacterOfPosition(node.getStart());
        found.push({ line: line + 1, control: { tag, classes, ancestorClasses }, inDialog });
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}

// ── the tree ────────────────────────────────────────────────────────────

const RULES = walk(RENDERER, (p) => extname(p) === '.css').flatMap((f) =>
  parseRules(readFileSync(f, 'utf-8')),
);
const PRODUCTION_TSX = walk(RENDERER, (p) => extname(p) === '.tsx' && !isTest(p));

function undersized(file: string): string[] {
  return contextSizedControls(file, readFileSync(file, 'utf-8'))
    .filter((f) => !f.inDialog && !meetsTarget(f.control, RULES))
    .map(
      (f) =>
        `${relative(REPO, file).replace(/\\/g, '/')}:${String(f.line)} (${f.control.classes.join(' ')})`,
    );
}

describe('RT-652 touch-target guard — context-sized V5 buttons', () => {
  it('scans a real tree with real rules', () => {
    expect(PRODUCTION_TSX.length).toBeGreaterThan(100);
    expect(RULES.length).toBeGreaterThan(500);
    const users = PRODUCTION_TSX.filter(
      (f) => contextSizedControls(f, readFileSync(f, 'utf-8')).length > 0,
    );
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
    const outside = contextSizedControls(
      'probe.tsx',
      '<div className="v5-probe"><button className="v5-live-btn">x</button></div>',
    );
    const [probe] = outside;
    expect(outside).toHaveLength(1);
    expect(probe?.inDialog).toBe(false);
    expect(probe !== undefined && meetsTarget(probe.control, RULES)).toBe(false);

    const inside = contextSizedControls(
      'probe.tsx',
      '<Dialog label="x"><div><button className="v5-live-btn">x</button></div></Dialog>',
    );
    expect(inside[0]?.inDialog).toBe(true);
  });

  it('a link needs a box display as well as a size', () => {
    const rules = parseRules('.probe a { min-block-size: 44px; }');
    const link: Control = {
      tag: 'a',
      classes: ['v5-live-btn'],
      ancestorClasses: new Set(['probe']),
    };
    expect(meetsTarget(link, rules)).toBe(false);
    const boxed = parseRules('.probe a { display: inline-flex; min-block-size: 44px; }');
    expect(meetsTarget(link, boxed)).toBe(true);
  });

  it('ignores size rules inside @media, and reads var() fallbacks', () => {
    const control: Control = { tag: 'button', classes: ['x'], ancestorClasses: new Set() };
    expect(
      meetsTarget(control, parseRules('@media (min-width: 1px) { .x { min-height: 44px; } }')),
    ).toBe(false);
    expect(
      meetsTarget(control, parseRules('@layer c { .x { min-block-size: var(--t, 44px); } }')),
    ).toBe(true);
  });

  it('every v5-live-btn outside a v5 Dialog has a 44px size rule (known offenders aside)', () => {
    const known = new Set(KNOWN_UNDERSIZED.map((k) => k.file));
    const offenders = PRODUCTION_TSX.filter(
      (f) => !known.has(relative(REPO, f).replace(/\\/g, '/')),
    ).flatMap(undersized);
    expect(offenders).toEqual([]);
  });

  it.each(KNOWN_UNDERSIZED)('known-failing: $file is still undersized — $reason', ({ file }) => {
    // When this fails, the fix landed: delete the entry from KNOWN_UNDERSIZED.
    expect(undersized(join(REPO, file)).length).toBeGreaterThan(0);
  });
});
