# D-N1: quotable sale number and the recent-sales list (RT-249, Planning)

> **Status: PLAN, for owner review.** No implementation here. Each slice in §8 becomes its own
> Implementation issue first.
>
> - **Jira:** **RT-249** (Work Mode: **Planning**). It closes decision **D-N1** in
>   [15](15-vnext-freeze-package.md) §7, finding **N-10** in [14](14-rt159-packaged-reaudit.md) §3, the
>   sale-number part of **F-11**, and dependency **X-4** in [08](08-rt24-invariants.md).
> - **Baseline:** POS `origin/main@0da76cbd`.
> - **Already decided (not reopened here):**
>   - the RT-249 "Approved recommendation";
>   - the 2026-10-07 reconciliation (comment 11150);
>   - the owner decisions of 2026-10-12 (comment 11720). The business date follows the
>     **Africa/Cairo** calendar. The recent list is **this terminal, current business day,
>     local only**: a cashier sees their own sales, a manager or admin sees every sale on the
>     terminal.
> - **Proposed here, needing an owner answer:** P-1 (§6.1), P-2 (§6.2) and the new strings (§7).
>   Everything else is the planner's contract work, which comment 11720 left to this issue.
> - **Precedence:** RT-24 and the merged code are the behaviour authority. This plan never
>   describes behaviour that `main` does not have as if it existed.

## 1. What happens today

### 1.1 How the number is made

- **Format.** `sale_number = <terminal_label>-<YYYY-MM-DD>-<NNNNNN>`
  (`src/main/sales/sale-number-allocator.ts:86`). `receipt_number === sale_number` in 008 v1
  (`finalize-transaction.ts:358`).
- **The label is free text.** The allocator comment says it was checked against
  `^[A-Z0-9-]{1,16}$` at pairing (`sale-number-allocator.ts:12-16`). **Nothing enforces that.**
  `pairing/service.ts:188` stores the backend's `terminal_label` as given. Real labels contain
  spaces and hyphens: `RT-159 audit`, and `Dev Terminal` in `dev-skip-pairing.ts:45`.
- **The date is the UTC day.** `finalize-dispatch.ts:123-127` takes `settled_at.slice(0, 10)`.
  Its comment says "Terminal-timezone shifting is deferred". The seam already exists: the
  injectable `localCalendarDayFor` at `finalize-dispatch.ts:59-69` and `:278`.
- **The sequence.** It is per `(terminal_id, calendar_day_local)` in `sale_number_sequences`
  (`migrations/0025`). The same day value is embedded in the number and stored in
  `sales.local_calendar_day`. `pad6` grows past 6 digits after 999,999 (`sale-number-allocator.ts:66-78`).
- **Uniqueness.** `UNIQUE (terminal_id, sale_number)` (`migrations/0020_create_sales.sql:39-41`).
  Two more indexes: `(tenant_id, branch_id, terminal_id)` and
  `(terminal_id, local_calendar_day)` (`:44-49`). The `sales` row is append-only (`0021`).

**Consequence (N-10).** The Cairo business day spans two UTC sequence runs: the counter resets
at 02:00 Cairo (03:00 in summer time). So a bare sequence number can repeat inside one Cairo
business day on one terminal. A sale at 01:53 Cairo carries the previous date.

### 1.2 Where the number goes

| Consumer | Uses `sale_number`? | Evidence |
|---|---|---|
| Backend-Core capture (011) | **No.** `externalId = pos-pulse:<envelope_handoff_action_id>` | `sales-sync/capture-payload.ts:251-253`; no `sale_number` in `src/main/sales-sync/` |
| Returns to Backend-Core (RT-15) | **No.** It sends the server `saleRef`. The local number is only the lookup key and a journal column | `returns-service.ts:194-230`; `returns-repository.ts:161` |
| Receipt | Yes: `Sale # <exact>` and `Receipt # <exact>`, plus a **UTC** stamp | `receipts/template-engine.ts:141-146` |
| Returns lookup | Exact, terminal-scoped match | `returns-service.ts:194-205` → `sales.repository.ts:113-119` |
| Legacy `/app/sales` find-and-reprint | Exact match after trim | `ui/receipts/FindSaleReceipt.tsx:61-68` |

