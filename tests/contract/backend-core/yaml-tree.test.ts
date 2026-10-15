/**
 * RT-217 — the block-YAML outline reader behind the conformance suite.
 */
import { describe, expect, it } from 'vitest';
import { buildTree, child, type YamlNode } from './yaml-tree.js';

function only(text: string): { key: string | null; value: string } {
  const node = buildTree({ name: 'x.yaml', text }).children[0];
  if (node === undefined) throw new Error('no node');
  return { key: node.key, value: node.value };
}

describe('yaml-tree', () => {
  it.each([
    ['key: value', 'key', 'value'],
    ['key:    spaced value', 'key', 'spaced value'],
    ['key:\tvalue', 'key', 'value'],
    ['key:', 'key', ''],
    ['key: value # comment', 'key', 'value'],
    ['key: value    # comment', 'key', 'value'],
    ['key:     value  # comment', 'key', 'value'],
    ['key: a#b', 'key', 'a#b'],
    ['"quoted key": "quoted value"   # comment', 'quoted key', 'quoted value'],
    ["'k': 'v' # c", 'k', 'v'],
    ['key:value', null, 'key:value'],
    ['just words', null, 'just words'],
  ])('reads %j', (text, key, value) => {
    expect(only(text)).toEqual({ key, value });
  });

  it('nests by indentation and opens compact lists', () => {
    const root = buildTree({
      name: 'x.yaml',
      text: 'paths:\n  /a:\n    get: {}\ntags:\n- name: t\n',
    });
    const paths = child(root, 'paths') as YamlNode;
    expect(paths.children.map((c) => c.key)).toEqual(['/a']);
    expect(child(paths, '/a')?.children[0]).toMatchObject({ key: 'get', value: '{}' });
    expect(child(root, 'tags')?.children[0]).toMatchObject({ item: true, key: 'name', value: 't' });
  });
});
