# 01 — Current-state visual audit (against GitHub `main`)

> RT-104 deliverable: "Current-state visual audit against GitHub `main`." Read-only source audit of
> `Kemetra/POS@28890facaf02d112fba4dec5ce48f4eb6909a12d` (origin/main on 2026-09-30, the RT-103
> merge). RT-104's description names `28d8e5e` (RT-79); `28890fa` is one commit later and is the
> baseline used here. `node_modules` was not installed in the audit environment, so **no runtime
> check or npm script ran**; findings come from source, docs and committed screenshots, each with a
> `file:line` reference. Committed screenshots predate RT-23 (`37513ed`, EGP in checkout) and
> RT-103 (`28890fa`, disabled voucher tile) — where a screenshot is cited, that caveat applies.
>
> Spot re-verified by grep on 2026-09-30: connection state initialises to `'online'` and is only
> set by the legacy AppShell DEV toggle (`connection-state.ts:18-23`, `AppShell.tsx:35`);
> `<SaleSyncStatus` has no production mount; `index.html:16` is `data-theme="light"`;
> `DEFAULT_THEME = 'light'` (`theme-store.ts:26`); the checkout `@container payment-surface
> (max-width: 1216px)` rule is at `tailwind.css:2183` (line numbers below may drift by a few
> lines); the only "F2" in the renderer is the unbound static-proof hint
> (`v5/sale/ProductRail.tsx:60`); the bilingual heading is at `TenderSelection.tsx:66`.

---

## 0. Executive summary

1. **Three design authorities disagree, and the code follows none of them fully.**
   - `docs/DESIGN.md` describes v3.5: navy `#1f4e7a`, Inter, **dark by default** (ADR-0004), and a dark rail.
   - `.impeccable/design.json` is older still: navy, Inter, and **light-only** ("Don't apply dark mode by default").
   - The shipped tokens follow **022 / v4.0**: teal `#0f766e`, the Windows "Dubai" system font, and a **light** default.
   - Neither design document has been updated for 022 or 023. A grep for `supersed|v4.0|022` in `docs/DESIGN.md` returns nothing.
2. **Only 2 of the roughly 15 `/app` screens are in the V5 clean-room frame.** Those are `/app/cart` (the live V5 Sale, genuinely clean-room) and `/app/checkout`. Checkout is the *legacy 006/022 `PaymentSurface`* dropped into the V5 frame, so v4, v3.5-kit and 006 class families all appear on one screen. Every other screen still renders in the legacy 003/007/v3.5 `AppShell`: a dark rail and a top bar with English copy.
3. **Many capabilities in the RT-104 checklist have no UI at all:**
   - shift open/close (015), returns/refunds (014, placeholder only), suspend/resume (no hold);
   - credit/third-party tender (020, draft spec only);
   - payment recovery (no dedicated surface), in-sale manager approval, error boundaries;
   - live offline detection (the connection state is hard-coded `online`);
   - sync status (the `SaleSyncStatus` component exists but is never mounted).
4. **The largest visual defects are in the legacy shell.**
   - At 1024–1279 px the nav rail goes icon-only, but its icons are empty `<span data-icon>` placeholders. The rail is visually blank; the screenshot shows only a teal block.
   - The identity strip renders `— · — · —` because the router never passes `pairedStatus`.
   - Legacy screen copy is English-first.
   - In dark mode, rail hover text becomes navy on navy.

---

## 1. Design documents: `docs/DESIGN.md` and `.impeccable/design.json`

### 1.1 `docs/DESIGN.md` (312 lines, YAML front-matter plus prose)

**North star.** "The Accountable Instrument" (`docs/DESIGN.md:144`). "Precision instrument, not a consumer product… does the operator know the true state of every operation?" (`:146`).

**Theme.** "Two themes — dark is the default (ADR-0004)… light toggle… persists in `localStorage`" (`:148`). This is **stale**: the code defaults to light (§2.3).

**Arabic-first.** `<html dir="rtl" lang="ar">`, logical properties, and the font stack Inter Variable → Segoe UI → system-ui (`:150`).

**Key characteristics** (`:155-161`):
- navy plus teal accent on under 15% of any screen;
- flat by default with structural shadow;
- Inter as the single typeface;
- 44×44 px touch floor;
- persistent banners, not toasts;
- the dark rail as the only drenched surface.

**Colours** (front-matter `:4-37`; prose `:163-195`):

| Token | Hex | Role (DESIGN.md) |
|---|---|---|
| primary | `#1f4e7a` | Command Navy: primary actions, active nav |
| primary-emphasis | `#163d61` | hover/emphasis |
| primary-soft | `#e6eef6` | Horizon Wash: selected/info tint |
| primary-on | `#ffffff` | |
| accent | `#2e7da3` | Teal Marker: nav active tab and focus ring only ("One-Accent Rule", `:167`) |
| rail / rail-hover / rail-text / rail-text-dim | `#0e1b2a` / `#162a40` / `#cdd6e0` / `#7a8a9c` | Vault Dark rail |
| background | `#fbfcfd` | Near-White workspace |
| surface | `#ffffff` | cards/panels |
| surface-elevated | `#f3f6fa` | Lifted Canvas |
| surface-sunken | `#eef2f6` | Recessed wells (PIN keypad) |
| text / text-muted / text-inverse | `#0f1d2e` / `#5b6b7c` / `#ffffff` | |
| border / border-soft / border-strong | `#d8dfe7` / `#e7ecf2` / `#9ca3af` | |
| success (+emph, soft) | `#1f8a5b` / `#176944` / `#e7f5ee` | |
| warning | `#b87600` / `#8f5b00` / `#fbf0db` | |
| danger | `#b32e36` / `#8e2329` / `#f7e2e3` | |
| info | `#1e6f8c` / `#175670` / `#e1f0f5` | |
| neutral / neutral-emphasis | `#5b6b7c` / `#3d4c5a` | |

**Typography** (`:38-73`, `:197-214`). All roles use Inter Variable.

| Role | Size | Weight | Line height | Letter spacing |
|---|---|---|---|---|
| display | 1.875rem (30px) | 700 | 1.1 | −0.01em |
| headline | 1.5rem (24px) | 700 | 1.2 | −0.008em |
| title | 1.125rem (18px) | 600 | 1.3 | −0.005em |
| body | 1rem (16px) | 400 | 1.5 | 0 |
| label | 0.75rem (12px) | 600 | 1 | +0.01em |
| mono | 0.875rem | 400 | 1.5 | — |

- The mono stack is ui-monospace / Cascadia Code / JetBrains Mono.
- Rules: No-Second-Font (FR-052) and Tight-Display.

**Radii** (`:74-82`): none 0, sm 2, md 4, lg 8, control 10, card 14, pane 16, pill 9999.

**Spacing** (`:83-92`): 4, 8, 12, 16, 24, 32, 48, 64, 96 (steps 1–9).

**Elevation** (`:216-228`):

| Level | Value |
|---|---|
| none | `none` |
| sm | `0 1px 2px rgba(0,0,0,.05)` |
| card | `0 1px 2px rgba(15,29,46,.04), 0 8px 24px rgba(15,29,46,.06)` |
| pane | `0 18px 60px rgba(15,29,46,.10)` |
| overlay | `0 20px 25px -5px / 0 8px 10px -6px rgba(0,0,0,.25)` |
| inset | inset pair |

**Motion and breakpoints.** Not in the DESIGN.md front-matter. The prose mentions only "state-change-only" motion (`:150`) and the rail breakpoints 84 px below 1280, 248 px from 1280, hidden below 1024 (`:245`).

**Component rules** (`:230-281`):

- **Buttons:**
  - 44 px high, 10 px radius, 14 px inline padding.
  - Variants: primary (navy), secondary (white with Quiet Edge border), ghost, destructive (red).
  - Focus: a 4 px, 18% halo.
  - Disabled: 50% opacity.
  - "Single Primary Rule" (`:242`).
- **Nav rail entry:**
  - 48 px high, 12 px radius, Muted Silver text.
  - Active: navy fill plus a 4×24 teal accent tab.
  - Focus: a 2 px teal ring.
- **Cards:** white, 1 px border, 14 px radius, card shadow, 32 px padding. No nested cards.
- **Inputs:** 10 px radius, 44 px minimum height, 14 px font. Focus uses a navy border and a 3 px, 20% halo. The error state is red.
- **Status banners:** full width under the top bar and persistent. Variants: degraded (amber), offline (red), syncing (teal, with a pulse dot).
- **Badges:** 26 px pill, 8 px dot, 12 px semibold label.

**Do/Don't** (`:283-312`):
- one navy primary per context;
- a Near-White background, never pure white;
- persistent banners for operational state;
- 44 px targets;
- colour never carries meaning alone;
- themes only through token values on `:root[data-theme="dark"]`, never forked components;
- no SaaS aesthetics, glassmorphism, gradient text, or accent stripes wider than 1 px;
- teal never as a fill;
- status colours never decorative;
- modals as a last resort;
- no nested cards.

### 1.2 `.impeccable/design.json` (schema v2, `generatedAt` 2026-05-13)