So the display form, the lookup and the list are **POS-local**. They need **no Backend-Core read
and no cross-repo contract**.

### 1.3 The bridge today

- **`sales.read`, `sales.findByNumber` and `sales.subscribe`.** They are session-gated and
  terminal-scoped. They have **no role filter**, so a cashier can read any sale on the terminal
  (`sales-bridge.ts:250-311`).
- **`SaleSummary`** is defined at `shared/bridge-api.ts:1230`. It excludes
  `envelope_handoff_action_id` and `payment_attempt_id` (§P15).
- **`sales.subscribe('recent')`** returns only the single newest sale
  (`banner-state-projector.ts:135`).
- **`receipts.reprint({ sale_id })`** is cashier-permitted with no role restriction (AD-10,
  `bridge-api.ts:1410-1436`).
- **`returns.*`** requires a manager or admin in main (`returns-service.ts:7`). It sits behind
  `POS_PULSE_FEATURE_RETURNS`.

### 1.4 Completion (X-4)

- **What Completion shows.** `PaymentSurface.tsx` renders `CompletionPanel` with no sale
  number and the headline «تم استلام المبلغ».
- **Why the old number was removed.** Review round 3 removed the earlier `recent`-poll number
  (`PaymentSurface.tsx:767-785`, `:1638-1655`). That poll matched on
  `finalized_at >= settled_at`, so a **prior** sale finalizing late could be adopted.
- **What stays blocked.** T013a (the completion claim) and T017 (the receipt) are blocked on "an
  identifier tying the finalized sale to this payment".
- **The identifier already exists on both sides:**
  - the renderer holds `envelope.handoff_action_id` and `paymentSlice.payment_attempt_id`;
  - `sales.envelope_handoff_action_id` is **UNIQUE** (`0020:36-37`);
  - main already has `salesRepo.findByHandoffActionId` (`sales.repository.ts:170`).
- **Timing.** Finalization is the AD-2 listener, with a 200 ms default tick
  (`finalize-listener.ts:6`, `:64-65`).

### 1.5 Time helpers

- **`cairoBusinessDay`** exists once, in `main/cart/park/park-rules.ts:27-37`. It is already
  labelled "the D-N1 rule".
- **`formatHumanDateTime`** (RT-257, `renderer/ui/format/human-format.ts:51-55`) uses the
  **terminal** zone and has no zone option. The Store-timezone source is RT-279 (To Do), as
  [22](22-rt311-locale-architecture.md) §1.6 also notes.

## 2. Display-form rule

**Short form.** The sequence part, **without leading zeros**, in Western digits. Example:
`RT-159 audit-2026-10-06-000001` gives **`1`**, and `…-000047` gives **`47`**. Copy:
«رقم البيع ‹short›».

**Derivation (main, one shared pure function `saleNumberDisplay(row)`):**
- **Input.** The stored `sale_number` and the stored `local_calendar_day`. It never takes a
  substring from the left, because the label may contain `-` and spaces.
- **Match from the right.** Use `^(.*)-(\d{4}-\d{2}-\d{2})-(\d{6,})$`. Require group 2
  `=== local_calendar_day`, and take the short form as `String(Number(group3))`.
- **On a failed parse,** return `short: null`. The UI then shows the exact number only, and never
  invents a short form.
- **The renderer never parses.** It receives `short_number` from main.

**Exact form.** Every surface that shows the short form also makes the exact number available.
This follows UX-10 "Scan short; inspect exact" (comment 11150).
- Show it smaller, as an LTR-isolated run that can be selected and copied.
- The receipt keeps printing it.

**Uniqueness.** The short form is unique per `(terminal, stored day)`, not per Cairo business
day. That is why lookup (§4) handles more than one match. P-1 (§6.1) would make it unique
inside the list's whole scope.

