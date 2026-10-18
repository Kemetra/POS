/**
 * RT-692 (doc 25 IC-1) — the semantic icon registry. Product code names an
 * icon by its meaning; only this module maps a meaning to a vendored Fluent
 * Regular glyph (`fluent-paths.ts`). doc 25 §3 is the canonical name table.
 *
 * - `mirror` is the product's RTL rule, not the vendor's: `never` stays as
 *   drawn, `mirror` flips in an RTL run, `variant` swaps to `rtlAsset`.
 * - `regular` / `filled` list only the grids a call site uses, since every
 *   declared variant ships (doc 25 §6). Filled is for the selected slim-rail
 *   nav entry only (D-263-8).
 * - Names with no POS call site yet (doc 25 §3 Admin-only and reserved rows)
 *   join with the slice that first renders them.
 */

export type IconGrid = 16 | 20 | 24;
export type IconMirror = 'never' | 'mirror' | 'variant';

interface IconEntry {
  /** Fluent asset name, without grid and style. */
  readonly asset: string;
  /** The separate Fluent RTL asset of a `variant` entry. */
  readonly rtlAsset?: string;
  readonly mirror: IconMirror;
  readonly regular: readonly IconGrid[];
  readonly filled?: readonly IconGrid[];
}

export const ICON_REGISTRY = {
  // Actions
  search: { asset: 'search', mirror: 'never', regular: [20] },
  scan: { asset: 'barcode_scanner', mirror: 'never', regular: [20, 24] },
  add: { asset: 'add', mirror: 'never', regular: [20] },
  remove: { asset: 'subtract', mirror: 'never', regular: [20] },
  close: { asset: 'dismiss', mirror: 'never', regular: [16] },
  confirm: { asset: 'checkmark', mirror: 'never', regular: [16] },
  // Keypads stay LTR, so backspace never flips (DESIGN.md).
  backspace: { asset: 'backspace', mirror: 'never', regular: [24] },
  retry: { asset: 'arrow_clockwise', mirror: 'never', regular: [16, 20] },
  park: { asset: 'pause', mirror: 'never', regular: [20] },
  print: { asset: 'print', mirror: 'never', regular: [20] },
  lock: { asset: 'lock_closed', mirror: 'never', regular: [16, 20, 24] },
  key: { asset: 'key', mirror: 'never', regular: [20] },
  pair: { asset: 'link', mirror: 'never', regular: [24] },
  // Direction: back and forward follow reading direction.
  forward: { asset: 'arrow_right', mirror: 'mirror', regular: [24] },
  back: { asset: 'arrow_left', mirror: 'mirror', regular: [20] },
  increase: { asset: 'arrow_up', mirror: 'never', regular: [16] },
  decrease: { asset: 'arrow_down', mirror: 'never', regular: [16] },
  // Status: each tone keeps its own shape, never colour alone (P8).
  'status.info': { asset: 'info', mirror: 'never', regular: [16, 20] },
  'status.success': { asset: 'checkmark_circle', mirror: 'never', regular: [16, 20] },
  'status.warning': { asset: 'warning', mirror: 'never', regular: [16, 20] },
  'status.danger': { asset: 'dismiss_circle', mirror: 'never', regular: [16, 20] },
  'status.unknown': { asset: 'question_circle', mirror: 'never', regular: [16] },
  'status.neutral': { asset: 'subtract_circle', mirror: 'never', regular: [16, 20] },
  // Domain
  dashboard: { asset: 'grid', mirror: 'never', regular: [20], filled: [20] },
  cart: { asset: 'cart', mirror: 'never', regular: [20], filled: [20] },
  sale: { asset: 'receipt', mirror: 'never', regular: [20], filled: [20] },
  return: { asset: 'arrow_hook_up_left', mirror: 'mirror', regular: [20], filled: [20] },
  audit: {
    asset: 'clipboard_task_list_ltr',
    rtlAsset: 'clipboard_task_list_rtl',
    mirror: 'variant',
    regular: [20],
    filled: [20],
  },
  inventory: { asset: 'box', mirror: 'never', regular: [20], filled: [20] },
  settings: { asset: 'settings', mirror: 'never', regular: [20], filled: [20] },
  cash: { asset: 'money', mirror: 'never', regular: [16, 20] },
  card: { asset: 'payment', mirror: 'never', regular: [20] },
  voucher: { asset: 'ticket_diagonal', mirror: 'never', regular: [20] },
  terminal: { asset: 'desktop', mirror: 'never', regular: [24] },
  shift: { asset: 'clock', mirror: 'never', regular: [16, 20] },
  stuckShift: { asset: 'clock_pause', mirror: 'never', regular: [20] },
  held: { asset: 'pause_circle', mirror: 'never', regular: [20] },
  people: { asset: 'people', mirror: 'never', regular: [20] },
} as const satisfies Readonly<Record<string, IconEntry>>;

export type IconName = keyof typeof ICON_REGISTRY;

export const ICON_NAMES = Object.keys(ICON_REGISTRY) as readonly IconName[];

/** The vendored key of one Fluent asset: its upstream file stem. */
export function assetKey(asset: string, grid: IconGrid, style: 'regular' | 'filled'): string {
  return `${asset}_${String(grid)}_${style}`;
}
