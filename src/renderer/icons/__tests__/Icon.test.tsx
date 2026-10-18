import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { FLUENT_PATHS } from '../fluent-paths';
import { Icon, ICON_SIZE_PX, type IconProps } from '../Icon';
import { ICON_NAMES, ICON_REGISTRY, assetKey, type IconGrid, type IconName } from '../registry';

/**
 * RT-692 (doc 25 IC-1) — the registry's `Icon`. The glyph is always
 * decorative: the control or the text beside it carries the meaning (§2 rule 4).
 */

afterEach(cleanup);

const PATHS: Readonly<Record<string, string>> = FLUENT_PATHS;

const SIZE_OF: Readonly<Record<IconGrid, 'sm' | 'md' | 'lg'>> = { 16: 'sm', 20: 'md', 24: 'lg' };

function draw(props: { name: IconName; size?: 'sm' | 'md' | 'lg'; selected?: boolean }) {
  const { container } = render(<Icon {...(props as IconProps<IconName>)} />);
  const svg = container.querySelector('svg');
  if (svg === null) throw new Error('no svg');
  return svg;
}

function pathsOf(svg: SVGSVGElement): string[] {
  return Array.from(svg.querySelectorAll('path')).map((p) => p.getAttribute('d') ?? '');
}

describe('Icon', () => {
  it('maps sm / md / lg to the 16 / 20 / 24 Fluent grids', () => {
    expect(ICON_SIZE_PX).toEqual({ sm: 16, md: 20, lg: 24 });
  });

  it('renders every name at every declared grid, at its native size, unscaled', () => {
    for (const name of ICON_NAMES) {
      const entry = ICON_REGISTRY[name];
      for (const grid of entry.regular) {
        const svg = draw({ name, size: SIZE_OF[grid] });
        expect(svg).toHaveAttribute('width', String(grid));
        expect(svg).toHaveAttribute('height', String(grid));
        expect(svg).toHaveAttribute('viewBox', `0 0 ${String(grid)} ${String(grid)}`);
        expect(pathsOf(svg)[0]).toBe(PATHS[assetKey(entry.asset, grid, 'regular')]);
        cleanup();
      }
    }
  });

  it('defaults to md', () => {
    const svg = draw({ name: 'search' });
    expect(svg).toHaveAttribute('width', '20');
    expect(svg).toHaveClass('rt-icon--md');
  });

  it('is decorative: aria-hidden, not focusable, no role or title', () => {
    const svg = draw({ name: 'cash' });
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).not.toHaveAttribute('role');
    expect(svg.querySelector('title')).toBeNull();
  });

  it('paints with currentColor so the control decides colour', () => {
    const svg = draw({ name: 'status.warning' });
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg).not.toHaveAttribute('stroke');
    expect(svg.querySelector('path')).not.toHaveAttribute('fill');
  });

  it('stamps the semantic name, never the vendor asset', () => {
    expect(draw({ name: 'status.neutral' })).toHaveAttribute('data-icon', 'status.neutral');
  });

  it('marks only mirrored names for the RTL flip', () => {
    for (const name of ICON_NAMES) {
      const svg = draw({ name, size: SIZE_OF[ICON_REGISTRY[name].regular[0]] });
      expect(svg.classList.contains('rt-icon--mirror'), name).toBe(
        ICON_REGISTRY[name].mirror === 'mirror',
      );
      cleanup();
    }
  });

  it('carries both audit assets and lets the direction pick one', () => {
    const svg = draw({ name: 'audit' });
    const [ltr, rtl] = Array.from(svg.querySelectorAll('path'));
    expect(ltr).toHaveClass('rt-icon__ltr');
    expect(ltr).toHaveAttribute('d', FLUENT_PATHS.clipboard_task_list_ltr_20_regular);
    expect(rtl).toHaveClass('rt-icon__rtl');
    expect(rtl).toHaveAttribute('d', FLUENT_PATHS.clipboard_task_list_rtl_20_regular);
  });

  it('draws the Filled glyph only for a selected slim-rail entry', () => {
    const regular = draw({ name: 'dashboard' });
    expect(pathsOf(regular)).toEqual([FLUENT_PATHS.grid_20_regular]);
    cleanup();
    const selected = draw({ name: 'dashboard', selected: true });
    expect(pathsOf(selected)).toEqual([FLUENT_PATHS.grid_20_filled]);
    expect(selected).toHaveClass('rt-icon--selected');
    cleanup();
    expect(pathsOf(draw({ name: 'audit', selected: true }))).toEqual([
      FLUENT_PATHS.clipboard_task_list_ltr_20_filled,
      FLUENT_PATHS.clipboard_task_list_rtl_20_filled,
    ]);
  });

  it('refuses a grid or style the registry does not declare', () => {
    expect(() => draw({ name: 'close', size: 'lg' })).toThrow(/close.*24.*regular/);
    expect(() => draw({ name: 'search', selected: true })).toThrow(/search.*20.*filled/);
  });
});

describe('icons.css', () => {
  const css = readFileSync(resolve(__dirname, '../icons.css'), 'utf-8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('takes direction from the nearest dir attribute, inherited', () => {
    expect(css).toMatch(/\[dir='rtl' i\]\s*\{[^}]*--rt-icon-flip:\s*-1/);
    expect(css).toMatch(/\[dir='ltr' i\]\s*\{[^}]*--rt-icon-flip:\s*1;/);
    expect(css).toMatch(
      /\.rt-icon--mirror\s*\{[^}]*transform:\s*scaleX\(var\(--rt-icon-flip, 1\)\)/,
    );
  });

  it('never uses :dir(), which the build lowers to :lang(), or a [dir] ancestor selector', () => {
    expect(css).not.toMatch(/:dir\(/);
    expect(css).not.toMatch(/\[dir[^\]]*\]\s+[.\w]/);
  });

  it('shows the LTR audit asset unless an RTL direction says otherwise', () => {
    expect(css).toMatch(/\.rt-icon__ltr\s*\{[^}]*display:\s*var\(--rt-icon-ltr, inline\)/);
    expect(css).toMatch(/\.rt-icon__rtl\s*\{[^}]*display:\s*var\(--rt-icon-rtl, none\)/);
    expect(css).toMatch(
      /\[dir='rtl' i\]\s*\{[^}]*--rt-icon-ltr:\s*none;[^}]*--rt-icon-rtl:\s*inline/,
    );
  });

  it('leaves forced colours to the system', () => {
    expect(css).not.toMatch(/forced-color-adjust/);
  });
});

/** Compile-time contract (never called): `npm run typecheck` fails if these stop erroring. */
export function typeContract(): JSX.Element[] {
  return [
    <Icon key="a" name="search" />,
    <Icon key="b" name="lock" size="lg" />,
    <Icon key="c" name="dashboard" selected />,
    // @ts-expect-error close declares no md grid, so the size must be given.
    <Icon key="d" name="close" />,
    // @ts-expect-error close declares no lg grid.
    <Icon key="e" name="close" size="lg" />,
    // @ts-expect-error search declares no Filled glyph.
    <Icon key="f" name="search" selected />,
    // @ts-expect-error the brand cross is not a registry icon (D-263-7).
    <Icon key="g" name="cross" />,
  ];
}
