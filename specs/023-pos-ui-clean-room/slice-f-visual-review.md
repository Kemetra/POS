# 023 Slice F — real Electron visual/parity review

**Date:** 2026-09-24 · **Branch:** `feat/023-pos-ui-clean-room-sale-proof` (baseline `ca9486c` = `origin/main`) · **Route:** DEV-only `#/app/sale-v5`

**Question:** Does the wired v5 Sale screen still preserve the approved clean-room direction ([1024](./screenshots/sale-proof-1024.png), [1280](./screenshots/sale-proof-1280.png)) after real controls, dialogs, live data and production behaviour were added?

**Verdict (engineering):** Yes, after the small v5-only presentation corrections below, the composition, RTL structure, cart dominance, price/total hierarchy, tax-pending line and CTA prominence match the approved direction. This is not owner approval. The functional state adds visible elements the static proof lacked: a scan field, badges, a void toolbar, dialogs, and the legacy app shell around the screen. Owner reconfirmation on the functional captures is requested.

## Method

- Real Electron 40 renderer from the Vite dev server, run with the sanctioned unpackaged-only fixtures `POS_PULSE_DEV_SKIP_PAIRING`, `POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN` (manager) and `POS_PULSE_DEV_SEED_CATALOGUE`, plus the `cart`, `productSearch` and `payments` flags. Real main-process SQLite cart/catalogue and the real preload bridge; no renderer mocks.
- A fresh `--user-data-dir` profile; the real `pos-pulse` profile was not touched. The API base was pointed at a dead local port, so the fixture device token never reached a backend.
- **Fresh cart per run:** each run reloads the renderer. It boots to `#/app/dashboard`, which never creates a cart, and only then enters `#/app/sale-v5`, whose own controller creates the cart. No run starts from an `/app/cart` cart.
- Driven over the DevTools protocol with real mouse, keyboard and IME-text input events. Viewports are set with `Emulation.setDeviceMetricsOverride` at 1024×768 and 1280×800. Each state records focus target and ring, disabled states, controls under 44×44, and horizontal overflow (`screenshots/functional-*-log.json`).

## Scenario results (both widths)

| Scenario | Result |
| --- | --- |
| A. Initial | RTL two-region composition holds. Cart dominant. Honest empty cart (`—` totals, handoff disabled), "never synced" freshness, search prompt instead of fake browse rows. No overflow. All controls ≥ 44×44 after fixes. |
| A. Search results | Six real seeded rows: Arabic name, English secondary, pack, SKU, EGP price. No empty metadata rows. Controlled/Rx badges shown only when flagged. |
| B. Add confirmation | Keyboard (listbox ↓ Enter) and scan paths both open confirm with focus on **Add** (2px teal ring). Escape closes at once and returns focus to search. Enter on Add adds the line, then focus returns to search. |
| C. Cart interaction | Three scanned adds; + to quantity 3, − to 2, remove. Bridge-confirmed totals: 112.00 → 52.00 EGP. Tax line reads "قيد الإضافة · لا تُحسب هنا". |
| D. Note dialog | Focus in textarea; Save and Clear disabled while unchanged and empty; 230 typed chars capped at 200; Escape closes and returns focus to the opener; saved note renders under the line. |
| E. Void dialog | Focus on the safe "العودة"; Tab moves to "تأكيد الإلغاء" (destructive red); Escape closes and returns focus to "إلغاء البيع". Not confirmed, so the sale continues. |
| F. Handoff → checkout | Handoff freezes the cart (line controls gone, Continue enabled, frozen total 52.00 EGP), then Continue reaches `#/app/checkout`. Checkout not reviewed or changed. |

## Findings

