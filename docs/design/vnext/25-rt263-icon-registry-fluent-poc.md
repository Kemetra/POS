# RT-263 — Semantic icon registry and the Fluent System Icons fit / licence / bundle PoC (UX-03)

> **Work Mode: Planning.** Jira **RT-263** (parent RT-2, related RT-106). Docs only: no production
> code, no dependency, no `package.json` or lockfile change, nothing written to Admin-Console.
> Each slice in §8 needs its own bounded Jira issue before any implementation.
>
> **Decisions:** D-263-1 … D-263-9 (§7) are **Selected — recommended option, chosen by the
> coordinator under the owner's standing delegation of 2026-10-17; owner may revisit.** The
> visual judgments (D-263-1 visual fit, D-263-5 stroke weight, D-263-8 filled-on-selected) were
> **approved by the owner on 2026-10-20** (RT-263 comment 13139).
>
> **Baselines.** `Kemetra/POS` `origin/main` = `4b8b25ba7f22b633449892176cde6d255beeb735` (RT-672,
> #750). `Kemetra/Admin-Console` `main` = `909a71446e39a6c97573e391bfa0cfb0e657d0f0` (RT-677, #133),
> read-only clone. Measured on 2026-10-17 with `@fluentui/react-icons` **2.0.344** and
> `@fluentui/svg-icons` **1.1.344**. Both were installed in a throwaway scratch directory outside
> both repositories.
>
> **Authorities read.** Confluence RETAIL _UX/UI Constitution — UX-03 Typography & Iconography_
> (page 22839299, owner-approved 2026-10-07); POS [`docs/DESIGN.md`](../../DESIGN.md) (RT-104
> VNext) and `.impeccable/design.json`; Admin-Console `DESIGN.md` §4 (RT-265 rebaseline); docs
> [04](04-design-language.md) and [15](15-vnext-freeze-package.md) of this package.
>
> **Companion preview:** [25-rt263-icon-candidates.html](25-rt263-icon-candidates.html). It is a
> static page with no dependency. It shows every registry name with today's POS and Admin glyphs,
> the Fluent Regular glyph at 16, 20 and 24, Filled 20 on the Teal Wash, and the RTL rule applied.

## 0. Summary

- **Inventory.** Neither repository depends on an icon library today. Both use one closed,
  hand-drawn set of inline-SVG stroke glyphs (24 grid, 1.75 stroke, `currentColor`):
  - **POS:** `V5Icon` has 39 glyphs and 32 consumer files. There are also one stray `SearchGlyph`
    component and three live text glyphs. A DEV-only static proof has four more.
  - **Admin:** `Icon` has 17 glyphs. There are also two one-off inline SVGs and three text glyphs.
  - Each repository also has one brand mark.
- **Fit.** Fluent System Icons has a glyph for every concept in use today and for the six
  concepts that UX-03 names. The registry has 53 names (§3).
  - Licence: **MIT, © 2020 Microsoft Corporation**, verified from the upstream `LICENSE` (§5).
  - RTL: the upstream metadata cannot express this product's "RTL follows meaning" rule for arrows.
    The registry has to own mirroring (§4.2).
  - Weight: Fluent Regular is a lighter line than today's set, about 1.0px against 1.46px at 20px
    (§4.3). That is the main visual question.
- **Bundle (§6).** For the 47 distinct Fluent glyphs in use, at one size (20 Regular):
  - Vendored path data: **5.9 KB gzip**.
  - The library's headless per-icon ESM imports: **7.1 KB + 1.1 KB CSS**.
  - The default Griffel API: **9.6 KB**, because it pulls a CSS-in-JS runtime.
  - Icon fonts: **382–817 KB per face**, with no tree-shaking.

  That 20-Regular set is the **floor**. The complete registry as proposed has every Regular grid
  (16/20/24) plus Filled 20/24 for the seven slim-rail entries. It costs **17.8 KB gzip** vendored,
  against **19.1 KB** headless. Today's set is 1.5 KB. The npm package is **174 MB unpacked**.
- **Recommendation.** Adopt Fluent Regular as the single glyph source. Ship it as **vendored path
  data inside a semantic registry module in each repository**, with the MIT notice. Add **no npm
  dependency**, so no dependency decision is needed.
- **Migration.** Four bounded slices. IC-1 builds the POS registry with no visual change. IC-2
  moves POS onto it. IC-3 does the same for Admin. IC-4 records the decision in Confluence (§8).

## 1. Inventory — icons in use today

### 1.1 POS renderer (`src/renderer/**`, excluding tests)

| Source | What | Count |
|---|---|---|
| `v5/foundation/V5Icon.tsx` | Closed map `PATHS` → one `<path>`, 24 grid, stroke 1.75 (`cross` uses 3), `currentColor`, always `aria-hidden` | **39 glyphs**, used in **32 files**: 19 keys with literal `name="…"`, the rest through typed maps (`NAV_ICON`, `MARK`, `BADGE_GLYPH`, `STATE_ICON`, tender tiles, manager tiles, `ToneIcon`'s `status-${tone}`) |
| `v5/manager/honest/SearchGlyph.tsx` | A second magnifier, drawn differently from `V5Icon` `search` | 1 |
| Text glyphs (live) | `v5/checkout/CashKeypad.tsx:80` `⌫`; `scan/ScanGuardHost.tsx:101` `!` (the scan-notice warning mark, mounted on every route by `App.tsx`); legacy `ui/payments/VoucherEntry.tsx:204` `✓` | 3 |
| Text glyphs (DEV-only static proof) | `v5/sale/SaleCart.tsx` `−` `＋` `←`; `v5/sale/ProductRail.tsx` `＋` `⌕`; `v5/sale/SaleScreen.tsx` `✚` (brand). Reached only via `#/dev/sale-proof`, which Vite strips from builds (`main.tsx:24-37`) | 6 (not shipped) |
| Brand | `V5Icon` `cross`: the pharmacy cross in the nav and the entry strip | 1 (brand, not an icon) |
| Library dependency | none | 0 |

The 39 `V5Icon` keys:

- **Actions:** `search`, `scan`, `minus`, `plus`, `close`, `check`, `backspace`, `retry`, `pause`,
  `printer`, `lock`, `key`, `link`.
- **Direction:** `forward`, `back`, `arrow-up`, `arrow-down`.
- **Status:** `status-info`, `-success`, `-warning`, `-danger`, `-unknown`, `dash`.
- **Navigation:** `nav-dashboard`, `-cart`, `-sales`, `-returns`, `-audit`, `-inventory`,
  `-settings`.
- **Tenders:** `tender-cash`, `-card`, `-voucher`.
- **Entry:** `terminal`.
- **Manager:** `manager-shift`, `-cashiers`, `-held`, `-stuck`.
- **Brand:** `cross`.

Two tests and styles depend on the current shape:

- `ToneIcon` and `Banner` stamp `data-icon={tone|icon}`, and `legacy-banners-v5.test.tsx` asserts
  `[data-icon="printer"]`.
- Several stylesheets target `.v5-icon`: `park.css`, `entry.css`, `live-sale.css`. A migration has
  to keep both, or move them in the same slice.

### 1.2 Admin-Console (`src/**`, excluding tests)

| Source | What | Count |
|---|---|---|
| `components/Icon.tsx` | Closed map → fragments, 24 grid, stroke 1.75, decorative unless `title` (then `role="img"` + `<title>`) | **17 glyphs**: `overview`, `tenants`, `stores`, `operators`, `audit`, `catalog`, `unknown`, `stock`, `cash`, `connection`, `device`, `receipt`, `search`, `bell`, `help`, `sign-out`, `chevron`. Used in 3 files (the `AppShell` nav maps, `AuditFilters`, `UnknownItemList`) |
| Inline one-offs | `auth/NoAccess.tsx` (a lock, stroke 1.5), `shell/ScopeHeader.tsx` (the scope caret) | 2 |
| Text glyphs | `components/BackArrow.tsx` `←` (CSS-mirrored, used in 7 files); `components/Drawer.tsx` `✕`; `shell/ScopeHeader.tsx` `✓` | 3 |
| Typography, not icons | `shell/ScopeHeader.tsx` `›` breadcrumb separator (Bidi_Mirrored, RT-266 §2.1); quantity `×` in POS rows | stays text |
| Brand | `components/TowerMark.tsx` | 1 (brand, not an icon) |
| Library dependency | none (`package.json` has no icon package) | 0 |

Admin `DESIGN.md` §4 already names Fluent as the leading family. It says "pending … RT-263", and
`src/components/Icon.tsx` stays until then.

### 1.3 What the inventory shows

- Both sets already follow the registry idea: a closed, typed name map, `currentColor`, and
  decorative by default. So the migration swaps the **source of the glyphs** and the **names**. It
  does not change the component model.
- Nine concepts are drawn twice, once per repository, with different geometry:
  - search, cash, receipt/sale, audit, inventory/stock, people, terminal/device, dashboard/overview;
  - lock (POS `lock` vs Admin NoAccess).

  One shared registry removes that drift.
- POS names mix three schemes: by **screen** (`nav-sales`, `manager-held`), by **shape** (`dash`,
  `cross`) and by **meaning** (`status-*`). UX-03 asks for meaning only.

## 2. Registry rules (aligned with UX-03, POS `DESIGN.md`, Admin `DESIGN.md` §4)

1. **Names are meanings, never shapes or vendor names.** Use `icon.<concept>`, with one level of
   grouping for status (`icon.status.warning`). Product code never imports a vendor name. Only the
   registry module maps a name to a glyph.
2. **One grammar.** Fluent Regular is the only glyph source. Filled is allowed only through an
   explicit `selected` variant for a persistent selected state (UX-03 "Regular by default"). No
   other family appears in product UI. Brand marks are not registry icons:
   - POS pharmacy cross;
   - Admin `TowerMark`.
3. **Icons reinforce; text decides.** An icon never carries meaning alone.
   - Financial, destructive and recovery actions always show their text label. These include pay,
     void, return, payout, cash-up, sign-out, delete and retry-a-payment.
   - Icon-only controls are allowed only for universal, non-financial actions: close a dialog,
     clear a search, the keypad backspace, quantity ± in a row that is already labelled. Each one
     needs an accessible name on the **control**.
4. **Accessibility labelling.**
   - The glyph is always `aria-hidden="true"` and `focusable="false"`.
   - The accessible name lives on the control or on adjacent text, never on the `<svg>`.
   - Admin's `title` prop (svg `role="img"`) is retired. A standalone informative icon (rare) is
     wrapped in an element that has a visually hidden text sibling. This keeps one rule for both
     products and matches the existing POS contract.
5. **Colour.**
   - `fill="currentColor"`, so status and interaction tokens decide colour (UX-03 "semantic colour
     ownership").
   - No `forced-color-adjust: none` on icons. Under `forced-colors: active` they take
     `CanvasText` / `ButtonText` / `HighlightText` from their control.
   - Status glyphs keep a distinct shape per tone (P8 "never colour alone"):
     - info ⓘ;
     - success ✓○;
     - warning △;
     - danger ✕○;
     - unknown ?○;
     - neutral –○.
6. **RTL follows meaning** (§4.2). Each registry entry carries `mirror: 'never' | 'mirror' |
   'variant'`. Direction comes from the document (`:dir(rtl)`). It is never hard-coded per call
   site.
7. **Sizes are the Fluent optical grids: `sm` 16, `md` 20 (default), `lg` 24.**
   - Map today's ad hoc sizes as follows: 14 → 16, 18 → 20, 26 → 24.
   - A glyph renders at its native grid and is never scaled between grids. A thin 16-grid line
     blown up to 26px is the thing to avoid.
   - Larger "outcome" icons (doc 04 outcome panel) use `lg` inside a sized container. The glyph is
     not scaled.
8. **No decorative icon tiles** unless the surface is a real launcher. This applies to the manager
   home cards (G-6) and the tender tiles (UX-03).

Proposed API (same shape in both repositories; illustrative, not code to merge):

```ts
type IconName = 'search' | 'scan' | … ;          // the §3 names without the "icon." prefix
<Icon name="return" size="md" />                  // decorative; text label beside it
<Icon name="dashboard" selected />                // Filled glyph, only for a persistent selected state
```

Internally `REGISTRY[name] = { regular: {16?, 20, 24}, filled?: {20, 24}, mirror, source }`. Here
`source` is the Fluent asset name and package version, kept for provenance and licence audit.

## 3. The registry — semantic name → glyph

Mirror rule: **never** = identical in both directions. **mirror** = the LTR-canonical glyph,
flipped with `scaleX(-1)` under `:dir(rtl)`. **variant** = Fluent ships separate `Rtl` / `Ltr`
assets, and the registry chooses one by direction.

| Registry name | POS today | Admin today | Fluent asset (Regular) | RTL | Notes |
|---|---|---|---|---|---|
| **Actions** | | | | | |
| `icon.search` | `search`, `SearchGlyph` | `search` | Search | never | Fluent unified the magnifier direction |
| `icon.scan` | `scan` | — | Barcode Scanner | never | |
| `icon.add` | `plus` | — | Add | never | |
| `icon.remove` | `minus` | — | Subtract | never | |
| `icon.close` | `close` | Drawer `✕` | Dismiss | never | |
| `icon.confirm` | `check` | ScopeHeader `✓` | Checkmark | never | never shown before the fact is persisted (P3) |
| `icon.backspace` | `backspace`, CashKeypad `⌫` | — | Backspace | never | keypads stay LTR (DESIGN.md) |
| `icon.retry` | `retry` | — | Arrow Clockwise | never | upstream has no `directionType` |
| `icon.park` | `pause` | — | Pause | never | |
| `icon.print` | `printer` | — | Print | never | today's glyph adds a warning mark. That mark moves to the Banner's tone glyph, which IC-2 renders **beside** the source glyph (§4.1) |
| `icon.lock` | `lock` | NoAccess inline | Lock Closed | never | |
| `icon.key` | `key` | — | Key | never | |
| `icon.pair` | `link` | — | Link | never | |
| `icon.signOut` | — | `sign-out` | Sign Out | mirror | 20/24 only; `sm` uses the 20 asset at 20px |
| **Direction** | | | | | |
| `icon.forward` | `forward`, SaleCart `←` | — | Arrow Right | mirror | points left in Arabic |
| `icon.back` | `back` | `BackArrow` `←` | Arrow Left | mirror | POS `back` is a chevron today; this unifies on the arrow (visual sign-off) |
| `icon.disclosure` | — | `chevron`, scope caret | Chevron Down | never | |
| `icon.increase` | `arrow-up` | — | Arrow Up | never | price difference (PK-3) |
| `icon.decrease` | `arrow-down` | — | Arrow Down | never | |
| **Status** | | | | | |
| `icon.status.info` | `status-info` | — | Info | never | |
| `icon.status.success` | `status-success` | — | Checkmark Circle | never | |
| `icon.status.warning` | `status-warning` | — | Warning | never | |
| `icon.status.danger` | `status-danger` | — | Dismiss Circle | never | Error Circle (!) rejected: too close to Info at 16px |
| `icon.status.unknown` | `status-unknown` | — | Question Circle | never | RT-660 "not known yet" |
| `icon.status.neutral` | `dash` | — | Subtract Circle | never | |
| **Domain** | | | | | |
| `icon.dashboard` | `nav-dashboard` | `overview` | Grid | never | |
| `icon.cart` | `nav-cart` | — | Cart | never | physical object |
| `icon.sale` | `nav-sales` | `receipt` | Receipt | never | UX-03 `icon.sale` |
| `icon.return` | `nav-returns` | — | Arrow Hook Up Left | mirror | upstream says use Arrow Hook instead of Arrow Undo, and marks it `mirror` |
| `icon.audit` | `nav-audit` | `audit` | Clipboard Task List **Rtl** / Ltr | variant | 20/24 only |
| `icon.inventory` | `nav-inventory` | `stock` | Box | never | UX-03 `icon.inventory` |
| `icon.product` | — | `catalog` | Tag | never | UX-03 `icon.product` |
| `icon.unknownItem` | — | `unknown` | Tag Question Mark | never | |
| `icon.cash` | `tender-cash` | `cash` | Money | never | UX-03 `icon.cash` |
| `icon.card` | `tender-card` | — | Payment | never | UX-03 `icon.card` |
| `icon.voucher` | `tender-voucher` | — | Ticket Diagonal | never | |
| `icon.shift` | `manager-shift` | — | Clock | never | UX-03 `icon.shift` |
| `icon.stuckShift` | `manager-stuck` | — | Clock Pause | never | no exact match; always with its title (visual sign-off) |
| `icon.held` | `manager-held` | — | Pause Circle | never | |
| `icon.people` | `manager-cashiers` | `operators` | People | never | |
| `icon.terminal` | `terminal` | `device` | Desktop | never | |
| `icon.settings` | `nav-settings` | — | Settings | never | |
| `icon.tenant` | — | `tenants` | Building | never | |
| `icon.store` | — | `stores` | Building Shop | never | UX-03 `icon.store` |
| `icon.connection` | — | `connection` | Plug Connected | never | |
| `icon.notifications` | — | `bell` | Alert | never | |
| `icon.help` | — | `help` | Chat Help | never | kept distinct from `status.unknown` |
| **Reserved** (named by UX-03 or VN-S6, no use today) | | | | | |
| `icon.payment` | — | — | Wallet | never | |
| `icon.drawer` | — | — | Drawer | never | UX-03 custom-icon gate: test the standard glyph with its label before commissioning a custom cash-drawer glyph |
| `icon.sync` | — | — | Arrow Sync | **never** | upstream marks it `mirror`; the product rule does not flip a cycle (§4.2) |
| `icon.offline` | — | — | Cloud Off | never | VN-S6 (doc 24) |
| `icon.posting` | — | — | Document Arrow Right | mirror | UX-03: never a pictogram puzzle; always with text |
| `icon.approval` | — | — | Shield Checkmark | never | always with text |

**Coverage:**

- **47 in use + 6 reserved = 53 names, served by 53 distinct Fluent assets.** The bundle
  measurement in §6 uses the 47 in-use assets.
- All 39 POS keys and all 17 Admin keys map, apart from the two brand marks.
- Three assets have no 16 grid: Sign Out, Clipboard Task List, Drawer. They use their 20 asset.
- **No concept needs a custom glyph.**

## 4. Fluent System Icons — fit

### 4.1 Coverage of the needed semantics

Every in-use concept and every UX-03 name has a Fluent Regular **and** Filled asset at 20 and 24.
`@fluentui/svg-icons` 1.1.344 ships 2,833 icons at 20 Regular and 2,476 at 24 Regular. For the
pharmacy domain, Pill and Heart Pulse exist if a future screen needs them.

There are two weak metaphors. Neither is a coverage gap:

- **printer-with-warning:** no Fluent asset, and rule 2 forbids composites. Today
  `PrinterFailureBanner` passes `icon="printer"`. `Banner.tsx:37-43` then renders that source
  glyph **instead of** `ToneIcon`, so the warning shape exists only inside the bespoke printer
  glyph. A plain Print glyph would therefore lose the warning shape. IC-2 changes `Banner` so that
  a source `icon` renders **next to** the tone glyph, with the tone glyph first, and does not
  replace it. The banner then shows △ + printer: the tone keeps its shape (P8), and the source
  stays distinguishable from the offline banner (RT-605). The `[data-icon="printer"]` hook stays
  on the source glyph. The pair layout needs visual sign-off.
- **stuck shift:** Clock Pause. It always sits beside its title.

### 4.2 Arabic / RTL behaviour

- **The glyphs are script-neutral.** No asset in the registry contains Latin letters or digits.
  Arabic labels sit beside them unchanged.
- **Upstream direction metadata** lives in each asset's `metadata.json` in
  `microsoft/fluentui-system-icons` as `directionType`. Its values are `mirror` (flip for RTL) and
  `unique` (separate Rtl/Ltr assets). Spot-checked:

  | Asset | `directionType` |
  |---|---|
  | Arrow Undo, Arrow Reply, Arrow Hook Up Left, Arrow Sync | `mirror` |
  | Arrow Left, Arrow Right, Chevron Left, Arrow Clockwise, Sign Out, Backspace, Search, Print, Receipt, Cart, Barcode Scanner | none |
  | Clipboard Task List | separate `…Rtl` / `…Ltr` assets |

  `@fluentui/svg-icons` does **not** ship this metadata.

- **How `@fluentui/react-icons` applies it.** About 196 exports are compiled with
  `flipInRtl: true`. They flip only inside an `IconDirectionContextProvider` with
  `textDirection="rtl"`. The headless API flips them through a `data-fui-icon-rtl` attribute plus
  its CSS.
- **Why the vendor metadata cannot be the authority.** Arrow Left and Arrow Right are absolute
  directions upstream. The product needs **"back"** and **"forward"** to follow reading direction:
  - DESIGN.md: "Direction-implying icons mirror; search, scan, print, lock, clock and check never
    do".
  - UX-03: "RTL follows meaning".

  Upstream also marks Arrow Sync `mirror`, which the product rule would not do for a cycle.
- **So the registry owns the mirror flag per semantic name** (§3). It applies the flag with CSS
  `:dir(rtl)` on the registry's own class. Admin's `BackArrow` already does this with a text
  arrow, and POS's `forward` / `back` glyphs are drawn pre-flipped today. Both become one mechanism.
- **Mixed direction.** Keypads and LTR-isolated runs (`dir="ltr"` on money, codes and quantities)
  correctly get **unmirrored** glyphs under `:dir()`. Use `:dir()` and not `[dir=rtl]` ancestor
  selectors for this reason. The Electron 40 and Chromium baseline supports `:dir()`.

### 4.3 Visual fit with the pharmacy-teal VNext language

- **Character fits.**
  - Fluent 2 geometry is calm and rounded, on a pixel-aligned grid.
  - It has no playful or skeuomorphic detail, and that matches the "clinical calm" register of
    DESIGN.md.
  - Rounded caps and corners sit well with the Dubai face and the 8px control radius.
- **Weight is lighter.** Fluent Regular glyphs are filled outline paths drawn on each grid. Line
  thickness is measured from the assets:

  | | Line | Share of the grid | At render size |
  |---|---|---|---|
  | Today (both repos) | 1.75 / 24 | 7.3 % | 1.46px at 20px, 1.17px at 16px |
  | Fluent 16 grid | 1.0 | 6.3 % | 1.0px at 16px |
  | Fluent 20 grid | 1.0 | 5.0 % | 1.0px at 20px |
  | Fluent 24 grid | 1.5 | 6.3 % | 1.5px at 24px |

  On the 96-dpi cashier displays, Fluent at 16 and 20 reads finer but crisper, because it is
  hinted to whole pixels. The `cross`-style heavy stroke cannot be tuned: these are fills, not
  strokes. **Needs the owner's visual sign-off.** See the preview's "POS today" column next to
  "Fluent 20".
- **Contrast is unaffected.** Pharmacy Teal `#0f766e` on white is 5.47:1, and on the Teal Wash it is
  4.84:1. Both are above the 3:1 non-text minimum (WCAG 1.4.11) at a 1px line.
- **Filled on selected.**
  - UX-03 allows Filled for persistent selection. The selected nav entry already has Teal Wash,
    teal ink, the 2px inline-start bar and `aria-current`.
  - UX-03 also says "Enough selection signals". Recommended: Filled **only** in the slim rail (icon +
    12px label), where the glyph is the largest visible cue. Not in the labelled panel or on
    tender tiles.
  - Visual sign-off.
- **Forced colours.** Glyphs use `fill="currentColor"` with no `forced-color-adjust: none`, so they
  take the system colours like text. On a selected tile with `Highlight`, they take `HighlightText`.
  The preview page includes a `forced-colors` rule for checking. A forced-colours capture is part
  of IC-2 and IC-3 evidence (DESIGN.md Forced-Colours Rule).

## 5. Licence

- **Licence: MIT.** `Copyright (c) 2020 Microsoft Corporation`, read from the upstream
  `https://github.com/microsoft/fluentui-system-icons/blob/main/LICENSE` on 2026-10-17. Both npm
  packages declare `"license": "MIT"` and point to that repository. **The npm tarball of
  `@fluentui/react-icons` 2.0.344 contains no `LICENSE` file.** Attribution therefore has to come
  from the upstream text, not from `node_modules`.
- **Obligation.** "The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software." Vendored path data is a portion of the Software.
- **What each repository must carry** (IC-1 / IC-3 scope):
  1. The full MIT text and copyright line in a notice file next to the registry module. For example
     `src/renderer/icons/LICENSE-fluentui-system-icons.txt` in POS and
     `src/components/icons/LICENSE-fluentui-system-icons.txt` in Admin.
  2. A provenance header in the registry module: source package, version, and asset name per glyph.
     It is kept as a `/*! … @license MIT */` legal comment so the minified bundle keeps it.
  3. A third-party entry in each repository's `NOTICE`. **POS:** the packaged app already ships
     `NOTICE` as `NOTICE.txt` through `electron-builder.yml` `extraFiles`, so a `NOTICE` entry
     reaches every distributed build. No packaging change is needed. **Admin:** the `NOTICE` entry
     plus the legal comment in the served bundle.
- **Compatibility.** MIT is compatible with both repositories' Apache-2.0 licence. It brings no
  copyleft, no patent clause to reconcile and no trademark grant. The Fluent _name_ and Microsoft
  marks are not used in product UI.

## 6. Bundle-size impact

**Method.**

- A throwaway directory outside both repositories, with
  `npm i --ignore-scripts @fluentui/react-icons@2.0.344 @fluentui/svg-icons@1.1.344 react@19 esbuild@0.28.2`.
- Each candidate is an ESM entry that imports the **47 distinct 20-Regular glyphs** of the in-use
  registry, or 1 glyph for the floor.
- Build: `esbuild --bundle --minify --format=esm` with React external, then `gzip -9`.
- The baseline is today's POS `V5Icon.tsx` bundled the same way.

| Option | 1 glyph raw / gz | 47 glyphs, 20 Regular only (floor) raw / gz | Extra | Tree-shakes? |
|---|---|---|---|---|
| **Today** (POS `V5Icon`, 39 stroke glyphs) | — | 3.2 KB / **1.5 KB** | — | n/a (closed map) |
| **A. `@fluentui/react-icons`, default (Griffel) API**, named imports from the barrel | 7.4 / 3.4 KB | 25.6 / **9.6 KB** | pulls the `@griffel/react` CSS-in-JS runtime (most of the 1-glyph floor) and injects styles at runtime | yes: barrel and `/svg/<name>` atoms give identical output |
| **B. `@fluentui/react-icons` headless**, per-icon atoms `…/headless/svg/<name>` | 1.8 / 1.0 KB | 20.0 / **7.1 KB** | + `headless/styles.css` 2.3 / 1.1 KB (a side-effect import) | yes, per atom (the headless barrel exports no icons) |
| **C. Vendored path data** in a registry module, from `@fluentui/svg-icons` assets | — | 17.2 / **5.9 KB** | none | n/a: only the registry's glyphs exist |
| **D. SVG sprite** (`<symbol>` per glyph, `<use href>`) | — | 19.5 / **5.9 KB** | an extra asset or inline block; `<use>` across a file boundary complicates CSP and `:dir()` mirroring per instance | no: the sprite is all-or-nothing |
| **E. Icon font** (`FluentSystemIcons-*.woff2`, shipped inside react-icons) | — | Regular **816.9 KB**, Filled 721.9 KB, Resizable 382.1 KB | per face; subsetting needs extra tooling; glyph hinting and forced-colours behave like text | **no** |

**Install footprint** (dev and CI, not runtime):

- `@fluentui/react-icons` 2.0.344 is **174 MB unpacked** across about 5,830 per-icon atom modules,
  with a runtime dependency on `@griffel/react` even for headless use.
- `@fluentui/svg-icons` is 12.8 MB.
- Both release roughly weekly (both at x.y.**344**).

**The complete registry.** The table measures one 20-Regular asset per name. That is a floor,
because the proposed `REGISTRY` is a closed map indexed by name at runtime. Every variant it
declares ships, whatever the call sites use. Measured the same way for all 47 in-use names:

| Registry content | Vendored (C) raw / gz | Headless atoms (B) raw / gz |
|---|---|---|
| 20 Regular only (floor, above) | 17.2 / 5.9 KB | 20.0 / 7.1 KB (+ 1.1 KB CSS) |
| 20 Regular + Filled 20/24 for the 7 slim-rail nav names | 23.2 / 7.5 KB | — |
| Regular 16 + 20 + 24, all names | 52.2 / 16.5 KB | — |
| **Full proposal:** Regular 16 + 20 + 24 + Filled 20/24 for the 7 nav names | 58.1 / **17.8 KB** | 63.5 / **19.1 KB** (+ 1.1 KB CSS) |

So IC-1 declares, **per name, only the grids that a call site uses** (most names need one or two),
and Filled only for the slim-rail nav. From IC-2 on, once consumers have moved, a registry test
fails on any declared variant that no call site uses. The realistic cost is between the floor and the full figure: about 8–12 KB gzip. The
ranking of the options does not change.

**Reading the numbers.**

- **Per glyph.** Fluent glyphs are outline fills (two contours per stroke), so each costs about 3×
  a stroke path. Every option except E adds roughly **6–19 KB gzip** to a renderer bundle, depending on how many
  variants the registry declares. That is still small next to the renderer and fonts.
- **Size does not decide this.** What decides it:
  - control over the glyph set and its review;
  - supply chain and install footprint;
  - whether a runtime styling engine comes in (A);
  - whether tree-shaking holds without per-icon import discipline (A/B: yes; D/E: no).

## 7. Decisions

Each decision is **Selected — recommended option, chosen by the coordinator under the owner's
standing delegation of 2026-10-17; owner may revisit.** Items marked _visual_ also need the owner's
visual sign-off before IC-2 / IC-3 ship pixels.

| ID | Question | Options | Selected |
|---|---|---|---|
| D-263-1 | Icon family | Fluent System Icons Regular (+ Filled for selection) · keep the bespoke sets · another family | **Fluent System Icons**, as UX-03 leads. _Visual_: confirm the lighter weight (§4.3) |
| D-263-2 | Packaging | A Griffel API · B headless per-icon ESM · **C vendored path data** · D sprite · E icon font | **C: vendored path data in a semantic registry module per repository.** Smallest of the options at every variant count (5.9 KB gz floor, 17.8 KB gz full proposal; §6). No runtime engine. No 174 MB dependency. Each glyph is reviewed and has provenance. Matches both repos' existing "closed, hand-picked map" contract. E is rejected (size, no tree-shaking). A is rejected (runtime CSS-in-JS in a cashier renderer). |
| D-263-3 | Add an npm dependency? | add `@fluentui/react-icons` or `@fluentui/svg-icons` · **add none** | **None.** Glyphs are vendored by a one-off extraction outside the repository. The source version is recorded per glyph. An update is a reviewed diff, not a version bump. |
| D-263-4 | Who decides RTL mirroring | vendor `directionType` / `IconDirectionContext` · **the registry, per semantic name** | **The registry** (§4.2), applied with `:dir(rtl)` |
| D-263-5 | Sizes | free px · **16 / 20 / 24 native grids** | **`sm` 16, `md` 20, `lg` 24**, no scaling between grids. _Visual_: the 20px line is 1.0px against today's 1.46px |
| D-263-6 | Accessibility labelling | label on the svg (`role="img"`) · **label on the control** | **On the control or adjacent text; the glyph is always `aria-hidden`.** Retire Admin's `title` prop. Financial, destructive and recovery actions stay text-visible (UX-03). |
| D-263-7 | Brand marks | into the registry · **outside** | **Outside.** The POS pharmacy cross and Admin `TowerMark` stay bespoke brand components. |
| D-263-8 | Filled glyphs | everywhere selected · **slim-rail selected nav only** · never | **Slim-rail selected nav only** (§4.3). _Visual_ |
| D-263-9 | Cross-repository shape | shared package · **same names, vendored per repository** | **Same names and rules, vendored per repository.** This doc's §3 is the canonical table. No new cross-repository package or contract. Admin adopts it in its own slice. |

Nothing here changes RT-24 behaviour, workflow semantics, copy, tokens or any contract.

## 8. Migration slices

Each slice is its own Jira issue (Implementation, or Docs for IC-4), in one repository, with its
own evidence.

| Slice | Repo | Scope | Visual change | Evidence | Depends on |
|---|---|---|---|---|---|
| **IC-1** POS registry module | POS | Add `src/renderer/icons/`: the vendored §3 glyphs with provenance, `Icon` with `name` / `size` / `selected`, the mirror class with `:dir(rtl)`, the MIT notice file, and the `NOTICE` entry. IC-1 declares the grids each name's current `V5Icon` call sites use (§6, complete registry). Unit tests: every name renders at every declared size; `aria-hidden` / `focusable`; mirror rules per name; no `forced-color-adjust`; a registry-completeness test. **No consumer moves; `V5Icon` untouched.** | none | tests, typecheck, lint, CodeScene | this doc merged |
| **IC-2** POS consumers onto the registry | POS | Move the 32 `V5Icon` consumer files to semantic names. Remove `SearchGlyph` and the live text glyphs `⌫` (`CashKeypad`) and `!` (`ScanGuardHost` → `icon.status.warning`). Change `Banner` so that a source `icon` renders beside the tone glyph, not instead of it (§4.1, printer banner). Keep `data-icon` and `.v5-icon` hooks, or move them with their tests. The DEV-only `#/dev/sale-proof` text glyphs move too, or the proof is retired. Delete `V5Icon` except the brand `cross` (→ brand component). Add a test that forbids a raw `<svg` in `src/renderer/**` outside `icons/` and brand components. Legacy `ui/payments/VoucherEntry` `✓` only if that surface is still live. | **yes** | VA captures at 1024 and 1280, light and forced colours, for nav (rail and panel), Sale, Checkout tenders, Banner tones, manager home, entry screens; axe | IC-1; owner visual sign-off on D-263-1/5/8 |
| **IC-3** Admin registry + consumers | Admin-Console | Same module under `src/components/icons/` (same names, Admin subset), MIT notice, `NOTICE`. Migrate `Icon` (17), NoAccess lock, ScopeHeader caret, `BackArrow` (7 files), Drawer `✕`, ScopeHeader `✓`. Retire the `title` prop (D-263-6). Update Admin `DESIGN.md` §4 from "pending RT-263" to the decided rules. | **yes** | Admin unit tests + Playwright/axe, forced-colours capture of shell and nav | this doc; owner visual sign-off |
| **IC-4** Record the decision | Confluence | Update UX-03 (page 22839299) and the RETAIL Decisions page: packaging C, no dependency, the registry rules, the mirror ownership. Update POS `docs/DESIGN.md` iconography line to point at doc 25. | none | page versions | owner sign-off (or after IC-2) |

The reserved names (`icon.sync`, `icon.offline`, …) are added to the registry by the slice that
first renders them, for example the VN-S6 slices of doc 24. There is no separate slice for them.

Order: **IC-1 → (visual sign-off) → IC-2 ∥ IC-3 → IC-4.** IC-2 and IC-3 are independent.

## 9. Evidence limits

- Planning only. No POS or Admin test, build, Electron run or hardware was run. Nothing under
  `src/**` was changed in either repository. No dependency was added.
- Bundle numbers come from esbuild 0.28.2 in isolation, not from the repositories' Vite builds.
  Vite (esbuild/Rollup) is expected to land within a few hundred bytes. The relative order of the
  options is the finding.
- Glyph counts are from `grep` over `src/` at the baselines above. Map-driven `V5Icon` uses were
  traced through their typed maps.
- `directionType` was spot-checked on 15 assets, not audited across the whole set.
- The preview renders with Segoe UI / Tahoma substitutes for Dubai and covers labels only. It is
  for comparing glyphs, not for screen acceptance.
