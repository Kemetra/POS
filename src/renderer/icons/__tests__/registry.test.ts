import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FLUENT_PATHS } from '../fluent-paths';
import { ICON_NAMES, ICON_REGISTRY, assetKey, type IconGrid, type IconName } from '../registry';

/**
 * RT-692 (doc 25 IC-1) — the semantic icon registry. Names are meanings, the
 * registry alone maps them to vendored Fluent Regular glyphs, it owns RTL
 * mirroring, and it declares only the grids its call sites use.
 */

/** Doc 25 §3: each former `V5Icon` key (bar the brand `cross`) and the name it became. */
const FROM_V5: Readonly<Record<string, IconName>> = {
  search: 'search',
  scan: 'scan',
  plus: 'add',
  minus: 'remove',
  close: 'close',
  check: 'confirm',
  backspace: 'backspace',
  retry: 'retry',
  pause: 'park',
  printer: 'print',
  lock: 'lock',
  key: 'key',
  link: 'pair',
  forward: 'forward',
  back: 'back',
  'arrow-up': 'increase',
  'arrow-down': 'decrease',
  'status-info': 'status.info',
  'status-success': 'status.success',
  'status-warning': 'status.warning',
  'status-danger': 'status.danger',
  'status-unknown': 'status.unknown',
  dash: 'status.neutral',
  'nav-dashboard': 'dashboard',
  'nav-cart': 'cart',
  'nav-sales': 'sale',
  'nav-returns': 'return',
  'nav-audit': 'audit',
  'nav-inventory': 'inventory',
  'nav-settings': 'settings',
  'tender-cash': 'cash',
  'tender-card': 'card',
  'tender-voucher': 'voucher',
  terminal: 'terminal',
  'manager-shift': 'shift',
  'manager-cashiers': 'people',
  'manager-held': 'held',
  'manager-stuck': 'stuckShift',
};

/** Doc 25 §3, RTL column: only direction-implying meanings mirror. */
const MIRRORED: readonly IconName[] = ['forward', 'back', 'return'];
const VARIANT: readonly IconName[] = ['audit'];

/** D-263-8: Filled only for the selected slim-rail nav entry. */
const SLIM_RAIL: readonly IconName[] = [
  'dashboard',
  'cart',
  'sale',
  'return',
  'audit',
  'inventory',
  'settings',
];

/** Production renderer sources, outside the registry module itself. */
function consumerSources(): string[] {
  const renderer = resolve(__dirname, '../..');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && path !== resolve(renderer, 'icons')) walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(readFileSync(path, 'utf-8'));
      }
    }
  };
  walk(renderer);
  return out;
}

describe('icon registry names', () => {
  it('replaces every former V5Icon glyph except the brand cross, one meaning each', () => {
    // RT-695 (IC-2) deleted V5Icon; FROM_V5 keeps its 38 non-brand keys as the record.
    expect(existsSync(resolve(__dirname, '../../v5/foundation/V5Icon.tsx'))).toBe(false);
    expect(Object.keys(FROM_V5)).toHaveLength(38);
    expect([...ICON_NAMES].sort()).toEqual([...new Set(Object.values(FROM_V5))].sort());
  });

  it('declares no name that no renderer call site uses (doc 25 §6)', () => {
    const source = consumerSources().join('\n');
    for (const name of ICON_NAMES) {
      expect(source, name).toMatch(new RegExp(`['"\`]${name.replace('.', '\\.')}['"\`]`));
    }
  });

  it('names meanings, never screens, shapes or the vendor', () => {
    for (const name of ICON_NAMES) {
      expect(name).toMatch(/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)?$/);
      expect(name).not.toMatch(/^(nav|tender|manager)-|fluent|arrow|chevron|^dash$|^cross$/i);
    }
  });

  it('keeps the brand cross out of the registry (D-263-7)', () => {
    expect(ICON_NAMES).not.toContain('cross');
  });
});

