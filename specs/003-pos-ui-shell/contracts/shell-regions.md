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

The `useViewportTier` hook (`src/renderer/shell/viewport/useViewportTier.ts`) returns
`'expanded' | 'icon-only' | 'too-small'`. It uses `window.matchMedia` (not `resize` events) and
debounces internal transitions by 100 ms; tests assert no more than one tier transition is
dispatched for a single window resize crossing a breakpoint.

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

Rendered by AppShell when `useViewportTier()` returns `'too-small'`. A single full-viewport
panel containing:

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
  When the viewport is `< 1024 px`, NavRail is **not in the DOM at all**.
- **Focus** lands on the heading on first paint. Tab order is empty thereafter (no actionable
  elements).
- **Live updates.** When the viewport crosses back over 1024 px, the panel is unmounted and
  the AppShell remounts; nothing in ScreenTooSmall persists state across that transition.

**Tests this section drives.**

- `ScreenTooSmall.test.tsx` — heading text === `"الشاشة أصغر من 1024×768."`; body text ===
  `"كبّر النافذة أو استخدم شاشة أكبر."` (M-F2, RT-241); exactly one `<h1>`; exactly one
  `<main>`; zero actionable elements (no `<button>`, `<a>`, `<input>`, `[role="button"]`).
- `NavRail.test.tsx` — at `< 1024 px` the NavRail is NOT in the DOM (queryByRole `'navigation'`
  is `null`); no `data-testid="hamburger"` exists at any width.

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
