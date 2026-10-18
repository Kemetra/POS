# RT-278: plausibility bounds on shift amounts against scanner digits (Planning)

| | |
|---|---|
| Jira | RT-278, Work Mode **Planning**. No implementation here. Parent RT-6 (W6 Returns / Refunds / Shifts). |
| Source | RT-248 comment 11141 point 5; [16-d-f2-cash-received-bound.md](16-d-f2-cash-received-bound.md) §3, owner decision 5 ("open the same gap under RT-17 for scanned shift amounts"). |
| Finding class | F-02 (RT-159): a 13-digit barcode in a money field is read as **major** units, so `6221000000011` becomes `622_100_000_001_100` minor (about 6.2×10¹² EGP). |
| Precedent | RT-437 (implementation of RT-248 / D-F2, PR #652): `src/shared/payments/cash-bound.ts`, refusal `cash_amount_out_of_range`, copy M-P29. |
| Baseline | `origin/main@d63ee893` (RT-527 merge, #770, 2026-10-18). |
| Related | RT-17 (Done, shift cash-up), RT-239 (UI scan guard), RT-236, RT-658 (G-2 shift references). |

## 1. What exists today

### 1.1 The shift money inputs

There are four entry points that carry an amount from the renderer. All four use the same field, `ShiftAmountField` (`src/renderer/v5/shift/ShiftParts.tsx`), and the same parser, `parseShiftAmount` (`shift-format.ts`, which wraps `parseCurrencyToMinor`).

| Input | Renderer | IPC / bridge | Main service | Stored in (migration 0043) |
|---|---|---|---|---|
| Opening float | `V5ShiftRoute.tsx` `submit` | `shiftCashup:open` `{ openingFloatMinor }` | `openShift` | `opening_float_minor >= 0` |
| Pay-in | `CashMovementDialog.tsx` (kind `pay_in`) | `shiftCashup:payIn` `{ amountMinor, reasonCode, note? }` | `recordCashMovement` → `guardPayIn` | `amount_minor > 0` |
| Pay-out | `CashMovementDialog.tsx` (kind `pay_out`) | `shiftCashup:payOut` (same shape) | `recordCashMovement` → `guardPayOut` | `amount_minor > 0` |
| Counted cash at close | `CloseShiftPanel.tsx` `submit`, and again from `ManagerApprovalDialog.tsx` | `shiftCashup:close` `{ countedCashMinor, approver? }` | `closeShift`, and `verifyApprover` first when an approver is sent; both call `planClose` | `counted_cash_minor` |

### 1.2 The bounds that apply

| Layer | Opening float | Pay-in | Pay-out | Counted cash |
|---|---|---|---|---|
| Renderer `parseShiftAmount` | digits, at most 2 decimals, safe integer | same | same | same |
| Renderer scan guard (RT-239) | `inputMode="decimal"`, so `refuseKindOf` returns `'amount'`: a wedge burst ending in Enter is refused with M-S5 | same | same | same |
| IPC readers (`src/main/ipc/shift-cashup.ts`) | safe integer ≥ 0 | safe integer ≥ 1 | safe integer ≥ 1 | safe integer ≥ 0 |
| Service | none | `requireSafeAggregate` on pay-in total + amount and on expected cash + amount (`aggregate_out_of_range` → renderer `invalid_input`) | ≤ expected drawer cash now (`pay_out_exceeds_drawer_cash` → generic `pay_out_not_accepted`, tallied as a probe) | none on the amount. The calculator bounds the aggregates only. |
| Wire (`shift-wire.ts`) | `invalid_amount` if not a safe integer or does not fit `^-?[0-9]{1,15}(\.[0-9]{1,4})?$` | same | same | same |

**The real EGP maximum is 2⁵³ − 1 minor, not "about 10¹⁵ EGP".** `maxShiftAmountMinor('EGP')` returns `min(10^(15+2) − 1, Number.MAX_SAFE_INTEGER)`. That is `9_007_199_254_740_991` minor, about **9.0×10¹³ EGP**. The F-02 amount (6.2×10¹⁴ minor) is about 15 times smaller and passes every check in the table. Doc 16 §1 and the RT-278 description both say "about 10¹⁵ EGP". The conclusion holds, but the figure is wrong (OD-278-9).

### 1.3 What the scan guard does not cover

The UI guard claims only a **burst that ends in Enter**. It does not cover hand-typed digits, a paste, a scanner set up without an Enter suffix, or a slow wedge that the burst detector does not see. This is the gap D-F2 closed for cash received. Main is the only layer that sees every path.

### 1.4 The precedent: how RT-437 (PR #652) closed D-F2

| RT-437 element | What it did | For shift amounts |
|---|---|---|
| Pure shared rule | `src/shared/payments/cash-bound.ts`: `maxCashReceivedMinor`, `isCashAmountWithinBound`, imported by main and the renderer | **Carries over** as `src/shared/shift-cashup/amount-bound.ts` (§3.2) |
| Placement | FSM cash branch, inside the apply transaction, before any `lines.insert` or outbox write | **Carries over in kind**: service checks before any `repo.record*` (§3.3) |
| Rule shape | `amount ≤ max(cap, remaining)` | **Differs**: flat caps, because the analogous term (the expected cash) is hidden by the blind count (§3.1) |
| Refusal | `cash_amount_out_of_range` added to `REFUSAL_REASONS` | **Carries over**: `amount_out_of_range` added to `SHIFT_CASHUP_REFUSALS` (§3.4) |
| Copy | M-P29 «المبلغ أكبر من الحد المسموح للنقدية. راجع المبلغ.», pre-check plus main refusal, amount kept, field refocused, never «حاول مجددًا» | **Carries over**, with a new catalog row (§3.5) |
| Log | a new dedicated `warn` line, `tender.apply.cash_out_of_range`, with the attempt id and no amount | **Differs**: the existing `info` line `shift_cashup:refused {op, reason}` already logs every shift refusal without the amount. OD-278-8 asks whether to add a `warn` line |
| Audit | none (D-F2 decision 4) | **Carries over**: none (§3.6) |
| Change-preview suppression | the ledger stopped previewing change for an out-of-range amount | **Not needed**: the shift screens preview nothing derived from the amount |
| Fix-off proof | with the checks disabled, the new tests fail | **Carries over** (§5) |

## 2. Risk, by damage

Committed shift facts are immutable. A mistake is corrected only by a compensating event ([Shift & Cash Management](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/24674305) lines 1592–1625), and each count is a durable Count Attempt.

| Rank | Input | What a scanned value does |
|---|---|---|
| 1 | **Counted cash** | By default `varianceApprovalThresholdMinor` is unset, so **no** variance needs a manager. A scanned count closes the shift at once with a variance of about +6.2×10¹⁴ minor. The close is final, it syncs to Backend-Core, and the cashier is never shown the variance (blind count, P2-3). When a threshold is set, the manager approves blind too, because `ManagerApprovalDialog` shows no variance. |
| 2 | **Pay-in** | The expected cash is inflated for the rest of the shift. The only correction is a compensating pay-out of the same absurd amount, which the drawer bound then allows. The close then shows a large negative variance. |
| 3 | **Opening float** | The same inflation as a pay-in, but it is part of the open fact itself. It cannot be compensated without a pay-out. |
| 4 | **Pay-out** | Already bounded by the expected drawer cash. A scanned pay-out is refused unless a scanned float or pay-in inflated the drawer first. Once ranks 2 and 3 are bounded, the drawer cannot be inflated by a scan. |

## 3. Recommendation

### 3.1 Rule per input: flat caps, no relative term

| Input | Recommended rule | Value (owner to confirm) |
|---|---|---|
| Opening float | `openingFloatMinor ≤ maxShiftEntryMinor('opening_float', currency)` | **EGP 100,000.00** (`10_000_000` minor), the D-F2 value |
| Pay-in | `amountMinor ≤ maxShiftEntryMinor('pay_in', currency)`, per movement | **EGP 100,000.00** (`10_000_000` minor) |
| Pay-out | no new cap. The existing drawer bound stays. | n/a |
| Counted cash | `countedCashMinor ≤ maxShiftEntryMinor('counted_cash', currency)` | **EGP 1,000,000.00** (`100_000_000` minor) |

**Why flat, and not D-F2's `max(cap, remaining)`.** For cash received, `remaining` is shown to the cashier anyway. For a shift, the analogous term is the expected drawer cash, which the blind count hides on purpose (P2-3; the probe tally exists for this reason). A rule like `counted ≤ max(cap, expected + cap)` would let a cashier find upper bounds on the expected cash by trying amounts and watching for refusals. A flat cap depends on nothing hidden. It reveals nothing, and the renderer can run the same check without being told the expected cash.

**Why pay-out gets no cap.** A pay-out is already refused above the drawer, under a generic line that names no bound. A separate cap would need its own refusal. If that refusal differed from `pay_out_not_accepted`, it would show whether the drawer holds more than the cap. A legitimate end-of-day bank drop can also be large. The drawer bound is the right plausibility check here.

**Why counted cash gets a higher cap.** A legitimate close counts the whole drawer: the float plus every cash sale in the shift. At a busy store that can be more than EGP 100,000. A pharmacy terminal drawer above EGP 1,000,000 is implausible. **Escape hatch:** if a drawer really holds more than the cap, the cashier records a `bank_drop` pay-out first. That physically removes the cash, so the count falls under the cap. A manager forced close (`ForcedCloseDialog`) takes no amount. It is a Backend-Core action on a stuck shift. Whether it closes a terminal's open local shift was not verified for this plan, so it is not offered as the hatch.

**Scanner-digit arithmetic** (digits read as major units; method of doc 16 §2):

| Code | Read as | EGP 100,000 cap (float, pay-in) | EGP 1,000,000 cap (count) |
|---|---|---|---|
| EAN-13 (Egypt, prefix 622) | about 6.2×10¹² EGP | refused | refused |
| UPC-A (12 digits) | ≥ about 10¹⁰ EGP with a leading 0, ≥ 10¹¹ otherwise | refused | refused |
| EAN-8 | ≥ 10⁷ EGP (≥ 10⁶ with one leading 0) | refused, unless three or more leading zeros | refused, unless two or more leading zeros |
| UPC-E (8 digits, leading 0) | ≥ 10⁶ EGP unless more leading zeros | refused, unless three or more leading zeros | refused, unless two or more leading zeros |

No cap catches every code, because a code with many leading zeros reads as a small number. RT-239 stays the first line of defence. These caps are the backstop that keeps an absurd amount from being **recorded**, whatever path it came from.

**Shifts recorded before rollout.** The caps apply only to **new inputs**: the float at open, each new pay-in, and the count. They never apply to an aggregate (pay-in total, expected cash). A shift that is open at upgrade, with a large float or pay-in already recorded, can still take a pay-out and still close. `requireSafeAggregate` and the calculator's `within` stay as they are.

### 3.2 Where the value lives

- A new pure module, `src/shared/shift-cashup/amount-bound.ts`. It is the counterpart of `src/shared/payments/cash-bound.ts`, and both main and the renderer import it. The renderer cannot import `src/main/shift-cashup/shift-amount-bound.ts`, which stays as the storage bound.
- It is a code constant, not tenant configuration. A per-tenant setting would need a new cross-repo configuration contract, and the cash-limit **policy** in the Confluence page (lines 1817–1828) is deferred. This is a plausibility bound only.
- It fails closed: an unknown currency gives a cap of 0, so only a 0 float or count is accepted, and every pay-in is refused. The product is EGP only (`deps.currencyCode`).
- The float and pay-in value is the same number as `maxCashReceivedMinor('EGP')`. Recommendation: take it from `cash-bound.ts` instead of repeating the literal, so that one owner decision moves both.

### 3.3 Placement in main (the authority)

| Call | Check placed | Order |
|---|---|---|
| `openShift` | after `admit()`, before `requireClockFrom` and before `repo.recordOpen` | input check first, nothing written |
| `recordCashMovement` (pay-in) | first line of `guardPayIn`, before `requireSafeAggregate` | before any cash-up read or write |
| `recordCashMovement` (pay-out) | none | the existing drawer bound |
| `closeShift` and `verifyApprover` | at the top of `planClose`, before `openShiftAt` | before the PIN verify (`managerPins.verify`), before the `variance_approval_required` tally (`tallied`), before any write |

Putting the count check in `planClose` covers both close entry points with one line. It also means that a scanned count is never tallied as a probe and never reaches PIN verification, so no manager PIN attempt is spent on it.

### 3.4 Refusal shape

- **Service:** a new `ShiftCashupRefusalReason`, `'amount_out_of_range'`, thrown as `ShiftCashupRefusedError`. Nothing is written, so a corrected retry is evaluated again.
- **Bridge:** a new renderer refusal, `'amount_out_of_range'`, added to `SHIFT_CASHUP_REFUSALS` in `src/shared/shift-cashup/types.ts` and mapped one-to-one in `SERVICE_REFUSALS` (`shift-cashup-bridge.ts`). This is an additive IPC value. Main and the renderer ship in the same build. `REFUSAL_COPY` in `shift-copy.ts` is an exhaustive `Record`, so the compiler forces the copy row.
- **Consumers checked** (`grep SHIFT_CASHUP_REFUSALS|ShiftCashupRefusal` on `main@d63ee893`): the two exhaustive maps `SERVICE_REFUSALS` and `REFUSAL_COPY`, and the pass-through types in `V5ShiftRoute.tsx`. There is no runtime validator: `src/preload/shift-cashup.ts` and `src/renderer/v5/shift/shift-bridge.ts` pass the reason through. An unknown reason would only fall back to the generic line in `shiftRefusalMessage`.
- **Alternative (no contract change):** map the new service reason to the existing `invalid_input`. This was rejected because that line, «البيانات غير صالحة. راجع المبلغ والسبب والملاحظة.», sends the cashier to the reason and the note, and gives no hint that the amount is implausible.
- The refusal names a closed reason, never a value or the bound (P7). The existing `shift_cashup:refused {op, reason}` info line already logs it without the amount.

### 3.5 Renderer

- **Pre-check (recommended).** At submit, each of the three screens runs `isShiftAmountWithinBound` after `parseShiftAmount`: the open screen, the movement dialog for `pay_in` only, and the close panel. Above the bound, nothing is sent, the field is marked `aria-invalid` (`invalidEntry`), the new line is shown under it, the amount stays in the field and focus returns to it. Main stays the authority.
- **Main's refusal.** `amount_out_of_range` from main is shown as `invalidEntry` (marked invalid), not `refusedCall`. Like M-P29, it must never say «حاول مجددًا».
- **Copy (owner to word; draft):** «المبلغ أكبر من الحد المسموح لهذه العملية. راجع المبلغ. لم يُسجَّل شيء.» It follows M-P29 («المبلغ أكبر من الحد المسموح للنقدية. راجع المبلغ.») and the shift catalog's «لم يُسجَّل شيء» ending. It names no amount and no bound. It needs a new row in doc 15 §5.
- **G-2 references.** RT-658's G-2 shift set was approved as "every string verbatim from `shift-copy.ts`, no new strings". A new string therefore needs a small G-2 addendum, or an explicit owner note that this row is outside G-2. It does not change any layout.

### 3.6 Audit

No audit event, matching RT-17 part 1 decision 4 and D-F2 decision 4. Nothing is recorded, so there is no shift fact to audit. The existing refusal log line is enough.

**Owner option:** record it as a fraud or abuse signal. `audit_events.action_category` has no CHECK constraint, so a new category needs **no local migration**. Audit events sync to Backend-Core, though, so a new category is a **sync contract** change (GATED, §5).

## 4. Owner decisions

Each decision has a recommended option, listed first.

| ID | Decision | Recommended | Alternatives |
|---|---|---|---|
| OD-278-1 | Cap for opening float and pay-in | **EGP 100,000.00** each, the same constant as D-F2 | a lower float cap (for example EGP 20,000); separate values per field |
| OD-278-2 | Cap for counted cash | **EGP 1,000,000.00**, with the bank-drop escape hatch | EGP 100,000 (blocks a busy day's close until a bank drop); a higher value |
| OD-278-3 | Rule shape | **Flat caps for every field**; no relative term (blind count, §3.1) | a variance bound `counted − expected ≤ cap` in main only, with no pre-check, which is a probing oracle against P2-3 |
| OD-278-4 | Pay-out | **No new cap**; the drawer bound stays | add a cap equal to OD-278-2 under the same generic `pay_out_not_accepted` |
| OD-278-5 | Refusal | **New `amount_out_of_range`** service reason and renderer refusal (additive IPC) | map to the existing `invalid_input` and its generic copy (no contract change) |
| OD-278-6 | Arabic copy | **«المبلغ أكبر من الحد المسموح لهذه العملية. راجع المبلغ. لم يُسجَّل شيء.»** as a new doc 15 §5 row, plus a G-2 addendum note | the owner's own wording; reuse M-P29 verbatim (it says «للنقدية», which fits less well for a count) |
| OD-278-7 | Who enforces | **Main enforces; the renderer pre-checks** with the same shared rule | main only (the cashier sees the refusal only after the round trip) |
| OD-278-8 | Audit and log | **No audit event; keep the existing `info` line `shift_cashup:refused {op, reason}`**, which has no amount | add a dedicated `warn` line like RT-437's `tender.apply.cash_out_of_range` (still no amount); a fraud-signal audit category (sync contract, GATED) |
| OD-278-9 | Doc correction | **Correct "about 10¹⁵ EGP" to "2⁵³ − 1 minor, about 9.0×10¹³ EGP"** in doc 16 §1, in the implementation slice | leave doc 16 as historical |

## 5. Follow-up slices

| Slice | What | Gate |
|---|---|---|
| **S1** (Implementation) | Shared bound module, the main checks, the additive `amount_out_of_range` refusal, the renderer pre-check and copy, docs (doc 15 §5 row, doc 16 correction, G-2 addendum note). No migration, no Backend-Core change. | **Not gated.** It needs OD-278-1…9 answered, and the copy approved. |
| S2 | SQLite CHECK constraints on the 0043 amount columns (defence in depth) | **GATED: local migration.** Adding a CHECK means a table rebuild, and rows recorded before rollout above the cap would fail it. Not recommended. |
| S3 | Server-side bound on shift facts in Backend-Core (the contracts' amount pattern or API validation) | **GATED: cross-repo contract** (Kemetra contracts and Backend-Core). Not recommended for the pilot, because the POS is the only writer of these facts. |
| S4 | Audit category for refused shift amounts | **GATED: sync contract** (audit events sync to Backend-Core). Only if OD-278-8 picks it. |

### S1 outline (for the implementation ticket)

**Files**

- Create: `src/shared/shift-cashup/amount-bound.ts`, `tests/unit/shared/shift-cashup/amount-bound.test.ts`
- Modify: `src/main/shift-cashup/shift-cashup-service.ts` (reason, `openShift`, `guardPayIn`, `planClose`), `src/main/shift-cashup/shift-cashup-bridge.ts` (`SERVICE_REFUSALS`), `src/shared/shift-cashup/types.ts` (`SHIFT_CASHUP_REFUSALS`), `src/renderer/v5/shift/shift-copy.ts`, `V5ShiftRoute.tsx`, `CashMovementDialog.tsx`, `CloseShiftPanel.tsx`
- Docs: `docs/design/vnext/15-vnext-freeze-package.md` §5, `16-d-f2-cash-received-bound.md` §1, the G-2 addendum note

**Interfaces**

- `export type ShiftAmountEntry = 'opening_float' | 'pay_in' | 'counted_cash';`
- `export function maxShiftEntryMinor(entry: ShiftAmountEntry, currency: string): number;`, with 0 for an unknown currency
- `export function isShiftAmountWithinBound(entry: ShiftAmountEntry, amountMinor: number, currency: string): boolean;`
- `ShiftCashupRefusalReason` gains `'amount_out_of_range'`. `SHIFT_CASHUP_REFUSALS` gains `'amount_out_of_range'`.

**Tests**

Shared (`amount-bound.test.ts`):

- `maxShiftEntryMinor('opening_float', 'EGP') === 10_000_000`, `('pay_in', 'EGP') === 10_000_000`, `('counted_cash', 'EGP') === 100_000_000`. An unknown currency gives 0.
- For each entry: the cap is accepted, cap + 1 is refused, 0 is accepted. The F-02 amount `622_100_000_001_100` is refused.

Main (service and bridge):

- **Open:** a float at the cap opens. Cap + 1 → `amount_out_of_range`. No shift row is written and the open shift stays null.
- **Pay-in:** at the cap it is recorded. Cap + 1 and the F-02 amount → `amount_out_of_range`. No movement row is written, the pay-in total is unchanged, and the check fires before `aggregate_out_of_range`.
- **Pay-out:** an amount above the pay-in cap but within the drawer is still accepted. Above the drawer it still gives `pay_out_not_accepted` (unchanged).
- **Close:** a count at the cap closes. Cap + 1 → `amount_out_of_range`, with no close row and the shift still open. With a threshold set, a scanned count is refused **before** `variance_approval_required`, and the probe tally is unchanged.
- **verifyApprover:** a scanned count is refused, and `managerPins.verify` is not called (no PIN attempt spent).
- **Before rollout:** a shift seeded with a float and a pay-in above the cap still takes a pay-out and closes with a count under the count cap.
- **Bridge:** `amount_out_of_range` maps one-to-one, and the `shift_cashup:refused` log payload has `{ op, reason }` and no amount.

Renderer:

- On each of open, pay-in and close, above the cap: no bridge call, `aria-invalid`, the new line shown, the value kept, focus on the field.
- A pay-out above the pay-in cap is sent (no pre-check).
- Main's `amount_out_of_range` shows the new line marked invalid, not a retry line.
- The RT-240 strict sweep (`latin-leaks.ts`) passes on the new copy.

**Fix-off proof:** with the main checks and the pre-check disabled, the new main and renderer tests fail.

## 6. Rollout and risk

- No migration, no Backend-Core API change. One additive IPC refusal value, shipped in the same app build as its renderer copy.
- **Risk:** a legitimate drawer above EGP 1,000,000 cannot be counted. Mitigation: a bank-drop pay-out first.
- **Risk:** a legitimate float or pay-in above EGP 100,000 is refused. Mitigation: split it into several pay-ins. Each one is a separate, reasoned fact.
- **Change footprint:** three pre-write checks in one service, with no new state, no new transition and no new persisted field.

## 7. Next safe action

The owner answers OD-278-1…9 on RT-278. Then S1 is opened as one bounded Implementation ticket under RT-6.
