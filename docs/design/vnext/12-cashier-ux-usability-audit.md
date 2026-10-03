# 12 — Cashier UX / usability audit (RT-159)

> **Status: PRELIMINARY / current-`main` UX evidence — not final RT-159 acceptance.**
> **RT-159 remains open** pending the post-RT-117 packaged/lab audit and the evidence gaps in
> [§12](#12-evidence-gaps-and-what-was-not-done). Docs only: no production code, dependency, IPC, DB,
> API, payment, sync or ERP change. It consumes RT-24 (behaviour authority), RT-25, RT-104
> ([01](01-current-state-audit.md)–[10](10-direction-comparison.md)) and RT-111
> ([11](11-operational-workflow-benchmark.md)) and fills the gap they record: **nobody had run the
> built app** (`01` §10: "No runtime run"). Where a recommendation touches RT-24 semantics, it is
> raised as a conflict, not designed around.
>
> **Read these limits first**
>
> 1. **Runtime baseline is `main@0028827`, before RT-117 lands.** Inactivity, lock and tender-sweep
>    behaviour will change with RT-117 (S1: LOCKED state, 10-minute genuine-input threshold, live
>    tender no longer auto-reversed).
> 2. **The packaged build could not be taken past pairing** (dev flags are gated on `!app.isPackaged`;
>    no lab credentials).
> 3. **Every runtime scenario beyond the pairing screen ran in the *unpackaged* app with a fixture
>    manager session** (the dev skip-sign-in flag), not a real cashier and not the packaged exe.
> 4. **No duplicate Jira work:** findings F-04, F-05 (card-cancel confirmation) and F-06 are already
>    owned by the RT-116 contract and its RT-117 / later slices (S1 lock core; S4 held-cart
>    re-attach; S5 stuck-attempt re-attach; S6 manager recovery). They are recorded here only as
>    pre-RT-117 *evidence* and must not spawn implementation issues.
> 5. No usability sessions were run, no real scanner or cashier role was used (§11, §12).

## Baseline

| | |
|---|---|
| Repository / branch | `Kemetra/POS`, worktree `claude/rt-159-execution-03a222` |
| Verified `origin/main` | `0028827505e65b237eef253a4d87c967a109821c` (Node 24 CI, Electron 44.5.1) — fetched at execution, worktree clean at that SHA; still the tip when this PR was opened |
| Runtime baseline | **`main@0028827`, before RT-117 lands** — preliminary evidence; re-audit after RT-117 on a packaged/lab build |
| Jira | RT-159, Work Mode **Planning**, parent Epic RT-106 |
| Machine | Windows 11 Pro, Electron 44.5.1 (`npm ci`, `npm run build`, `npm run package:dir` all succeeded) |
| Date of runs | 2026-10-03 |
| Viewports | 1280×800 and 1024×768 via CDP `Emulation.setDeviceMetricsOverride` (the real window's native inner size was 1264×735) |

## Evidence labels (read first)

Every claim below carries one label. **Nothing is stated as measured that was not run.**

| Label | Meaning |
|---|---|
| **R-dev** | Run in the **built production bundle** (`dist/`, `file://` renderer) launched by the unpackaged `electron.exe`, with a scratch `--user-data-dir`, driven over CDP. `app.isPackaged` is false, so the credential-free dev flags apply (`POS_PULSE_DEV_SKIP_PAIRING`, `…_SKIP_OPERATOR_SIGNIN`, `…_SEED_CATALOGUE`, four `POS_PULSE_FEATURE_*`). Session role is the fixture **manager**, not a cashier. |
| **R-pkg** | Run in the **packaged** `dist-electron/win-unpacked/POS Pulse.exe`. Only the first-run pairing screen is reachable: every dev flag is gated on `!app.isPackaged` (`dev-skip-pairing.ts:82`, `dev-skip-operator-signin.ts:74`, `dev-seed-catalogue.ts:259`) and no lab credentials were available. |
| **C** | Read in source on `main@0028827`; not run. |
| **N** | Not run / not available. Stated explicitly in [§12](#12-evidence-gaps-and-what-was-not-done). |

**Why R-dev rather than R-pkg for the audit:** the AC asks for the packaged build. The packaged exe
boots, accepts `--remote-debugging-port` and renders the pairing screen (R-pkg), but cannot be taken
past pairing/sign-in without owner lab credentials. The renderer bundle, preload and main code are the
same files in both builds, so R-dev exercises the same UI code; what R-dev cannot show is anything
that depends on the real pairing token, real operator sign-in, the cashier role, or packaged-only
paths (asar, migrations dir). That is a stated limit, not a substitution.

**Measurement honesty.** Click/keypress/Tab counts below are **scripted minimum path lengths**
(CDP-dispatched events). They are not human time-on-task. Scanner input was modelled as a 5 ms/char
key burst ending in Enter, which is how a keyboard-wedge scanner presents to the page; no real scanner
was used. The only time figures are **KLM model estimates** (§4.4), labelled as such.

**Harness note.** On the sign-in page `Page.captureScreenshot` stalled at several emulated sizes
(1279–1281×800, 1280×720/768) while JS stayed responsive; sign-in was captured at 1264×735 and
1024×768 instead. Treated as a harness artefact, not a product finding.

---

## 1. Executive summary

The Sale screen is in better shape than the rest: axe-core is **clean on 9 of 10 sampled states**,
no interactive control on Sale/Checkout is below 44×44 px, the money/quantity/ID runs are LTR-isolated
and the void dialog defaults to the safe button. The problems are in **how focus, scanner input,
inactivity and the payment steps interact** — none of which a static mock shows:

1. **A scanner burst is treated as keyboard input by whatever has focus.** Verified: with focus on a
   line's `+` the scanned Enter increments that line's quantity; on `حذف` it **deletes the line**;
   in the cash amount field it becomes the amount received and the confirm control **enables** — and
   the main process stored a tender of `622 100 000 001 100` minor units. A second scan while the
   confirm dialog is open silently drops the item. (F-01, F-02, F-08; RT-24 I-4, rule 1.)
2. **After every add, focus returns to the *search* field, not the scan field**, so the next scan
   searches instead of adding ("not found"). Each barcode item costs a click/Tab plus a confirm Enter.
   (F-07.)
3. **Inactivity ends the session — it does not lock — and swept an applied cash tender while the
   screen kept showing it.** After ~15 min idle the session was `null`, the DB tender line was
   `reversed` and the attempt `failed`, but the checkout still showed «200.00 received», due `0.00`,
   and an enabled «تأكيد الدفع»; clicking it gave a generic «تعذّر إتمام عملية الدفع. يرجى المحاولة مرة
   أخرى». (F-04; conflicts with RT-24 I-8 — **escalated, not redesigned; already owned by RT-116/RT-117, so evidence only, no new Jira**.)
4. **After applying cash the screen shows the wrong change.** Before confirm it shows 37.00 (correct,
   main stored `change_due_minor = 3700`); after confirm it shows **200.00** — the full amount received.
   Renderer bug, root cause at `CashEntry.tsx:62-92`. (F-03.)
5. **Both primary payment confirmations render as plain text** (`background: transparent; border: 0`)
   and, at 1280, the amount due is off-screen (y = 891 on an 800 px viewport) during cash entry. (F-09, F-10.)
6. **Restart drops the draft from view**: a 25-line `editing` cart is in SQLite but the Sale shows an
   empty cart; the app lands on an English «Dashboard — Coming soon». (F-06; **owned by the RT-116 held-cart slice (S4)** — evidence only.)

Counts: **6 × S0, 9 × S1, 8 × S2, 6 × S3** (§9). No sessions with real cashiers were run (§11).
**Exactly one next safe action** is in §13.

---

## 2. Current-state UX audit (what was run)

### 2.1 Scenario matrix (the 16 required + entry/lock)

| # | Scenario | Label | Result (min path / observation) | Findings |
|---|---|---|---|---|
| 1 | Fast barcode sale | R-dev | **8 items = 8 clicks into the scan field + 8 confirm-Enters (2 cashier actions/item)**, then payment path 7 clicks (§4.1). Dialog appears for every scan. After confirm, focus is the search field. | F-07, F-08 |
| 2 | Search-heavy sale | R-dev | 1 item = click search + 3 chars + `Tab` `Tab` `Enter` `Enter`. `ArrowDown` in the search box does nothing; the listbox is a separate tab stop (`LiveSearchResults.tsx:75-94`). Search text is retained after the add. | F-19 |
| 3 | 20+ line cart | R-dev | 25 lines: cart viewport shows **4.9 rows @1280 / 4.5 @1024** (with the drawer banner present; 7 / ~6.5 rows without it, from A03/A04). **Newest line not scrolled into view** (`scrollTop 0`, last row out of view). **105 `Tab`s** from search to the handoff button. | F-18, F-19 |
| 4 | Qty correction / remove | R-dev | Quantity is a `+`/`−` stepper only: **qty 5 = 4 clicks**; the number is not editable; `ArrowUp`, digits and `Delete` on the stepper do nothing. `حذف` removes the line **immediately, no confirm, no undo, no toast**; focus drops to `<body>`. | F-16, F-17 |
| 5 | Checkout → safe Back → edit | R-dev | **Not possible**: no Back control, `Esc` is a no-op, navigating to Sale shows the frozen cart (read-only, only «إلغاء البيع» + «المتابعة إلى الدفع»). Editing = void and rebuild. Known (RT-26 To Do). | F-12 |
| 6 | Cash with change | R-dev | 7 clicks (§4.1). Change line 37.00 before confirm; **200.00 after**; completion shows no change. | F-03, F-11 |
| 7 | Card decline | R-dev | The card panel has **one** action «تأكيد معالجة جهاز البطاقات». Decline = «إلغاء», which reverses an applied card line in one click with no confirmation and no "void on the terminal" warning. | F-05, F-13 |
| 8 | Card UNKNOWN / recovery | C + N | No UI for it (05 VN-26 "None dedicated"); not reproducible. | F-13 |
| 9 | Network loss while selling | R-dev (renderer-only) | `navigator.onLine=false`: **no text changes** on Sale; the legacy shell's pill stays «Online». Main-process connectivity was not emulated. | F-15 |
| 10 | Inactivity, draft cart | R-dev | After ≥15 min idle: `getCurrentSession()` = `null`; UI unchanged; a route change did **not** redirect to sign-in; returning to Sale showed **0 lines**. | F-04 |
| 11 | Inactivity, live tender | R-dev | See §1.3: line `reversed` + attempt `failed` at 01:40:58Z while the UI still showed the applied tender and an enabled settle button; settle → generic error. | F-04 |
| 12 | Receipt/print failure | R-dev (partial) | No printer configured → OS-print to the Windows default (a real HP queue; I paused it). Completion says «لم يصدر إيصال بعد» although **a receipt job was submitted to the OS queue for each completed sale (2 across the audit)**; no print state is shown. A cash-drawer banner appears (bilingual) and **persists** across New Sale and restart. A true print-failure state was **not** reproduced (BIXOLON bench is RT-110). | F-11, F-20 |
| 13 | Restart / recovery | R-dev | Abrupt `Stop-Process` with a 25-line draft: relaunch lands on `/app/dashboard`; Sale is empty; DB still holds the `editing` cart (25 lines) and a `frozen_handed_off` one (8). No restart notice. | F-06 |
| 14 | Manager-gated action | R-dev + C | Post-handoff «إلغاء البيع» as manager opens the same generic dialog; `attribution_operator_id: null` at `cart-bridge.ts:200,385,491,549,626,682`. No credential-backed approval. Cashier role **not run**. | F-04-adjacent (MD-2) |
| 15 | Return/refund entry | R-dev | `/app/returns` = English «Returns are not yet available at this terminal. Coming soon.» (manager). Cashier gating **not run**. | F-25 |
| 16 | Shift close / cash-up | R-dev | Absent; dashboard «Current shift — Coming soon». | F-25 (RT-17) |
| — | Sign-in / takeover / lock | R-dev + R-pkg | Packaged first run = English-only pairing card (A18). Sign-in with the roster unreachable: English «No cashiers available», broken layout (A19/A20), cashier PIN path unusable without the backend (consistent with RT-111 MD-1; re-read on `main`: `sign-in-handler.ts:337` calls `checkActiveSession`, which maps `no_connection` to a refusal at `check-active-session.ts:41`; the PIN path itself was **not run**). **No lock state exists**; takeover/PIN **not run**. | F-14 |

### 2.2 What is good (keep; do not regress)

- axe-core 4.11: **clean** on Sale empty / confirm dialog / 3 lines / handed-off, Checkout (method select / cash entry /
  cash applied), Completion, legacy Dashboard; one `serious` **color-contrast** finding on the legacy
  Sales page, all 5 nodes in `.drawer-failure-banner__hint`. (R-dev; axe is a floor, not a usability result.)
- 46 interactive controls on Sale at both sizes: **none under 44×44** (R-dev). Exception on a legacy
  route: «Catalogue Diagnostics» link 134×24.
- Money, quantities, indices are LTR-isolated; Arabic copy leads.
- Void dialog: safe default focus «العودة» (A22). Sign-out is **disabled while a tender is open** with
  the reason «أكمل الدفع أو ألغِه أولاً».
- `Enter` inside the cash amount field does **not** apply the tender (RT-24 I-4 respected for typing).
- The disabled voucher tile keeps its slot with «غير متاحة حاليًا» (RT-103).

---

## 3. Targeted research digest (evidence gaps only)

Not repeated: Arabic fonts, numerals, WCAG 2.5.8/2.4.x, forced-colors/reduced-motion basics
([03](03-external-reference-audit.md) §3) and competitor workflows ([11](11-operational-workflow-benchmark.md)).
Sources were fetched or searched on 2026-10-03; strength = how strongly it supports a *decision*.

| # | Pattern / problem | Source | Strength | Applicability to Retail Tower | Constraint / reason to reject |
|---|---|---|---|---|---|
| R1 | Confirmation dialogs are habituated; prefer **undo** over warning for reversible slips | Raskin, "Never Use a Warning When you Mean Undo", A List Apart (2007) | Moderate: practitioner essay, widely cited | **F-17 line delete** — replace immediate delete with delete + visible undo | Reject for **financial** commitments (payment confirm, cancel after card): they are not undoable, so RT-24's explicit confirm stays; WCAG 3.3.4 below |
| R2 | Financial submissions must be **reversible, checked, or confirmed** (any one) | W3C WCAG 2.2 Understanding SC 3.3.4 | Strong: normative | Payment confirm already "confirmed"; **cash amount field is not "checked"** (F-02) | Applies to web pages; used here as the accepted minimum, not as a compliance claim |
| R3 | Slips (inattention) vs mistakes (mental-model gaps) need different prevention; "emergency exit" for mistaken actions | Nielsen Norman Group, 10 usability heuristics (#3, #5) | Moderate: expert consensus | F-01 is a *slip* (focus rests on a button); F-13 is a *mental-model* gap (no decline/unknown) | General principles, not POS-specific data |
| R4 | KLM predicts expert, error-free execution time from operator counts (K≈0.28 s, P≈1.1 s, H≈0.4 s, M≈1.35 s) | Card, Moran & Newell (1983); Kieras, "Using the KLM to Estimate Execution Times" | Strong as a method; **models, does not measure** | §4.4 converts the counted actions into a comparison between today and "focus returns to scan field" | Expert/no-error assumption; ignores scanner time and thinking; not a substitute for the sessions in §11 |
| R5 | Keyboard-wedge scanners insert decoded data **at the cursor as if typed**; prefix/suffix are configurable | Vendor/KB material (Zebra, Honeywell, integrator KB), surfaced via search — **snippets only, not read in full** | Weak–moderate (secondary) | Explains F-01/F-02/F-07 mechanically; configurable prefix/suffix is the usual hook for "this is a scan" detection | **Verify on the pilot scanner's programming guide**; the empirical result here is the real evidence |
| R6 | Numbers (phone numbers, clocks) are **not mirrored** in RTL | Material Design bidirectionality guidance | Moderate: design-system guidance | Hypothesis for F-24: the cash keypad lays out 1-2-3 right→left, opposite to a physical numpad | **Hypothesis only** — Material speaks of numbers/phone numbers, not on-screen keypads; needs a user check (§11 task T6) |
| R7 | Use `dir`/`bdi` to isolate embedded LTR runs; trailing punctuation can still land on the wrong side | W3C i18n, "Structural markup and right-to-left text in HTML" | Moderate: standards body guidance | Matches shipped defects «‎.portal», «Staff code ·» (F-26) | Guidance is "not foolproof"; fix is copy-level (one language per label) |

**Gap, stated plainly.** Pharmacy-counter literature (e.g. dispensing-verification / barcode-scanning
practice at the point of sale) and Arabic-language transactional-UI research were **not** reviewed in
this pass; findings in those areas rest on the runs above and on the open questions in §11.

---

## 4. Scenario / task-flow measurements (with evidence boundaries)

### 4.1 Minimum path lengths (R-dev, scripted; **not** human timings)

| Flow | Cashier inputs (min) | Notes |
|---|---|---|
| Barcode item, today | click scan field **or** `Tab` (from search) + `Enter` to confirm = **2 per item** | focus returns to search after confirm |
| Search item, keyboard | 3 chars + `Tab` `Tab` `Enter` `Enter` = **7 keys** (+1 click to focus search) | `ArrowDown` in search is inert |
| Sale → paid, **cash**, mouse | handoff, continue, «نقدي», quick-amount chip, «تأكيد الدفع النقدي», «تأكيد الدفع», «بيع جديد» = **7 clicks** | two near-identical confirm labels |
| Handoff by keyboard, 25 lines | **105 `Tab`s** (measured; ≈4 stops per line — ملاحظة, حذف, −, + — plus a few fixed ones, inferred) | `Shift+Tab` reaches it in 10 via the nav |
| Cash confirm by keyboard | amount field → **~24 stops** (5 quick chips, 12 keypad keys, «بالضبط», 4 more quick buttons) → confirm sits just before «إلغاء» | counted from the observed order with confirm disabled (skipped), so the position is inferred |
| Quantity 1 → 5 | **4 clicks** | no typed quantity |

### 4.2 Scanner-ownership matrix (R-dev; focus location → where a scanner burst lands)

| Focus when the scan arrives | Result observed | RT-24 I-4 |
|---|---|---|
| Scan field `#v5-live-scan` | Resolves → confirm dialog (correct) | ok |
| Search field (default after every add / app start) | Digits go to the search box; Enter searches → «لم يُعثر على الصنف»; **nothing added** | gap |
| Confirm-add dialog open | Enter hits the focused «إضافة إلى السلة»; **the second item is silently dropped** | **violates** (X-1 confirmed) |
| Line `+` (after a click on it) | Enter re-activates `+`: quantity 2 → 3, item not added | **violates** |
| Line `حذف` | Enter **deletes the line** (2 → 1 lines) | **violates** |
| Note textarea | Barcode + newline inserted into the note | gap |
| Cash amount field | Becomes the amount received (`6221000000011.00`), confirm enabled; main stored **622 100 000 001 100** minor with `change_due_minor 622 099 999 984 800` | **violates** ("no scanner input into money fields") |
| Tender radio (cash selected) | Ignored | ok |
| `<body>` (after void / delete / dialog close) | Not run; source has no global capture (`01` §7) | unknown |
| Paid (settled) cart still on Sale | Scan → dialog → «تعذّرت الإضافة — حاول مرة أخرى» although it can never succeed | gap |

### 4.3 Inactivity result (scenarios 10–11, R-dev + C)

`inactivity-monitor.ts` ends the session after 15 min (`DEFAULT_THRESHOLD_MS`, tick 60 s) and the
`onEnded` hook runs `sweepStuckAttempt` (`index.ts:922-927`). Observed on two idle instances:

| | Draft cart (instance 1) | Live tender (instance 2) |
|---|---|---|
| Session after idle | `null` | `null` |
| UI | unchanged until a route change; guard did not redirect | unchanged: «200.00 received», due 0.00, settle enabled |
| Stored | cart `editing` rows remain; Sale shows 0 lines after navigation | tender `reversed_at 01:40:58Z`, attempt `failed_at 01:40:58Z` (same instant) |
| User-visible outcome | draft vanishes with no message | settle → «تعذّر إتمام عملية الدفع. يرجى المحاولة مرة أخرى.» |

**Control (R-dev):** on a fresh instance a 3-line draft survived `#/app/sales` and back with no idle
(3 lines before and after, session still present), so the draft vanishing in column 1 is tied to the
session ending, not to a plain route remount.

This **contradicts RT-24 I-8** ("inactivity never discards money or cart") and confirms RT-111's
reading. The causal link (idle → session end → sweep) is code-read plus the matching timestamps; the
exact idle clock start was not logged.

### 4.4 KLM model estimate (R4; **model, not measurement**)

Assumptions: expert, error-free, scanner time excluded, K = 0.28 s (also used for a click),
P = 1.1 s, H = 0.4 s, no M.

| Per scanned item | Operators | Model time |
|---|---|---|
| Today: Enter to confirm, then mouse to the scan field | H+K + H+P+K | 0.68 + 1.78 = **2.46 s** |
| If focus returned to the scan field after confirm | H+K | **0.68 s** |
| Difference | | **≈ 1.8 s per item ≈ 36 s over 20 items** |

If direct-add replaced confirm-first (RT-24 §C.1, **not confirmed**) the Enter also disappears; that
needs the owner decision, not this audit.

---

## 5. Screen-by-screen critique

Screenshots live in [`references/audit-rt159/`](references/audit-rt159/) (synthetic data; own app;
no third-party assets). RT-104 target references are `VN-B1/B2` and `VN-R*` in [`references/`](references/README.md).

| Screen | State today (evidence) | Critique |
|---|---|---|
| **Pairing** (A18, R-pkg) | English-only card on an RTL page; «‎.portal» punctuation misplaced; usable at 800×600 (no too-small guard) | Arabic copy needed; low risk (once per terminal) — S3 |
| **Sign-in** (A19/A20) | Two cards pulled to opposite edges with a large gap; header at far right; «Staff code · كود الموظف»; «No cashiers available» in English | Layout does not hold at 1024 or 1264 in the roster-unreachable state — F-14 |
| **Sale empty** (A01/A02) | Clean; search first, scan field second; «لم يُنزّل الكتالوج بعد · جارٍ التحديث…» in the rail footer | Scan field is visually secondary to search although it is the primary input |
| **Sale, 8 lines** (A03/A04) | 7 rows visible @1280, ~6.5 @1024; scrollbar visible; money mono; counts in Latin digits; product names keep Arabic-Indic digits («١٠٠٠», «٧٠٪») | Capacity is the limit; mixed numerals (OD-3 open) |
| **Sale, 25 lines** (A06/A07) | 4.9 / 4.5 rows with the drawer banner; newest line off-screen | F-18, F-20 |
| **Confirm-add dialog** | Safe, readable; default focus «إضافة إلى السلة» | Needed per scan today; scanner Enter lands on it (F-08) |
| **Checkout, method select** (A08/A09) | 3 regions at 1280; stacked at 1024 with the page scrolling; heading «طريقة الدفع (Payment method)»; identity «Manager / Dev Manager / DE» repeated in the nav | No Back/cancel here at all (F-12); English role chip; bilingual headings |
| **Cash entry** (A10/A11) | 1280: amount due **below the fold** (label top 891 > 800); 1024: amount due at top but keypad + confirm below the fold; an empty bordered input above the readout; two overlapping quick-amount groups (5 chips + «بالضبط» row of 4) | F-10; confirm is borderless text (F-09); duplicate quick groups (F-24) |
| **Cash applied** (A12) | «Change due **200.00**» next to due 0.00 | F-03 — would prompt over-returning cash |
| **Card entry** (A15) | Borderless confirm; «المبلغ المخصوم» and «المبلغ المُقتطع» both shown; after apply a stale validation line «يجب أن يكون المبلغ مطابقاً تماماً…» appears beside 0.00 | F-09, F-13 |
| **Completion** (A14) | ✓ «تم استلام المبلغ» / «لم يصدر إيصال بعد», 163.00 EGP, one button «بيع جديد»; banner above | No change reminder, no sale/receipt number, no print state (F-11) |
| **Dialogs** (A22/A23) | Void: safe default. Sign-out: **destructive confirm focused by default**, no mention of the open cart | F-22 |
| **Restart landing** (A17) | Legacy shell: «Dashboard · Coming soon», «Online» pill, «Dark» toggle, empty icon rail at 1280, English role | F-06, F-25 |
| **Forced colors** (A21) | Frames and chips are visible; the confirm control has no border; the sticky drawer banner **overlaps the page header** | F-09, F-20 |

---

## 6. Keyboard / scanner interaction audit

- **No F-key or accelerator bindings on the cashier path** (C: no global shortcut registration;
  matches `01` §7). Local `onKeyDown` handlers do exist (scan field Enter, results-listbox arrows,
  PinPad, dialogs). The RT-24 key map is still unconfirmed, so nothing here was tested against F-keys.
- **Tab order** follows DOM: Sale (search → scan → listbox → per-line 4 stops → CTA → nav); Checkout
  starts on the tender radios and the nav sits after them; the card entry's amount, reference and
  confirm are reachable.
- **Focus management gaps (R-dev):** after delete, void and some dialog closes the active element is
  `<body>`; after every add it is the search field; the Checkout route change leaves `<body>` active.
- **Enter semantics:** Enter in the amount field does not apply (good); Enter on a focused `+`/`حذف`
  does (the F-01 mechanism).
- **Practical conclusion:** the cashier path is mouse-first with scanner as a typist into whichever
  field is focused. A keyboard-only cash sale is *possible* but ≈24 `Tab`s from the amount field to
  confirm and 105 from the search box to handoff on a 25-line cart.

## 7. Arabic / RTL audit

| Area | Finding | Label |
|---|---|---|
| Direction | `<html lang="ar" dir="rtl">`; money, qty, indices isolated LTR; cart columns read right→left correctly | R-dev |
| LTR isolation | Good on money/qty; **bilingual labels mis-place punctuation** («.portal», «Staff code ·», «(Payment method)», «Last opened: unknown — آخر فتح: —») | R-dev, R7 |
| Numerals | Money/qty Latin; timestamps/counts Arabic-Indic elsewhere (`01` §6); catalogue names keep Arabic-Indic digits and the Arabic-Indic zero renders as a **small dot** — legible at 1×, easy to misread as punctuation at small sizes | R-dev ([A24](references/audit-rt159/A24-arabic-indic-digits-zoom.png)) |
| Keypad order | `1 2 3` runs right→left in the cash pad (hypothesis vs numpad habit) | R-dev; **needs users** (R6) |
| English leakage | Pairing, sign-in roster state, legacy shell, role chip «Manager», banner copy | R-dev/R-pkg |
| Copy tone | Error copy is non-technical but sometimes wrong in meaning: «حاول مرة أخرى» offered where retry cannot succeed (F-04, F-21) | R-dev |

## 8. 1024 / 1280 density and capacity; accessibility; consistency

**Capacity and fit (R-dev).** Cart rows are 72 px; 7 visible @1280 (no banner), 4.9 with the banner.
Checkout cash: 1280 hides the amount due (X-3 confirmed at runtime); 1024 stacks everything and scrolls.
Direction B (approved) is still a *planning* reference; this audit supplies the real-app capture that
`README` "VN-S12 capacity capture" asks for as **A03/A04/A06/A07**.

**Accessibility.**
- axe: see §2.2. Only finding: contrast in the drawer-banner hint.
- Targets: all Sale/Checkout controls ≥ 44 px; one 24 px legacy link.
- **Focus visibility:** rings were seen on pairing/sign-in controls and the search field; a systematic
  per-control ring check was **not** done (N).
- **Forced colors:** captured Checkout cash and Sale; confirm controls borderless; banner overlap (A21).
- **Reduced motion:** emulated; one running animation on Sale was observed and not identified — not a
  confirmed violation (N).
- Windows display scaling 125/150 %, screen readers, touch hardware: **N**.

**Consistency (R-dev).** The V5 Sale and the legacy Checkout/Completion/Dashboard still read as
different products: borderless confirms, English headings, repeated identity strip, duplicate quick
amounts, two “confirm” labels in a row («تأكيد الدفع النقدي» then «تأكيد الدفع»), legacy shell
copy that is now wrong («Dark is the default» on Settings; light is the shipped default).

---

## 9. UX findings matrix

Severity per the Jira model: **S0** safety/financial-integrity UX risk · **S1** blocks/seriously
confuses a primary task · **S2** significant efficiency/error-rate · **S3** consistency/a11y debt ·
**S4** nice-to-have. Frequency: *Likely* = occurs in ordinary use; *Possible* = needs a specific
sequence; *Rare*. "Pilot" = must be resolved or consciously accepted before a pilot with real cashiers.

| ID | Finding | Evidence | Workflow / screen | Sev | Freq | User impact | Trace | Recommended design response | Class |
|---|---|---|---|---|---|---|---|---|---|
| F-01 | Scanner Enter activates the focused control: `+` → qty+1, `حذف` → **line deleted**; scan itself is lost | R-dev §4.2 | Sale line edit | **S0** | **Likely** (click `+`/`حذف` then scan the next item) | Silent over/under-billing | RT-24 I-4, rule 1; X-1 family; VN-S5 | Scan ownership: scan field/global scan target regains focus after any line action; buttons never consume a wedge burst (detect burst); keep visible button alternatives | **Pilot** |
| F-02 | Scanned digits fill the cash amount field; confirm enables; main accepts 6.2×10¹⁴ minor | R-dev §4.2, DB rows | Checkout cash | **S0** | Possible | Absurd tender/change; ledger pollution | I-4 ("no scanner input into money fields"), I-9, WCAG 3.3.4 "checked" | UI: reject scan bursts and implausible amounts in money fields. **Whether main also bounds the value is a contract question → decision issue, not assumed** | **Pilot** |
| F-03 | After apply, «Change due» shows the **amount received** (200.00), not the change (37.00) | R-dev; `CashEntry.tsx:62-92,249-259` (change recomputed against remaining 0); DB `change_due_minor 3700` correct | Checkout cash applied | **S0** | **Likely** (every cash sale with change) | Cashier hands back the wrong amount | I-9; VN-S4 | Show the change computed at apply time, or hide the row once applied; renderer-only, no money math change | **Pilot** |
| F-04 | Inactivity **ends** the session; applied tender swept while UI still shows it; settle gives a misleading generic error; draft disappears | R-dev §4.3; C | Inactivity (draft/live tender) | **S0** | Possible (15 min idle at the till) | Lost money state; cashier retries a dead payment | **RT-24 I-8 conflict**; RT-111 V-1/MD | **Escalate** — behaviour decision first (lock, preserve, or sweep with a visible, truthful state). UX can then draw VN-R8 | **Owned by RT-116/RT-117** — no new Jira (S1 lock core RT-117; S4/S5 later) |
| F-05 | «إلغاء» after an applied **card** line reverses it in one click, no confirm, no «void on the terminal» warning | R-dev | Checkout card | **S0** | Possible | POS record gone, bank charge remains | I-7, I-10, I-2 | Confirm step stating the terminal charge is not cancelled by POS; copy-only. Cash reversal: show the result («تم التراجع») | **Owned by RT-116/RT-117** — no new Jira (RT-116 §3: external-card cancel needs explicit void-on-terminal confirmation) |
| F-06 | Restart: draft/handed-off carts exist in SQLite but Sale is empty; lands on English dashboard; no notice | R-dev §2.1 #13; `useSaleCartController.ts:139-145` hydrates only a cart already in renderer memory | Restart | **S0** | Possible | Cashier believes a customer's cart was lost | I-1, rule 1; VN-36 | Hydrate/offer the stored cart; notice «استُعيدت السلة بعد إعادة التشغيل» (05 VN-36) — **needs contract check** (reads existing `cart.snapshot`) | **Owned by RT-116/RT-117** — no new Jira (S4 held-cart re-attach / restart) |
| F-07 | After each add (and after void/delete/dialog close) focus is the search field or `<body>`; the next scan searches or is lost | R-dev §4.2 | Sale | **S1** | **Likely** | +1 click or `Tab` per item; "not found" on first scan | I-4; VN-S5 | Return focus to the scan target after every add/dialog | **Pilot** |
| F-08 | Confirm-first dialog on every scan; a scan during the dialog drops the item silently | R-dev | Sale | **S1** | Likely | Extra Enter per item; lost line | RT-24 §C.1 (**unconfirmed**), X-1 | Fix X-1 now (scanner suspended while open or queue the scan); direct-add only after §C.1 is confirmed | **Pilot** |
| F-09 | Primary payment confirms render as plain text (`transparent`, `border:0`); no border under forced colors either | R-dev computed style | Checkout cash/card | **S1** | **Likely** | The one action that completes payment has no affordance | I-3, VN-S4 | One primary-button style for the commit action on both tenders | **Pilot** |
| F-10 | 1280: amount due off-screen during cash entry; 1024: confirm below the fold | R-dev (label top 891 > 800) | Checkout cash | **S1** | Likely | Cashier cannot see what is owed while keying cash | I-3, X-3 | VN-S4 pinned ledger | **Pilot** |
| F-11 | Completion: no change reminder, no sale/receipt number, no print state; receipt jobs were submitted anyway | R-dev (2 OS-print jobs for 2 completed sales) | Completion | **S1** | Likely | Change forgotten; "no receipt" despite a print | X-4, I-7 | Completion proof list per VN-30/R5 (only proven references) — **sale number depends on X-4 correlation id** | **Pilot** |
| F-12 | No Back from Checkout; frozen cart cannot be edited | R-dev | Sale↔Checkout | **S1** | Likely (add-one-more) | Void-and-rebuild | I-12, RT-26 | Ship only after RT-26; until then say so on the frozen cart | **Pilot** (RT-26) |
| F-13 | Card: no decline/cancelled/UNKNOWN outcome; decline = «إلغاء» | R-dev; C | Checkout card | **S1** | Likely | Wrong mental model for the main non-cash path | I-7, I-10; VN-26 | Outcome selector (approved / declined / unknown) — **needs a payment-state contract (RT-10)** | **Pilot** (planning) |
| F-14 | Sign-in layout breaks at 1024/1264 (roster-unreachable state); English fragments; cashier cannot sign in without the backend | R-dev/R-pkg; C | Sign-in | **S1** | Possible | First screen of the shift looks broken; offline start blocked (RT-111 MD-1) | VN-S8; MD-1 | Recompose on the V5 vocabulary; Arabic-only copy; truthful offline message | **Pilot** |
| F-15 | Connection state is invisible/static (legacy pill «Online» always; V5 has none) | R-dev | All | **S1** | Likely | Cashier cannot tell if sales are queuing | X-2, VN-S6 | Needs a real signal first; never draw a fake «متصل» | **Pilot** (signal) |
| F-16 | Quantity only via `+`/`−` | R-dev | Sale line | **S2** | Likely (packs) | 4 clicks for 5; error-prone for 12 | VN-13 | Typed quantity (existing qty update; check bridge) | Pilot-conditional |
| F-17 | Line delete immediate, no undo, focus → body | R-dev | Sale line | **S2** | Likely | Mis-tap on `حذف` (adjacent to `ملاحظة`) loses a line | R1; I-1 | Delete + undo toast (R1), not a confirm dialog | Pilot-conditional |
| F-18 | Newest line not scrolled into view; 4.9 rows with banner | R-dev | Sale (long cart) | **S2** | Likely | Cashier cannot verify the last scan | RT-24 Sale clarity | Scroll-to-new-line + brief row highlight | **Pilot** |
| F-19 | Keyboard path long: 105 Tabs (25 lines); ~24 Tabs to cash confirm; `ArrowDown` in search inert | R-dev §4.1 | Sale/Checkout | **S2** | Likely (keyboard users) | Practical keyboard-only completion is poor | I-4 visible alternatives; VN-S5 | Roving focus in cart; skip links; `ArrowDown` from search into results | Post-pilot unless pilot cashiers are keyboard-first |
| F-20 | Drawer banner: bilingual, no dismiss, ≈170 px, persists across New Sale/restart, contrast `serious`, overlaps header in forced colors | R-dev + axe | All | **S2** | Likely (any terminal without a drawer) | Steals capacity; stale | VN-S6 | One banner mechanism; stateful, dismissible per sale, shown only when blocking | **Pilot** |
| F-21 | Scan on a paid cart → «تعذّرت الإضافة — حاول مرة أخرى» | R-dev (A16) | Sale after completion | **S2** | Possible | Misleading retry | — | State «هذا البيع مدفوع — ابدأ بيعًا جديدًا» + focus New Sale | Pilot-conditional |
| F-22 | Sign-out: destructive confirm focused by default; no mention of the open cart | R-dev | Frame | **S2** | Possible | Enter signs out | R1/R3, I-8 | Safe default; state what happens to the cart | Post-pilot |
| F-23 | Manager-gated actions are not credential-backed | C (`attribution_operator_id: null`) | Post-handoff cancel | **S2** | — | Audit attribution is an id the renderer sends | I-6; RT-111 MD-2 | Existing; owned by VN-S7/RT-28 | (tracked) |
| F-24 | Cash pad: empty bordered input above the readout; two overlapping quick-amount groups; keypad `1 2 3` right→left | R-dev | Cash entry | **S3** | Likely | Visual noise; **possible** numpad mismatch (hypothesis R6) | VN-S4 | One entry surface; confirm keypad direction with users | Post-pilot |
| F-25 | Legacy shell/placeholder pages: English, «Coming soon», stale copy («Dark is the default»), empty icon rail on the restart landing | R-dev | Dashboard, Settings, Returns, Audit, Inventory | **S3** | Likely (manager) | Looks unfinished | OD-6, VN-S10 | Hide from cashier role; restyle for manager | Post-pilot |
| F-26 | Bilingual labels and bidi punctuation | R-dev, R7 | Pairing, sign-in, checkout | **S3** | Likely | Looks unpolished | VN-S2/S8 | One language per label | Post-pilot |
| F-27 | Arabic-Indic digits in catalogue names beside Latin money; zero is a dot | R-dev | Sale, Checkout | **S3** | Likely | Dose strength misread risk (small) | OD-3 (open) | Settle OD-3 against real receipts; consider Western digits for dose strengths | Post-pilot |
| F-28 | Packaged pairing screen English-only, no too-small guard | R-pkg | Pairing | **S3** | Rare | — | VN-S2 | Arabic copy + guard | Post-pilot |
| F-29 | Void dialog does not state line count/total | R-dev | Sale | **S3** | Possible | Weak "what am I discarding?" | R3 | Add «N أصناف · المجموع» | Post-pilot |

Counts: S0 ×6 (F-01…F-06), S1 ×9 (F-07…F-15), S2 ×8 (F-16…F-23), S3 ×6 (F-24…F-29); 29 findings.

**Conflicts with RT-24 raised (not resolved here):** F-04 (I-8), F-02's main-process side
(contract), F-08 (§C.1 direct-add), F-13/F-06 (new states need contract confirmation).

---

## 10. Current → target annotated references (most important findings)

| Finding | Current (this audit) | Target (RT-104, approved/proposed) | Delta to draw / build |
|---|---|---|---|
| F-10 checkout cash fit | [A10](references/audit-rt159/A10-cash-entry-1280.png), [A11](references/audit-rt159/A11-cash-entry-1024.png) | [VN-B2](references/VN-B2-checkout-cash-1280.png) / [VN-R2](references/VN-R2-checkout-cash-1280.png) | amount due pinned in the ledger column; one confirm with button chrome |
| F-03 / F-11 cash applied + completion | [A12](references/audit-rt159/A12-cash-applied-change-200-1280.png), [A14](references/audit-rt159/A14-completion-1280.png) | [VN-R5](references/VN-R5-complete-print-failed-1280.png) | change shown once, correct; proof list; print state |
| F-18 capacity | [A06](references/audit-rt159/A06-sale-25-lines-1280.png), [A07](references/audit-rt159/A07-sale-25-lines-1024.png) | [CMP-B-long-cart-1024](references/CMP-B-long-cart-1024.png) | Direction B capacity gain is now measurable against a real-app baseline (4.9 / 4.5 rows) |
| F-13 card recovery | [A15](references/audit-rt159/A15-card-entry-1280.png) | [VN-R3](references/VN-R3-card-unknown-recovery-1280.png) | outcome states, UNKNOWN surface (contract first) |
| F-04 lock | n/a (no state exists on `main@0028827`) | [VN-R8](references/VN-R8-lock-live-tender-1280.png) | owned by RT-117 (lock screen); re-capture after it lands |
| F-14 sign-in | [A19](references/audit-rt159/A19-signin-roster-unreachable-1264.png), [A20](references/audit-rt159/A20-signin-roster-unreachable-1024.png) | VN-03/04 (no capture exists) | recompose; truthful offline copy |
| F-20 banner | [A21](references/audit-rt159/A21-forced-colors-checkout-1280.png) | [VN-R7](references/VN-R7-offline-selling-1024.png) | one banner mechanism |

---

## 11. Usability-session script and results

**Results: none. No sessions were run.** No cashier/pharmacy-counter users were available to this
execution and none were substituted with opinion. The script is ready to run.

**Set-up.** 3–5 participants (prefer people who have worked a till or pharmacy counter). Packaged build
on the pilot terminal class (≥1024×768), real keyboard-wedge scanner and a printed set of 12 synthetic
barcodes; synthetic catalogue only; cashier role signed in by the facilitator; **no real tender**. One
facilitator, one note-taker; screen + audio recording with consent. Think-aloud; facilitator does not
help unless a participant is stuck > 60 s (log it as a "rescue").

**Tasks (map to the 16 scenarios):**
T1 scan 8 items, finish with cash and make change (1, 6) · T2 find 3 items by name (2) · T3 build a
22-line cart, then verify the last item is in it (3) · T4 change one quantity to 12, remove one line (4)
· T5 realise a customer wants one more item **after** reaching Checkout (5) · T6 type an amount on the
cash pad and say aloud which number is the change (6, F-03, R6) · T7 customer's card is declined, then
"the terminal printed nothing" (7, 8) · T8 the network cable is pulled mid-sale (9) · T9 step away for
16 minutes with a cart open, return (10, 11) · T10 app is restarted mid-sale (13) · T11 a discount is
requested (14) · T12 find yesterday's receipt to reprint (12) · T13 customer returns an item (15) ·
T14 end of shift (16).

**Capture per task:** completion (Y/N/rescued); time-on-task (stopwatch, human); clicks/keys
(observer); hesitations > 3 s; mis-clicks/wrong actions; **scanner landed somewhere wrong** (Y/N + where);
questions asked; mental-model quotes; recovery steps; confidence rating 1–5; severity assigned
afterwards with the S0–S4 model. Close with SUS-style questions and "what would make you slower here?".

**Exit criteria:** F-01/F-03/F-07 each reproduced or refuted with ≥ 3 participants; the keypad
direction hypothesis (F-24) answered; inactivity expectations (T9) recorded.

---

## 12. Evidence gaps and what was not done

- **No real users** (§11). No human timings.
- **No real wedge scanner**; scans were CDP bursts. The pilot scanner's prefix/suffix and speed were
  not assessed.
- **No packaged run past pairing**; no cashier role; no PIN sign-in; no takeover; no lock (none exists);
  no real backend, so offline/reconnect/sync states other than the renderer-offline probe are **N**.
- **Print failure, drawer, BIXOLON**: not reproduced; RT-110 bench.
- **Windows scaling 125/150 %**, screen readers, touch hardware, per-control focus-ring audit,
  dark theme: **N**.
- Tenders beyond cash and card_external: out of scope (RT-10).
- Pharmacy-counter and Arabic transactional-UI literature: not reviewed (§3).
- Side effects of the runs, disclosed: two OS-print receipt jobs were submitted to the Windows default
  printer (paused during runs) and deleted before the printer was resumed; a pre-existing errored job
  (id 2, submitted before these runs) was left in place. All state was in scratch profiles under `C:\posaudit\`.

---

## 13. Bounded Jira implementation slices (proposals — nothing created)

No big-bang rewrite; each is one issue, one repo (`Kemetra/POS`), one Work Mode, citing
[08](08-rt24-invariants.md). They refine, not replace, [09](09-implementation-slices.md).

| Slice | Title | Work Mode | Depends on | Scope (bounded) | Out of scope | Pilot? |
|---|---|---|---|---|---|---|
| **UX-S0** | Close evidence gaps: packaged + cashier + real scanner run, then user sessions | Verification | owner lab credentials; pilot scanner; 3–5 users | **After RT-117 lands:** re-run §2.1 on the packaged build with lab credentials, a cashier role and a real scanner; run §11; confirm/refute F-01, F-02, F-03, F-07, F-24 | any fix | Pilot gate |
| **UX-S1** | Scanner ownership & focus return | Planning → Implementation | RT-24 §C.5 key map (VN-S5), X-1 | Focus returns to the scan target after add/void/delete/dialog; buttons ignore scan bursts; scan during a dialog is queued or refused visibly; money fields reject bursts (F-01, F-02 UI side, F-07, F-08, F-21) | direct-add switch; main-process amount bounds | **Pilot** |
| **UX-S2** | Cash display correctness + completion proof | Implementation | VN-S2 (tokens) | Correct change after apply (F-03); change shown on completion (F-11); keep money math untouched | sale/receipt number (X-4) | **Pilot** |
| **UX-S3** | Payment actions affordance + Checkout fit | Implementation | VN-S2 | Button chrome for commit actions (F-09); pinned amount due at 1024/1280 (F-10); removes duplicate quick groups (F-24) — **absorbed into VN-S4** | new tenders, Back | **Pilot** |
| ~~UX-S4~~ | **Not proposed** — inactivity and restart semantics are already decided and sliced: RT-115 decision, RT-116 contract, RT-117 (S1), later S3–S6 | — | — | **Do not create an issue.** After RT-117 merges, UX-S0 re-verifies F-04/F-05/F-06 on the packaged build | — | — |
| **UX-S5** | Line editing: typed quantity, delete-with-undo, scroll-to-new | Implementation | cart bridge supports qty update (check) | F-16, F-17, F-18 | discounts, suspend | Pilot-conditional |
| **UX-S6** | Card outcome states (declined / UNKNOWN) | Planning | RT-10 payment-state contract | F-13 only. Cancel-after-card confirmation (F-05) is RT-116 §3 / its slice, **not** repeated here | bank API | **Pilot** |
| **UX-S7** | Banner/status consolidation | Implementation | real connectivity signal (VN-S6) | F-15, F-20 | faking online | **Pilot** |
| **UX-S8** | Sign-in/pairing recompose | Implementation | VN-S7 Dialog | F-14, F-28, F-26 (VN-S8) | auth semantics | **Pilot** |
| **UX-S9** | Keyboard path | Planning → Implementation | UX-S1 | Roving focus in cart, results from search, skip links (F-19) | key map beyond §C.5 | Post-pilot |
| **UX-S10** | Legacy placeholder cleanup | Implementation | OD-6 | F-25, F-27, F-29 (VN-S10) | Admin-Console | Post-pilot |

**Next safe action (exactly one):** once RT-117 lands, run UX-S0 — the packaged, lab-credentialed,
cashier-role re-audit with a real scanner and 3–5 users — and fold the results into this document.
This PR is for owner review of the preliminary evidence only; **RT-159 is not accepted** and no
implementation issues are created from it yet.

---

## Acceptance-criteria trace (RT-159) — preliminary, **not accepted**

| Criterion | Status |
|---|---|
| Current implementation verified against GitHub main | `origin/main 0028827`; built and run |
| RT-24/25/104/111 reused, not duplicated | cited throughout; research limited to gaps (§3) |
| Research targeted | 7 sources, 2 gaps declared |
| Core scenarios audited in the **packaged** app | **Not met.** Packaged first run (pairing) only; everything else ran unpackaged with a fixture manager. Open until the post-RT-117 packaged/lab audit |
| 1024×768 and 1280×800 reviewed | yes (§5, §8) |
| Keyboard/scanner behaviour assessed | yes (§4.2, §6) |
| Arabic/RTL and accessibility with evidence | yes (§7, §8) |
| Evidence vs opinion separated | labels R-dev/R-pkg/C/N; hypotheses marked |
| Reproducible steps / screenshots | scripts reproducible from §4; 23 screenshots in `references/audit-rt159/` |
| Pilot-critical vs post-pilot | §9 column "Class" |
| Bounded Jira slices | §13 |
| No implementation | docs + screenshots only |
| One next safe action | §13 |

---

## Appendix A — Reproduction recipe

Build once: `npm ci && npm run build`. Launch (PowerShell, **scratch profile — the skip-pairing flag
overwrites pairing, never use it on a real profile**; short path avoids a GPU-cache path-length error):

```powershell
$env:POS_PULSE_DEV_SKIP_PAIRING='1'; $env:POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN='1'
$env:POS_PULSE_DEV_SEED_CATALOGUE='1'; $env:POS_PULSE_FEATURE_CART='1'
$env:POS_PULSE_FEATURE_PAYMENTS='1'; $env:POS_PULSE_FEATURE_SALE_FINALIZATION='1'
$env:POS_PULSE_FEATURE_PRODUCT_SEARCH='1'
Start-Process node_modules\electron\dist\electron.exe -ArgumentList '.','--user-data-dir=C:\posaudit\p1','--remote-debugging-port=9333'
```

Pause the Windows default printer first (`Invoke-CimMethod` `Pause` on `Win32_Printer`) and delete the
queued receipt jobs before resuming. Seed barcodes: `6221000000011`, `…020`, `…037`, `…044`. Drive with
any CDP client (`Input.dispatchKeyEvent`, scanner = digits ~5 ms apart then Enter). The scripts used
were session-local and are not committed; the steps below are the contract.

| Finding | Steps | Expected (today) |
|---|---|---|
| F-01 | Click the scan field, scan item A, Enter; same for item B. Click `+` on line 1. Scan any seed barcode. Then focus line 2's «حذف» (Tab) and scan again. | Line 1 quantity 2 → 3, no new line; line 2 removed |
| F-02 | One item → «تسليم السلة للدفع» → «المتابعة إلى الدفع» → «نقدي». Click the amount field. Scan a 13-digit barcode. Click «تأكيد الدفع النقدي». | Readout `<barcode>.00`, confirm enabled; after confirm due `0.00` and a trillion-scale change; SQLite `payment_tender_lines.amount_applied_minor` ≈ 6.2×10¹⁴ |
| F-03 | Item(s) totalling < 200 → checkout → «نقدي» → quick chip `200.00`. Read «الباقي للعميل». Click «تأكيد الدفع النقدي». Read it again. | Before: `200 − due`; after: `200.00` (DB `change_due_minor` stays correct) |
| F-04 | Build a cash tender (apply, do **not** settle) and leave the app untouched ≥ 15 min. Then run `await window.api.operator.getCurrentSession()` in the console, click «تأكيد الدفع», and read `payment_tender_lines.state`. | **Owned by RT-116/RT-117** — no new Jira (S1 lock core RT-117; S4/S5 later) |
| F-05 | One item → checkout → «بطاقة» → «تأكيد معالجة جهاز البطاقات» → «إلغاء». | **Owned by RT-116/RT-117** — no new Jira (RT-116 §3: external-card cancel needs explicit void-on-terminal confirmation) |
| F-06 | Add 3 items (draft). `Stop-Process` the app, relaunch with the same `--user-data-dir`. Open Sale. Read `carts`/`cart_lines` with `ELECTRON_RUN_AS_NODE=1 electron.exe -e` + `better-sqlite3`. | **Owned by RT-116/RT-117** — no new Jira (S4 held-cart re-attach / restart) |
| F-07 | Scan an item via the scan field and press Enter to confirm. Without clicking anywhere, scan another. | Digits appear in the search field → «لم يُعثر على الصنف»; nothing added |
| F-09 | In checkout, read computed style of `.cash-entry__confirm` / `.external-card-terminal-entry__confirm`. | `background-color: rgba(0,0,0,0)`, `border: 0` |
| F-10 | Checkout → «نقدي» at 1280×800; read the top of the «المبلغ المستحق» label. | `top ≈ 891 > 800` |
| F-14 | «تسجيل الخروج» → confirm; screenshot at 1024×768. | Cards offset to opposite edges, English «No cashiers available» |
