# 14 — RT-159 packaged re-audit and Impeccable critique (current `main`)

> **Status: planning evidence for the RT-159 freeze. It is not RT-159 acceptance and authorises no
> implementation.** This document re-runs the audit of [12](12-cashier-ux-usability-audit.md) on
> current GitHub `main`, mostly on the **packaged** build, and adds an Impeccable critique. The
> freeze package that uses these results is [15](15-vnext-freeze-package.md).
>
> This is docs only: there is no production code, dependency, IPC, DB, API, payment, sync or ERP
> change. RT-24 is still the behaviour authority, and wherever a finding touches behaviour it is
> raised for a decision rather than designed around. Work Mode: **Planning**, Jira RT-159 (Epic RT-106).

## Baseline

| | |
|---|---|
| Repository | `Kemetra/POS`. Worktree `claude/rt-159-execution-03a222`, with `HEAD == origin/main` checked after `git fetch` |
| Verified `origin/main` | `7b6839829c2f5a097c2c29d1a00d8bffdee0cf83` (RT-17 runbook docs on top of `175ac1f`, RT-235 `8b6322b`, RT-26, RT-117, RT-202 and RT-15) |
| Packaged build | Built from that SHA with `npm ci`, `npx electron-rebuild -f -w argon2`, `npm run build` and `npm run package:dir`. Electron 44.5.1. `POS Pulse.exe` sha256 `31da6baf…3b6e`; `app.asar` sha256 `9d011e02…c916` |
| Lab | rt9 Backend-Core `481eb26`, with `POS_RETURNS_ENABLED=true` and `POS_SALE_TENDERS_ENABLED=true`. The ERP stack was off. The owner minted a fresh pairing code and the run used a fresh profile `D:\rt159-userdata`. POS flags `CART`, `PAYMENTS`, `SALE_FINALIZATION`, `PRODUCT_SEARCH`, `SHIFT_CASHUP` and `RETURNS` were all `1` |
| Catalogue | 25 synthetic lab products `RT159-01…25` with EAN-13 barcodes `2001590000NNC` (in-store range), plus the 3 RT9 items. The products were seeded into the lab Backend-Core DB with the owner's approval; an undo script is kept outside the repo. Synthetic data only |
| Display | Primary 2560×1440 at 100 % (96 dpi). The packaged window shows a native menu bar about 25 px tall, so the client area was set to **1280×825 and 1024×793**, which gives page viewports of exactly **1280×800 and 1024×768** |
| Date | 2026-10-07 (Africa/Cairo). Lab times in the evidence are UTC (2026-10-06 22:42–23:15Z) |

## Evidence labels

| Label | Meaning |
|---|---|
| **R-pkg** | Packaged exe on the lab, **driven by scripted OS input**: Win32 `SendInput` for mouse and keys, with a keyboard-wedge burst at about 5 ms per character followed by Enter. Captures were taken with `PrintWindow`. The packaged build refuses CDP (RT-164), so no in-page script ran. Evidence comes from captures, the read-only `pos-pulse.db` and `logs/main-*.log`, and `docker logs rt9-api`. **This is not a human run and the scanner input was emulated.** Scripted durations are not time-on-task. |
| **R-hw** | The owner at the keyboard with the **real Honeywell wedge scanner**, reading the barcodes from a monitor. |
| **R-dev** | The built bundle under unpackaged `electron.exe` with dev flags and a fixture manager, driven over CDP. Used only where it measures something R-pkg cannot (computed styles, focus element, axe, forced colours). |
| **C** | Read in source at `7b68398`; not run. |
| **N** | Not run. |

**Run hygiene.** The owner's chat message pulled foreground focus away during the first 22-item
scan loop, so items 10–23 of that loop were lost. That loop is excluded from the evidence, and
the second, slower loop (all 14 items added, verified in the DB) is the one used. The window was
resized only between scenarios.

---

## 1. Scenario matrix on current `main`

