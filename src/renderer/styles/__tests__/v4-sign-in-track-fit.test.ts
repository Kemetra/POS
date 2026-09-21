import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * 022 US1-R3 — sign-in PIN track must contain its keypad.
 *
 * ── WHAT THIS DEFENDS ─────────────────────────────────────────────────────
 *
 * The v4 sign-in rebuild's headline claim is a PERSISTENT PIN COLUMN: choosing
 * a cashier must not reflow the surface. That claim only holds if the PIN track
 * is actually wide enough to hold `.pin-pad`. If it is not, the keypad overflows
 * its panel into the roster beside it — which is the precise failure the fixed
 * track was introduced to prevent.
 *
 * jsdom computes NO layout, so every existing renderer test passes with an
 * overflowing keypad. Nothing in the suite could see this. The guard therefore
 * does the box arithmetic directly against the stylesheet.
 *
 * ── WHY THIS COMPUTES RATHER THAN ASSERTS A LITERAL ───────────────────────
 *
 * `expect(track).toBe(320)` would pass while meaning nothing: it would rot the
 * moment `--space-5` or the 64px key size changed, and it would not re-derive
 * the requirement it exists to check. So the required width is COMPUTED from
 * the same tokens the layout is built from — key size, grid gap, `.pin-pad`
 * padding, `.v4-panel` padding and border. Change any token and this test
 * re-derives the new requirement and still guards the real invariant.
 *
 * ── THE BOX CHAIN ─────────────────────────────────────────────────────────
 *
 *   .v4-columns--sign-in  PIN track (--v4-cols, 3rd value)
 *     └ aside.v4-panel    padding ×2 + border ×2
 *         └ .pin-pad      padding ×2
 *             └ .pin-pad__grid   3 × key + 2 × gap
 *
 * Checked for BOTH track declarations: the base rule and the ≤1279px override.
 * A fix applied to only one of them ships a still-broken viewport range.
 */

const CSS_PATH = resolve(__dirname, '../tailwind.css');
const css = readFileSync(CSS_PATH, 'utf-8');

/** Strip comments so the prose arithmetic in them is never parsed as CSS. */
const scrubbed = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Resolve a `--space-N` token to its pixel value from the token register. */
function spaceToken(name: string): number {
  const match = new RegExp(`--${name}:\\s*(\\d+)px`).exec(scrubbed);
  if (match === null) throw new Error(`token --${name} not found`);
  return Number(match[1]);
}

/**
 * Read a single declaration's px value out of a named rule block.
 * `var(--space-N)` is resolved through the token register.
 */