- **colorMeta** (`:6-279`). This block covers only 14 colour roles. Each has an OKLCH canonical value and a 10-step tonal ramp.
  - Examples: primary `oklch(36% 0.085 236)` = `#1f4e7a`; accent `oklch(52% 0.085 218)` = `#2e7da3`.
  - Missing roles: emphasis/soft variants of success/warning/danger/info, `surface-muted`, `border-soft`, `border-strong`, `neutral`.
- **Shadows** (`:306-342`): the same six as DESIGN.md, plus `md` ("rarely used"). There are no dark-register values.
- **Motion** (`:343-366`): `duration-1` 80 ms, `-2` 150 ms, `-3` 220 ms, `-4` 320 ms; `ease-out` `cubic-bezier(0.2,0.7,0.25,1)`; `ease-in-out` `cubic-bezier(0.45,0.05,0.25,1)`.
- **Breakpoints** (`:367-378`): `rail-collapse` 1024 px; `rail-expand` 1280 px.
- **Components** (`:380-445`). Reference HTML/CSS snippets, all with hard-coded navy hex:
  - `ds-btn-primary`, `ds-btn-secondary`, `ds-btn-destructive`;
  - `ds-input`, `ds-nav-entry`, `ds-card`;
  - `ds-status-banner--offline/degraded/syncing`, `ds-badge--*`.
- **Narrative** (`:446-526`). Same north star and rules, but:
  - "The palette is determinedly light… rejects… **dark-mode defaults**" (`:448`);
  - "Don't apply dark mode by default — the one light theme is deliberate" (`:514`);
  - "Do keep the navigation rail as the only intentionally dark surface" (`:509`).

### 1.3 Inconsistencies

**DESIGN.md vs design.json:**

| Topic | DESIGN.md | design.json |
|---|---|---|
| Default theme | Dark default, light toggle (`:148`, `:296`) | Light only; "Don't apply dark mode by default" (`:514`) |
| Motion / breakpoints | Absent from front-matter | Present |
| Label type | — | "All-caps forbidden" (`:299`) |
| Button focus | — | Primary uses a 4 px halo; secondary uses a 2 px teal outline (`:387`, `:395`) |

- design.json's CSS also adds details that DESIGN.md does not state: `font-size: 0.875rem`, `letter-spacing: -0.005em`, and 120 ms transitions.

**Both documents vs the shipped code** (the `src/renderer/styles/tailwind.css` tokens, §2):

- **Primary colour.** The docs say navy `#1f4e7a`. The code uses **teal `#0f766e`** (`tailwind.css:20`), and its comment explicitly supersedes navy and the One-Accent Rule (`:17-19`).
- **Accent.** The docs say `#2e7da3`, used only as a tab or ring. The code sets it equal to primary, `#0f766e` (`:27`). The One-Accent Rule is therefore void.
- **Font.** The docs say Inter Variable. The code uses **Dubai → Segoe UI → Tahoma → Arial** (`:110`). The comment explains that Inter was never bundled (`:104-109`). `docs/product.md:34` also still says Inter.
- **Default theme.** DESIGN.md says dark. The code defaults to **light** (`index.html:16` `data-theme="light"`; `theme-store.ts:26` `DEFAULT_THEME = 'light'`), with a one-shot migration that wipes stored v3.5 "dark" (`theme-store.ts:141-150`).
- **Status and neutral values.** All differ. They were re-measured for WCAG in the code (§2.2).
- **Body size.** The docs say 16 px. The code's `body` is **14 px** (`--font-size-sm`, `tailwind.css:371`).
- **Border-strong.** The docs say `#9ca3af`. The code uses `#6f7b89` (`:75`); the comment says the docs value failed WCAG 1.4.11.
- **Focus ring.** The docs specify a teal 2 px ring or a navy halo. The code uses `--color-focus-ring: var(--color-primary)` with a 2 px outline and 2 px offset (`:76`, `:381-384`). Some `.btn` variants still use the 4 px color-mix halo (`:443` and similar).
- **Rail.** The docs say it collapses to 84 px icon-only. The **V5 frame nav never goes icon-only.** It is a light panel, 208 px at 1280 and above and 140 px at 1024–1279, with labels always visible (`v5/foundation/foundation.css:13`, `:45-50`; `V5Navigation.tsx:9-11`). This contradicts the "dark rail anchor" rule in both documents.

---

## 2. The shipped token implementation

### 2.1 Where tokens live

| File | What it contains |
|---|---|
| `src/renderer/styles/tailwind.css:3-189` | `:root` light tokens, the single source of values |
| `src/renderer/styles/tailwind.css:212-280` | `:root[data-theme='dark']` overrides (values only) |
| `src/renderer/styles/tailwind.css:282-308` | Tailwind v4 `@theme` re-export of a subset of `--color-*` (so utilities like `border-border` resolve) |
| `src/renderer/ui/tokens/*.ts` | TS mirrors returning `var(--…)` strings. Includes a parity test (see the `tokens.test.ts` T008 comment at `tailwind.css:91-97`) and `touchTarget.min = 44` (`ui/tokens/touch.ts`) |
| `src/renderer/v5/foundation/foundation.css:11-42` | V5 aliases scoped to `.v5-frame`: `--v5-nav-inline-size`, `--v5-gutter`, `--v5-gap`, `--v5-target: 44px`, `--v5-focus-ring`, `--v5-surface-*`, `--v5-divider*`, `--v5-text-title/section/body/meta`. All resolve to base tokens. |
| `tailwind.config.ts:1-4` | `darkMode: 'class'`. This is dead: Tailwind v4 ignores this file without `@config`, and theming actually keys on `data-theme`. |
| `src/renderer/styles/__tests__/token-guard.test.ts` | Blocks raw literals in inline styles, per the `RECONCILIATION.md §C` citation |

### 2.2 Light tokens as shipped, with deltas from DESIGN.md

| Token | Shipped (`tailwind.css` line) | DESIGN.md | Delta |
|---|---|---|---|
| `--color-background` | `#f7f9fa` (:7) | `#fbfcfd` | changed |
| `--color-surface` | `#ffffff` (:8) | `#ffffff` | = |
| `--color-surface-elevated` / `-muted` (alias) | `#f3f6fa` (:9-10) | `#f3f6fa` | `-muted` is a duplicate alias |
| `--color-surface-sunken` | `#eef2f6` (:177) | `#eef2f6` | = |
| `--color-text` | `#0f1d2e` (:13) | = | = |
| `--color-text-muted` | `#53647a` (:14) | `#5b6b7c` | darker, for AA |
| `--color-primary` / `-emphasis` / `-soft` / `-on` | `#0f766e` / `#0b5b55` / `#e6f4f1` / `#fff` (:20-23) | navy family | **hue changed** |
| `--color-accent` | `#0f766e` (:27) | `#2e7da3` | collapsed into primary |
| `--color-success` / `-emph` / `-soft` / `-on` | `#15774d` / `#10603d` / `#e7f5ee` / `#fff` (:31-34) | `#1f8a5b`… | changed (AA) |
| `--color-warning` | `#a35a00` / `#7d4500` / `#fdf1e0` (:36-39) | `#b87600`… | changed |
| `--color-danger` | `#b3261e` / `#8c1d18` / `#fbe9e7` (:41-44) | `#b32e36`… | changed |
| `--color-info` | `#1b6ca8` / `#145184` / `#e4f0f9` (:46-49) | `#1e6f8c` teal | **hue changed to blue** |
| `--color-neutral` | `#5b6b7c` / `#3d4c5a` (:52-54) | = | = |
| `--color-rail*` | `#0e1b2a` / `#162a40` / `#cdd6e0` / `#7a8a9c` (:57-60) | = | = (used only by the legacy rail) |
| `--color-border` / `-soft` / `-strong` | `#d8dfe7` / `#e7ecf2` / `#6f7b89` (:63-75) | `…` / `#9ca3af` | strong changed |
| `--color-focus-ring` | `var(--color-primary)` (:76) | teal marker | changed |
| `--color-overlay-scrim` | `rgba(8,14,24,.55)` (:77) | — | not in the docs |

**Spacing** (`:80-88`, `:180`): `--space-0`…`--space-9` = 0/4/8/12/16/24/32/48/64/96. This matches the docs, plus `space-0`.

**Checkout geometry tokens** (`:98-101`): `--checkout-tile-padding-block 18px`, `-inline 14px`, `--checkout-action-padding-block 15px`, `-inline 40px`.

**Typography:**
- Families: `--font-family-sans` = `'Dubai','Segoe UI',Tahoma,Arial,system-ui,sans-serif` (:110); `--font-family-mono` = `ui-monospace,'Cascadia Code','JetBrains Mono','Consolas',monospace` (:115).
- Weights: 400/500/600/700 (:117-120).
- Sizes: 2xs 11, xs 12, sm 14, md 16, lg 18, xl 20, 2xl 24, 3xl 30, 4xl 44 (:122-130).
- Checkout steps: 26 / 19 / 15 px (:139-141). Receipt slip: 0.7rem / 1.4rem (:147-148).
- Line heights: 1.25 / 1.375 / 1.5 / 1.625 (:150-153).
- There are no role tokens such as display, headline or title. Components pick raw sizes from the scale.

