# RT-445 (PK-3, VN-S11): park / resume UI evidence

**Compare:** open [`compare.html`](compare.html). It shows each implementation capture next to its frozen reference from [`../../visual-acceptance/PK3-Park-Resume/`](../../visual-acceptance/PK3-Park-Resume/) (RT-471, merged `dfa65dc`), with filters for width and mode.

* **Captures:** 21 states × 1024×768 and 1280×800 × light and forced colours = 84 PNGs (`rt445-<State>-<W>x<H>[-forced].png`).
* **Source:** the real screens, rendered in the DEV-only harness `#/dev/park-proof?state=<State>` (`src/renderer/v5/park/dev/ParkProof.tsx`). That is the real `AppRouter`, Sale, list, review and shift close, against in-memory bridges. Vite drops the harness from production builds.
* **What the captures prove:** layout and presentation only. The packaged bench is RT-446 (PK-V).

## Automated checks ([`rt445-capture-log.json`](rt445-capture-log.json))

These ran on every capture, through [`tools/capture-rt445.cjs`](tools/capture-rt445.cjs):

| Check | Result |
|---|---|
| axe-core, whole document (light) | **0 violations** in all 42 light captures |
| Horizontal page overflow | none |
| Park / list / review panels, dialog, commit, void outside the viewport | none |
| Page errors | none |
| Targets under 44×44 | only «إدارة الوردية» (71×17), the **existing** operational notice link that the shift flag shows (`V5OperationalNotices`, not touched here) |
| Text under 12px | 2 nodes on the Sale states: the **existing** command-bar field labels «التقاط مسح الباركود» and «البحث بالاسم أو الباركود»; none in any park surface |

## Keyboard-only walk and scanner walk ([`rt445-walk-log.json`](rt445-walk-log.json))

The walk used [`tools/walk.cjs`](tools/walk.cjs), with no mouse after load. **19 / 19 steps pass:**

* **Park:** Tab reaches «تعليق البيع». Enter opens the dialog with focus on the label. Tab stays inside the dialog. Enter parks. The sale clears, the notice shows, and focus returns to the scan field.
* **Close:** Esc closes the dialog with nothing parked. Focus returns to «تعليق البيع» and the sale is kept.
* **D-K1:** F3 and F4 do nothing.
* **List and review:** Tab reaches «المبيعات المعلّقة». The list opens with focus on the newest «استئناف البيع». Enter opens the review with focus on the accept. Tab moves to «رجوع», which goes back to the list with no call. Accept resumes and returns to the Sale.
* **Shift close:** the refusal shows the count. Tab reaches «عرض مبيعاتي المعلّقة», and Enter opens the list.
* **Scanner (RT-239):**
  * a burst in the park dialog is refused with M-S6 and the label is left as it was;
  * a burst on the list, or while the review's accept has focus, is refused with «المسح متوقف — نافذة مفتوحة» (OD-15) and resumes nothing.

## Impeccable audit / harden / polish record

The repo's impeccable skill ships only the `craft`, `shape` and `product` references. So the pass used the shared design laws, `reference/product.md` and `docs/DESIGN.md`, measured against the frozen references.

**Fixed during the pass:**

* **Park dialog layout.** The Dialog pins the panel's last `<div>` as the action row, so the title, summary and form were laid out side by side. The form is now the panel's last child, as in the other v5 dialogs.
* **Focus.**
  * While saving, the disabled submit dropped focus to `<body>`; focus now stays on the read-only field.
  * After an OD-14 re-preview, focus was lost; each new review now focuses its first action.
  * The limit refusal's «عرض المبيعات المعلّقة» was focused before it had rendered; this is now an effect.
* **Bidi.** The conflict sentence rendered «EGP 95.00». The amount is now an isolated LTR run (DESIGN.md: isolate the number, never the sentence). The park label in «عُلِّق البيع ‹الاسم›.» is a `<bdi>`.
* **Numbers.** Money, counts and times are isolated LTR runs with tabular figures that never wrap, as the references' `.num` draws them.
* **Minus sign.** The price difference uses U+2212 for the minus (DESIGN.md numerals); the reference used a hyphen.

**Checked:**

* **Buttons.**
  * 44px floor on every new control; 2px focus outline with 2px offset.
  * Park is neutral (primary-emphasis outline and a pause glyph). Only «إلغاء البيع» carries danger, and a divider separates the two (I-2).
  * One filled primary per region.
* **Forced colours.** Every tag, chip, table, badge and panel has a CanvasText edge. The conflict, «ستُحذف» and the shift alert have 2px edges. Disabled is GrayText and focus is Highlight. «قديم», «ستُحذف» and the price direction each carry an icon and a word, never colour alone.
* **Edge cases.**
  * A 36-character label fits. Longer labels are cut with an ellipsis and shown whole on focus (OD-11).
  * Other covered cases: an empty list, a refused list, no bridge at all (generic line, never an empty list), and transport failure (generic).
  * A second resume press while the preview is pending is ignored.
  * A retry of the same label or the same diff reuses its idempotency key; a new label or diff gets a new key.
  * `session_locked` stays silent (the lock screen covers it).
* **Arabic copy.** Every string is in `src/renderer/v5/park/park-copy.ts`, as drawn and approved (OD-3). The term is «معلّق» everywhere (OD-2): `RECOVERY_COPY.parked` is now «معلّقة».

**Raised, not changed (owner's call):**

* **Typography.** DESIGN.md asks for monospace on amounts. The frozen PK-3 references draw them in the body face with tabular figures, and the implementation follows the references.

## Interpretations the owner should confirm visually

1. **The Sale frame is the shipped Direction B Sale, not the references' simplified Sale.** The park pieces sit where Direction B has room:
   * «تعليق البيع» is next to «إلغاء البيع» in the money column's secondary region, behind a divider;
   * «المبيعات المعلّقة» with its count is on the command bar's status line;
   * the «عُلِّق البيع …» notice is above the workstation.

   The list and review are full screens on `/app/cart/parked` inside the Sale entry, so the nav keeps «نقطة البيع» current and the slim rail shows.
2. **OD-1 quantity.** The review shows the per-unit difference, exactly as drawn. RT-610 now supplies `quantity`, but no reference draws a quantity or a line difference, so none is shown.
3. **«أبقِ البيع الحالي» (OD-8)** is a local back to the parked list, the same as «رجوع». It makes no call.
4. **«عُلِّق البيع.»** With no label, the M-H1 sentence simply ends; the references draw only the labelled case.