| # | Finding | Class | Action |
| --- | --- | --- | --- |
| 1 | Dialog buttons had no button styling: Cancel/Add ran together as plain text, and Confirm Void had no destructive treatment. | BLOCKING VISUAL DRIFT | Fixed: `v5-live-btn` secondary, `--primary` (Add, Save), `--danger` (Confirm Void); dialog title, name and mono price hierarchy. |
| 2 | Secondary buttons had no padding; "تحديث الكتالوج" and "إلغاء البيع" wrapped; `اختيار` 31px, `حذف` 29px, dialog buttons 23–25px wide. | MINOR VISUAL DRIFT | Fixed: padding, `nowrap`, 44px minimum width. Every state now measures zero controls under 44×44. |
| 3 | Controlled-substance / prescription awareness (shown by legacy on rows and confirm) was missing in v5. | MINOR VISUAL DRIFT (safety-relevant parity) | Fixed test-first with a display-only v5 `SaleProductFlags` (text label, not colour alone). No enforcement added. |
| 4 | Line actions (note/remove) were boxed chrome under each name, noisier than the approved rows. | MINOR VISUAL DRIFT | Fixed: quiet text actions that keep the 44px hit area. |
| 5 | Unit price wrapped "15.00 / EGP" at 1024. | MINOR VISUAL DRIFT | Fixed: money cells `nowrap`. At 1024 the unit price now sits close to the stepper; acceptable. |
| 6 | Search field showed a double focus ring (wrapper plus native input). | MINOR VISUAL DRIFT | Fixed: the wrapper keeps the single `:focus-within` ring. |
| 7 | Scan field looked like an unlabelled empty box, crowded against the search hint. | MINOR VISUAL DRIFT | Fixed: placeholder and spacing. The separate focus-confined scan field stays (production scanner contract). |
| 8 | Under the guarded `/app` route, v5 renders inside the legacy app shell (dark nav, top bar), and its own brand header duplicates the shell brand. The static proof was full-bleed. | KNOWN CUTOVER BLOCKER (owner decision) | Not changed. Shell is outside Sale scope (`shell/**`). Decide before G: keep the shell and drop the v5 brand block, or give Sale a shell-less layout. |
| 9 | Prices read "15.00 EGP" (shared `money.format`) instead of the proof's illustrative "18.50 ج.م". Product rows use a labelled "اختيار" button instead of the proof's inert "+". | MINOR VISUAL DRIFT (accepted) | Intentional: the plan mandates `shared/money.ts` formatting, and a real select action needs a label. |
| 10 | Cart lines show only bridge-confirmed name, quantity and prices; no English/barcode/pack under the name as in the proof. | PASS | Correct: `CartLinesAddResponse` carries no such metadata; nothing is fabricated. |
| 11 | Mouse-opened dialogs show no ring on the initially focused control (`:focus-visible` heuristic); keyboard paths show the 2px teal ring. | PASS | Standard focus-visible behaviour. |
| 12 | Second scan while confirm is open: the scanner's Enter can activate the focused Add (same in legacy). | BEHAVIOR ISSUE — NOT SLICE F | Recorded only. |
| 13 | Transport-level handoff rejection is uncaught; overlapping typed searches can race. | BEHAVIOR ISSUE — NOT SLICE F | Recorded only. |
| 14 | No cart-read bridge: an `/app/cart` cart shows no lines in v5. | KNOWN CUTOVER BLOCKER | Recorded only; every run used a fresh cart. |

## Evidence

`screenshots/functional-{1024,1280}-*.png`: initial, search results, confirm (search and controlled product), cart lines, note dialog, line with note, void dialog, frozen before checkout. Plus the `functional-{1024,1280}-log.json` measurement logs. All captured after the fixes.

## Gates

Typecheck, changed-file ESLint (0 warnings), Prettier, `git diff --check`, and the renderer build with a clean bundle grep for `sale-v5|v5-live|v5-sale|LiveSaleWorkspace|sale-proof` all pass. Full suite with CI coverage thresholds: 496 files, 5,745 passed, 3 skipped. The coverage run also exposed a real v5 crash, now fixed test-first: an unparseable freshness timestamp threw `RangeError`; legacy already guarded this. Repository-wide lint is still blocked by the unrelated ignored `.impeccable/hook.cache.json`.

**Owner gate:** owner reconfirmation of the functional captures is requested, because the added controls and the app shell visibly change the approved appearance. The owner decision on finding 8 is required before G (`/app/cart` cutover).