**Radii** (`:156-163`): match the docs.

**Shadows** (`:166-174`): the docs set, plus `--shadow-md` and `--shadow-lg` (stock Tailwind values; used 0 times in the CSS).

**Motion** (`:183-188`): matches design.json. `--ease-in-out` is used 0 times. Durations are also hard-coded in many rules (150 ms ×8, 200 ms ×4, 120 ms ×4, 160 ms ×2, 100 ms ×2 in `tailwind.css` and the v5 CSS). One example is the `.btn` transition `120ms ease-out` (`:407-411`).

### 2.3 Dark register (`tailwind.css:212-280`)

**Values:**

| Token | Dark value |
|---|---|
| background | `#0a1420` |
| surface | `#111f30` |
| elevated | `#182a3e` |
| sunken | `#0b1623` |
| text | `#e8eef5` |
| muted | `#93a5b7` |
| **text-inverse** | **`#0f1d2e`** |
| primary | `#14b8a6` (on-colour navy `#0f1d2e`) |
| accent | `#14b8a6` |
| success / warning / danger / info | `#41b283` / `#d9a13a` / `#d96770` / `#4ba3c4` (soft variants are 13–14% rgba) |
| rail | `#070f18` |
| borders | `#243a52` / `#1a2c40` / `#3c5a7a` |

Shadows deepen as well.

**Default and switching.** Light is the default; dark is reachable only through `ThemeToggle`. That toggle lives in the legacy `TopBar` (`shell/regions/TopBar.tsx:61`) and in `SettingsSkeleton`. **The V5 frame has no theme toggle.**

**No high-contrast support.** There is no `forced-colors`, no `prefers-contrast` and no `prefers-color-scheme` query anywhere in `src/renderer` (verified by grep).

### 2.4 Token hygiene

- **No raw colour literals** exist outside the token blocks. There are zero hex/rgb matches after `tailwind.css:281` and in any v5 CSS.
- Colour derivations use 45 `color-mix()` calls over tokens.
- **Off-scale font sizes.** `tailwind.css` has 34 raw literals, for example 0.8125rem ×5, 1.375rem ×5, 0.6875rem ×7, 1.75rem ×3, 0.90625rem, 0.625rem.
- **Raw radii:** `999px`, `22px`, `12px`, `4px 4px 0 0`.
- **Raw px values.** 445 raw `px` literals in `tailwind.css` and about 110 in the v5 CSS. They are mostly geometry, such as column tracks `16px minmax(0,1fr) 84px 120px 100px` (`v5/sale/live-sale.css:52-53`).
- **Undefined token.** `var(--font-size-base)` is used at `tailwind.css:3079` (`.takeover-prompt__body`) but is never defined, so the rule falls back to the inherited size.
- **Inline styles in TSX.** These escape the CSS layer, although most use `var()`:
  - `ReceiptPreview.tsx:181-230`: whole style objects.
  - `CashEntry.tsx:165`: `minWidth: 240`, a raw number.
  - `touchTarget.min` minHeights in `AmountPad`, `TenderSelection`, `CashEntry`, `ExternalCardTerminalEntry` and `VoucherEntry`.
  - `DashboardView.tsx:109-138`: computed bar sizes.
- **Stock Tailwind utilities and non-existent theme keys:**
  - `ui/receipts/FindSaleReceipt.tsx:76-120` uses `flex gap-4 rounded-md min-h-11 px-3 …`.
  - `text-amber-700` (`:105`) is an **off-token stock palette colour**.
  - `text-muted-foreground` (`:113`) is a shadcn class with no theme key, so it does nothing.
  - `ReprintAffordance.tsx:92` uses `min-h-11 min-w-11`.

---

## 3. App shell, routing and screen generations

### 3.1 Boot and frames

- **Entry:** `src/renderer/main.tsx`.
  - A DEV-only `#/dev/sale-proof` renders the static V5 proof `SaleScreen` (`:33-43`).
  - Otherwise it runs `initTheme()`, Sentry and flag hydration, then `<App/>` (`:44-71`).
- **Router:** `src/renderer/router.tsx`. It is a hash router in production (`:295`). The boot phase renders an **empty `<main data-testid="route-loading"/>`** (`:123-125`), which is a blank frame.
- **Route tree** (`router.tsx:173-271`):
  - `/` → `/pairing` or `/paired`;
  - `/pairing`, `/paired`, `/sign-in`: **no frame**. Each is a standalone screen.
  - `/app` sits under one `OperatorRouteGuard` (`:164-171`) and has two layout routes:
    - `V5AppLayout` (V5Frame plus `V5OperationalNotices`) → `cart`, `checkout` (`:182-188`);
    - legacy `AppShell` → index redirect, `dashboard`, `sales`, `returns` (manager/admin), `audit` (manager/admin), `inventory`, `inventory/diagnostics`, `settings`, `manager/cashiers`, `manager/stuck-shifts`, `manager/force-fail` (`:189-267`).
- **Nav entries.** There are seven, from one contract: `specs/003-pos-ui-shell/contracts/shell-routes.ts:89-97`. The Arabic labels are لوحة المتابعة, نقطة البيع, المبيعات, المرتجعات, سجل المراجعة, المخزون, الإعدادات. Returns and audit are restricted to manager/admin.
  - V5 nav derives its entries from the contract (`v5/frame/nav-model.ts:352-357`).
  - Legacy `NavRail` also reads the contract, but it uses `labelEn` as the aria-label and shows the Arabic label visually (`shell/regions/NavRail.tsx:115-131`).
- **Index redirect** (022 FR-44): cashier → `/app/cart`; others → dashboard (`routes/app/AppIndexRedirect.tsx`).
- **Feature flags** default to all off: `cart`, `payments`, `saleFinalization`, `productSearch`, `voucherTender` (`stores/feature-flags-store.ts:44-48`). With `cart` off, the V5 Sale shows "سلة البيع غير مفعّلة على هذا الجهاز بعد." (`v5/sale/LiveSaleWorkspace.tsx:31-37`). With `payments` off, checkout shows the 003 `CheckoutPlaceholder` (`CheckoutRoute.tsx:46-48`).

**V5 frame** (`v5/frame/V5Frame.tsx:46-77`, `frame.css`):
- RTL grid with the screen first, nav second (`frame.css:6-12`).
- Light nav panel containing the brand ("POS Pulse" with an SVG cross), links, operator name and role (Arabic), and `V5SignOut`.
- A persistent `StatusBanner` when the connection is not `online`.
- A `notices` slot holding ShiftClosed, PrinterFailure and DrawerFailure banners.
- `<main class="v5-frame__main">`, which is a size container `v5-screen` (`frame.css:44-52`).
- `ScreenTooSmall` below 1024 px.
- No theme toggle, no connection pill, no terminal identity.

**Legacy AppShell** (`shell/AppShell.tsx:33-126`, CSS `tailwind.css:488-700`):
- `TopBar`: wordmark, `IdentityStrip`, `ConnectionIndicator` pill (English: "Online / Connection slow / Offline / Syncing…", `ConnectionIndicator.tsx:9-12`), `ThemeToggle`, `OperatorSlot` (an English role badge, or a stale disabled "Sign in / Sign-in is not yet available." button, `OperatorSlot.tsx:28-40`).
- `NavRail`: dark `--color-rail`, 84 px / 248 px (`tailwind.css:541-566`).
- Banners, then `<Outlet/>`.
- `pairedStatus` is **never passed** by the router (`router.tsx:190` renders `<AppShell />` without props), so the identity strip shows `—` placeholders. This is confirmed in `h-retire-1024-09-dashboard-legacy-shell.png` and in the G0 note at `execution-ledger.md:114`.

### 3.2 Screen → component → generation table

"V5" means the `src/renderer/v5/**` clean-room tree (023). "v4" means the 022 `.v4-*` vocabulary, US3/US4a. "v3.5" means the kit.css port under `docs/design/pos-v3.5`. "Legacy" means the 002/003/004/006/007/008 BEM families.