function pxDeclaration(selector: string, property: string): number {
  const rule = new RegExp(`${selector.replace(/[.\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(scrubbed);
  if (rule === null) throw new Error(`rule ${selector} not found`);
  const decl = new RegExp(`(?:^|;|\\n)\\s*${property}:\\s*([^;]+)`).exec(rule[1] ?? '');
  if (decl === null) throw new Error(`${selector} declares no ${property}`);
  const value = (decl[1] ?? '').trim();
  const direct = /^(\d+)px/.exec(value);
  if (direct !== null) return Number(direct[1]);
  const token = /var\(\s*--(space-\d+)\s*\)/.exec(value);
  if (token !== null) return spaceToken(token[1] ?? '');
  throw new Error(`${selector} ${property}: cannot resolve "${value}"`);
}

/**
 * Which grid column each sign-in region is placed in.
 *
 * Read from the `grid-column` declarations rather than assumed from source
 * order, because the two deliberately DISAGREE: the DOM is ordered by task
 * flow (pick cashier → enter PIN) while the columns are painted in the order
 * the design handoff specifies. Resolving regions positionally would silently
 * measure the wrong track the moment that placement changes — see the note on
 * `signInTrackDeclarations` below.
 */
function regionColumns(): { pin: number; rail: number; roster: number } {
  const read = (region: string): number => {
    const rule = new RegExp(
      `\\.v4-columns--sign-in\\s*>\\s*\\.v4-col--${region}\\s*\\{([^}]*)\\}`,
    ).exec(scrubbed);
    if (rule === null) throw new Error(`no placement rule for .v4-col--${region}`);
    const column = /grid-column:\s*(\d+)/.exec(rule[1] ?? '');
    if (column === null) throw new Error(`.v4-col--${region} declares no grid-column`);
    return Number(column[1]);
  };
  return { pin: read('pin'), rail: read('rail'), roster: read('roster') };
}

/**
 * Every `--v4-cols` declaration for the sign-in track, base rule and overrides,
 * with each track resolved to the REGION that occupies it.
 *
 * Tracks are matched to regions through `grid-column`, never by list position.
 * A positional read (`tracks.at(-1)` as "the PIN track") is exactly the false
 * pass this suite already shipped once: after the columns were reordered it
 * would have measured the STAFF RAIL against the keypad floor, passed at the
 * base shape, and failed at the narrow shape for an unrelated reason. Mapping
 * by declared placement survives a future reorder instead of inverting.
 */
function signInTrackDeclarations(): { cols: string; pin: number; rail: number }[] {
  const placement = regionColumns();
  const found: { cols: string; pin: number; rail: number }[] = [];
  const re = /\.v4-columns--sign-in\s*\{[^}]*?--v4-cols:\s*([^;]+);/g;
  let match = re.exec(scrubbed);
  while (match !== null) {
    const cols = (match[1] ?? '').trim();
    const tracks = cols.split(/\s+/);
    // `grid-column` is 1-based; the track list is 0-based.
    const fixedTrack = (column: number, label: string): number => {
      const raw = tracks[column - 1] ?? '';
      const px = /^(\d+)px$/.exec(raw);
      if (px === null) throw new Error(`${label} track is not a fixed px value: "${cols}"`);
      return Number(px[1]);
    };
    found.push({
      cols,
      pin: fixedTrack(placement.pin, 'PIN'),
      rail: fixedTrack(placement.rail, 'staff-code rail'),
    });
    match = re.exec(scrubbed);
  }
  return found;
}

/**
 * Minimum legible roster card width.
 *
 * A roster card is avatar + name + role on one row. The chrome (border,
 * padding, avatar, inner gaps, role) is fixed, so every pixel below this floor
 * is taken out of the NAME — the only part that distinguishes one cashier from
 * another. Ellipsising the names defeats the roster's entire purpose as the
 * primary choice on this screen.
 *
 * Asserted on CARD WIDTH rather than on residual name width on purpose: card
 * width is exactly derivable from the stylesheet, whereas a name-width
 * threshold would need a guessed glyph width for the role label and would
 * encode that guess as a hard gate.
 */
const MIN_ROSTER_CARD = 240;

/** Columns `repeat(auto-fit, minmax(Npx, 1fr))` yields in a container. */
function autoFitColumns(container: number, min: number, gap: number): number {
  return Math.max(1, Math.floor((container + gap) / (min + gap)));
}

/** Width the PIN track must have for `.pin-pad` to fit inside `.v4-panel`. */
function requiredPinTrackWidth(): number {
  const keySize = pxDeclaration('.pin-pad__key', 'inline-size');
  const gridGap = pxDeclaration('.pin-pad__grid', 'gap');
  const padPadding = pxDeclaration('.pin-pad', 'padding');
  const panelPadding = pxDeclaration('.v4-panel', 'padding');
  const keypad = keySize * 3 + gridGap * 2;
  // Both paddings apply on both sides; `.v4-panel` adds a 1px border each side.
  return keypad + padPadding * 2 + panelPadding * 2 + 2;
}

describe('022 US1-R3 — sign-in PIN track fits its keypad', () => {
  it('derives the keypad requirement from the stylesheet, not a literal', () => {
    // 3 × 64px keys + 2 × 8px gaps + 2 × 24px pad + 2 × 24px panel + 2px border.
    expect(requiredPinTrackWidth()).toBe(306);
  });

  it('declares the sign-in track at both the base and narrow breakpoints', () => {
    // Two declarations: the base rule and the ≤1279px override. If this drops to
    // one, a viewport range lost its override and the arithmetic below is blind.
    expect(signInTrackDeclarations()).toHaveLength(2);
  });

  it.each(signInTrackDeclarations())('contains the keypad at track shape "$cols"', ({ pin }) => {
    expect(pin).toBeGreaterThanOrEqual(requiredPinTrackWidth());
  });

  /**
   * The roster's usable width is decided by the two FIXED tracks beside it, not
   * by the viewport — so its column count must follow its container, not a
   * media query. A viewport breakpoint got this exactly backwards: at 1279px
   * the roster ran 2 columns, and crossing UP to 1280px added a third column at
   * the tightest container width on the whole range, so widening the window
   * made the names less readable. `auto-fit` + `minmax()` removes the
   * discontinuity by construction.
   */
  const VIEWPORTS = [1024, 1279, 1280, 1440, 1920] as const;

  it('sizes roster columns from the container, not a viewport breakpoint', () => {
    const rosterGrid = /\.roster-list__items\s*\{([^}]*)\}/.exec(scrubbed);
    if (rosterGrid === null) throw new Error('.roster-list__items rule not found');
    expect(rosterGrid[1]).toMatch(/grid-template-columns:\s*repeat\(\s*auto-fit/);
    // A rule can MATCH here and still never apply, because a textual search
    // says nothing about the at-rule enclosing it. This guard gave exactly that
    // false pass once: the roster grid matched while sitting inside a
    // `prefers-reduced-motion` block that a stray brace had left 543 lines
    // long, so it was inert for every operator without reduced motion. Assert
    // the rule is reachable unconditionally, not merely present.
    const before = scrubbed.slice(0, scrubbed.indexOf(rosterGrid[0]));
    const opens = (before.match(/\{/g) ?? []).length;
    const closes = (before.match(/\}/g) ?? []).length;
    // Exactly one level deep: `@layer components`. Any deeper means some
    // conditional at-rule encloses the roster grid and it may not apply.
    expect(opens - closes).toBe(1);
    // A viewport override would reintroduce the 1279→1280 discontinuity.
    expect(scrubbed).not.toMatch(
      /@media[^{]*\{[^}]*\.roster-list__items\s*\{[^}]*grid-template-columns/,
    );
  });

  it.each(VIEWPORTS)('keeps roster cards legible at %ipx', (viewport) => {
    const narrow = signInTrackDeclarations().at(-1);
    const base = signInTrackDeclarations().at(0);
    if (narrow === undefined || base === undefined) throw new Error('missing track declarations');
    const shape = viewport <= 1279 ? narrow : base;
    const railPx = shape.rail;

    const screenPadding = pxDeclaration('.v4-screen', 'padding');
    const columnGap = pxDeclaration('.v4-columns', 'gap');
    const panelPadding = pxDeclaration('.v4-panel', 'padding');
    const cardGap = spaceToken('space-4');

    const track = viewport - screenPadding * 2 - columnGap * 2 - railPx - shape.pin;
    const inner = track - panelPadding * 2 - 2;
    const columns = autoFitColumns(inner, MIN_ROSTER_CARD, cardGap);
    const card = (inner - cardGap * (columns - 1)) / columns;

    expect(card).toBeGreaterThanOrEqual(MIN_ROSTER_CARD);
  });

  it('keeps the roster the widest track at the 1024px viewport floor', () => {
    // The documented reason the narrow override exists: the roster carries the
    // primary choice, so it must never be out-sized by the rails beside it.
    const narrow = signInTrackDeclarations().at(-1);
    if (narrow === undefined) throw new Error('no narrow track declaration');
    const screenPadding = pxDeclaration('.v4-screen', 'padding');
    const columnGap = pxDeclaration('.v4-columns', 'gap');
    const roster = 1024 - screenPadding * 2 - columnGap * 2 - narrow.rail - narrow.pin;
    expect(roster).toBeGreaterThan(narrow.rail);
    expect(roster).toBeGreaterThan(narrow.pin);
  });

  /**
   * ── PAINT ORDER IS DECLARED, NOT INHERITED FROM SOURCE ORDER ────────────
   *
   * `<main>` carries `dir="rtl"`, so grid auto-placement paints the FIRST
   * child at the RIGHT edge. Left to auto-placement the screen renders
   * mirrored against the approved composition — the handoff warns about
   * exactly this: "Do not rely on `dir=\"rtl\"` alone to mirror the page — it
   * will produce the wrong column order."
   *
   * So DOM order and paint order deliberately disagree, and each is correct
   * for its own axis:
   *
   *   DOM   — staff-code → roster → PIN   (task flow: pick cashier, then PIN;
   *                                        this is what keyboard users get)
   *   PAINT — staff-code | roster | PIN    (handoff: rail left, PIN right)
   *
   * Explicit `grid-column` is what lets both hold at once. WCAG 2.4.3 asks
   * focus order to preserve MEANING, not to mirror pixel order — the DOM keeps
   * the meaningful sequence, so placing regions visually does not violate it.
   *
   * LIMIT OF THIS GUARD: jsdom resolves no layout and no writing mode, so no
   * test here can prove the columns actually PAINT in this order — only that
   * the placement is declared. Visual confirmation belongs to the owner
   * capture.
   */
  it('places each sign-in region explicitly rather than by RTL auto-placement', () => {
    const { rail, roster, pin } = regionColumns();
    // Under RTL, grid line 1 is the RIGHT edge. Painting rail-left/PIN-right
    // therefore means the PIN takes the FIRST track and the rail the LAST.
    expect(pin).toBe(1);
    expect(roster).toBe(2);
    expect(rail).toBe(3);
  });

  it('keeps the DOM ordered by task flow, not by paint order', () => {
    const route = readFileSync(resolve(__dirname, '../../routes/sign-in.tsx'), 'utf-8');
    const order = ['v4-col--rail', 'v4-col--roster', 'v4-col--pin'].map((c) => route.indexOf(c));
    expect(order.every((i) => i > -1)).toBe(true);
    // Ascending source positions: a cashier is chosen BEFORE the PIN is typed,
    // and keyboard traversal must follow that, whatever the paint order is.
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