**Business date (decided).** Every date shown with the number is the **Africa/Cairo** calendar
day and a 24-hour clock with Western digits. This covers Completion, the list, the lookup and
the receipt.
- It is a display rule. The stored value is unchanged unless P-1 is approved.
- **One helper.** Move `cairoBusinessDay` from `park-rules.ts` into
  `src/shared/time/business-day.ts`, next to `STORE_TIME_ZONE = 'Africa/Cairo'`. Park then
  imports it.
- **Renderer.** Add an optional `timeZone` to `formatHumanDateTime` and pass
  `STORE_TIME_ZONE` from D-N1 surfaces only. Switching the default for every caller belongs to
  RT-279 / RT-311.
- This creates no second formatter (RT-257 rule) and no third Cairo helper. RT-279 later
  replaces the constant with the Store's configured zone.

## 3. The recent-sales list: main read `sales.listRecent`

A new read-only channel on the `sales.*` namespace.

```ts
interface SalesListRecentRequest { short_number?: string } // digits only, 1–9 chars
type SalesListRecentResponse =
  | { kind: 'ok'; business_day: string; items: RecentSaleRow[]; truncated: boolean }
  | { kind: 'refused'; reason: SalesRefusalReason }; // no_session | forbidden_field_in_request | invalid_input*
interface RecentSaleRow {
  sale_id: SaleId;
  sale_number: SaleNumber;       // exact
  short_number: string | null;   // §2
  finalized_at: string;          // UTC ISO; the renderer formats in STORE_TIME_ZONE
  total_minor: number;           // subtotal_minor + total_tax_minor
  tender_types: SalesTenderType[];
  selling_operator_display_name: string;
  latest_print_outcome: PrintEventOutcome | 'none';
}
```

`*` `invalid_input` is a new member of the closed `SALES_REFUSAL_REASONS`. Every exhaustive
switch over it is updated in the same slice.

**Main computes all of the scope. The renderer sends no role, operator, terminal or date.**
1. **Guards.** The forbidden-field guard runs first, then the session (`no_session`).
2. **Scope.** The session's `(tenant_id, branch_id, terminal_id)`.
3. **Role.**
   - A **cashier** gets `selling_operator_id = session.operator_id`. That is the operator
     stamped at payment time (`payments/audit-emitter.ts:226-249` → `finalize-dispatch.ts:264`).
   - A **manager or admin** gets every sale on the terminal.
4. **Window.** The current Cairo business day of main's injected clock.
   - Select the scoped rows with `finalized_at >= now − 48 h`. This uses the
     `(tenant, branch, terminal)` index.
   - Keep the rows whose `cairoBusinessDay(finalized_at) === cairoBusinessDay(now)`.
   - **Do not filter on `local_calendar_day`**: under today's storage that is the UTC day. The
     JavaScript filter needs no daylight-saving arithmetic.
5. **Filter.** Apply `short_number` if given, before the cap.
6. **Order and cap.** Order by `finalized_at DESC`, then cap at 300 rows with
   `truncated: true`. Because the filter runs first, a short-form search never misses an older
   row.
7. **Projection.**
   - No `envelope_handoff_action_id`, `payment_attempt_id`, `envelope_cart_id` or tax id
     (§P15).
   - No tender references, voucher ids or amounts per tender.
   - The response is audit-free, like the other `sales.*` reads.

**Offline.** The list reads only the terminal's SQLite. It works with the API down, and sync
state is not shown (RT-113 owns that signal). With `saleFinalization` off there are no rows, so
the list is honestly empty.

## 4. Lookup by short form

The input field on each surface takes either form:

