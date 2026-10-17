# RT-660: Returns content on the shared V5 controls — evidence

**Compare:** open [`compare.html`](compare.html). It shows each implementation capture next to its owner-approved reference from [`../../visual-acceptance/G6-Returns/`](../../visual-acceptance/G6-Returns/G6R-Spec.html) (RT-660 Phase 1, PR #739, merged `826e3d9`; RD-1…RD-10 approved as recommended), with filters for width and mode.

* **Captures:** 32 states × 1024×768 and 1280×800 × light and forced colours = 128 PNGs (`rt660-<State>-<W>x<H>[-forced].png`).
* **Source:** the real screen, rendered in the DEV-only harness `#/dev/returns-proof?state=<State>` (`src/renderer/returns/dev/ReturnsProof.tsx`). That is the real `AppRouter` at `/app/returns` inside the V5 frame, against an in-memory returns bridge scripted per state. The capture script reaches each step by pressing the same visible controls a manager presses. Vite drops the harness from production builds.
* **What the captures prove:** layout and presentation only. RT-15 behaviour is pinned by the returns test suites, which were not weakened.

## What changed

* `ReturnsScreen` and its steps now use the shared v5 controls:
  * `v5-manager-panel` for every step and the journal;
  * `v5-manager-btn` (with the new `--primary` / `--ghost` variants) for buttons;
  * `v5-manager-field` and `v5-manager-input` (new `--code` variant) for the sale number;
  * `v5-manager-facts` and `v5-manager-num` for facts and figures;
  * the foundation `Notice` / `ToneIcon` anatomy for every message;
  * the shared `HonestNotice` for the fail-closed gate (the G-6 honest page).
* `returns.css` and the whole `rt-*` class set are retired. `v5-returns.css` adds only what G6R draws beyond the shared controls: the stepper, the tables, the refund total, the state pills and the outcome/payout layout.
* `V5Icon` gains `status-unknown`, a question-mark glyph for an unconfirmed row (RD-5).
* **Unchanged:** RT-15 behaviour, every Arabic string, the bridge, main, focus order, live regions and roles.

## Automated checks ([`rt660-capture-log.json`](rt660-capture-log.json))

These ran on every capture, through [`tools/capture-rt660.cjs`](tools/capture-rt660.cjs):

| Check | Result |
|---|---|
| axe-core, whole document (light) | **0 violations** in all 64 light captures |
| Horizontal page overflow; panel or table spill | none |
| Page scroll (ScreenSection) | none: every state fits at 1024×768 and 1280×800; only the journal table scrolls (RD-3) |
| Targets under 44×44 | none |
| Text under 12px | none |
| `rt-*` classes left in the DOM | none |
| Page errors | none |

## Keyboard-only walk ([`rt660-walk-log.json`](rt660-walk-log.json))

The walk used [`tools/walk-rt660.cjs`](tools/walk-rt660.cjs), with no mouse after load. **28 / 28 steps pass:**

* **Flow:**
  * The sale-number field has focus on load. Enter looks the sale up, and focus moves to the step heading.
  * Tab reaches the first enabled stepper; Space picks one unit.
  * Tab reaches «احسب مبلغ الاسترداد»; Enter quotes, and focus moves to «ملخص الاسترداد».
  * **Enter on the summary confirms nothing (D3).** Tab reaches «تأكيد الإرجاع»; Space confirms, and focus moves to «نتيجة المرتجع».
  * Tab reaches «افتح الدرج واصرف النقد» before «مرتجع جديد». Enter pays out.
  * Tab then reaches «طباعة نسخة من الإيصال», «مرتجع جديد» and the journal row actions.
* **Manual payout:** after a drawer failure, Tab reaches «صرفتُ المبلغ يدويًا». The confirmation focuses «إلغاء» first, and «إلغاء» goes back with nothing recorded.
* **Journal:** Tab reaches «تحقّق من غير المؤكدة» and the row actions. «صرف ‹رقم البيع›» opens that return's payout with focus on «نتيجة المرتجع».
* **Refusal:** a lookup refusal is an alert, and focus stays in the field.

## Differences from the references

* **The frame.** The captures show the shipped V5 frame, which the references stand in for: the RT-604 status indicator «جارٍ التحقق من الاتصال», and the brand cut to «POS Pu…» at 1024. Both are frame parts, unchanged here.
* **PayoutDrawerFailed, second line — a reference error.** G6R drew «لم تستطع الطابعة فتح الدرج.» (`printer_dk_failure`) beside «حاول فتح الدرج مجددًا». RT-15 never offers a retry for that reason: only `no_drawer_configured` proves the kick never left (P1). The implementation shows the real retryable case, «لا يوجد درج نقود موصول بهذا الجهاز.». Behaviour wins.
* **Focus when a control disables itself.** Two cases drop focus to the screen section:
  * a stepper at its bound;
  * a payout button while its call runs.

  The capture log's `focus` field shows this, in SelectPicked and the Payout states. It is RT-15 behaviour as shipped, and moving focus is out of this slice's scope.
* **Font.** Captured on Linux without Dubai (a fallback face), as with the earlier packs. On Windows the font is Dubai.

## Validation

* **Tests (vitest):**
  * `src/renderer/returns` — every suite, including:
    * the new `returns-v5-controls.test.tsx`, which pins the shared controls and the retirement of `returns.css` / `rt-*`;
    * `returns-proof.test.tsx`, which pins the harness.
  * `src/renderer/v5`.
* **Updated, not weakened:**
  * `returns-frame-css.test.ts` now reads `v5-returns.css` and allows exactly one scroll container, the journal table (RD-3).
  * Five assertions now read the v5 classes instead of the `rt-*` ones.
* **Commands:** `npm run typecheck` and `npm run lint` (eslint and prettier) are clean. The full `npx vitest run` passes: **841 / 841 files, 12,910 tests** (4 skipped, as on `main`), and the coverage gate (`npx vitest run --coverage`, per-file thresholds) passes.

## Reproduce

```bash
npm run dev:vite &
node docs/design/vnext/captures/RT-660/tools/capture-rt660.cjs docs/design/vnext/captures/RT-660
node docs/design/vnext/captures/RT-660/tools/walk-rt660.cjs docs/design/vnext/captures/RT-660/rt660-walk-log.json
python3 -I docs/design/vnext/captures/RT-660/tools/gen_compare.py
```
