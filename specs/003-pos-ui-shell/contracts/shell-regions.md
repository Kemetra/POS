# Contract — Shell Regions

**Feature:** 003-pos-ui-shell
**Plan:** [../plan.md](../plan.md)
**Data model:** [../data-model.md](../data-model.md)
**Status:** planning-time snapshot. Once `src/renderer/shell/` lands, the canonical surface is
the code; this file remains a frozen visual contract for the Figma handoff.

This contract describes the **AppShell layout**: the named regions, the responsive matrix, the
four connection-state visuals, and the hard non-implementation boundaries that make the shell
safe to ship as UI-only.

---

## AppShell composition

```
┌─────────────────────────────────────────────────────────────────┐
│ TopBar                                                          │
│  ┌── IdentityStrip ───┐  ┌── StatusBanner (when not online) ─┐ │
│  │ tenant · branch ·  │  │  …                                  │ │
│  │ terminal label     │  └─────────────────────────────────────┘ │
│  └────────────────────┘  ┌── ConnectionIndicator ────┐  ┌──┐    │
│                          │ online | degraded |       │  │OS│    │
│                          │ offline | syncing         │  └──┘    │
│                          └───────────────────────────┘  Operator│
└─────────────────────────────────────────────────────────────────┘
┌──────┐  ┌────────────────────────────────────────────────────────┐
│ Nav  │  │ MainContent                                             │
│ Rail │  │  <Outlet /> — one of six placeholder panes              │
│      │  │                                                         │
│ ▣ Db │  │                                                         │
│ ▣ Sl │  │                                                         │
│ ▣ Ct │  │                                                         │
│ ▣ Rc │  │                                                         │
│ ▣ Iv │  │                                                         │
│ ▣ St │  │                                                         │
└──────┘  └─────────────────────────────────────────────────────────┘
```

Layout uses **logical CSS properties** (NFR-9): the rail sits at `inline-start`, never hard-coded
`left`. A future RTL flip is non-breaking.

---

## Region inventory

| Region | Element root | Role / landmark | Composes |
|:--|:--|:--|:--|
| `TopBar` | `<header>` | `banner` | `IdentityStrip`, `StatusBanner`, `ConnectionIndicator`, `OperatorSlot` |
| `IdentityStrip` | `<div>` | none (text + Badge) | tokens; `Badge` for terminal label |
| `ConnectionIndicator` | `<div>` | `status` | `Badge` + icon + text |
| `OperatorSlot` | `<div>` | none | `Button` (visibly disabled) + tooltip |
| `StatusBanner` | `<aside>` | `status` (via `aria-live="polite"`) | `StatusBanner` primitive |
| `NavRail` | `<nav>` | `navigation` | `Button` per entry (with React Router `<Link>` semantics) |
| `MainContent` | `<main>` | `main` | `<Outlet />` |

---

## Responsive viewport matrix

| Effective width | Rail behaviour | `MainContent` behaviour | A11y impact |
|:--|:--|:--|:--|
| **≥ 1280 px** | **Expanded.** Each entry shows icon + text label. Active entry is visually distinct (background tint + left-edge accent). | Full width minus rail. | Each entry's accessible name is its label. |
| **1024 – 1279 px** | **Icon-only.** Each entry shows icon only; the label is exposed as the accessible name (`aria-label`) and as a tooltip on hover / focus. Active entry remains visually distinct. | Full width minus rail. | Each entry's accessible name is the same label as in expanded mode. |
| **< 1024 px** | **Not rendered.** | Replaced by `ScreenTooSmall` primitive (a friendly "screen too small" message). | `ScreenTooSmall` is the only landmark in the document. |

**Hard exclusion.** No mobile hamburger drawer, no slide-out menu, no bottom-tab bar is rendered
at any width. (Spec Clarifications §2.)

**Height floor.** Whatever the width, an effective height **under 600 px** is treated like a
width under 1024 px: the rail and `MainContent` are not rendered and `ScreenTooSmall` (height
variant) replaces them. 600–767 px is the **compact-height band**: it renders, but it is not
supported until it is verified on pilot hardware (RT-407). 768 px stays the full reference.

| Effective height | Rail and `MainContent` | Support |
|:--|:--|:--|
| **≥ 768 px** | Rendered. | Full reference. |
| **600 – 767 px** | Rendered (Sale and Checkout run). | Compact-height band; not supported until verified on pilot hardware (RT-407). |
| **< 600 px** | **Not rendered.** `ScreenTooSmall` (height variant). | Blocked. |