| # | Scenario | Label | Result |
|---|---|---|---|
| 0 | First-run pairing → catalogue | R-pkg | The read-down ran right after in-session pairing: 28 products and 27 barcodes were in place at 22:42:10Z with no restart. **RT-202 fixed on packaged `main`.** |
| 1 | Barcode-heavy sale | R-pkg | 23 distinct lines added through the scan field. Each item needs **2 cashier actions**: click the scan field, then Enter on the confirm dialog ([K02](references/audit-rt159-pkg/K02-scan-confirm-dialog-1280.png)). A second scan without a click lands in the **search** box ([K03](references/audit-rt159-pkg/K03-second-scan-lands-in-search-1280.png)). |
| 1b | Same, real scanner | R-hw | The owner's Honeywell read the on-screen EAN-13 barcodes. Three lines were added ([K30](references/audit-rt159-pkg/K30-real-scanner-owner-run-1280.png)). Whether focus behaved as in R-pkg is **pending the owner's account** of steps 2–3 (§6). |
| 2 | Search-heavy sale | R-pkg | Typing «باراسي» returns 3 results with the first highlighted. The keyboard path is `Tab` `Tab` `Enter` → confirm dialog → `Enter`, which adds the item, and a repeat of the same SKU merges into its quantity ([K07](references/audit-rt159-pkg/K07-search-results-1280.png)). |
| 3 | 20+ line cart | R-pkg | 23 lines. **About 6.5 rows are visible at 1280 and about 6 at 1024** ([K05](references/audit-rt159-pkg/K05-long-cart-23-lines-1280.png), [K06](references/audit-rt159-pkg/K06-long-cart-23-lines-1024.png)). The newest line is **not** scrolled into view. With the drawer banner and the shift banner showing, the cart drops to **about 3.5 rows at 1280** ([K14](references/audit-rt159-pkg/K14-offline-sale-no-signal-banner-shift-1280.png)). |
| 4 | Quantity / remove | R-dev | There is no typed quantity. `حذف` (delete) acts immediately with no undo, and focus moves to `<body>`. A scan with focus on `+` or `حذف` changes the quantity or deletes the line. |
| 5 | Checkout → Back → edit | R-pkg | Pressing `Esc` before a tender method is opened returns to the same editable cart (`cart.return_to_sale.ok`). **RT-26 works on packaged `main`.** |
| 6 | Cash with change | R-pkg | 992.25 due and 1000 received. Before apply the screen shows 7.75 (correct). **After apply it shows «الباقي للعميل 1000.00»** while the DB holds `change_due_minor = 775` ([K10](references/audit-rt159-pkg/K10-cash-applied-change-shows-received-1280.png)). The same happened in the offline sale (100.00 shown, 10.50 correct). |
| 7 | Card cancel | R-pkg | «إلغاء» after an applied card reverses it in one click. There is no confirmation and no "void it on the terminal" warning (`tender.reversed`, `payment.cancelled`, no supervisor) ([K18](references/audit-rt159-pkg/K18-card-cancelled-back-refused-1280.png)). |
| 8 | Card UNKNOWN | N | There is no UI path. The external terminal result is recorded by hand. |
| 9 | Network loss while selling | R-pkg | `docker stop rt9-api` at 22:54:22Z. The sale completed and was stored, and the sync state became `pending` with `no_connection`. **Nothing on the Sale, Checkout or Completion screens shows offline or pending sync.** The legacy Sales screen still shows a green «Online» pill ([K15](references/audit-rt159-pkg/K15-sales-legacy-online-pill-while-api-down-1280.png)). After `docker start rt9-api` at 22:57:11Z the sale was `synced` at 22:57:31Z, after 5 attempts. |
| 10–11 | Inactivity lock (draft / live tender) | not re-run | Covered by RT-117/RT-112 packaged evidence (Jira RT-117 comments; RT-159 10804 and 10806). The lock contract is RT-116, Done. |
| 12 | Receipt / print | R-pkg | `os_print:success` and `print_events.outcome = success` were recorded even though the Windows queue was **paused**, so "printed" means *spooled*. Completion still says «لم يصدر إيصال بعد» ([K12](references/audit-rt159-pkg/K12-completion-1280.png)). |
| 13 | Restart with a live tender | R-pkg | A cashier applied cash 18.50, the window was closed gracefully and the app relaunched. The DB still holds the tender `applied`, the attempt `started` and the cart `frozen_handed_off`. **The UI shows an empty Sale with no notice and no route to the payment** ([K27](references/audit-rt159-pkg/K27-restart-applied-tender-not-shown-1280.png)). This is RT-159 10810 again, on current `main`. |
| 14 | Manager-gated action | R-pkg + C | Cancel after a card is applied is not gated (scenario 7). There is still no credential-backed manager approval (RT-114 To Do). |
| 15 | Return / refund entry | R-pkg | The manager can open `/app/returns`. It works only with the **full** sale number `RT-159 audit-2026-10-06-000001`; «000001» returns «لا يوجد بيع بهذا الرقم». The full number is shown nowhere on Completion ([K19](references/audit-rt159-pkg/K19-returns-line-picker-1280.png)). For a cashier the Returns navigation entry is hidden. |
| 16 | Shift open / close | R-pkg | The cashier lands on Sale with the banner «لا توجد وردية مفتوحة…». Selling, checkout and **applying cash all work with no shift open** (see N-06). Open with float 500, then a blind count of 495: the close is recorded with `variance_minor -500` and no approver (RT-17 policy), and the cashier sees only «أُغلقت الوردية.» ([K28](references/audit-rt159-pkg/K28-shift-open-1280.png), [K29](references/audit-rt159-pkg/K29-shift-closed-1280.png)). |
| — | First PIN (RT-235) | R-pkg | **Refused about 19 min after the manager signed in**, with the English message "Action could not be completed. Please try again.". Retrying does not help. It succeeded 33 s after a fresh sign-in (see N-01) ([K21](references/audit-rt159-pkg/K21-first-pin-refused-expired-jwt-1280.png)). |
| — | Cashier sign-in | R-pkg | Roster tile → PIN pad, with digits typed from the keyboard → `cashier_sign_in signed_in`, online admission. The PIN card sits **below the fold** at 1280 and at 1024 ([K22](references/audit-rt159-pkg/K22-signin-1280.png)–[K24](references/audit-rt159-pkg/K24-cashier-pin-pad-1280.png)). |

