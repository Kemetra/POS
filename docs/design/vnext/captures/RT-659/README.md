# RT-659: the receipt preview as a V5 Dialog (option A)

**Compare:** open [`compare.html`](compare.html). Each capture sits next to its owner-approved G-6 addendum reference ([`G6P-Receipt-Preview`](../../visual-acceptance/G6P-Receipt-Preview/G6P-Spec.html), approved 2026-10-17), filterable by width and mode.

* **Owner decisions (2026-10-17):** «طباعة» option **(A)**, the button is removed and reprint stays on the result row; the sale number under the title is approved; everything else as drawn.
* **Captures:** 3 states (Ready, Loading, Failed) × 1024×768 and 1280×800 × light and forced colours = 12 PNGs (`rt659-<State>-<W>x<H>[-forced].png`).
* **Source:** the real `AppRouter`, frame, Sales lookup and `ReceiptPreview` in the DEV-only harness `#/dev/one-frame-proof?path=/app/sales&sale=found&preview=<ok|pending|fail>`. The tool types the sale number, presses Enter and opens the preview from «معاينة الإيصال». `preview` is new in this slice: `ok` answers the engine's own `preview` HTML for a sample sale (`src/renderer/v5/frame/dev/preview-slip-fixture.ts`, the same slip the addendum draws), `pending` never answers and `fail` refuses. Vite drops the harness from production builds.
* **What the captures prove:** layout and presentation only, against in-memory bridges. The preview reads `receipts.preview` exactly as before.

## What changed

| Before (008 `ui/receipts/ReceiptPreview.tsx`) | Now (`v5/manager/sales/ReceiptPreview.tsx`) |
|---|---|
| Non-modal `section` with inline `style={}` objects | The one V5 `Dialog`: modal, the frame behind inert, Tab kept inside |
| Its own ✕ («إغلاق المعاينة») and a footer «إغلاق» | «إغلاق» only, focused on open |
| «زر التكبير» (80mm / 160mm) | Removed: the slip renders 80mm wide at 12px mono, the type floor (it was 0.7rem ≈ 11px) |
| «طباعة», always disabled | Removed (option A); reprint stays on the result row |
| Slip as `role="img"` named with the sale id | The slip in a focusable «الإيصال» scroll region; no accessible name carries the sale id |
| Esc listened on `window` | Esc handled by the Dialog; focus returns to «معاينة الإيصال» |
| — | The sale number under the title, as an LTR code that describes the dialog |

The copy is the shipped copy («معاينة الإيصال», «جارٍ التحضير», «تعذّرت معاينة الإيصال», «إغلاق») plus the approved sale number. The failure is a V5 warning `Notice`. `--font-size-slip` and `--font-size-slip-zoomed` are deleted from `styles/tailwind.css`: nothing else used them. Receipt content and format, the print transport, sale access rules and main are untouched; the slip is still the engine's HTML.

## Automated checks ([`rt659-capture-log.json`](rt659-capture-log.json))

These ran on every capture through [`tools/capture-rt659.cjs`](tools/capture-rt659.cjs). The tool exits non-zero if any check fails:

| Check | Result |
|---|---|
| axe-core, whole document (light) | **0 violations** in all 6 light captures |
| One dialog, `aria-modal="true"`, named «معاينة الإيصال», described by the sale number | all 12 |
| Controls in the dialog | exactly «إغلاق», and it has focus, in all 12 |
| 008 leftovers (`data-testid=receipt-preview`, inline styles outside the engine slip) | none, in all 12 |
| Dialog inside the viewport, no text under 12px, no horizontal overflow | all 12 |
| Page errors | none |
| Slip well scrolls (information) | Ready at both widths: the slip is taller than the dialog; the title and «إغلاق» stay on screen |

## Keyboard-only walk ([`rt659-walk-log.json`](rt659-walk-log.json))

[`tools/walk-rt659.cjs`](tools/walk-rt659.cjs), no mouse at all: type the sale number, Enter, Tab to «معاينة الإيصال», Enter. Ready, Loading and Failed at 1024 and 1280. **6 / 6 pass:**

* Focus opens on «إغلاق».
* Tab and Shift+Tab stay inside the dialog: «الإيصال» and «إغلاق» when ready, «إغلاق» alone while loading or failed. Nothing behind it is reachable.
* Esc closes it and focus returns to «معاينة الإيصال». Enter there reopens it; Enter on «إغلاق» closes it with the same focus return.

The jsdom suites pin the same behaviour: `src/renderer/v5/manager/sales/__tests__/ReceiptPreview.test.tsx` (Dialog, focus, Tab, Esc, focus return, loading / failed / no bridge, axe in all three states, no inline style or disabled control in the source) and the RT-659 block in `SalesLookup.test.tsx` (through the real lookup).

## Differences from the references

* **The screen behind the dialog.** Main now shows the RT-542 store-history panel above the lookup; the G-6 frame the addendum reuses predates it. The dialog is what is compared.
* **The focus ring on «إغلاق»** is drawn in the references; the captures open the dialog with a mouse click, so `:focus-visible` does not paint it. The keyboard walk confirms the focus.
* **The slip's mixed Arabic/Latin bands** render as the engine emits them, in both the references and the captures.

## Re-running

With `npm run dev:vite` running, from the repo root. The tools default to the cloud session's Chromium and `playwright-core`; elsewhere set `CHROMIUM_PATH` (and `PLAYWRIGHT_CORE`) to a local install. The repo declares no Playwright dependency, and adding one is out of scope (CLAUDE.md §10).

```bash
node docs/design/vnext/captures/RT-659/tools/capture-rt659.cjs docs/design/vnext/captures/RT-659
node docs/design/vnext/captures/RT-659/tools/walk-rt659.cjs docs/design/vnext/captures/RT-659/rt659-walk-log.json
node docs/design/vnext/captures/RT-659/tools/build-compare.cjs
```