> **Amended by RT-313 (2026-10-12).** The height floor and band come from the RT-312 owner
> decisions D1 (600 px floor, 600–767 compact-height band, 768 full reference), D2 (block below
> the floor) and D6 (below the floor, keep the unmount/remount).

The `useViewportTier` hook (`src/renderer/viewport/useViewportTier.ts`, re-exported from
`src/renderer/shell/viewport/useViewportTier.ts`) returns `{ tier, height }`: `tier` is
`'expanded' | 'icon-only' | 'too-small'` and `height` is `'full' | 'compact-height' | 'too-short'`.
`viewportShortfall()` maps that to the floor the viewport is under: `'width' | 'height' | 'both'`,
or `null` when it is supported. It uses `window.matchMedia` (not `resize` events) with four
queries, `(min-width: 1280px)`, `(min-width: 1024px)`, `(min-height: 768px)` and
`(min-height: 600px)`. The height queries read "at least", so a fractional CSS height under 600
px (599.33 px at 150% scaling) is blocked. One 100 ms debounce covers all four queries; tests
assert no more than one transition is dispatched for a single window resize crossing a
breakpoint, including one that crosses a width and a height breakpoint together.

---

## Connection-state visuals

The four states are driven by the `useConnectionState` zustand slice
(`src/renderer/shell/connection/useConnectionState.ts`). Default is `online`. State changes are
exclusively driven by:

- a developer / story toggle (`?conn=online|degraded|offline|syncing` URL search param), and
- explicit `setConnectionState(value)` calls from dev tooling.

**No real network probing, fetch, IPC, or persistence is involved.**

| State | Indicator color | Indicator label | Banner | Behaviour |
|:--|:--|:--|:--|:--|
| `online` | success / `--color-success` | "Online" | hidden | normal |
| `degraded` | warning / `--color-warning` | "Connection slow" | non-blocking warning banner | display only |
| `offline` | danger / `--color-danger` | "Offline" | non-blocking danger banner | display only |
| `syncing` | info / `--color-neutral` | "Syncing…" | non-blocking neutral banner | **display only — no real sync** |

### `syncing` — hard non-implementation list

This list is repeated verbatim from the spec's Clarifications §3. Any contributor adding a real
sync implementation MUST do so in a follow-up feature with its own spec; this feature ships only
the visual.

`syncing` MUST NOT:

- trigger any sync queue, replay, or background job;
- trigger any backend / fetch call;
- touch any persistence (`better-sqlite3`, `SecretStore`, file system, localStorage,
  sessionStorage);
- introduce any new IPC channel;
- change the preload bridge surface;
- contain any actual network synchronization logic.

A guard test in `src/renderer/shell/connection/__tests__/useConnectionState.test.ts` asserts:

- the slice has a single setter and no other mutation path;
- the slice has zero side-effect subscriptions (no `subscribe` listener that calls `fetch`,
  `window.api`, `localStorage`, or any persistence API).

---

## TopBar — region detail

The TopBar is a single horizontal row at the inline-start through inline-end of the viewport.

- **`IdentityStrip`** at inline-start: tenant name (regular weight) · separator · branch name
  (medium weight) · separator · terminal label (Badge, neutral intent). Each value falls back to
  `—` when the paired-terminal state from 002 returns the corresponding field as missing
  (FR-6 edge case).
- **`StatusBanner`** in the centre, only when connection-state ≠ `online`. Non-blocking; no
  destructive action. A11y: `role="status"` + `aria-live="polite"`.
- **`ConnectionIndicator`** at inline-end-minus-OperatorSlot: shows the four-state visual. A11y:
  `role="status"`. Does NOT carry an action — clicking it is a no-op in this feature.
- **`OperatorSlot`** at inline-end: a visibly-disabled "Sign in" Button with a tooltip
  explaining why it is disabled ("Sign-in is not yet available."). A11y: `aria-disabled="true"`,
  non-focusable, accessible explanation via the tooltip's `aria-describedby`.

**Constitution Principle VIII binding.** The OperatorSlot is the only place in the shell that
hints at user identity. Its design MUST visibly disable operator-bound actions and never silently
no-op (spec FR-8 + Constitution VIII).