describe('icon registry RTL rules (D-263-4)', () => {
  it('mirrors only direction-implying meanings', () => {
    const mirrored = ICON_NAMES.filter((n) => ICON_REGISTRY[n].mirror === 'mirror');
    expect([...mirrored].sort()).toEqual([...MIRRORED].sort());
  });

  it('serves the audit list from its separate Fluent LTR and RTL assets', () => {
    const variants = ICON_NAMES.filter((n) => ICON_REGISTRY[n].mirror === 'variant');
    expect(variants).toEqual(VARIANT);
    expect(ICON_REGISTRY.audit).toMatchObject({
      asset: 'clipboard_task_list_ltr',
      rtlAsset: 'clipboard_task_list_rtl',
    });
  });

  it('never flips search, scan, print, lock, clock or check (DESIGN.md)', () => {
    for (const name of ['search', 'scan', 'print', 'lock', 'shift', 'confirm'] as const) {
      expect(ICON_REGISTRY[name].mirror).toBe('never');
    }
  });

  it('gives only a variant entry an RTL asset', () => {
    for (const name of ICON_NAMES) {
      const entry = ICON_REGISTRY[name];
      expect('rtlAsset' in entry).toBe(entry.mirror === 'variant');
    }
  });
});

describe('icon registry grids (doc 25 §2 rule 7, §6)', () => {
  it('declares only the Fluent optical grids, at least one per name', () => {
    for (const name of ICON_NAMES) {
      const { regular } = ICON_REGISTRY[name];
      expect(regular.length).toBeGreaterThan(0);
      for (const grid of regular) expect([16, 20, 24]).toContain(grid);
      expect(new Set(regular).size).toBe(regular.length);
    }
  });

  it('declares Filled only for the slim-rail nav entries, at 20 (D-263-8)', () => {
    const filled = ICON_NAMES.filter((n) => 'filled' in ICON_REGISTRY[n]);
    expect([...filled].sort()).toEqual([...SLIM_RAIL].sort());
    for (const name of SLIM_RAIL) expect(ICON_REGISTRY[name]).toMatchObject({ filled: [20] });
  });

  it('has vendored path data for every declared grid and style', () => {
    for (const key of declaredAssetKeys()) {
      expect(FLUENT_PATHS[key as keyof typeof FLUENT_PATHS], key).toMatch(/^[Mm][\d.\s,a-zA-Z-]+$/);
    }
  });

  it('vendors nothing the registry does not declare', () => {
    expect(Object.keys(FLUENT_PATHS).sort()).toEqual([...declaredAssetKeys()].sort());
  });
});

/** Every vendored key the registry declares: asset(s) × declared grids × style. */
function declaredAssetKeys(): Set<string> {
  return new Set(ICON_NAMES.flatMap((name) => entryAssetKeys(ICON_REGISTRY[name])));
}

function entryAssetKeys(entry: (typeof ICON_REGISTRY)[IconName]): string[] {
  const assets = 'rtlAsset' in entry ? [entry.asset, entry.rtlAsset] : [entry.asset];
  const filled: readonly IconGrid[] = 'filled' in entry ? entry.filled : [];
  return assets.flatMap((asset) => [
    ...entry.regular.map((grid) => assetKey(asset, grid, 'regular')),
    ...filled.map((grid) => assetKey(asset, grid, 'filled')),
  ]);
}

describe('Fluent licence (doc 25 §5)', () => {
  const root = resolve(__dirname, '../../../..');

  it('keeps the MIT notice file next to the registry', () => {
    const notice = readFileSync(
      resolve(__dirname, '../LICENSE-fluentui-system-icons.txt'),
      'utf-8',
    );
    expect(notice).toContain('MIT License');
    expect(notice).toContain('Copyright (c) 2020 Microsoft Corporation');
    expect(notice).toContain(
      'The above copyright notice and this permission notice shall be included in all',
    );
  });

  it('lists Fluent in the shipped NOTICE', () => {
    const notice = readFileSync(resolve(root, 'NOTICE'), 'utf-8');
    expect(notice).toContain('Fluent UI System Icons');
    expect(notice).toContain('Copyright (c) 2020 Microsoft Corporation');
    expect(notice).toContain('MIT');
  });

  it('opens the vendored data with a legal comment the minifier keeps', () => {
    const source = readFileSync(resolve(__dirname, '../fluent-paths.ts'), 'utf-8');
    expect(source.startsWith('/*!')).toBe(true);
    const header = source.slice(0, source.indexOf('*/'));
    expect(header).toContain('@license MIT');
    expect(header).toContain('Copyright (c) 2020 Microsoft Corporation');
    expect(header).toContain('@fluentui/svg-icons 1.1.344');
  });

  it('keeps legal comments through the renderer minifier, which strips them by default', () => {
    const config = readFileSync(resolve(root, 'vite.config.ts'), 'utf-8');
    expect(config).toMatch(/output:\s*\{\s*comments:\s*\{\s*legal:\s*true\s*\}/);
  });
});