- **Normalisation.** Trim, then turn Arabic-Indic digits into Western digits.
- **Digits only (1–9 digits)** means a short form. Call `sales.listRecent({ short_number })`:
  - **0 matches:** show M-R1 plus M-N3 ("if the sale is from an earlier day, enter the full
    number as printed on the receipt");
  - **1 match:** open that sale;
  - **2 or more matches:** M-N4. Show the candidates with time, total and seller, and
    **never pick one automatically**.
- **Anything else** means the exact number. Use the existing path unchanged
  (`returns.lookup({ saleNumber })` or `sales.findByNumber`). This keeps sales from earlier
  days reachable from the receipt.

`returns.*` is **not changed**. The Returns screen resolves a short form or a picked row to the
exact `sale_number`, then calls `returns.lookup` as today. The RT-15 contract, its audit and its
online requirement (the live `readSale`) all stay. Offline, the list still works, and the
lookup then answers RT-15's existing `offline` refusal.

## 5. X-4: Completion correlates to its sale

### 5.1 The read

A new read-only channel:

```ts
interface SalesReadForHandoffRequest { handoff_action_id: string; payment_attempt_id: string }
type SalesReadForHandoffResponse =
  | { kind: 'ok'; sale: SaleSummary; short_number: string | null }
  | { kind: 'pending' }                                   // not finalized yet
  | { kind: 'refused'; reason: SalesRefusalReason };       // no_session | sale_not_found | forbidden_field_in_request
```

Main does the following:
1. Runs the forbidden-field guard, then checks the session.
2. Calls `findByHandoffActionId`. **Null** answers `pending`.
3. Answers `sale_not_found` when the row's scope differs from the session, or its
   `payment_attempt_id !== req.payment_attempt_id`. It does not answer `tenant_isolation`,
   so existence does not leak (§A4 #6).
4. Otherwise returns `SaleSummary` plus `short_number`. **Neither id is echoed**:
   `SaleSummary` already omits both (§P15).

### 5.2 Why this is safe

Round 3 removed a poll that matched on `finalized_at >= settled_at`. That match could adopt
**another** sale. This read uses the **exact** UNIQUE key of this handoff and confirms the
attempt id, so it cannot return another sale. Polling it is therefore safe. The poll is still
bounded so it does not run forever.

### 5.3 Renderer

- **When it starts.** In `phase === 'settled'`, and only when `saleFinalization` is on. With
  the flag off it makes **no call**.
- **What it reads.** The two ids the renderer already holds.
- **Poll timing.** It polls every 250 ms for 2 s, then every 1 s up to 15 s in total. It stops
  on `ok`, on `refused` or on unmount.
  - The settled phase must keep `payment_attempt_id` until Completion unmounts.
  - Verify that in the slice. Today it comes from `paymentSlice`.
- **On `ok`, the proof list gains two things:**
  - M-C1 «رقم البيع ‹short›», with the exact number secondary;
  - the headline «اكتمل البيع». It is proven now, which unblocks the T013a claim.
- **While `pending`:** no number line and no claim.
- **After the bound:** the neutral M-N5 line. It never claims the sale was saved.
- **What this unblocks.** It unblocks the receipt reference (T017) on the same key. Receipt
  preview UI stays with its own slice.
- **Comments.** Replace the "blocked on a correlation key" comments at
  `PaymentSurface.tsx:623-635`, `:767-785` and `:1638-1655`, and in
  `drawer-notice-store.ts:19-20`. Keep the drawer-notice scoping unchanged unless its own
  issue revisits it.

## 6. Proposed owner decisions

### 6.1 P-1: allocate the stored day on the Cairo calendar (recommended: yes, as its own slice)

**The change.** `finalize-dispatch` defaults `localCalendarDayFor` to
`cairoBusinessDay(settled_at)` instead of the UTC slice.
- The **format** `<label>-<YYYY-MM-DD>-<NNNNNN>` is unchanged.
- The **value** of the date part changes for new sales.
- 008 AD-7 and R-7 already specify the terminal's local day. The UTC default is a documented
  deferral (`finalize-dispatch.ts:62-68`).
- It is still a stored-value change, which comment 11720 reserves for a decision.

**Why it is worth doing:**
- the short form becomes unique across the whole recent-list scope;
- the date printed in the exact number equals the receipt's Cairo date.

**Blast radius:**
- **Backend-Core: none.** `sale_number` is not on the wire; see §1.2.
- **Returns journal:** stores the number as copied text, so old rows are untouched.
- **Receipt:** prints whatever `sale_number` holds.
- **Sequence at cutover:** no collision at any deploy time. The sequence key and the embedded
  date are the same value. Before the switch the key is the UTC day; after it, the Cairo day.
  - **Deploy at 01:30 Cairo on day D:** new sales use key `D`, which has no rows yet, so they
    start at 1. Earlier sales that day carry `D-1`.
  - **Deploy at 22:30 Cairo on day D:** key `D` is already in use, so numbering continues. The
    next Cairo midnight starts key `D+1` at 1.
  - Either way, `UNIQUE (terminal_id, sale_number)` holds.

**Until P-1 ships,** §4's "2 or more matches" branch covers the overlap window.

### 6.2 P-2: the cashier's door to their recent list (recommended: Sale command bar, dialog)

**The gap.** Comment 11720 gives a cashier their own sales for reprint. The cashier cannot do
returns, because main gates returns to manager and admin. The frozen entry-point table
([15](15-vnext-freeze-package.md) §1) has **no** cashier door to a list, and UX-09 rules out a
new nav destination. Today a cashier can reprint only from Completion (S14) or from the legacy
`/app/sales`.

**Recommendation:**
- **The door.** A secondary Sale command-bar action «إعادة طباعة إيصال». It opens a
  **dialog**, not a route, and follows the S17 dialog rules:
  - focus returns to the invoker;
  - a scanner burst is refused visibly.
- **The dialog** lists «مبيعاتك اليوم» with the short-form field. Picking a row calls the
  existing `receipts.reprint`.
- **When it is available.** Only while the cart is empty, so a reprint never interleaves with
  an open sale.

This changes the journey structure, so it needs the owner's yes under the freeze rule. If the
answer is no, the cashier keeps Completion-only reprint, and the list ships on the Returns
screen alone.

**Related, not in scope.** The owner's "today's invoices view" idea (a cashier list with search,
reprint and drawer number, behind a per-tenant toggle) has no Jira issue yet. P-2 is its
smallest compatible first step.

## 7. Copy

Arabic only, using «الإيصال», never «فاتورة». Strings marked **proposed** need the owner's
approval.

| ID | Where | Arabic | Status |
|---|---|---|---|
| M-C1 | Completion | «اكتمل البيع» · «رقم البيع ‹short›» (exact number secondary, LTR) · «الباقي للعميل ‹amount›» | exists; ⏳ D-N1 resolved by this plan |
| M-N1 | List title | manager or admin: «مبيعات اليوم على هذا الجهاز» · cashier: «مبيعاتك اليوم» | proposed |
| M-N2 | List empty | «لا توجد مبيعات اليوم على هذا الجهاز.» · cashier: «لا توجد مبيعات لك اليوم.» | proposed |
| M-N3 | Short form not found (after M-R1) | «إن كان البيع من يوم سابق فأدخل الرقم كاملًا كما في الإيصال.» | proposed |
| M-N4 | Ambiguous short form | «يوجد أكثر من بيع بهذا الرقم اليوم. اختر البيع من القائمة.» | proposed |
| M-N5 | Completion, number not ready at the bound | «رقم البيع غير متاح الآن.» (neutral) | proposed |
| M-N6 | List truncated | «تظهر أحدث 300 عملية. ابحث برقم البيع.» | proposed |
| M-N7 | Cashier door (P-2) | «إعادة طباعة إيصال» | proposed, with P-2 |
| M-N8 | Field label and hint | «رقم البيع» · «الرقم القصير أو الرقم الكامل من الإيصال» | proposed |

A list row reads `‹short› · ‹HH:MM› · ‹total› · ‹tender›`, plus the seller for a manager.
- **Formatting.** Western digits; money from `formatHumanMoney`; time from
  `formatHumanDateTime(…, { withDate: false, timeZone: STORE_TIME_ZONE })`.
- **Print state.** The row shows «أُرسل الإيصال للطابعة», «تعذّرت الطباعة» or nothing, never «طُبع» (N-09).

**Receipt (S5).**
- **Add** a bold line «رقم البيع ‹short›» above the existing exact `Sale #` line.
- **Date.** Print the sale time as the Cairo local time
  (`YYYY-MM-DD HH:MM`, 24-hour) instead of `utcStamp`.
- **Keep** the `Receipt #` line. Removing it is not part of this plan.

## 8. Implementation slices

Each slice is one issue in `Kemetra/POS`, Work Mode Implementation, citing this document.

| Slice | Scope | Depends on | Gate |
|---|---|---|---|
| **N-S1** Main reads + shared helpers | `shared/time/business-day.ts` (hoist and re-point park); `shared/sales/sale-number-display.ts`; `sales.listRecent` and `sales.readForHandoff` in `sales-bridge.ts` + repo queries; preload + `bridge-api.ts` types; `invalid_input` added to the refusal enum | — | **§A4 bridge-security re-check** for the two new channels (new record under `specs/008-…/security-review/`) |
| **N-S2** Completion number (X-4) | bounded poll in `PaymentSurface`; `CompletionPanel` gains `saleNumber?: { short; exact }` and the proven M-C1 headline; comment cleanup | N-S1; W1-C `CompletionPanel` (RT-243) | strings approved (M-N5) |
| **N-S3** Returns list + short lookup | list and field on the Returns screen (manager/admin); resolves to the exact number, then `returns.lookup` | N-S1 | strings approved (M-N1–M-N4, M-N6, M-N8) |
| **N-S4** Cashier reprint dialog | P-2 door + dialog + `receipts.reprint` | N-S1, **P-2 yes** | strings approved (M-N7) |
| **N-S5** Receipt | short-number line + Cairo stamp in `template-engine.ts`; golden updates | N-S1 helpers | receipt goldens reviewed |
| **N-S6** Cairo allocator anchor | `finalize-dispatch` default `localCalendarDayFor = cairoBusinessDay` | **P-1 yes** | migration-free; cutover test (§9) |

**Not in any slice:**
- a migration (none is needed: §3 uses existing columns and indexes);
- a change to the capture or returns contracts, or a Backend-Core read;
- a store-wide list (rejected for the pilot; a later store-wide list would need a Backend-Core
  read contract, which is **not** designed here);
- `/app/sales` legacy restyle (OD-6).

## 9. Test plan

**Unit tests (shared):**
- `saleNumberDisplay`:
  - `RT-159 audit-2026-10-06-000001` → `1`;
  - `A-B-C-2026-10-06-000047` (hyphenated label) → `47`;
  - a 7-digit sequence → `1000000`;
  - a mismatch between the stored day and the embedded date → `null`;
  - malformed input → `null`;
  - never throws.
- `cairoBusinessDay`:
  - 2026-10-06T22:53Z → `2026-10-07` (the N-10 case: 01:53 Cairo);
  - both sides of Cairo midnight in winter and summer time;
  - the DST change days: last Friday of April and last Thursday of October.
- Short-form normalisation: Arabic-Indic digits → Western; whitespace trimmed; non-digits →
  the exact path.

**Main tests (sql.js adapter, injected clock):**
- **`listRecent` scope:**
  - other tenant, branch or terminal rows are excluded;
  - a cashier sees only `selling_operator_id = session.operator_id`;
  - a manager and an admin see all rows on the terminal;
  - a request carrying `role`, `operator_id` or `terminal_id` is ignored or refused by the
    forbidden-field guard, never honoured.
- **`listRecent` window:**
  - a sale at 23:30 Cairo yesterday is excluded;
  - a sale at 00:10 Cairo today is included, even though its `local_calendar_day` is
    yesterday's UTC date.
- **`listRecent` filter and cap:**
  - the `short_number` filter returns all matches, including two sales with the same short form
    from two UTC runs in one Cairo day;
  - the filter applies before the cap;
  - 301 rows give 300 plus `truncated: true`;
  - order is `finalized_at DESC`.
- **`listRecent` projection:**
  - no `envelope_handoff_action_id`, `payment_attempt_id`, `envelope_cart_id` or tax id
    appears (a deep key scan of the response);
  - `no_session` answers before any read.
- **`readForHandoff`:**
  - no row → `pending`;
  - matching row → `ok`, without either id in the payload;
  - another terminal's row → `sale_not_found`;
  - same handoff with a different `payment_attempt_id` → `sale_not_found`;
  - `no_session`;
  - forbidden field.
- **N-S6** (if P-1 is approved):
  - a deploy at 01:30 Cairo starts key `D` at 1;
  - a deploy at 22:30 Cairo continues key `D`;
  - no `UNIQUE (terminal_id, sale_number)` violation in either case;
  - existing allocator tests stay green.

**Renderer tests (jsdom):**
- **Completion:**
  - flag off → no call;
  - `pending`, then `ok` → the number and «اكتمل البيع» appear;
  - **a different sale finalizing in between never shows** (fake bridge returns `pending` for
    this key while the `recent` topic has another sale);
  - the bound reached → M-N5 and polling stops (fake timers);
  - unmount stops polling;
  - focus stays on «بيع جديد» (§3.2).
- **Returns:**
  - short form with 1 match → `returns.lookup` called with the **exact** number;
  - 0 matches → M-R1 + M-N3;
  - 2 or more matches → M-N4 and no auto-pick;
  - exact input → the existing path;
  - offline → list shown, lookup shows RT-15's `offline` copy.
- **Cashier dialog (N-S4):**
  - lists own rows only (as given by main);
  - a scanner burst is refused;
  - focus returns to the invoker;
  - unavailable with a non-empty cart.
- **String sweep:** no Arabic-Indic digits, and no «طُبع», «فاتورة» or English on the new
  surfaces.

**Receipt goldens (N-S5):**
- the short line is present;
- the Cairo stamp for a sale at 2026-10-06T22:53Z prints `2026-10-07 01:53`;
- the duplicate variant is unchanged apart from these lines.

**Evidence (per slice):**
- captures at 1024 and 1280, light and forced-colours, for Completion with a number, the
  Returns list, and the dialog;
- for N-S2 and N-S5, one packaged sale after 00:00 Cairo showing the same Cairo date on
  Completion, the list and the receipt;
- for N-S1, the §A4 record.

## 10. Acceptance criteria (this Planning issue)

- [x] Display-form rule defined, including the business-date rule (Cairo, decided): §2.
- [x] Lookup by short form defined, including no-match, multi-match and earlier-day behaviour:
  §4.
- [x] Recent-list scope defined as the owner decided it (terminal, Cairo day, cashier-own,
  manager or admin all, local only, offline): §3.
- [x] X-4 correlation defined on an exact key with no miscorrelation path: §5.
- [x] Tests listed per slice: §9.
- [x] No Backend-Core read and no new cross-repo contract. The stored format and the
  capture/returns contracts are unchanged (P-1 is proposed separately): §1.2, §6.1, §8.
- [ ] Owner answers P-1, P-2 and the proposed strings (§6, §7).
- [ ] Implementation issues N-S1…N-S6 created from §8 (N-S4 and N-S6 only on a yes).

## 11. Risks and gaps

- **Operator identity across sign-in paths.** The cashier filter assumes the payment-time
  `operator_id` equals the session `operator_id` for the same cashier, including offline PIN
  sign-in (017/019 `user_id` re-anchor). N-S1 verifies this with a test across an offline
  PIN sign-in. If they differ, the cashier list is empty rather than leaking, which fails
  safe, and the slice stops and reports.
- **Manager recovery attribution (RT-441).** A sale settled under manager recovery is stamped
  with the manager, so the cashier's own list will not show it. That is accepted under "own
  sales" and is recorded here, not changed.
- **Existing reads have no role filter.** A cashier can still read or reprint another cashier's
  sale by its **exact** number (`sales.findByNumber` / `receipts.reprint`, AD-10). The list
  does not widen this, and narrowing it is outside D-N1.
- **Earlier-day returns.** The returns window spans several days (S&R 1040), but the list
  covers today only, so older sales need the full number from the receipt. A store-wide or
  multi-day list needs a Backend-Core read, which this plan does not design.
- **Timezone data.** The Cairo results depend on Electron's ICU tzdata, including Egypt's
  reinstated DST. The DST-day unit tests catch a stale table.
- **Receipt template determinism.** The receipt template avoids `Intl` on purpose
  (`template-engine.ts:13`). The Cairo stamp must use the explicit-zone helper and be pinned by
  goldens.
- **Freeze rule.** P-2 adds an entry point, so it is held for the owner. Nothing else changes
  journey structure.