---

## NavRail — entries

Six entries, in this fixed order:

1. **Dashboard** → `/app/dashboard`
2. **Sales** → `/app/sales`
3. **Cart** → `/app/cart`
4. **Receipts / Checkout** → `/app/checkout` *(hosts the eleven payment-tender visual reservations
   for future 005-checkout-payments — see `shell-routes.ts` §"Payment-tender visual reservation")*
5. **Inventory** → `/app/inventory`
6. **Settings / Help** → `/app/settings`

Each entry uses a React Router `<Link>` styled by Button visuals. Active state is computed from
the current pathname (NavRail does not own routing state).

**A11y.**

- `<nav aria-label="Primary">` wraps the rail.
- Each entry has an accessible name equal to its label, in both expanded and icon-only modes.
- Active entry uses both color and a non-color cue (left-edge accent in expanded, ring in
  icon-only).

---

## ScreenTooSmall

Rendered by AppShell (and by `V5Frame` and `SupportedViewport`) when
`viewportShortfall(useViewportTier())` is not `null`: the effective viewport is narrower than
1024 px, shorter than 600 px, or both. A single full-viewport panel containing:

- **Heading (frozen copy):** `الشاشة أصغر من 1024×768.` — typography token `size.xl`, weight
  `semibold`. Renders as `<h1>` (only heading on the page). `1024×768` is an LTR run inside
  `<bdi dir="ltr">`.
- **Body (frozen copy):** `كبّر النافذة أو استخدم شاشة أكبر.` — typography
  token `size.md`, weight `regular`, colour `text-muted`. Renders as `<p>` directly under the
  heading.
- The `<main>` carries `dir="rtl" lang="ar"` because the notice also renders outside the V5
  frame (pairing and sign-in).

> **Amended by RT-241 (VNext W1-A, 2026-10-08).** The copy is the Arabic message M-F2 from
> `docs/design/vnext/15-vnext-freeze-package.md` §5. The 003 English strings
> (`Screen too small` / `Use a display at least 1024px wide to run POS Pulse.`) are retired.
- **No actions.** No "Continue" link, no "Try anyway" button, no dismiss control.

The two copy strings above are the production strings shipped by 003. They are deliberately
literal in the contract so a future Sonnet pass and the Figma file can match without
ambiguity.

> **Amended by RT-313 (2026-10-12; copy owner-approved as RT-312 D5).** M-F2 has three
> variants, chosen by the floor the viewport is under. The width variant is the copy above,
> unchanged. Every number is a Western-digit run in `<bdi dir="ltr">`; `Windows` stays in the
> Arabic run. The `<main>` carries `data-shortfall="width|height|both"`.

| Variant | When | Heading (`<h1>`) | Body (`<p>`) |
|:--|:--|:--|:--|
| `width` | narrower than 1024 px, at least 600 px high | `الشاشة أصغر من 1024×768.` | `كبّر النافذة أو استخدم شاشة أكبر.` |
| `height` | shorter than 600 px, at least 1024 px wide | `ارتفاع الشاشة أقل من الحد المدعوم.` | `كبّر النافذة، أو اضبط مقياس العرض في Windows على 100% أو 125%.` |
| `both` | under both floors | `الشاشة أصغر من 1024×768.` | `كبّر النافذة، أو اضبط مقياس العرض في Windows على 100% أو 125%.` |

`both` uses the size heading, which is true of both dimensions, with the height action: on a
scaled display, lowering Windows Scale or maximizing the window clears both floors.

The panel grows past the viewport instead of clipping (`min-block-size: 100dvh`, `justify-content:
safe center`), so on a very short viewport the card's top stays reachable by scrolling.

**Accessibility contract.**

- The panel is the **only** landmark on the page when this state is active. Renders as `<main>`
  with `aria-labelledby` pointing at the heading's `id`.
- The heading is the page's H1 (no other H1 elsewhere in the document while ScreenTooSmall is
  active).
- The body is associated with the heading via DOM proximity; it does NOT need
  `aria-describedby` because the heading + paragraph pair is already a recognised pattern.
- **No mobile drawer / hamburger / bottom-tab bar / slide-out menu** is rendered at any width
  while ScreenTooSmall is active — the rail is fully suppressed (Spec Clarifications §2; see
  the responsive viewport matrix above).