| Screen / route | Component file(s) | Generation | Notes |
|---|---|---|---|
| Boot / loading | `router.tsx:123-125` | Legacy (none) | Empty `<main>`; no spinner or copy |
| Pairing `/pairing` | `routes/pairing/PairingScreen.tsx`, `PairingForm.tsx`, `InvalidStateBanner.tsx`, `routes/pairing/messages.ts`; CSS `.pairing-screen*` (`tailwind.css:~987-1140`) | Legacy 002/007 S4 | CenterStage pane. The code input is mono, 22–36 px, `letter-spacing .32em`, `text-transform: uppercase` (`:1080-1086`). No frame and no ScreenTooSmall guard. |
| Paired `/paired` | `routes/paired/PairedScreen.tsx`; `.paired-screen*` | Legacy 002/007 | Success-check circle; terminal detail rows |
| Sign-in `/sign-in` (roster, PIN, manager staff-code, takeover) | `routes/sign-in.tsx:196-333`; `ui/operator/RosterList.tsx`, `PinPad.tsx`, `ManagerAdminSignInForm.tsx`, `TakeoverPrompt.tsx` | **v4 (022 US1)**, with legacy 004 children | `.v4-screen` / `.v4-columns--sign-in` with tracks 312 / 1fr / 320 (256 below 1280; `tailwind.css:4030-4120`). Children keep the 004 BEM classes (`pin-pad`, `roster-list`, `takeover-prompt`). Mixed Arabic/English, e.g. "كود الموظف · Staff code" (`sign-in.tsx:240`). The takeover branch is a v4-screen that wraps the legacy `TakeoverPrompt` (`:183-186`). No shift-start step, by design (`:215-229`). |
| Shift open | — | **none** | No `openShift` bridge or UI (defect register D-003) |
| Shift close / cash management (015) | — (only a forward reference PNG) | **none** | 015 is Deferred (`specs/README.md:45`) |
| Forced shift-close notice | `ui/operator/ShiftClosedBanner.tsx` in both frames | Legacy 004 | **English-only** copy "Your previous shift was closed on …", with `toLocaleDateString(undefined, …)` (system locale) (`:9-19`). It renders inside the Arabic V5 frame. |
| Manager: stuck shifts `/app/manager/stuck-shifts` | `ui/operator/ForcedCloseSurface.tsx` | Legacy 004 | **Unstyled**: native `<fieldset>`, `<button>` and `role=dialog` with no classes. English copy (`:100`, `:237`, `:242`, `:280`). |
| Manager: cashiers `/app/manager/cashiers` | `routes/app/manager/CashierManagement.tsx` | Legacy 019/006 | `Workspace title="Cashier Management"` (English); `.btn` buttons; hand-rolled `role=dialog` (`:140`) |
| Manager: force-fail `/app/manager/force-fail` | `router.tsx:317-323` (placeholder); `ui/payments/ForceFailSurface.tsx` (not routed with props) | Legacy | The route shows a bare English sentence. The component has no classes and English copy (`ForceFailSurface.tsx:73`). |
| Takeover (another operator's live session) | `ui/operator/TakeoverPrompt.tsx` | Legacy 004 | Hand-rolled dialog with Escape handling (`:81-90`) |
| **Sale workspace `/app/cart`** | `v5/sale/V5SaleRoute.tsx` → `LiveSaleWorkspace.tsx`, `LiveCatalogueRegion.tsx`, `LiveProductRail.tsx`, `LiveSearchResults.tsx`, `LiveSaleCart.tsx`, `LiveCartParts.tsx`, `SaleDialog.tsx`, `SaleProductFlags.tsx`; CSS `sale-screen.css` + `live-sale.css` | **V5 clean-room (023 Slice G)** | The only fully migrated screen. Owner-approved on 2026-09-25 (`polish-pass-review.md:55-57`). Contents: 44 px titlebar with h1 "مساحة البيع"; product region; dominant cart; truthful tax-pending line "قيد الإضافة · لا تُحسب هنا" (`LiveSaleCart.tsx:352-355`); a single CTA. |
| Product search / barcode | `LiveProductRail.tsx:88-155`, `LiveSearchResults.tsx`; hooks `sale/useSaleCatalogueController.ts`, `stores/useDebouncedSearch.ts` | V5 | Separate search field and dedicated scan field (`inputMode="none"`, dashed sunken target). Listbox with arrow-key selection. |
| Confirm-add dialog | `LiveCatalogueRegion.tsx:62-117`, `SaleDialog.tsx` | V5 | Arabic name, English secondary name, Rx/controlled flags, mono price |
| Cart lines / stepper / note / void | `LiveCartParts.tsx`, `LiveSaleCart.tsx` | V5 | 5-column row: #, product, unit, qty stepper, total. Note dialog (200-character cap). Void confirm dialog in danger styling. |
| Catalogue freshness | Inline in the V5 rail as `FreshnessBar` (`LiveProductRail.tsx:157-174`); diagnostics at `routes/app/CatalogueDiagnostics.tsx` | V5 (sale) / Legacy (diagnostics) | The legacy `CatalogueFreshness` component was deleted in Slice H. Diagnostics shows English headings: "Catalogue Diagnostics", "Terminal", "Catalogue sync"… (`:170-237`). |
| Suspend / resume (hold) | — (only dead CSS: `.held-tray` `tailwind.css:3448`, `.held-chip` `:3462`) | **none** | D-007: no hold/park bridge |
| Discounts | `LiveSaleCart.tsx:260-272` ("خصم قيد المعالجة" placeholder rows plus a remove action) | V5 | Placeholder rows only. No discount-entry or manager-approval UI. |
| **Checkout / tender `/app/checkout`** | `routes/app/checkout/CheckoutRoute.tsx` → `shell/regions/Workspace.tsx` → `ui/payments/PaymentSurface.tsx`, `TenderSelection.tsx`, `PaymentCartSummary.tsx`, `CashEntry.tsx`, `AmountPad.tsx`, `MoneyRoll.tsx`, `ExternalCardTerminalEntry.tsx`, `VoucherEntry.tsx`; CSS `tailwind.css:2084-2560`, `3282-3760` | **Mixed: legacy 006 components, v3.5 kit classes (`method-card`, `tender-row`, `tender-slots`, `quick-amount-btn`, `amount-due-card`) and v4 022 US3 geometry, inside the V5 frame** | Not clean-room. It violates the 023 rule "new CSS wraps old DOM ≠ migrated" (`023/spec.md:21`). It uses the legacy `Workspace` (48 px inline padding, `tailwind.css:934-944`). `OperatorBadge` repeats the identity the V5 nav already owns (`PaymentSurface.tsx:453`, `:537`). Bilingual heading "طريقة الدفع (Payment method)" (`TenderSelection.tsx:66`). |
| Cash tender | `CashEntry.tsx`, `AmountPad.tsx`, `MoneyRoll.tsx` | Legacy 006 + v3.5 port | Keypad; quick-amount chips (بالضبط + banknote roll-ups); animated change-due. Bilingual labels "المبلغ المستلم (Amount received, EGP)" (`CashEntry.tsx:163`). |
| External card terminal | `ExternalCardTerminalEntry.tsx` | Legacy 006 + v3.5 | Records the amount only; no PAN |
| Voucher | `VoucherEntry.tsx`; tile at `TenderSelection.tsx:130-153` | Legacy 006 + v3.5 | **RT-103 (28890fa):** the tile is disabled by default, with the sub-label "غير متاحة حاليًا" and aria "قسيمة — غير متاحة حاليًا"; the `voucherTender` flag defaults to false (`PaymentSurface.tsx:145`, `:210`, `:610`). Styling: `.tender-method-grid .method-card:disabled` (`tailwind.css:2471`). |
| Credit / third-party tender (020) | — | **none** | Draft spec only (`specs/020…/spec.md:4`). `TENDER_TYPES` = cash, card, voucher (`src/shared/payments/types.ts:43`). |
| Payment recovery | `PaymentSurface.tsx:160-180` (resume a `started`/`settled` attempt on remount); refusal copy `:708-717`; reversal-pending hint `:697-706` | Legacy 006 | No dedicated recovery screen. Manager force-fail is a placeholder. |
| Sale completion (settled) | `PaymentSurface.tsx:424-529` | **v4 (022 US4a)** in the V5 frame | `.v4-screen` / `.v4-panel`; "تم استلام المبلغ" plus a flag-dependent detail; dominant amount; `btn--lg btn--primary` "بيع جديد". **No receipt and no sale number** (T013a/T017 are blocked on a correlation id, `:126-140`). |
| Receipt preview / reprint | `ui/receipts/ReceiptPreview.tsx`, `ReprintAffordance.tsx`, `FindSaleReceipt.tsx` (mounted only on `/app/sales`) | Legacy 008 | Three different styling approaches: inline style objects, `.btn`, and Tailwind utilities. Bilingual copy "طباعة — Print", with Print disabled ("Printing lands in Slice 3", `ReceiptPreview.tsx:240`). FindSaleReceipt uses the English label "Sale number". |
| Printer / drawer failure banners | `ui/receipts/PrinterFailureBanner.tsx`, `DrawerFailureBanner.tsx`, `useBannerState.ts` | Legacy 008 (`.v4-row`, `.btn`) | Both frames mount them. **The V5 frame wires Reprint/Manual to the bridge** (`V5OperationalNotices.tsx:27-41`). **The legacy AppShell passes a no-op `onReprint`** (`AppShell.tsx:104-106`), so behaviour differs by frame. |
| Returns / refunds / voids (014) | `routes/app/ReturnsPlaceholder.tsx` (`placeholder-pane`, `Workspace title="Returns"`) | Legacy v3.5 Slice 1 | Placeholder only; manager/admin. Cart void exists in V5 (above). Post-handoff cancel goes through `cart:cancelPostHandoff` (ledger `:104`). |
| Sales `/app/sales` | `routes/app/SalesWorkspace.tsx` | Legacy 003 | `Workspace title="Sales"` (English); FindSaleReceipt |
| Dashboard `/app/dashboard` | `DashboardRoute.tsx` → `DashboardPlaceholder.tsx` → `DashboardSkeleton.tsx` (prod) / `DashboardDemo.tsx` + `DashboardView.tsx` (DEV `?demo=1`) | Legacy 003 + v3.5 Slice 5 | English "Dashboard" and "Coming soon" cards. The demo data uses `¤` (`dashboard-demo-data.ts:21-23`). |
| Inventory `/app/inventory` | `InventoryPlaceholder.tsx` | Legacy 003 | English |
| Audit `/app/audit` | `AuditPlaceholder.tsx` | Legacy v3.5 | English title "Audit" |
| Settings `/app/settings` | `SettingsHelpPlaceholder.tsx`, `SettingsSkeleton.tsx` | Legacy 003 + v3.5 | English "Settings / Help", "Theme"; contains a ThemeToggle |
| Diagnostics | `CatalogueDiagnostics.tsx` | Legacy 010/v3.5 | English |
| Sync status (011) | `ui/sales-sync/SaleSyncStatus.tsx` (`.sale-sync-status`, `tailwind.css:3237`) | Legacy 011 | **Never mounted**: zero `<SaleSyncStatus` usages. The sync outbox state is invisible to operators. |
| Offline / connection banner | `ui/primitives/StatusBanner/StatusBanner.tsx`; copy in `connection/connection-state.ts:34-38` | Legacy 003 (shared by both frames) | **The state is hard-coded `'online'`** (`connection-state.ts:18-23`). Only the DEV `?conn=` toggle in the legacy AppShell changes it (`AppShell.tsx:45-56`). The banner never appears in production. The copy is mixed, e.g. "الاتصال بطيء — Connection slow". |
| Stuck-shift badge | `shell/StuckShiftBadge.tsx` | Legacy | **Never mounted** |
| Screen too small (under 1024 px) | `ui/states/ScreenTooSmall.tsx` | Legacy 003 | **English-only** "Screen too small / Use a display at least 1024px wide…". Used by both frames. Pairing and sign-in have no such guard. |
| Error boundaries | — | **none** | No `ErrorBoundary` or `errorElement` in any route. React Router's default error page would appear. |
| Static V5 proof (DEV) | `v5/sale/SaleScreen.tsx`, `ProductRail.tsx`, `SaleCart.tsx`, `demo-sale.ts` | V5 static | Still in the tree for `#/dev/sale-proof`. Uses `ج.م` and an "F2" key hint (`ProductRail.tsx:59-61`) that has no binding. |

**Count.** One screen is genuinely V5 clean-room (Sale). One has V5 chrome over v4/v3.5/legacy content (checkout and completion). Sign-in is v4. About 12 surfaces are legacy. About 7 checklist capabilities have no UI.

---

## 4. Specs and design history

### 4.1 `specs/023-pos-ui-clean-room`

- **`spec.md`** (33 lines):
  - Goal: rebuild the presentation "one screen at a time without inheriting legacy composition" (`:5`).
  - Clean-room rule: new DOM, no legacy screen-style dependency, real evidence, owner approval (`:21`).
  - An import/class wall forbids `ui/cart`, `ui/catalogue`, `shell/**` and the legacy class families under `v5/**` (`:23`).
  - Direction: "light, calm, teal-led desktop pharmacy terminal", cart-dominant, 44 px targets, LTR isolation (`:27`).
  - Non-capabilities: Saudi/ZATCA/SAR/15% VAT/mada/insurance/voucher-gift/loyalty/Rx workflow/returns/shift close (`:29`).
  - "Do not change Checkout, Completion, Sign-in, US5, US6" (`:33`).
- **`plan.md`** (37 lines): file map for the static proof, sequence, and review focus (long Arabic names, cart dominance at 1024, the tax-pending line).
- **`tasks.md`** (13 lines): everything is checked except the repo lint gate, which is blocked by `.impeccable/hook.cache.json` (`:79`). The owner approved the static direction on 2026-09-23 (`:81`).
- **`production-integration-plan.md`** (181 lines):
  - Extraction of neutral hooks (`sale/useSaleCartController`, `useSaleCatalogueController`, `useConfirmSaleAdd`, `useCatalogueFreshness`).
  - Slices A1, A2, B, C, D, E, F, G. The cutover checklist is complete (`:134-143`).
  - Risks (`:170-181`): stale-search race, uncaught transport rejection, and a second scan activating Add while the confirm dialog is open.
- **`execution-ledger.md`** (55 lines) records:
  - A–F complete;
  - `cart.snapshot` hydration;
  - polish pass;
  - post-handoff cancel fix;
  - owner approval 2026-09-25 (`:105`);
  - §A4 review closure;
  - G0 frame parity (`:114`);
  - V5 sign-out (`:115`);
  - Slice G cutover (`:116`);
  - Slice H legacy Sale retirement: 26 files and 118 CSS rules removed (`:117-138`).
- **Recorded as not fixed:**
  - checkout `¤` (since fixed by RT-23 `37513ed`);
  - `sales:subscribe` IPC noise;
  - `CheckoutPlaceholder` renders two `h1`;
  - 51 dead CSS classes (`account-row*`, `held-tray*`, `v4-stepper*`, `badge--*`) (`:129`);
  - axe `nested-interactive` on result rows (`polish-pass-review.md:97`).
- **`polish-pass-review.md`** (108 lines): 12 problems and their fixes. Examples: invisible keyboard selection, whispered notices, 0.55-opacity disabled CTA, vertical chrome crowding (4.3 rows at 1024 went to 6–7), overflowing unit price, a scan field that looked like search, the teal-filled active nav, and Unicode glyph icons. Owner approved.
- **`slice-f-visual-review.md`** (55 lines): 14 findings. Finding 8 ("v5 inside legacy app shell") was resolved by G's V5Frame. Finding 9 accepted "15.00 EGP" instead of "ج.م" (shared `money.format`).
- **Pending for 023** (inferred from the ledger):
  - screens other than Sale were never migrated;
  - checkout and completion are not clean-room;
  - no receipt or sale number on completion;
  - the stepper ArrowUp/ArrowDown affordance was lost (`:123`);
  - `payments.discardOnSessionEnd` check (`:115`).
- **`screenshots/`** (98 files): listed in §9. They were captured before RT-23 (`¤` in checkout) and before RT-103 (voucher tile enabled). **No screenshot shows the current checkout** (EGP plus disabled voucher). No screenshot of sign-in or pairing exists anywhere in 023.
- **`security-review/`**: `s-cart-snapshot-review.md`, `s-cart-cancel-post-handoff-review.md`.

### 4.2 `specs/022-pos-ui-v4-rescue`

- `spec.md` (606 lines) contains FR-1…FR-47 and NFR-1…NFR-7 (`:261-387`). Key items:
  - FR-1: light default.
  - FR-3/4: green pharmacy teal; filled large primaries allowed.
  - FR-5: navy for text and structure.
  - FR-6/7: orange for warning only, red for destructive only, blue for info only.
  - FR-8: every value from a token.
  - FR-10: intentional Arabic typeface.
  - FR-12: tabular money.
  - FR-13/21: LTR isolation for Latin segments.
  - FR-14/38: one primary per surface.
  - FR-15: cart dominant.
  - FR-16: amount due is the strongest numeral.
  - FR-19: Arabic-led strings on the cashier journey.
  - FR-20: RTL table order.
  - FR-23: focus order follows RTL.
  - FR-25: connection state as a banner.
  - FR-26: never colour alone.
  - FR-31: no success claim without settlement.
  - FR-33–39: anti-patterns.
  - FR-44: role-aware landing.
  - NFR-1: 44 px targets; NFR-2: keyboard-only operation; NFR-3: WCAG AA; NFR-4: axe.
- `tasks.md`: 59 done, 26 open. Every screenshot-capture task is open: T0A2, T0B2, T0C1, T0C2, T0D1, T0E1, T083, T0F1. All of US5 (states: T090–T095) and US6 (keyboard, a11y, contrast, anti-pattern verification: T100–T106) are open, as are T110–T113. T013a and T017 (completion receipt) are blocked.
- `screenshots/` contains **only `README.md`**. No 022 evidence was ever committed.
- `visual-references/`: `01-visual-system.png`, `02-sign-in.png`, `03-sale-workspace.png`, `04-checkout-tender.png`, `05-sale-success.png`.
- `design-handoff/RECONCILIATION.md`, key points:
  - A: functional truth wins over the mockup (`:13-28`).
  - B, not authorised: ZATCA/QR, 15% VAT, SAR, mada, six tenders, returns, shift close, loyalty, Rx (`:32-64`). The tender set is pinned at three.
  - C: `tokens.css` is provenance only. The repo's measured-contrast tokens win. Values may enter only as token definitions, and `token-guard.test.ts` enforces this (`:68-101`).
  - D: the handoff README maps 4 of the 5 PNG filenames to the wrong screens. The 022 filenames are authoritative (`:105-139`).
  - E: the 1024 px floor is unchanged (`:143-158`).
  - The wordmark "Retail Tower POS" is not authorised in the product (`:162-179`).
  - The `.dc.html` mockups do not render because `support.js` is missing (`:199-227`).
- `design-handoff/forward-references/`: `returns-014.png` and `shift-close-015.png`, both 909×525 crops. They are the only visual references for 014 and 015.
- `design-handoff/tokens.css` is designer provenance only; it uses stock Tailwind red/amber/blue.

### 4.3 `docs/design/pos-v3.5`

- `README.md`: v3.0/3.5 handoff. "Arabic-first (RTL), **dark-default**"; the scope includes credit and insurance co-pay, returns, audit and a customer display (`:1-10`). `design-reference/kit.css` and `pos-app.jsx` are the prototype.
- `defect-register.md` (49 lines):

| ID | Status | Summary |
|---|---|---|
| D-001 | fixed | flaky test |
| D-002 | open | eslint ignores |
| D-003 | escalated | **no open-shift contract** |
| D-004 | open | nav test coverage |
| D-005 | escalated | catalogue has no stock/expiry/interaction; Rx is display-only |
| D-006 | fixed | route gating plus LTR isolation |
| D-007 | resolved as shells | **no VAT, no hold-sale** |
| D-008 | deferred | product flags not on cart lines |
| D-009 | guard | reject prototype client-side change and voucher logic and the extra tenders |
| D-010 | escalated | **dashboard metrics contract-blocked**; demo is dev-only |

  The primitive API baseline is at `:21-49`.

---

## 5. Component vocabulary (production-reachable, with divergences)

| Kind | Implementations (file) | Generation | Divergence |
|---|---|---|---|
| **Buttons** | `.btn` + `--sm/md/lg` + `--primary/secondary/ghost/destructive` (`tailwind.css:391-480`) | Legacy/003 | 44 / 52 px; 120 ms transitions; color-mix focus halo |
| | `ui/primitives/Button/Button.tsx` | 007 | **Not used by any production screen** |
| | `.v5-live-btn` / `--primary` / `--danger` (`live-sale.css:266-303`) | V5 | Disabled opacity .55 vs .5 for `.btn` |
| | `.v5-sale-checkout` CTA, 56–60 px (`sale-screen.css:459`; `live-sale.css:550`) | V5 | |
| | `.v5-frame__sign-out button` (`frame.css:228-258`) | V5 | Uses `--radius-md` (4 px), not `--radius-control` (10 px) |
| | `.payment-surface__confirm` / `__cancel` (`tailwind.css:2288`, **and again** `:2516`) | 006/022 | Two competing rule blocks |
| | `.quick-amount-btn` (`:3592`) | v3.5 | |
| | `method-card` tiles (`:2262` **and** `:3312`; `.tender-method-grid .method-card` at `:2247` **and** `:2435`) | v3.5 + 022 US3 | Duplicated or overlaid definitions |
| | `ReceiptPreview` inline `primaryBtn` / `secondaryBtn` / `ghostBtn` objects | 008 | |
| | Tailwind-utility buttons in `FindSaleReceipt.tsx:97-120` | 008 | |
| | Unstyled native buttons in `ForcedCloseSurface` / `ForceFailSurface` | 004/006 | |
| **Keypads** | `ui/operator/PinPad.tsx` (`.pin-pad`, `tailwind.css:2959`; `dir="ltr"` grid; global window keydown for digits, Backspace, Enter, `:66-81`) | 004/022 | |
| | `ui/payments/AmountPad.tsx` (`.amount-pad`, `:2564`) | v3.5 | Own `formatMinorUnits` with `Math.floor`, which renders negatives wrongly (e.g. −150 → "-2.50") (`AmountPad.tsx:23`; the same pattern is in `MoneyRoll.tsx:22-30`) |
| **Cart rows** | V5 `CartLineRow` (`LiveCartParts.tsx:24-64`) | V5 | |
| | Static proof `SaleCart` `CartLine` (`v5/sale/SaleCart.tsx`) | V5 | DEV only |
| | Checkout `PaymentCartSummary` rows (`ui/payments/PaymentCartSummary.tsx`) | 006 | A second, differently styled rendering of the same lines |
| **Totals** | `.v5-sale-totals` / `.v5-sale-grand-total` (`LiveSaleCart.tsx:339-362`) | V5 | |
| | `.payment-cart-summary` | 006 | |
| | `.payment-surface__amount` (amount due) | 022 US3 | |
| | `.payment-surface__settled-amount` | 022 US4a | |
| | `.amount-due-card` | v3.5 | |
| **Dialogs** | `ui/primitives/Dialog` (`.dialog-panel`, `tailwind.css:1564`) | 007 | **Unused in production** |
| | V5 `SaleDialog` | V5 | Focus-in, Escape, focus restore |
| | Hand-rolled: `TakeoverPrompt`, `ForcedCloseSurface` (`role=dialog`), `CashierManagement` (`role=dialog`), `ReceiptPreview` (`aria-modal=false`) | Legacy | Four different dialog mechanics |
| **Toasts** | `ui/primitives/Toast` (`.toast`, `:1852`) | 007 | **Never mounted**; no toast system exists |
| **Banners / notices** | `StatusBanner` (`:1620`) | 003 | Connection |
| | `ShiftClosedBanner` (`:2720`) | 004 | English |
| | `PrinterFailureBanner`, `DrawerFailureBanner` | 008 | |
| | `InvalidStateBanner` | 002 | Pairing |
| | `.v5-live-notice` (`--danger/--success`) | V5 | |
| | `.v5-live-freshness` (`data-tone`) | V5 | |
| | `.payment-surface__bridge-refusal` / `__reversal-pending-hint` | 006 | |
| | `.dashboard-demo-banner` | DEV | |
| **Status chips / badges** | `ui/primitives/Badge` (`.badge`, `:1802`) | 007 | **Unused** |
| | `OperatorBadge` (English role via `roleDisplayName`) | 004 | Shown in both the legacy top bar and checkout |
| | `ConnectionIndicator` pill (English) | 003 | |
| | `.v5-live-cart-state[data-tone]` | V5 | |
| | `SaleProductFlags` (Rx/controlled, `.v5-live-flag`) | V5 | |
| | `.diagnostics-badge` | 010 | |
| | `method-card__check` "✓" (a glyph, not an SVG) | v3.5 | |
| | `StuckShiftBadge`, `SaleSyncStatus` | Legacy | **Unmounted** |
| **Inputs** | `ui/primitives/Input` (`.input-field`, `:1531`) | 007 | **Unused** |
| | `.v4-field` (ManagerAdminSignInForm) | 022 | |
| | `.pairing-form` code input | 002 | |
| | V5 search field (`:focus-within` ring) and scan field (dashed, mono, `unicode-bidi: plaintext`) | V5 | |
| | `CashEntry` / `ExternalCardTerminalEntry` / `VoucherEntry` inputs (`.tender-row`) | 006/v3.5 | |
| | FindSaleReceipt Tailwind input | 008 | |
| | V5 note textarea | V5 | |
| **Icons** | `v5/foundation/V5Icon.tsx`: search, scan, minus, plus, forward, cross (1.75 stroke SVG) | V5 | Only 6 glyphs |
| | Legacy nav `data-icon` spans are **empty** (`NavRail.tsx:126`; CSS `tailwind.css:621-633`) | Legacy | No glyphs at all |
| | Checkout, completion and receipts use Unicode glyphs (✓, ✕, ⌫) | Legacy | |
| **Layout primitives** | `Workspace` (legacy, 48 px padding, 1280 max) | Legacy | Also used by checkout inside V5 |
| | `CenterStage` (pairing) | Legacy | |
| | `.v4-screen` / `.v4-columns` / `.v4-panel` / `.v4-stack` / `.v4-row` (`tailwind.css:3960-4330`) | 022 | |
| | `.v5-frame*`, `.v5-sale*` | V5 | |
| | `.placeholder-pane` | 003 | |
| | `ws-*` / `panel` / `stat-*` (dashboard, v3.5) | v3.5 | |

**Takeaway.** The 007 primitives are effectively dead in production; only `StatusBanner` is used. Each generation carries its own button, dialog, badge and input vocabulary, and the three layout systems (`Workspace`, `v4-*`, `v5-*`) coexist. Checkout alone stacks `v5-frame` → `workspace` → `payment-surface` / `v4-panel` → `method-card` / `tender-row` / `quick-amount-btn` / `.btn`.

---

## 6. Arabic/RTL, numerals, focus, targets, motion, theming, responsive

**Direction:**
- The root is `<html lang="ar" dir="rtl">` (`index.html:16`).
- Frames redundantly re-set `dir="rtl"` (`V5Frame.tsx:59`, `AppShell.tsx:81`, `sign-in.tsx:209`, and every `LiveSaleWorkspace` section at `:28-158`).
- Latin runs are isolated with `dir="ltr"` on money, indices and quantities (e.g. `LiveCartParts.tsx:28`, `:55`, `:59`, `:80`; `LiveSaleCart.tsx:350`, `:358`; `PaymentSurface.tsx:505-513`, `:567-573`) and with `.v5-ltr { direction:ltr; unicode-bidi:isolate }` (`foundation.css:60-63`).
- The PinPad grid is `dir="ltr"` (D-006).

**Logical properties.** They dominate: 294 logical uses in `tailwind.css` and 112 in the v5 CSS. The physical exceptions are the `.dialog-panel` centring `left: 50%` (`tailwind.css:1585-1590`, documented) and a deliberate `text-align: left` for the amount value (`:2237-2239`).

**Bidi defect in legacy copy.** English sentences inside RTL containers place trailing punctuation on the wrong side. `h-retire-1024-09` shows ".Best-selling items for the current shift" and "Z- / .report".

**Fonts.** The shipped stack is Dubai → Segoe UI → Tahoma → Arial → system-ui (`tailwind.css:110`), with no `@font-face` or bundled file. Mono is for money and codes (`font-family-mono` is used 32 times). `tabular-nums` appears 18 times in `tailwind.css` and 9 times in the v5 CSS.

**Numerals: mixed systems on one screen.**
- **Money is always Latin ASCII.** `shared/money.ts:191-198` produces "123.45 EGP" with no thousands separator. It is used by V5 (`LiveCartParts.tsx:10-12`) and checkout (`format-checkout-money.ts:10-15`).
- **Timestamps use `Intl.DateTimeFormat('ar-EG')`**, which defaults to Arabic-Indic digits. Examples: the V5 freshness line (`LiveProductRail.tsx:24-34`), `SaleSyncStatus.tsx:81`, and counts via `Intl.NumberFormat('ar-EG')` (`SaleSyncStatus.tsx:91-92`).
- **Item counts use Latin digits** with fixed plural nouns: "1 أصناف · 2 وحدات" (`LiveSaleCart.tsx:239-241`). The grammar is wrong for 1.
- **`ShiftClosedBanner` uses the system locale** (`:9`).
- **Catalogue product names can contain Arabic-Indic digits** from the data (`v5-polish-1280-F`).
- There is no documented numeral policy. `docs/product.md:34` says only "Latin numerals appear on receipts".

**Currency.**
- EGP is the only currency (`shared/money.ts:24`).
- Code "EGP" is used in both live V5 and checkout. RT-23 (`37513ed`) replaced `¤`.
- The static proof uses "ج.م" (`SaleCart.tsx:78`, `:88`; `ProductRail.tsx:25`).
- `MoneyRoll` and `AmountPad` render a bare "1500.00" with " EGP" appended in markup (`CashEntry.tsx:259`).
- Bilingual field labels say "(Amount received, EGP)".
- There is no `Intl.NumberFormat` currency formatting anywhere.

**Focus-visible:**
- Global: `:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 2px }` (`tailwind.css:381-384`).
- V5 repeats it (`foundation.css:54-57`; `live-sale.css:295-303`).
- `.btn--primary` swaps to a 4 px color-mix halo (`tailwind.css:442-444`).
- `outline: none` or `0` appears at `tailwind.css:1094`, `1139`, `1486`, `1578`, `3350`, `3394`, `3624`, `4343` and at `live-sale.css:163`, `426`, `sale-screen.css:169`. These are mostly on wrappers that carry `:focus-within` rings (the V5 search field, `live-sale.css:155-165`). Each needs a replacement ring to be confirmed at runtime.

**Touch targets:**
- `--v5-target: 44px` (`foundation.css:18`).
- V5 secondary buttons enforce `min-block-size: 44px; min-inline-size: 44px` (`live-sale.css:98-110`).
- `.btn--md` is 44 px and `--lg` is 52 px (`tailwind.css:422-431`).
- `touchTarget.min` minHeight is set inline across tender controls.
- The Electron runs report "no control under 44×44" for the Sale and checkout flow (`execution-ledger.md:116`, `:127`).
- **Sub-44 candidates in legacy CSS:** `aside[role='status']` at 38 px (`tailwind.css:779-783`, a status row, not a control); `.held-chip` at 36 px (`:3462-3469`, dead). The V5 sub-44 values (`live-sale.css:500` 32 px sticky header; `:543` 30 px total row; `sale-screen.css:323` / `:413`) are non-interactive rows.

**Reduced motion:**
- `tailwind.css:1719`, `1794` (banner entrances) and `:2790-2830` stop the skeleton shimmer, pulse dot, toast and dialog fades, and the spinner.
- V5: `frame.css:208-212` covers only the nav-link transition.
- `MoneyRoll` checks `matchMedia('(prefers-reduced-motion: reduce)')` (`:37`).
- There is a test at `ui/__tests__/reduced-motion.test.tsx`.
- `live-sale.css` / `sale-screen.css` transitions (CTA hover and similar) have no reduced-motion guard. The risk is low.

**Dark mode.** Token-only, via `:root[data-theme='dark']` (§2.3).
- **Defect:** legacy `.nav-rail__entry:hover { color: var(--color-text-inverse) }` (`tailwind.css:588-591`) turns into `#0f1d2e` on `--color-rail-hover` `#142940` in dark mode. That is dark navy text on a dark rail, with very low contrast.
- **Defect:** `.nav-rail__entry--active::before` uses `--color-accent` (`:599-606`), which equals `--color-primary` in both themes. The 4×24 active tab is invisible against the primary-filled active entry.
- The V5 frame offers no theme control, so a terminal switched to dark on a legacy screen stays dark inside the V5 Sale.

**High contrast.** None (§2.3).

**1024 / 1280 behaviour:**
- **Tier hook:** `renderer/viewport/useViewportTier.ts`. Expanded is 1280 px and above, icon-only is 1024–1279, too-small is below 1024. Tier changes are debounced by 100 ms (`:5-47`). `shell/viewport/useViewportTier.ts` re-exports it.
- **V5 frame:**
  - nav 208 px, or 140 px at 1279 and below (`foundation.css:13`, `:45-50`);
  - gutters 12 px, or 8 px at 1279 and below;
  - `main` is a size container `v5-screen` (`frame.css:44-52`).
- **V5 Sale:**
  - `@container v5-screen (max-width: 1120px)` switches to compact tracks: rail 320 px, cart columns `16px 1fr 84px 120px 100px`, and a 2xl grand total (`live-sale.css:36-71`);
  - `(max-width: 900px)` sets the rail to 288 px (`:73-77`);
  - viewport fallbacks `@media (max-width: 1120px)` (`live-sale.css:316`; `sale-screen.css:480`).
  - Captures show about 6–7 cart rows at both sizes (`polish-pass-review.md:89`).
- **Checkout:**
  - `@container payment-surface (max-width: 1216px)` moves the **amount-due panel to row 2, below the methods**; `(max-width: 768px)` and `@media (max-width: 1023px)` collapse to one column (`tailwind.css:2150-2180`).
  - Inside the V5 frame at 1280 the container is about 1070 − 96 px, so the 1216 rule is **always active**.
  - At 1280, during cash entry, the amount due is off-screen: `h-retire-1280-06-cash-entry.png` shows summary and methods only, and the keypad runs to the bottom edge. That is FR-16 tension.
  - At 1024 (`h-retire-1024-05`) everything stacks in one column: amount, methods, summary.
- **Sign-in:** column tracks narrow at 1279 and below (`tailwind.css:4114-4120`).
- **Legacy shell:**
  - The rail is 84 px icon-only at 1024–1279. **Labels are hidden and the icons are empty**, so the rail is unusable by sight at that tier (`NavRail.tsx:126-131`; `h-retire-1024-09`).
  - Kit media rules at 1180, 820 and 720 remain (`tailwind.css:3494-3500`, `:3744-3750`, `:3857`).

---

## 7. Keyboard and scanner handling (locations only)

- **No global hotkey map.** There are no F-key or accelerator bindings anywhere in `src/renderer`. The "F2" hint in the static proof (`v5/sale/ProductRail.tsx:59-61`) is unbound.
- **Scanner.** A keyboard-wedge scanner writes into the dedicated V5 scan field `#v5-live-scan`: `type="text"`, `inputMode="none"`, and Enter as the terminator. The buffer clears after each scan (`LiveProductRail.tsx:104-110`, `:132-152`). There is no global capture, so the field must hold focus. Focus returns to search after confirm or cancel (`LiveCatalogueRegion.tsx:26-33`, `:55`).
- **Typed search** (`LiveProductRail.tsx:93-103`; `stores/useDebouncedSearch.ts:23-60`):
  - 150 ms debounce;
  - minimum 2 characters;
  - Enter searches immediately and bypasses the debounce.
- **Results listbox** (`LiveSearchResults.tsx:69-95`): ArrowUp/ArrowDown and Enter select; `aria-activedescendant`.
- **Dialogs:**
  - `SaleDialog`: Escape dismisses and focus is restored (`v5/sale/SaleDialog.tsx:39-41`).
  - `V5SignOut`: Escape cancels (`v5/frame/V5SignOut.tsx:111-112`).
  - `TakeoverPrompt:84-90`, `ForcedCloseSurface:190-196`, `CashierManagement:55-61`, `ReceiptPreview:75-79` and `primitives/Dialog:42-48` each use their own document or window keydown Escape handler.
- **PinPad.** A window keydown listener takes digits, Backspace and Enter while the component is mounted (`ui/operator/PinPad.tsx:66-81`). Keys also respond to Enter and Space (`:117-120`).
- **Known interaction hazard (recorded, not fixed).** A second scan while the confirm dialog is open sends its Enter to the focused "Add" button (`slice-f-visual-review.md:151`; `execution-ledger.md:98`).
- **Lost affordance.** Stepper ArrowUp/ArrowDown was not ported to V5 (`execution-ledger.md:123`).

---

## 8. Visible defects and inconsistencies found in code

1. **Stale design authorities.** `docs/DESIGN.md` (navy, Inter, dark default) and `.impeccable/design.json` (navy, Inter, light-only, the "no dark default" rule) both contradict the shipped v4 teal, Dubai and light-default tokens, and they contradict each other on the default theme (§1.3). `docs/product.md:34` still names Inter. The tool-facing `.impeccable/design.json` still hard-codes navy in its component CSS.
2. **Legacy rail icon-only tier is blank.** It has empty icon spans and hidden labels (`NavRail.tsx:126-131`; `tailwind.css:621-633`; `h-retire-1024-09`).
3. **Legacy identity strip is always "—".** No `pairedStatus` is passed (`router.tsx:190`; `AppShell.tsx:58-60`).
4. **Dark-theme rail hover contrast failure**, and an **invisible active accent tab** in both themes (`tailwind.css:588-606`, together with the token equality at `:27` and `:237`).
5. **Mixed generations on the checkout and completion screens:**
   - V5 frame, legacy `Workspace`, 006 `payment-surface`, v4 `v4-screen` / `v4-panel`, v3.5 `method-card` / `tender-row` / `quick-amount-btn`, and `.btn`.
   - Duplicate rule blocks: `.method-card` (`tailwind.css:2262`, `:3312`); `.payment-surface__confirm` (`:2288`, `:2516`); `.tender-method-grid .method-card` (`:2247`, `:2435`).
   - An identity badge duplicated with the V5 nav (`PaymentSurface.tsx:453`, `:537`).
   - Bilingual "(Payment method)" headings, and an amount due that falls below the fold at 1280 (§6).
6. **English-only or English-first copy on surfaces reachable in the Arabic frame or the cashier journey:**
   - `ShiftClosedBanner` (`:18`), `ScreenTooSmall` (`:23-27`), `ConnectionIndicator` (`:9-12`), `OperatorBadge` role (`Manager`);
   - `OperatorSlot` "Sign in / not yet available" (`:28-40`), which is stale because sign-in exists;
   - every legacy `Workspace` title (Sales, Inventory, Settings / Help, Returns, Audit, Cashier Management, Catalogue Diagnostics);
   - the English copy in `ForcedCloseSurface` and `ForceFailSurface`.
7. **Four dialog mechanisms** and **three button styling mechanisms** in the receipts code alone: inline style objects in `ReceiptPreview`, Tailwind utilities in `FindSaleReceipt`, and `.btn` in `ReprintAffordance`.
8. **Off-token values:**
   - `text-amber-700` and the non-existent `text-muted-foreground` (`FindSaleReceipt.tsx:105`, `:113`);
   - `rounded-md` (6 px, off-scale);
   - undefined `--font-size-base` (`tailwind.css:3079`);
   - 34 raw font-size literals and hard-coded durations (§2.4);
   - V5 sign-out uses `--radius-md` where other V5 controls use `--radius-control` (`frame.css:232`).
9. **Dead or unused UI:**
   - 007 primitives Button, Card, Dialog, Input, Table, Toast and Badge are not used by production screens;
   - `SaleSyncStatus` and `StuckShiftBadge` are unmounted;
   - `.held-*`, `.account-row*` and `.v4-stepper*` CSS, and 51 dead classes in total (`execution-ledger.md:129`);
   - `tailwind.config.ts` `darkMode: 'class'` is dead.
10. **No production visibility of connectivity or sync state.** The connection is hard-coded online (`connection-state.ts:18-23`) and the sync status is not mounted. This is a "Failure is loud" gap.
11. **Behaviour differs by frame.** The legacy AppShell's printer-banner Reprint is a no-op; the V5 version is wired (`AppShell.tsx:104-106` vs `V5OperationalNotices.tsx:27-41`).
12. **Numeral inconsistency.** Arabic-Indic timestamps and counts appear beside Latin money and quantities on the same Sale screen (§6).
13. **Money formatter duplication.** `shared/money.format`, `MoneyRoll.formatMinorUnits`, `AmountPad.formatMinorUnits` and `formatMinorToInput` all exist. The `Math.floor` versions mis-render negative amounts.
14. **Blank boot frame** (`router.tsx:124`), no error boundaries, and no frame or too-small guard on pairing or sign-in.
15. **Completion has no receipt and no sale number** (blocked; `PaymentSurface.tsx:126-140`). Receipt print is disabled ("Printing lands in Slice 3", `ReceiptPreview.tsx:240`).
16. **Accessibility debt:**
    - axe `nested-interactive` on V5 result rows (`polish-pass-review.md:97`);
    - `CheckoutPlaceholder` has two `h1` (`execution-ledger.md:116`);
    - the frozen-cart line region adds an extra tab stop while editing (`polish-pass-review.md:104`).
17. **Evidence gap.** No committed screenshot reflects `main` after RT-23 (EGP in checkout) and RT-103 (disabled voucher). 022 has zero committed captures. No sign-in, pairing, dashboard-in-dark or error-state captures exist.

---

## 9. Representative existing screenshot paths (paths only, not copied)

**Approved or reference authority (022):**
- `specs/022-pos-ui-v4-rescue/visual-references/01-visual-system.png`
- `specs/022-pos-ui-v4-rescue/visual-references/02-sign-in.png`
- `specs/022-pos-ui-v4-rescue/visual-references/03-sale-workspace.png`
- `specs/022-pos-ui-v4-rescue/visual-references/04-checkout-tender.png`
- `specs/022-pos-ui-v4-rescue/visual-references/05-sale-success.png`
- `specs/022-pos-ui-v4-rescue/design-handoff/forward-references/returns-014.png`
- `specs/022-pos-ui-v4-rescue/design-handoff/forward-references/shift-close-015.png`

**023 static proof (owner-approved direction):**
- `specs/023-pos-ui-clean-room/screenshots/sale-proof-1024.png`
- `specs/023-pos-ui-clean-room/screenshots/sale-proof-1280.png`

**023 V5 Sale polish (owner-approved 2026-09-25), 1024 and 1280:**
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1024-A-empty.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1280-A-empty.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1280-B-search-results.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1280-C-keyboard-selection.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1280-E-confirm-scan-long-name.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1280-F-cart-two-lines.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1280-G-confirm-scan-controlled.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1024-H-cart-many-lines.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1280-J-note-dialog.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1280-K-void-dialog.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-polish-1280-M-frozen-handed-off.png`

**023 production flow after Slice H.** The latest captures; they predate RT-23 (`¤`) and RT-103 (voucher enabled):
- `specs/023-pos-ui-clean-room/screenshots/h-retire-1024-01-sale-empty.png`
- `specs/023-pos-ui-clean-room/screenshots/h-retire-1280-03-sale-one-line.png`
- `specs/023-pos-ui-clean-room/screenshots/h-retire-1280-04-handed-off.png`
- `specs/023-pos-ui-clean-room/screenshots/h-retire-1024-05-checkout-in-frame.png`
- `specs/023-pos-ui-clean-room/screenshots/h-retire-1280-05-checkout-in-frame.png`
- `specs/023-pos-ui-clean-room/screenshots/h-retire-1280-06-cash-entry.png`
- `specs/023-pos-ui-clean-room/screenshots/h-retire-1280-07-settled.png`
- `specs/023-pos-ui-clean-room/screenshots/h-retire-1024-09-dashboard-legacy-shell.png`
- `specs/023-pos-ui-clean-room/screenshots/h-retire-1280-09-dashboard-legacy-shell.png`
- `specs/023-pos-ui-clean-room/screenshots/h-retire-log.json`

**Earlier 023 stages (history):**
- `specs/023-pos-ui-clean-room/screenshots/functional-1280-A2-search-results.png`
- `specs/023-pos-ui-clean-room/screenshots/v5-frame-sale-1280-C-cart-11-lines.png`
- `specs/023-pos-ui-clean-room/screenshots/continuity-1-legacy-cart.png` (the only capture of the retired legacy cart)
- `specs/023-pos-ui-clean-room/screenshots/g-cutover-1280-05-checkout-in-frame.png`

**v3.5 prototype sources (not screenshots):**
- `docs/design/pos-v3.5/POS-Terminal-prototype.html`
- `docs/design/pos-v3.5/design-reference/kit.css`
- `docs/design/pos-v3.5/design-reference/pos-app.jsx`
- `docs/design/pos-v3.5/design-reference/assets/retail-tower-hero.png`

**Absent.** Sign-in, pairing or paired, takeover, the manager surfaces, printer and drawer banners, offline and connection banners, dark theme, the too-small screen, and every state variant (loading, empty, error, gated).

---

## 10. Not verified / assumptions

- No runtime run and no `npm` script, because `node_modules` is absent. Contrast ratios are quoted from source comments, not measured. The "sub-44 px" and "off-screen amount due" claims rely on the committed screenshots and CSS arithmetic.
- Jira and Confluence context was gathered separately (see [02](02-rt25-delta.md), [08](08-rt24-invariants.md)).
- The screenshots are historical: taken on 2026-09-26, before `37513ed` (RT-23) and `28890fa` (RT-103).
