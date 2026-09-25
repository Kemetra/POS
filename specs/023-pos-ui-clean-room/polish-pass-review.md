# 023 V5 Sale + V5Frame polish pass

Presentation-only polish of the DEV-only `#/v5/sale` composition (V5Frame around the live Sale) before the Slice G cutover-readiness pass. Baseline `main` = `origin/main` = `959c68c`. `/app/cart` stays on the legacy screen. Nothing changed in main, preload, IPC, the DB, payment, money, or lifecycle behaviour.

## Problems found

| # | Problem | Why it mattered |
|---|---|---|
| 1 | The keyboard-selected search result was invisible: `aria-selected` moved, but nothing styled it. | Enter picked a row the cashier couldn't see. |
| 2 | Handoff errors and the paid/voided/cancelled acknowledgements rendered at 2xs in muted grey. | Failure and state notices were whispered, which breaks "failure is loud". |
| 3 | The search-recovery buttons ("تعديل البحث" / "حاول مرة أخرى") were unstyled native buttons. | They sat outside the 44px rule. |
| 4 | The disabled CTA was a 0.55-opacity teal. | It read as a pale button that still worked. |
| 5 | A frozen (handed-off) cart had no visible state. | The only clue was that the steppers disappeared. |
| 6 | Vertical chrome stacked up: a 52px titlebar, a 74px eyebrow+heading, a void toolbar on its own row, and a 42px column header. | Only about 4.3 cart rows fit at 1024. |
| 7 | At 1024, "187.50 EGP" overflowed the 76px unit-price column into the product name. | Prices collided with product names. |
| 8 | The scanner field looked like a second search box. | Cashiers could mistake which field takes a scan. |
| 9 | The catalogue freshness status and its refresh button sat inside the search area. | The same styling whether or not search can be trusted. |
| 10 | The active nav entry was filled teal. | It competed with the Sale's one primary action. |
| 11 | Unicode glyphs stood in for icons (⌕ ✚ − ＋ ←). | Rendering was inconsistent. |
| 12 | Found in Electron: a frozen cart's scrolling line area held no focusable content (axe `scrollable-region-focusable`). | It couldn't be scrolled by keyboard. |

## Changes (all under `src/renderer/v5/**`)

- **Frame**
  - The active nav entry is now a soft tint plus bold, with `aria-current` kept.
  - The nav is 140px at the 1024 tier, down from 152px.
  - The brand mark is an SVG.
- **Sale title**
  - The titlebar is 44px.
  - Region headings are one line and the eyebrows are gone.
  - The cart heading carries the count, a derived state label (`مُسلّمة للدفع` / `مدفوعة` / `ملغاة`) and the void entry point, so the toolbar row is gone.
- **Discovery**
  - The search keeps its field.
  - The scanner is a distinct sunken, dashed target with a barcode icon. Its value runs in its own direction (`unicode-bidi: plaintext`, mono font).
  - The result count moved into the results header.
  - Freshness is a status line under the results. It turns warning-toned for never-synced, synced-empty and unavailable.
  - The selected option is tinted, and ringed while the listbox has focus.
- **Cart**
  - The column header is sticky.
  - Rows are compact (64px minimum, 72px with line actions).
  - The unit price is quiet (xs, muted) in an 84px column, sized for "1234.50 EGP".
  - The stepper is 120px with a strong border and SVG −/+.
  - A frozen quantity reads as a value.
  - The line area is a focusable named region, `بنود السلة`.
- **Totals and CTA**
  - The footer is tighter.
  - The CTA gains a hover state and an SVG arrow.
  - Disabled is a sunken neutral.
- **Notices**
  - Danger, success and neutral notices are shown at sm semibold, in the actions area and in the confirm and note dialogs.
- **Dialogs**
  - Dialogs use the overlay shadow.
  - The Latin secondary name aligns with the Arabic.

## Owner decision

**Approved 2026-09-25.** The owner approved these captures as the visual direction for the V5 Sale + V5Frame composition, which satisfies the `spec.md` gate.

## Evidence

Evidence was captured in the real Electron 40 renderer (Vite dev server) with an isolated scratch `--user-data-dir`. The run used the dev fixtures (skip pairing, skip sign-in as manager, seed catalogue), the cart, productSearch and payments flags, and a dead API base. Viewports were set via CDP and `innerWidth` was verified. The full provenance is in [`screenshots/v5-polish-check-log.json`](./screenshots/v5-polish-check-log.json).

**Scratch-DB disclosure:** `dev-p-long` (barcode 6221000009999) was inserted into the scratch DB only, copied from `dev-p-001`.

`screenshots/v5-polish-{1024,1280}-*.png` covers these states:

| Code | State |
|---|---|
| A | empty |
| B | typed results |
| C | keyboard selection |
| D | typed confirm |
| E | long-name scan confirm |
| F | first line: the long-name product added by keyboard at D, then its quantity merged by the scan at E (Panadol is never added) |
| G | controlled/Rx confirm |
| H/I | 11-line cart, top and scrolled |

In the log, each capture's `lines` value lags the add that preceded it by one.
| J | note dialog |
| K | void dialog |
| L | voided → fresh sale |
| M | frozen/handed-off |

**Results at 1024 and 1280:**
- No horizontal overflow.
- No visible control under 44×44.
- No clipped labels or amounts.
- One brand, one `h1`, one `main`.
- About 6–7 cart rows fully visible at both sizes, up from about 4.3 at 1024.

**Axe:** clean except `nested-interactive` on result rows (see below).

**Not captured:** paid state. It needs a real tender through `/app/checkout`, which is outside this pass.

## Remaining, recorded not fixed

1. **Axe `nested-interactive`** (serious, predates this pass): each `role="option"` row contains the "اختيار" button. Fixing it changes the listbox interaction model, so it belongs in a separate behaviour-reviewed change.
2. **Post-handoff void defect** (behaviour, not UI; predates V5):
   - The shared `canVoidCart`/`voidCart` path offers "إلغاء البيع" to managers after handoff and calls `cart.void`.
   - Main refuses that call with `frozen`. The dialog then stays open with no reason shown, confirmed in Electron.
   - Main's `cancelPostHandoff` has no preload or bridge exposure, and legacy `CartPane` uses the same `voidCart`. So production `/app/cart` has the same defect today.
   - It is a correctness item before G, not a V5-only gap.
   - **Resolved on `fix/v5-post-handoff-void`:** `cart.cancelPostHandoff` is exposed through the typed bridge; the shared controller routes a frozen cart to it. Main also now refuses when the cart has a `started` or `settled` payment, since a paid cart stays `frozen_handed_off`.
3. **New tab stop:** the line area (`role=region`, `tabIndex=0`) is also a tab stop while editing. Focus order becomes heading → line area → line controls.
4. **Not re-verified in this pass:**
   - The `/app/sale-v5` legacy-shell preview, the paid state, and the static `#/dev/sale-proof`.
   - Some rules in `live-sale.css` are unscoped: the `@media` grid, `aria-selected` and `:disabled` rules. They reach the proof only when both chunks are loaded in one dev session.
5. Long names clamp to two lines with an ellipsis at 1024. The strength stays visible for the seed long name.
