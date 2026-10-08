/**
 * RT-217 — a minimal block-YAML outline reader (no YAML dependency).
 *
 * It turns block-style YAML into a tree of key / list-item nodes by indentation.
 * Prose in block scalars is always indented deeper than its key, so it can only
 * ever become descendants of that key; callers navigate known keys only and never
 * read prose as structure. Flow collections are kept as raw scalar text.
 */

export interface SourceText {
  /** Name used in error messages. */
  readonly name: string;
  readonly text: string;
}

export interface YamlLine {
  readonly no: number;
  readonly indent: number;
  readonly text: string;
}

export interface YamlNode {
  readonly line: YamlLine;
  /** `true` for a `- …` list item. */
  readonly item: boolean;
  /** Mapping key, or `null` for a list item that is a bare scalar such as `{}`. */
  readonly key: string | null;
  /** Inline scalar after the key (comments stripped, quotes removed); `''` if none. */
  readonly value: string;
  readonly children: YamlNode[];
}

const KEY_VALUE = /^("[^"]*"|'[^']*'|[^\s:#][^:#]*?):(?:\s+(.*))?$/;
const QUOTED = /^(["'])(.*)\1$/;
const TRAILING_COMMENT = /\s+#.*$/;

const unquote = (scalar: { readonly raw: string }): string => {
  const trimmed = scalar.raw.trim();
  return QUOTED.exec(trimmed)?.[2] ?? trimmed;
};

function toLine(raw: { readonly text: string; readonly no: number }): YamlLine | null {
  const trimmed = raw.text.trimEnd();
  const text = trimmed.trimStart();
  if (text === '' || text.startsWith('#')) return null;
  return { no: raw.no, indent: trimmed.length - text.length, text };
}

export function toLines(source: SourceText): YamlLine[] {
  return source.text
    .split(/\r?\n/)
    .map((text, i) => toLine({ text, no: i + 1 }))
    .filter((line): line is YamlLine => line !== null);
}

function toNode(line: YamlLine): YamlNode {
  const item = line.text.startsWith('- ');
  const body = item ? line.text.slice(2).trim() : line.text;
  const match = KEY_VALUE.exec(body);
  if (match === null) return { line, item, key: null, value: body, children: [] };
  const rawValue = (match[2] ?? '').replace(TRAILING_COMMENT, '');
  return {
    line,
    item,
    key: unquote({ raw: match[1] as string }),
    value: unquote({ raw: rawValue }),
    children: [],
  };
}

/** A list item at the same indent as an open `key:` belongs to that key (YAML compact list). */
function opensCompactList(parent: YamlNode, child: YamlNode): boolean {
  return child.item && !parent.item && parent.value === '';
}

function isParentOf(parent: YamlNode, child: YamlNode): boolean {
  if (parent.line.indent < child.line.indent) return true;
  return parent.line.indent === child.line.indent && opensCompactList(parent, child);
}

/** Build the outline. The returned root is a synthetic node at indent -1. */
export function buildTree(source: SourceText): YamlNode {
  const root: YamlNode = {
    line: { no: 0, indent: -1, text: '' },
    item: false,
    key: null,
    value: '',
    children: [],
  };
  const stack: YamlNode[] = [root];
  for (const line of toLines(source)) {
    const node = toNode(line);
    while (!isParentOf(stack[stack.length - 1] as YamlNode, node)) stack.pop();
    (stack[stack.length - 1] as YamlNode).children.push(node);
    stack.push(node);
  }
  return root;
}

/** The first child mapping key named `key`, if any. */
export function child(node: YamlNode, key: string): YamlNode | undefined {
  return node.children.find((c) => !c.item && c.key === key);
}
