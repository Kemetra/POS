# RT-654: void screen (`/app/void`) on the G-6 vocabulary — UI evidence

**Compare:** open [`compare.html`](compare.html). It shows each implementation capture next to its frozen reference from [`../../visual-acceptance/VD-Void/`](../../visual-acceptance/VD-Void/) (RT-654 phase 1, merged `219ac78`, owner-approved OD-1…OD-8), with filters for width and mode.

* **Captures:** 12 states × 1024×768 and 1280×800 × light and forced colours = 48 PNGs (`rt654-<State>-<W>x<H>[-forced].png`).
* **Source:** the real screen, rendered in the DEV-only harness `#/dev/void-proof?state=<State>` (`src/renderer/v5/void/dev/VoidProof.tsx`). That is the real `AppRouter` at `/app/void` inside the V5 frame, against in-memory `saleVoid` / `approval` bridges. Vite drops the harness from production builds.
* **Data:** fictional, as in the references. The harness times carry the Cairo offset and the capture runs with `timezoneId: 'Africa/Cairo'`, so the absolute times read as drawn.
* **What the captures prove:** layout and presentation only. Void behaviour, the manager-PIN rules, `POS_PULSE_FEATURE_SALE_VOID` and main are unchanged and out of scope.

## Automated checks ([`rt654-capture-log.json`](rt654-capture-log.json))

These ran on every capture, through [`tools/capture-rt654.cjs`](tools/capture-rt654.cjs):

| Check | Result |
|---|---|
| axe-core, whole document (light) | **0 violations** in all 24 light captures |
| Targets under 44×44 (a radio is measured by its whole line) | **none** (was: «بحث», «إلغاء هذا البيع», «تم الاطلاع» at ~22px) |
| Text under 12px | none |
| Arabic text rendered in a monospace face | **none** (was: the sale time and the seller name) |
| Horizontal page overflow | none |
| Panels, headers, dialog or buttons outside the viewport (journal rows scroll inside their list) | none |
| Page errors | none |

## Keyboard-only walk ([`rt654-walk-log.json`](rt654-walk-log.json))

The walk used [`tools/walk.cjs`](tools/walk.cjs), with no mouse after load. **18 / 18 steps pass:**

* **Lookup:** Tab reaches the sale number field; Enter searches and focus stays in the field; Tab reaches «بحث» then «إلغاء هذا البيع».
* **Dialog:** Enter opens it with focus on «رجوع» (the safe control). Tab cycles inside it and never leaves. Esc closes with no request and focus returns to «إلغاء هذا البيع».
* **Confirm:** Shift+Tab reaches the manager radios; Space chooses; Tab reaches the PIN; «تأكيد الإلغاء» enables at a 6-digit PIN. Enter in the PIN field does **not** send (the commit stays a press, as before). Enter on «تأكيد الإلغاء» journals the void, closes the dialog, shows the notice, and focus returns to the sale number field.
* **Refused:** the refusal shows inside the dialog, the PIN is cleared and focus moves to «رجوع».
* **Journal:** Tab reaches the list (a focusable scroll region, OD-5); PageDown scrolls it; Tab reaches «تم الاطلاع».

## What changed, and what did not

* `VoidScreen.tsx`: the `ScreenSection` page header (one `<h1>`) instead of the sunken shift strip; the lookup and «طلبات الإلغاء» as two G-6 panels (OD-1); V5 44px buttons; the sale number and amounts as LTR tabular runs, the time (`<time>`) and the seller in the Arabic text face; refusals as V5 warning notices that keep their `alert` role (OD-4); the journal as card-rows with a toned state pill and glyph (OD-3) in a focusable list (OD-5); the void action in the danger style (OD-2).
* `VoidActionDialog.tsx`: still the V5 `Dialog`; the sale as a summary band of two LTR runs without the dash (OD-7); 44px manager lines; the refusal in an always-mounted slot; «تأكيد الإلغاء» as the danger commit (OD-2).
* `void-parts.tsx` (new): the LTR code / money run and the refusal notice, shared by both.
* `void.css`: the void styles. **`shift.css` is not touched**; the void screen simply no longer imports it (the shift and recovery screens, RT-658 / RT-656, keep their rules).
* `dev/VoidProof.tsx` + one DEV-only branch in `main.tsx`: the harness.
* Copy: unchanged, every string from `void-copy.ts` (OD-6: the requested notice stays verbatim).

### Focus fixes found by the captures (presentation only)

1. After a refused approval the commit is disabled (the PIN is cleared), so focus fell out of the modal onto the page behind it. It now moves to «رجوع», as VD-Void DialogRefused draws.
2. After a void is requested, the dialog's opener («إلغاء هذا البيع») is gone, so focus was lost. It now returns to the sale number field, as VD-Void Requested draws.

## Interpretations the owner should confirm visually

1. **The «سُجّل طلب الإلغاء» notice is green (success)**, as drawn and approved. The V5 tone rule reserves success for proven facts; the request is recorded, not yet confirmed by Backend-Core. The references win here; the owner may prefer the info tone.
2. **The PIN field shows six dots** in DialogReady; the reference drew four, but the manager PIN is 6–8 digits (`MANAGER_PIN_PATTERN`).
3. **After a mouse press on «بحث»**, the button is disabled for the call, so focus does not stay on it (pre-existing, also on the G-6 sales lookup). Enter in the field keeps focus in the field. Not changed here.
4. **The frame's status line** («جارٍ التحقق من الاتصال») shows in the nav footer, as on every V5 screen since RT-604; the references predate it.
