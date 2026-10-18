import type { JSX } from 'react';
import { FLUENT_PATHS } from './fluent-paths';
import { ICON_REGISTRY, assetKey, type IconGrid, type IconName } from './registry';
import './icons.css';

/** The Fluent optical grids (doc 25 §2 rule 7): a glyph is never scaled between them. */
export const ICON_SIZE_PX = { sm: 16, md: 20, lg: 24 } as const;
export type IconSize = keyof typeof ICON_SIZE_PX;

type Entry<N extends IconName> = (typeof ICON_REGISTRY)[N];
type GridOf<N extends IconName> = Entry<N>['regular'][number];
type SizeFor<N extends IconName> = {
  [S in IconSize]: (typeof ICON_SIZE_PX)[S] extends GridOf<N> ? S : never;
}[IconSize];

/** `size` may be left out only when the name declares the default `md` grid. */
type SizeProp<N extends IconName> =
  20 extends GridOf<N> ? { readonly size?: SizeFor<N> } : { readonly size: SizeFor<N> };

/** `selected` exists only on names that declare a Filled glyph (D-263-8). */
type SelectedProp<N extends IconName> =
  Entry<N> extends { filled: readonly IconGrid[] }
    ? { readonly selected?: boolean }
    : { readonly selected?: never };

export type IconProps<N extends IconName> = { readonly name: N } & SizeProp<N> & SelectedProp<N>;

type Style = 'regular' | 'filled';

const PATHS: Readonly<Record<string, string | undefined>> = FLUENT_PATHS;

function pathOf(name: IconName, asset: string, grid: IconGrid, style: Style): string {
  const d = PATHS[assetKey(asset, grid, style)];
  // The types rule this out; a cast that slips past them fails loudly in tests.
  if (d === undefined) throw new Error(`icon "${name}" declares no ${String(grid)} ${style} glyph`);
  return d;
}

/**
 * RT-692 (doc 25 IC-1) — one registry glyph. Always decorative: the control
 * or the text beside it carries the meaning, never the `<svg>` (§2 rule 4).
 * Colour comes from `currentColor`; direction comes from the nearest `dir`
 * attribute through `icons.css`, never from the call site.
 */
export function Icon<N extends IconName>(props: IconProps<N>): JSX.Element {
  const { name } = props;
  const size: IconSize = props.size ?? 'md';
  const selected = props.selected === true;
  const entry: Entry<IconName> = ICON_REGISTRY[name];
  const grid = ICON_SIZE_PX[size];
  const style: Style = selected ? 'filled' : 'regular';
  const d = pathOf(name, entry.asset, grid, style);
  const classes = ['rt-icon', `rt-icon--${size}`];
  if (entry.mirror === 'mirror') classes.push('rt-icon--mirror');
  if (selected) classes.push('rt-icon--selected');

  return (
    <svg
      className={classes.join(' ')}
      data-icon={name}
      width={grid}
      height={grid}
      viewBox={`0 0 ${String(grid)} ${String(grid)}`}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {'rtlAsset' in entry ? (
        <>
          <path className="rt-icon__ltr" d={d} />
          <path className="rt-icon__rtl" d={pathOf(name, entry.rtlAsset, grid, style)} />
        </>
      ) : (
        <path d={d} />
      )}
    </svg>
  );
}