## 2. Status of the preliminary findings (F-01…F-29, doc 12) on `7b68398`

| ID | Status on current `main` | Evidence |
|---|---|---|
| F-01 scan activates the focused `+` / `حذف` | **Still present** | R-dev (`+` → qty 3; focused `حذف` → line deleted) |
| F-02 scan into cash amount | **Still present** (6,220,999,999,375.00 change shown, confirm enabled) | R-dev ([K31](references/audit-rt159-pkg/K31-rdev-barcode-scanned-into-cash-amount-1280.png)) |
| F-03 change shows the amount received after apply | **Still present** | R-pkg ×2, R-dev |
| F-04 inactivity ends session / sweeps tender | **Fixed by RT-117** (LOCKED state) | RT-117 / RT-112 packaged evidence |
| F-05 card cancel one click, no warning | **Still present**. Owned by RT-116 §3 | R-pkg |
| F-06 restart drops the draft from view | **Still present** for a live tender (scenario 13). Owned by RT-116 S4/S5 | R-pkg |
| F-07 focus returns to search after add | **Still present** | R-pkg, R-dev |
| F-08 confirm on every scan; scan during dialog dropped | **Still present.** A possible variant (N-07) was not reproduced. **Superseded in direction by owner decision D-C1** (§5) | R-pkg, R-dev |
| F-09 commit controls render as plain text | **Still present** («تأكيد الدفع النقدي», transparent, 0 border). The final «تأكيد الدفع» is teal | R-pkg, R-dev |
| F-10 amount due off-screen | **Worse with a long cart.** With 23 lines, Checkout shows **no amount due at all** in the first viewport. The due block and the commit sit about two screens down ([K08](references/audit-rt159-pkg/K08-checkout-long-cart-no-amount-due-1280.png), [K11](references/audit-rt159-pkg/K11-settle-button-two-screens-down-1280.png)) | R-pkg |
| F-11 completion lacks change, sale number, print state | **Still present.** The data now exists: `sales.sale_number`, `receipt_number`, `print_events` and `sale_sync_state` are all populated, and `SaleSummary` is on the bridge (`sales.read`, `findByNumber`) | R-pkg, C |
| F-12 no Back from Checkout | **Fixed (RT-26)** | R-pkg |
| F-13 no decline / UNKNOWN outcome | **Still present** | R-pkg |
| F-14 sign-in layout | **Still present.** Three cards scattered, the PIN card below the fold, «Staff code · كود الموظف», «Cashier» | R-pkg |
| F-15 connection state invisible / fake | **Still present, now packaged-proven:** «Online» while the API is down | R-pkg |
| F-16 qty only via +/− | Still present | R-dev |
| F-17 delete without undo | Still present | R-dev |
| F-18 newest line not scrolled into view | **Still present** | R-pkg |
| F-19 long keyboard path | Still present (45 Tabs for 10 lines) | R-dev |
| F-20 drawer banner | **Worse.** About 178 px, bilingual, on every screen including the cashier's next session and after restart. It shifts the layout and leaves 3.5 cart rows when combined with the shift banner. axe flags it `serious` | R-pkg, R-dev |
| F-21 scan on a paid cart → «حاول مرة أخرى» | Still present, now with an English suffix «(could not add — try again)» | R-pkg |
| F-22 sign-out focuses the destructive button | Still present | R-dev |
| F-23 manager gate not credential-backed | Still present (RT-114 To Do) | C |
| F-24 cash pad noise / mirrored keypad | Still present. The cash pad is mirrored (3-2-1) while the **PIN pad is LTR (1-2-3)**, so the app has two different keypad layouts | R-pkg |
| F-25 legacy English shell | Still present (landing Dashboard, «Coming soon», «Dark», Sales, Cashier Management) | R-pkg |
| F-26 bilingual labels / bidi punctuation | Still present («(Payment method)», «(Complete on the… confirm.», «.dashboard», «First PIN set.») | R-pkg |
| F-27 Arabic-Indic digits in names | Still present («٢٤», «١٤», freshness time «٠١:٤٢») | R-pkg |
| F-28 pairing screen English | Still present (now also the «Ready / Continue» screen after restart) ([K26](references/audit-rt159-pkg/K26-restart-ready-screen-english-1280.png)) | R-pkg |
| F-29 void dialog lacks count / total | Not re-run | — |

## 3. New findings (N-series)

Severity follows the RT-159 model (S0 safety / financial integrity · S1 blocks or seriously
confuses a primary task · S2 efficiency / error rate · S3 consistency / a11y · S4 nice-to-have).
"Owner" names where the behaviour already lives. **None of these is fixed or ticketed here.**

| ID | Finding | Evidence | Sev | Owner / decision needed | Class |
|---|---|---|---|---|---|
| **N-01** | **First-PIN provisioning only works within the Clerk JWT lifetime after the manager signs in.** POS holds the sign-in JWT and never refreshes it. About 19 min later Backend-Core answers `401 clerk_jwt_invalid` on `/api/pos/v1/operators/roster`, and the POS shows the English "Action could not be completed. Please try again.", which retrying cannot fix. The same expired JWT made the manager's sign-out refused at the backend, so the next manager sign-in needed a **takeover**. First failing boundary: the POS main-process `jwtHolder` serves the stale sign-in JWT (`pin-management.ts` → `listRoster`). Known open question **OQ-9** (no local refresh, "renewal via re-sign-in", specs 016/017) | R-pkg + `main-*.log` (`provision_cashier_pin.refused not_signed_in` ×2, then `success` 33 s after re-sign-in) + `docker logs rt9-api` | **S1** (pilot first-run blocker: a manager must sign in again right before setting a PIN) | RT-235 / OQ-9 (028). **Needs a Planning decision**: refresh, re-auth prompt, or truthful copy ("sign in again to continue") | **Pilot** |
| **N-02** | **Primary and destructive actions swap screen positions.** Before a card is applied, «إلغاء» sits alone at the bottom inline-start. After apply, «تأكيد الدفع» takes exactly that spot and «إلغاء» moves. A click aimed at Cancel settled the payment during this run | R-pkg ([K16](references/audit-rt159-pkg/K16-card-entry-cancel-position-1280.png) → [K17](references/audit-rt159-pkg/K17-card-applied-commit-takes-cancel-position-1280.png)) | **S1** (a financial commit by slip) | VNext layout (VN-S4): stable action slots | **Pilot** |
| **N-03** | **The long-cart Checkout hides both the money and the commit.** With 23 lines the order summary pushes «المبلغ المستحق» and «تأكيد الدفع» about two viewports down. This violates I-3 and the Never-Scrolled-Away rule | R-pkg (K08, K09, K11) | **S1** | VN-S4 (pinned ledger) | **Pilot** |
| **N-04** | **No offline or pending-sync signal on any cashier surface, and a false «Online» on legacy surfaces** while the API is down. The sale is safe locally and drains when the API returns | R-pkg (K14, K15; `sale_sync_state` pending → synced) | **S1** | X-2, VN-S6. The state source is RT-113 (In Review) | **Pilot** |
| **N-05** | **An applied tender survives a restart and is invisible.** After the restart no shift accounts for it either (N-06) | R-pkg (scenario 13) | **S0** (real cash in the drawer that no screen or shift shows) | RT-116 S5 (stuck-attempt re-attach) and RT-17 | **Pilot** |
| **N-06** | **Selling and taking cash are possible with no open shift. This is by design:** RT-17 comment 10919 and `ShiftNotice.tsx:20-31` say the notice does not block a sale, because blocking would strand a manager. The shift flag is **off on pilot terminals** until the owner accepts RT-17 (`docs/runbook/pilot-terminal-provisioning.md` flag row). *Not tested:* whether a **settled** cash sale made before the shift opened counts in that shift's expected cash. The 18.50 left out of the close here was an unsettled, orphaned tender (N-05), not a settled sale | R-pkg (scenario 16), C | S2 (needs a check, not a redesign) | RT-17: confirm the pre-shift sale attribution on the bench | Pilot-conditional (only when the flag is on) |
| **N-07** | A confirm dialog was seen ignoring Enter and swallowing later scans (K04). This was **observed once, after the owner's chat message took foreground focus in the middle of the loop. It was not reproduced:** the deterministic re-check could not run because the window was minimized | R-pkg (K04), not reproduced | S2 (unconfirmed) | VN-S5. Retired for scans by D-C1 | Re-test while any dialog remains |
| **N-08** | **The drawer-failure banner is persistent and cross-session.** It survives «بيع جديد», cashier sign-out and sign-in, and a restart. It pushes the workspace down about 178 px, so click targets move | R-pkg | **S2** (capacity and target shift; amber noise trains the cashier to ignore real warnings) | VN-S6 banner consolidation; behaviour of the drawer state owned by 008 | **Pilot** |
| **N-09** | **"Printed" is recorded for a paused or erroring queue.** OS-print success means spooled | R-pkg (queue paused; `print_events.outcome success`) | S2 (claims a fact the POS cannot prove) | Copy: «أُرسل الإيصال للطابعة», not «طُبع». The contract wording belongs to 008 | Pilot (copy) |
| **N-10** | **The sale number is not quotable.** It embeds the free-text terminal label with a space, plus a UTC date that differs from the Cairo calendar day after midnight, e.g. `RT-159 audit-2026-10-06-000001` at 01:53 local. Returns require the full string | R-pkg | S2 | Sale-number format is a 008 contract. **Planning decision** (short display form plus searchable recent list) | Pilot-conditional |
| **N-11** | **Cashier management (RT-235) is a functional placeholder.** English, with Unlock, Reset PIN and Set first PIN shown for every cashier whatever the state, a single unconfirmed PIN field and no PIN status | R-pkg (K20, K21) | S2 | VNext manager surface (RT-159 comment 11093) | Pilot (manager surface) |
| **N-12** | **Back is disabled with no visible reason while a tender entry panel is open at zero funds.** `Esc` first closes the panel (RT-24 layer order), but nothing says so | C (`PaymentSurface.tsx:132-133`), R-pkg | S3 | VN-S4 copy / affordance (behaviour is per RT-26) | Post-pilot |
| **N-13** | After a card reversal, the line «لا يمكن الرجوع إلى البيع بعد تسجيل أي مبلغ» stays while 0 is applied. This is **by contract** (`tenderBlocked` counts a reversing cancel), but it reads as stale | R-pkg (K18), C | S3 | Copy only (message catalog) | Post-pilot |
| **N-14** | The packaged build shows a native `File / Edit / View / Window` menu. `View → Reload` is a reload route in the middle of a tender | R-pkg | S3 (flag only) | Electron shell. **Planning check** (hide or keep) | Post-pilot |
| **N-15** | Two numeric keypads in one app: cash is mirrored (3-2-1), PIN is LTR (1-2-3) | R-pkg (K24 vs K09) | S3 | 04 says keypads stay LTR; VN-S4 | Post-pilot |

## 4. Impeccable critique (Method: dual-agent — A: design review (Opus) · B: detector (Sonnet))

**Design health: 15/40, Poor.** The V5 Sale screen alone would score about 24/40. Scores by heuristic:
- Visibility 2
- Match with the real world 2
- User control 2
- Consistency 1
- Error prevention 1
- Recognition 2
- Efficiency 1
- Minimalism 2
- Error recovery 1
- Help 1

**Design-specificity verdict.** The product is authored up to Sale and generic after it. The V5 Sale
screen belongs to this product: Arabic-first, tabular `EGP`, a pinned total, an honest frozen
state and an honest tax line. Checkout and cash entry are a generic stacked payment form, and the
legacy shell is a generic English admin dashboard. **The direction is right (the Direction B pack)
and the gap is in implementation.**

**What works**
1. The V5 Sale composition: money is the loudest thing on screen.
2. RT-26 Back, which is honest about why it is refused.
3. Explicit disabled-by-policy and pending states (voucher tile, «لم يصدر إيصال بعد»).

**Priority issues**
- **P1 (pilot blocker):** the cash change truth is wrong after apply, and two commits compete (F-03, F-09).
- **P1 (pilot blocker):** the scanner has no owner (F-01, F-02, F-07, F-08).
- **P1:** the Checkout composition breaks I-3 (F-10, N-03, N-02).
- **P1:** the card-cancel recovery is not truthful or safe (F-05, N-13; the confirmation itself belongs to RT-116).
- **P2:** two products stitched together (legacy shell, banner, fake «Online»: F-25, N-04, N-08).

**Cognitive load.** 6 of 8 checklist items fail:
- Two entry fields compete.
- Cash entry presents about 22 targets.
- The hero amount sits below the fold.
- The cashier has to do the change arithmetic.
- The shift status page shows 11 zero counters.

**Emotional journey.** Sale is calm. The first valley is the scan that lands in search. The
deepest valley is the wrong change at the highest-stakes moment. The ending is a persistent amber
drawer warning after every sale, so the peak-end is negative.

**Detector (Assessment B).** The CLI found one finding in `src/renderer/v5`:
`side-tab`, `shift/shift.css:203`, a 4 px inline-start warning edge on `.v5-shift-banner`. It
is low-signal as RTL-correct status styling, P3. `ui/payments`, `ui/receipts` and `shell` were
clean. **The in-page detector could not run**, because the renderer CSP (`script-src 'self'`, no
`wasm-unsafe-eval`) blocked both the overlay script and its WebAssembly core. No overlay exists.
A future runtime pass needs a dev-CSP build or a Vite-served copy.

**Gaps against the approved pack (Assessment A, verified against the pack's own classification
page).** The pack leaves four assumptions open on every screen: digit system, currency label,
keyboard shortcuts, and focus/scanner routing. It also draws «ج.م» (OD-3 says `EGP`), a
«Retail Tower» wordmark (OD-5 keeps «POS Pulse»), a sale number on every screen (only partly
unblocked, see F-11) and a lock button. For cash it draws **no** amount input, keypad,
quick-amount chips or «بالضبط», although I-9 requires them. It also draws **one** commit, «تأكيد
الدفع وإتمام البيع», where `main` has apply-then-settle (two steps). [15](15-vnext-freeze-package.md)
resolves or carries each of these.

## 5. Owner decision recorded in this run: D-C1 (2026-10-07)

The owner said in the RT-159 session (paraphrased): *"There shouldn't be a dialog to press OK
for every scan or typed item; it lengthens the transaction for no reason."* Answers to the
follow-up questions:

- **Direct add** for a **resolved barcode scan** and for a **picked search result** (Enter or
  click). There is no confirm dialog. The added line is acknowledged inline (row flash plus
  scroll into view) and the scan target keeps ownership.
- **Exceptions are inline notices, not blocking dialogs**:
  - unknown barcode or unavailable item;
  - an item carrying a flag such as `prescription_required` («بوصفة طبية»), shown beside the
    line without stopping the sale. There is no prescription workflow (I-17).
- **Mis-scan correction** is a quick **undo of the last added line** plus **delete with undo**,
  instead of confirming every item.

This **confirms RT-24 §C.1** (direct add) and **extends it to search picks**, which the VNext
references had kept confirm-first. It must be mirrored in the Confluence Decisions page and on
RT-24 / RT-159. That has not been posted yet; it waits for the owner's OK.

Knock-ons, recorded as inputs to [15](15-vnext-freeze-package.md) §7:
- F-08 retires for scans.
- N-07, if it is ever reproduced, matters only where a dialog remains.
- The model saving is about 1.8 s per item (KLM, doc 12 §4.4).
- **Undo needs a contract check.** No restore-line operation exists in `src` (`cart_lines.removed_at`
  exists; there is no un-remove), so undo is a Planning / contract item with an audit-event decision.
- The `prescription_required` flag exists in the catalogue snapshot (`product-snapshot.ts:44-45`). Whether the cart line view model carries it must be confirmed in the slice's Planning step.

## 6. Evidence gaps (stated, not papered over)

- **Real users: none.** No usability sessions were run. The script in doc 12 §11 is still ready.
  Representative users remain an open gap and are not replaced by opinion.
- **Real scanner: partial.** The owner's run (R-hw) shows that the scanner reads the synthetic
  EAN-13 sheet from a monitor and that three lines were added. *Pending:* the owner's account of
  whether the second scan without a click added the item and whether the quantity +1 on «زنك»
  came from a click or from the scan landing on `+`. Until then, F-01 and F-07 stay confirmed only
  under emulated wedge input (R-pkg / R-dev).
- **Not re-run in this pass:**
  - inactivity lock (RT-117 evidence stands);
  - card UNKNOWN (there is no path);
  - true print failure on the BIXOLON;
  - Windows 125/150 % scaling;
  - screen readers and touch hardware;
  - the void-dialog count (F-29).
- **Timings:** every timing here is a model (KLM) or a scripted duration, not human time-on-task.
- **Lab side effects, disclosed:**
  - 3 finalized packaged sales (`RT-159 audit-…-000001…3`, all synced to Backend-Core), 1 card
    reversal, 1 orphaned cash attempt (18.50, cashier session), 1 shift open/close and an open
    3-line cart, all in the rt9 lab and the scratch profile `D:\rt159-userdata`. There was also 1
    R-dev sale in the scratch profile `C:\posaudit\q1`. The 25 seeded products are in the lab
    Backend-Core DB;
  - a test PIN for «RT227 Cashier One» on terminal `daa25471…`, kept outside the repo;
  - the BIXOLON queue was paused during the run, and the receipt jobs of this run were deleted.