- **No hidden navigation trap.** There is no off-screen `<nav>`, no `display: none` rail, no
  `aria-hidden` rail container that an assistive-tech user could "fall into" by accident.
  When the viewport is `< 1024 px` wide or `< 600 px` high, NavRail is **not in the DOM at all**.
- **Focus** lands on the heading on first paint, and on the new heading when the variant
  changes (for example from `height` to `both`), so the new message is announced. Tab order is
  empty thereafter (no actionable elements).
- **Live updates.** When the viewport crosses back over both floors, the panel is unmounted and
  the AppShell remounts; nothing in ScreenTooSmall persists state across that transition.
- **Focus on return (RT-313).** A remounted screen that focuses its own control (the Sale's
  scan field, the pairing code) keeps it. Otherwise focus lands on the guard's defined target,
  never on `<body>`: `MainContent` (`main.app-shell__content`) in AppShell, `main.v5-frame__main`
  in `V5Frame`, and `SupportedViewport`'s own box (`.v5-supported-viewport`) outside the frame.
  Each target has `tabIndex={-1}`: focusable by script, never a Tab stop. `SupportedViewport`
  uses its own box rather than the screen's `<main>` because a screen that remounts through a
  loading state (Ready) replaces its `<main>`, which would drop focus back to `<body>`.
- **Scanner input (RT-313).** While the notice shows, the screen and its scan owner are
  unmounted, so a scanned code reaches no field and adds nothing; the scan guard reports that
  scanning is unavailable.

**Tests this section drives.**

- `ScreenTooSmall.test.tsx` — heading text === `"الشاشة أصغر من 1024×768."`; body text ===
  `"كبّر النافذة أو استخدم شاشة أكبر."` (M-F2, RT-241); exactly one `<h1>`; exactly one
  `<main>`; zero actionable elements (no `<button>`, `<a>`, `<input>`, `[role="button"]`).
- `NavRail.test.tsx` — at `< 1024 px` the NavRail is NOT in the DOM (queryByRole `'navigation'`
  is `null`); no `data-testid="hamburger"` exists at any width.
- RT-313: `screen-too-small.test.tsx` (the three variants, the LTR digit runs, focus on entry
  and on a variant change, axe); `useViewportTier.test.ts` (599/600, 767/768, combined
  crossings, one shared debounce); `AppShell.too-small.test.tsx`, `v5-frame-viewport.test.tsx`
  and `viewport-guard-routes.test.tsx` (the height floor ±1, the `both` variant, focus on
  return); `v5-resize-safety.test.tsx` (cart and tender kept across the width, height and both
  floors; scanner input during the notice reaches no field).

---

## Tests this contract drives

- `AppShell.test.tsx` — landmarks present, exactly one `<main>`, exactly one `<Outlet />` mount.
- `NavRail.test.tsx` — six entries; expanded layout @ ≥ 1280 px; icon-only @ 1024–1279 px;
  `< 1024 px` renders ScreenTooSmall; **NO** hamburger drawer rendered at any width (assertion
  on `data-testid="hamburger"` not present).
- `ConnectionIndicator.test.tsx` — four states render with distinct color + label + a11y name;
  `syncing` is exercised and asserts no fetch / IPC / persistence call is observable (the test
  spies on `globalThis.fetch`, `window.api`, `window.localStorage` and asserts zero calls).
- `OperatorSlot.test.tsx` — `aria-disabled="true"`; non-focusable; tooltip carries the
  explanation; click is observably a no-op.
- `useViewportTier.test.ts` — returns the correct tier for each documented range; transitions
  deterministically once per breakpoint crossing.
- `useConnectionState.test.ts` — default `online`; setter is the only mutation; zero side-effect
  listeners.
- **Static no-touch source-scope guard** — fails the run if any file matching the forbidden
  allowlist is added, modified, or deleted by this feature's commits. Forbidden allowlist
  (frozen): `src/preload/**`, `src/main/ipc/**`, `src/main/pairing/**`, `src/main/secrets/**`,
  `src/shared/bridge-api.ts`, `src/shared/api-types.ts`, `migrations/**`,
  `scripts/codegen-api.ts`, `scripts/openapi-snapshot.json`. Deterministic check:
  `git diff --name-only origin/main...HEAD` (triple-dot, squash-merge-safe). See `plan.md` Phase 2
  step 8 for the full mechanism and fallback.
