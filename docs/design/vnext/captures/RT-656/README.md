# RT-656: Manager → المبيعات المعلقة on the G-6 page header (evidence)

**Compare:** open [`compare.html`](compare.html). It shows each capture next to its owner-approved
reference from [`RC-Recovery`](../../visual-acceptance/RC-Recovery/RC-Spec.html) (PR #737,
OD-1…OD-7 approved as recommended), with filters for width and mode.

* **Scope:** presentation only. `/app/manager/recovery` (`src/renderer/v5/recovery/`) moves off the
  shift screen's header band (`v5-shift-mgr-head`) and panel / button classes onto the G-6 page
  header (`ScreenSection`, the one `<h1>`), G-6 panels, V5 `Notice`s and recovery-owned V5
  controls. Recovery behaviour, the bridge and main are unchanged.
* **Captures:** 16 states × 1024×768 and 1280×800 × light and forced colours = 64 PNGs
  (`rt656-<State>-<W>x<H>[-forced].png`). Source: the real `RecoveryScreen` inside the real
  `V5Frame` in the DEV-only harness `#/dev/recovery-proof` (RT-441), against its in-memory bridges.
  Dialog and outcome states are reached with the keyboard only.
* **Not captured:** `Loading` and `Unavailable` have references, but the harness answers at once and
  never fails; jsdom covers both (`recovery-g6.test.tsx`, `recovery-screen.test.tsx`).
* **What the captures prove:** layout and presentation only. No main process, PIN store or payment
  FSM runs in the harness.

## Owner decisions applied

| OD | Decision | In the code |
|---|---|---|
| OD-1 | Page header «المبيعات المعلقة», no sub-line, «لوحة المتابعة» current | `ScreenSection title={RECOVERY_COPY.title}`; the frame keeps the nav as before |
| OD-2 | No dates or times | none rendered |
| OD-3 | List failure keeps «تعذّر تنفيذ الإجراء. حاول مرة أخرى.», no retry | unchanged copy, warning notice |
| OD-4 | After a refused PIN, focus returns to the PIN field | `RecoveryActionDialog`: focus effect on a new refusal; test + walk |
| OD-5 | Both cancels neutral | `v5-recovery-btn` without `--primary` |
| OD-6 | Loading as a neutral notice | info `Notice` in the neutral treatment, `aria-busy` |
| OD-7 | «إلغاء البيع» dialog does not name the sale | unchanged |

## One presentation defect fixed on the way

The outcome «اكتمل البيع. الباقي للعميل: 50.00 EGP» was a plain string in an RTL run, so bidi
rendered the amount as «EGP 50.00» (also on main). The amount is now an isolated LTR tabular run, as
the reference draws it. The message string itself is unchanged.

## Automated checks ([`rt656-capture-log.json`](rt656-capture-log.json))

Run by [`tools/capture-rt656.cjs`](tools/capture-rt656.cjs) on every capture; the tool exits
non-zero on any failure:

| Check | Result |
|---|---|
| axe-core, whole document (light) | **0 violations** in all 32 light captures |
| Legacy classes (`v5-shift*`, `v5-live-btn`) | none, in all 64 |
| One `<h1>` («المبيعات المعلقة») | all 64 |
| Text under 12px (main and dialog) | none |
| Control under 44×44 (a checkbox measured by its label row) | none |
| Horizontal overflow | none |
| Page errors | none |

## Keyboard-only pass ([`rt656-walk-log.json`](rt656-walk-log.json))

[`tools/walk-rt656.cjs`](tools/walk-rt656.cjs), no mouse after load. **7 / 7 pass:**

* **Page (Typical, Long):** one full Tab cycle (sign-out reached twice) reaches «إكمال البيع»,
  «إلغاء الدفع» and every «إلغاء البيع» (4 in Typical, 9 in Long).
* **Dialogs (Complete, CancelPayment, CancelSale, NoPin):** opened with Enter; first focus on
  «رجوع»; 12 Tabs stay inside the dialog; Escape closes it and focus returns to the opener.
* **WrongPin (OD-4):** after «تأكيد» is refused, the PIN is cleared and focused.

## Shared CSS

`src/renderer/v5/shift/shift.css` is **not modified**. The recovery screen and dialog no longer use
or import it (or `live-sale.css`); the shift and void screens (RT-658, RT-654) keep every rule.

## Reproduce

```bash
npm run dev:vite &
node docs/design/vnext/captures/RT-656/tools/capture-rt656.cjs docs/design/vnext/captures/RT-656
node docs/design/vnext/captures/RT-656/tools/walk-rt656.cjs docs/design/vnext/captures/RT-656/rt656-walk-log.json
node docs/design/vnext/captures/RT-656/tools/build-compare.cjs
```
