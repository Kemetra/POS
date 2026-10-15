# 21 — D-P1: external-card outcome input and UNKNOWN recovery (RT-250)

**Status:** PROPOSED planning contract for owner review. Nothing here is implemented, and no
implementation is authorized by this document.

**Work Mode:** Planning (payment-state contract). **Repo:** `Kemetra/POS`.
**Jira:** RT-250 (parent RT-2, W2). **Authority:** RT-10 (tender contract) and RT-24 (cashier
behaviour).
**Consumes, does not redesign:**
- RT-116 contract (Confluence RETAIL 15663113): held / stuck attempt, §3.4 sign-out refusal, §4 admission guard, §5 manager recovery.
- RT-114 (C1–C10, action-kind catalogue).
- RT-441 (S6 manager recovery, on `main`).
- RT-256 (M-P13 manual-void copy).
**Source:** [15-vnext-freeze-package.md](15-vnext-freeze-package.md) §2 S10–S12, §5 M-P7–M-P13, §7 D-P1.
Invariants: [08](08-rt24-invariants.md) I-7 and I-10.

**Baseline:**
- Read at worktree `HEAD` = `96895000`.
- `origin/main` = `837b0866` at the time of writing. The only delta is docs and constitution v1.7.0, with nothing on payments (checked).

---

## 1. Problem and approved recommendation

**F-13 (RT-159).**
- The card entry has one action, «تأكيد معالجة جهاز البطاقات», which records an **approved** line.
- A decline can only be expressed by «إلغاء».
- A "not sure" result has no path at all.
- S11 (declined) and S12 (UNKNOWN) are visually frozen, but nothing can trigger them.

**Approved recommendation (RT-250):** an outcome selector on card entry with three choices:
- **approved**;
- **declined:** no money is recorded and the cashier chooses a method again (M-P8);
- **not sure:** UNKNOWN recovery (M-P9), with **no re-charge**.

The selector stays under RT-10 and never claims a bank API (I-10).

**Domain constraints** (RT-250 comment 11151; S&R 1017–1029; UX constitution):

| # | Rule |
|---|---|
| C-1 | UNKNOWN is **per external tender operation**, not per sale (S&R 1017). |
| C-2 | No re-charge while an UNKNOWN is unresolved (1019). |
| C-3 | Manual terminal recovery needs explicit evidence or operator attestation (1021). |
| C-4 | Force-fail never erases that funds may have moved (1024). |
| C-5 | Manager approval is bound to action and amount, with attribution (1025/1026; RT-114 C7). |
| C-6 | A restart never auto-reverses (1028). |
| C-7 | UNKNOWN stays visible until resolved (1029). |
| C-8 | UX-05: the selector's default focus is **not** "approved". UX-07: Pending ≠ Failed ≠ UNKNOWN. UX-12: «نتيجة الدفع غير مؤكدة» plus a duplicate-charge warning, never «مرفوض». |
| C-9 | I-7: UNKNOWN is not a decline. I-10: no PAN/CVV; `external_reference` optional, `^[A-Z0-9]{0,6}$`. |

---

## 2. Facts on `main` this contract builds on (verified)

| # | Fact | Where |
|---|---|---|
| F1 | The tender-line states are `applying, applied, refused, reversed, reversal_pending`, held in the SQL CHECK. The legal edges include **`applying → applied`** and **`applying → refused`**. | `0014`; `shared/payments/fsm-types.ts` |
| F2 | The FSM **never persists `applying`** today. Every apply inserts the line directly as `applied` or `refused`. | `tender-line-fsm.ts` (all `lines.insert` sites) |
| F3 | Every **live-tender** predicate already includes `applying`: held attempts, payment-attempts repo, session admission, lock-state reader, held carts, park store, manager recovery and the renderer `PaymentSurface`. The Back guard treats `applying` as an external operation in flight. | `held-attempts.ts:95`, `payment-attempts.repository.ts:275`, `session-admission.ts:117`, `lock-state-reader.ts:65,135`, `held-carts.ts:54`, `park-store.ts:79`, `manager-recovery.ts:171`, `checkout-return-guard.ts:12` |
| F4 | `settlementSumMinor` counts only `applied` lines, so confirm refuses `tender_underpaid` while a line is `applying`. | `payment-tender-lines.repository.ts:226-233` |
| F5 | `computeRemainingBalance` counts only `applied` lines. An `applying` card amount would still look **owed**, so a second card or cash apply would be accepted. **This is the C-2 double-charge hole a persisted UNKNOWN would open.** | `tender-line-fsm.ts:170-180` |
| F6 | `listAppliedLifoIds` returns only `applied` lines. `payments.cancel` would move the attempt to `cancelled` and leave an `applying` line dangling: live tender on a terminal attempt. | `tender-line-fsm.ts:579-585`; `payment-attempt-fsm.ts:237-290` |
| F7 | RT-441 `stuckView` counts live lines (including `applying`) as paid. `completeStuck` **consumes the RT-114 approval before** `confirm`, which would then refuse because of F4. The approval would be burned on a generic `payment_refused`. | `manager-recovery.ts:332-346, 553-575` |
| F8 | RT-441 `cancelStuck` already requires `card_void_confirmed_on_terminal` for any live `external_card_terminal` line. | `manager-recovery.ts:202-211` |
| F9 | The replay branch of `tender.apply` rebuilds `applied` / `refused` lines only. Any other state falls to `internal_error`. | `handlers/tender-apply.ts` replay block |
| F10 | `payment_tender_lines.refusal_reason` has **no** CHECK. `payment_action_outbox.action_kind` **has** a CHECK of 8 kinds, plus the 0016 append-only trigger and the `tender_line_id` biconditional CHECK. | `0014`, `0015`, `0016` |
| F11 | `audit_events.action_category` has no CHECK (RT-116 M12). `PAYMENT_AUDIT_CATEGORIES` and `REFUSAL_REASONS` are closed TS tuples with exhaustive consumers. | `shared/payments/types.ts` |
| F12 | The finalize summary and the RT-79 capture `tenders` read **only `applied`** lines. | `sales/finalize-dispatch.ts:194-200` |
| F13 | A card line must equal the remaining balance (exact-only). The renderer sends `amount_applied_minor = remainingBalanceMinor`. | `tender-line-fsm.ts:412-420`; `ExternalCardTerminalEntry.tsx` |
| F14 | Cancelling an **applied** card line reverses it locally with `manual_void_required = true`. The renderer then shows M-P7 (confirm) and M-P13 (after cancel). | `payments-cancel.ts:168`; freeze 15 §5 |
| F15 | RT-26 Back to Sale is refused while the cart has **any tender line in any state**: a `refused` line blocks it, and `applying` is already documented there as "UNKNOWN". The renderer maps any projected line to the M-P1 copy («… بعد تسجيل مبلغ»). | `checkout-return-guard.ts:1-30`; `PaymentSurface.tsx:359,799` |

---

## 3. Payment-state model

### 3.1 Decision: UNKNOWN is a persisted `applying` card line

"Not sure" writes the card line in state **`applying`**, with the amount the cashier keyed into
the terminal. The attempt stays `started`.

Why this model:
- **C-1:** UNKNOWN belongs to one external operation, so it sits on the tender line, not the attempt.
- **RT-116 §1:** held and stuck are derived states, with no new attempt state.
- **F1:** the resolution edges `applying → applied | refused` **already exist**. D-P1 adds **no FSM edge and no tender-line state**.
- **F3:** `applying` is already "live tender" everywhere. UNKNOWN therefore inherits without new code:
    - sign-out refusal `payment_in_progress` (RT-116 §3.4);
    - the admission guard `terminal_has_unresolved_payment` (§4);
    - hold-on-session-end and owner re-attach (S5);
    - Back blocked (`checkout-return-guard`);
    - the force-fail restriction (RT-441 `recovery_required`);
    - lock-screen `has_live_tender`.
- **C-6:** no restart path touches a live line (F3; the RT-116 §9 sweeps are retired), so the line is never auto-reversed.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| A new tender-line state `unknown` | Needs a gated 0014 table rebuild. Every live predicate (F3, 9 sites) must be edited, with a real risk of missing one. It adds a state whose edges duplicate `applying`'s. |
| A UNKNOWN attempt state | Breaks C-1, because a split tender has one UNKNOWN operation, not an UNKNOWN sale. It also adds an attempt state RT-116 avoids, and fights the `one_started_per_terminal` index. |
| Renderer-only state (route to a screen and persist nothing) | Lost on restart. Breaks C-6, C-7 and the audit deliverable. |
| Record "not sure" as `applied` and let cancel reverse it | Fabricates an approval. Breaks I-7. |

The name `applying` stays an internal storage value. The bridge and copy expose it as UNKNOWN, and
no raw state reaches the DOM (freeze §5 rule 3).

### 3.2 State mapping onto existing payment states

| Cashier choice | Tender line | Attempt | Money counted (`settlementSum`) | Bridge response | Outbox `action_kind` | Audit |
|---|---|---|---|---|---|---|
| **approved** | inserted `applied` (today's path) | `started` → can settle | yes | `{ kind: 'ok', … }` (unchanged) | `tender.apply` | `tender.applied` (unchanged) |
| **declined** | inserted `refused`, `refusal_reason = 'card_declined_on_terminal'`, `refused_at` | `started`, remaining unchanged | no | `{ kind: 'card_declined', tender_line_id, refused_at }` | `tender.apply` | `tender.refused` (same precedent as `non_cash_overpayment_refused`) |
| **not sure** | inserted `applying`, with `applied_at` null and `amount_applied_minor` = keyed amount | `started`; settle, cancel and new tender **blocked** (§3.4) | no | `{ kind: 'card_outcome_unknown', tender_line_id, recorded_at }` | `tender.apply` | **new** `tender.outcome_unknown` |
| UNKNOWN → resolved approved | `applying → applied` (sets `applied_at`, optional `external_reference`) | settle now possible | yes | `{ kind: 'resolved', resolution: 'approved', resolved_at }` | **new** `tender.resolve_outcome` | `tender.applied` with payload `resolved_from: 'unknown'` + new `tender.outcome_resolved` |
| UNKNOWN → resolved declined | `applying → refused`, `refusal_reason = 'card_declined_after_unknown'` | remaining restored | no | `{ kind: 'resolved', resolution: 'declined', resolved_at }` | `tender.resolve_outcome` | `tender.refused` + `tender.outcome_resolved` |
| UNKNOWN → closed by manager, terminal void attested | `applying → refused`, `card_unknown_void_attested` | then `cancelled` (RT-441) | no | RT-441 `{ kind: 'cancelled' }` | `tender.resolve_outcome` + `payment.cancel` | `tender.refused` + `payment.recovery_cancelled` (payload `card_void_confirmed_on_terminal: true`) |
| UNKNOWN → closed by manager, terminal unverifiable (**D-P1-4**) | `applying → refused`, `card_unknown_unverifiable` | then `cancelled` | no | RT-441 `{ kind: 'cancelled' }` | same | `tender.refused` + `payment.recovery_cancelled` (payload `card_outcome_unverifiable: true`, `reconciliation_required: true`) |

**Line close reasons.** These are persisted in `refusal_reason`, which has no CHECK (F10). They form
a new closed TS tuple `CARD_LINE_CLOSE_REASONS`:
- `card_declined_on_terminal`
- `card_declined_after_unknown`
- `card_unknown_void_attested`
- `card_unknown_unverifiable`

They are kept **out of** `REFUSAL_REASONS` because they are recorded facts, not bridge refusals.
The persisted column type becomes `RefusalReason | CardLineCloseReason`.

A `refused` line never re-opens. C-4 holds because the line row, its `amount_applied_minor` and the
audit trail stay forever, so "funds may have moved: X" is never erased.

### 3.3 Card retries

- After a **declined** outcome (proven by the terminal), another card attempt is legitimate, for example a different card. Card stays in the method list. M-P8 says «اختر طريقة دفع أخرى»; the card tile is not removed.
- After an **UNKNOWN**, no tender of any kind is accepted until it is resolved (G1).

### 3.4 Main-enforced guards (new)

**UNKNOWN on an attempt** = the attempt has at least one `external_card_terminal` line in `applying`. The guards live in main; the UI hiding an option is not enough.

| # | Call | New rule | Refusal |
|---|---|---|---|
| G1 | `tender.apply` (any type) | Refused while UNKNOWN exists. Closes the F5 double-charge hole and enforces C-2. | `card_outcome_unresolved` |
| G2 | `payments.confirm` | Refused while UNKNOWN exists, checked **before** the F4 sum. This gives a precise reason instead of `tender_underpaid`. | `card_outcome_unresolved` |
| G3 | `payments.cancel` (cashier path) | Refused while UNKNOWN exists. Avoids the F6 dangling line. The cashier resolves first (§4), or a manager closes it (§4.3). | `card_outcome_unresolved` |
| G4 | `tender.reverse` on an `applying` line | Already refused, because the edge is illegal. Pin it with a test. | `line_not_applied` (existing) |
| G5 | `recovery.completeAttempt` | Refused while UNKNOWN exists, **before** `consumeForAttempt`, so the approval is not burned (F7). | `card_outcome_unresolved` |
| G6 | `recovery.cancelAttempt` | Allowed. It closes each `applying` card line inside the cancel transaction according to the confirmation (§4.3), then runs the existing LIFO cancel. | `confirmation_required` (existing) when neither confirmation is present |
| G7 | `payments.forceFail` | Already restricted on live tender (RT-441). Unchanged. | `recovery_required` (existing) |
| G8 | `tender.resolveCardOutcome` | Only on an `applying` `external_card_terminal` line of a `started` attempt. Same owner and session gate as `tender.apply` (`requireOperatorSession`). | `line_not_applied` / `attempt_terminal` / `wrong_owner` |

`card_outcome_unresolved` is added to `REFUSAL_REASONS`.

**Scope of the freeze: every tender mutation, not only apply.** While an UNKNOWN exists, `tender.reverse` on a *different* `applied` line (for example earlier cash) is also refused `card_outcome_unresolved` (G1b). Two reasons:
- a partial reversal next to an unresolved card would leave a mixed state that neither the cashier S12 surface nor RT-441 cancel models;
- the only exits are resolution (§4.2) or the manager's whole-attempt cancel (§4.3), which handles every live line in one transaction.

Test: `reverse_other_line_refused_while_unknown`.

---

## 4. UNKNOWN recovery flow

### 4.1 Who resolves

**The original operator, by attestation (D-P1-1, recommended).** The cashier checks the terminal's
last transaction or its slip, then records what it shows. This is the C-3 "operator attestation"
branch. The audit records the attesting operator and the time.

The cashier can do this:
- immediately, on the S12 surface;
- after a lock (the same session resumes);
- after a restart or session end: the attempt is held as the stuck attempt (RT-116 S5), re-attaches when the owner signs in again, and lands on S12.

### 4.2 Resolution choices (cashier, S12)

| Choice (copy §5) | Effect | Next |
|---|---|---|
| «الجهاز يُظهر موافقة» | `applying → applied`. Optional reference (I-10; D-P1-2). | Normal Checkout: settle, or cancel through M-P7 / M-P13. |
| «الجهاز يُظهر رفضًا أو لا توجد عملية» | `applying → refused` (`card_declined_after_unknown`). | Method again (M-P8). |
| «لا أستطيع التحقق» | **No state change.** Shows M-P22 («اطلب المدير»). The line stays UNKNOWN, Back and sign-out stay blocked, and admission blocks other cashiers. | Manager recovery (§4.3). |

### 4.3 Manager path (RT-441, no new RT-114 kind for the pilot)

A manager enters recovery mode (`recovery.unlock_other`) and uses the existing
`recovery.cancel_attempt`. Its subject amount already includes the `applying` line, because
`liveTotal` uses the live predicate (F3/F7).

| Confirmation in `RecoveryCancelAttemptRequest` | Line close reason | Meaning |
|---|---|---|
| `card_void_confirmed_on_terminal: true` (existing field) | `card_unknown_void_attested` | The manager checked the terminal and voided any charge there, or confirmed there was none. |
| `card_outcome_unverifiable: true` (**new field**, D-P1-4) | `card_unknown_unverifiable` | The terminal can't be read (dead, no slip). The sale is cancelled; the possible charge goes to card-batch reconciliation. |

Either one satisfies `confirmationMissing` for a card UNKNOWN. A cash line still needs
`cash_returned_confirmed`.

**Completing a sale whose card outcome is UNKNOWN is not offered to a manager for the pilot** (G5).
Completion would mean a manager attests "approved" for someone else's operation. That is a new
RT-114 action kind (`recovery.resolve_card_outcome`), and the catalogue "grows by contract only".
It is listed as **D-P1-5** (recommendation: defer).

### 4.4 Interaction with the cancel confirm (RT-116 §3 / §5.2; M-P7, M-P13)

| Situation | Cancel behaviour |
|---|---|
| Card line **applied** (approved, or resolved approved) | Unchanged: M-P7 confirm → reverse with `manual_void_required` → M-P13. |
| Card line **refused** (declined) | Nothing to reverse. Cancel is the plain cancel (no M-P7, because no card money was recorded). |
| Card line **UNKNOWN**, cashier | Cancel is **refused** in main (G3). The UI does not offer «إلغاء» on S12: the primary is resolution, and the secondary is «لا أستطيع التحقق» → M-P22. A stale UI that sends cancel shows M-P21. |
| Card line **UNKNOWN**, manager recovery | RT-441 cancel with one of the §4.3 confirmations. The confirm copy is M-P23. |
| UNKNOWN line plus an earlier applied cash line | Cashier: G3 still refuses. Manager: both confirmations are required (cash returned + card void/unverifiable). |

### 4.5 Restart, lock, offline

- **Restart:** the line is durable and nothing reverses it (C-6). The attempt is the terminal's stuck attempt, and main re-attaches it to the owner on sign-in (RT-116 §3.1, `payment.reattached` on `main`).
    - **Renderer gap:** `complete-sign-in.ts` adopts only `getResumeState().cart_id`, and `payment_attempt_id` is ignored. The S19 route («متابعة الدفع المفتوح», freeze N-05, ⏳) does not exist yet.
    - Until it does, money is still safe: G1–G3, the admission guard and the sign-out refusal all hold in main. But the owner has no proven route back to S12 after a restart.
    - The S19 route is a **dependency of P1-B** (§10 order).
- **Lock:** no storage change (RT-116 §3.2). The lock screen shows no amounts (S18). `getLockState.summary.tender_applied_minor` excludes the UNKNOWN amount (applied only). `has_live_tender` is true.
- **Offline:** recording and resolution are local-only with no backend call, so they work offline. Manager recovery offline follows RT-114 C5.
- **Visibility (C-7):** S12 is the only Checkout state while UNKNOWN exists. The admission refusal and lock summary keep it visible to other operators without disclosing the amount (RT-116 §4).

---

## 5. Cashier UX

### 5.1 Card entry (S10, amended): the outcome selector

- **Layout:**
    - M-P6 instruction;
    - the amount to key into the terminal (unchanged, F13);
    - a radio group «ما نتيجة العملية على جهاز البطاقات؟» with three options in this order: «تمت الموافقة» · «رُفضت» · «غير متأكد»;
    - the reference field;
    - the pinned commit «تسجيل النتيجة».
- **No preselection (UX-05).** Initial focus goes to the group's legend (`tabIndex=-1`), not to an option. The commit is disabled until an option is checked, and **Enter is inert** until then. A scanner-suffix Enter can therefore never record an outcome.
- **Reference field:** shown and enabled only when «تمت الموافقة» is checked. It is optional, 0–6 characters, and `data-scan-refuse="reference"` stays (M-S5). For declined or not-sure, any typed reference is discarded and is not sent.
- **One step.** Choosing plus «تسجيل النتيجة» is one bridge call with a fresh idempotency key.
- **Wire:** `card_outcome: 'approved' | 'declined' | 'unknown'`, which main requires for `external_card_terminal` (`invalid_input` if it is missing).
- «تأكيد معالجة جهاز البطاقات» is retired.

### 5.2 S11 — declined

- Warning notice M-P8.
- The attempt and Checkout stay open, and the method picker gets focus.
- The ledger shows no card money.
- **Back stays refused** (F15, RT-26 unchanged): the declined line is a recorded interaction with a tender.
    - The way out is another method, or a plain cancel; nothing is reversed and M-P7 is not shown.
    - The Back refusal must show **M-P24**, not M-P1, because M-P1 claims an amount was recorded and here none was. The renderer distinguishes "only refused lines" from "applied lines".
    - Whether a proven decline should keep blocking Back is **D-P1-8**.

### 5.3 S12 — UNKNOWN (recovery workspace for the cashier)

- **Danger status heading** «نتيجة الدفع غير مؤكدة» (UX-12) with body M-P9. The amount is shown in an LTR `<bdi>`.
- **Primary:** a resolution radio group (§4.2, two options), plus the reference field for the "approval" option, plus the commit «تسجيل النتيجة». The same no-preselection and inert-Enter rules apply.
- **Secondary:** «لا أستطيع التحقق» → M-P22 inline. No state change.
- **Absent, not just disabled:** method picker, «إلغاء», Back and sign-out (freeze S12 "new charge, Back, sign-out" blocked; main enforces G1/G3 and RT-116 §3.4).
- **Esc:** does nothing on S12.

### 5.4 Copy catalog — proposed rows

These are proposals. Add them to 15 §5 in the implementing slice, not here: sibling sessions also edit 15.

| ID | Situation | Copy | Tone |
|---|---|---|---|
| M-P8 | Card declined (becomes final once D-P1 is approved) | «رُفضت العملية على جهاز البطاقات. لم يُسجَّل أي مبلغ. اختر طريقة دفع أخرى.» | warning |
| M-P9 | Result UNKNOWN, body; the S12 heading becomes UX-12's «نتيجة الدفع غير مؤكدة» (**D-P1-6**) | «النتيجة غير مؤكدة. لا تكرر الخصم. تحقق من جهاز البطاقات ثم تابع الاستعادة.» | danger |
| M-P19 | Outcome selector legend / options / commit | «ما نتيجة العملية على جهاز البطاقات؟» / «تمت الموافقة» · «رُفضت» · «غير متأكد» / «تسجيل النتيجة» | neutral |
| M-P20 | S12 resolution instruction / options | «تحقق من آخر عملية على جهاز البطاقات أو من إيصاله، ثم سجّل ما يظهر.» / «الجهاز يُظهر موافقة» · «الجهاز يُظهر رفضًا أو لا توجد عملية» | info |
| M-P21 | Cancel refused while UNKNOWN (stale UI or race) | «لا يمكن إلغاء الدفع قبل التحقق من نتيجة جهاز البطاقات. سجّل ما يظهر على الجهاز، أو اطلب المدير.» | warning |
| M-P22 | «لا أستطيع التحقق» | «اطلب المدير لإغلاق هذه العملية. لا تكرر الخصم ولا تبدأ بيعًا جديدًا على هذا الجهاز.» | danger |
| M-P24 | Back refused after a declined card (only refused lines, no money) | «لا يمكن الرجوع إلى البيع بعد محاولة دفع بالبطاقة. لم يُسجَّل أي مبلغ. اختر طريقة دفع أخرى أو ألغِ الدفع.» | info |
| M-P23 | Manager recovery confirmations for an UNKNOWN card line | «ألغيتُ العملية على جهاز البطاقات أو تأكدتُ أنه لا توجد عملية» / «تعذّر التحقق من الجهاز — تُحال العملية للمراجعة» | danger |

Rules: Arabic only; amounts in `<bdi dir="ltr">` with `EGP` after; no raw states; UNKNOWN never «مرفوض» (freeze §5 rules 1–6). No new `dir="rtl"` is added; the surface inherits from the root (RT-311 finding).

---

## 6. Local outbox, idempotency and sync

- **Apply hash.** `card_outcome` joins the canonical `tender.apply` payload (`action-payload.ts`), so a retry with a different outcome under the same key is refused `idempotency_payload_mismatch`.
- **Replay (F9).** One mechanism, with no new column.
    - A replay only reaches the response builder when the payload hash matched, so the replayed request's `card_outcome` equals the original's.
    - For a card apply, the response is built from **the request's `card_outcome` plus the reserved `tender_line_id`** and that line's original timestamp, **not from the line's current state**:
        - `unknown` → `card_outcome_unknown` with `recorded_at`, even if the line has since been resolved;
        - `declined` → `card_declined`;
        - `approved` → today's `ok` path (RT-304: `applied_at` is never cleared).
    - The schema has no "was UNKNOWN" column, so state-based reconstruction cannot answer a replay after resolution.
    - The renderer always re-reads `payments.read` after an apply, so a replayed `card_outcome_unknown` for an already-resolved line is corrected by that read.
    - **Timestamp source.** `recorded_at` is the time of the line's `tender.apply` outbox row (`created_at`). That row is append-only and is found by the reserved `action_id`.
- **New outbox kind** `tender.resolve_outcome` (line-bearing). This needs a **§A2-gated table rebuild** of `payment_action_outbox`:
    - extend the `action_kind` CHECK and the `tender_line_id` biconditional;
    - re-create the 0016 append-only trigger;
    - use the 0019 rebuild pattern;
    - use the next free migration number at execution (0051 if nothing lands first).
    
    The resolve request `{ payment_attempt_id, tender_line_id, resolution, external_reference? }` is hashed (reference redacted) under its own idempotency key. A replay returns the recorded resolution.
    
    **Rejected:** reusing the `tender.apply` kind for resolution. The outbox would show two "applies" for one line, and the replay branch keyed on `tender_line_id` would become ambiguous.
- **Recovery close** writes one `tender.resolve_outcome` row per UNKNOWN line (`action_id = ${approval_id}:resolve:${tender_line_id}`) inside the RT-441 cancel transaction, before `payment.cancel`.
- **Sale sync / capture: unaffected (F12).** Declined and UNKNOWN lines are never `applied` on a settled attempt, so they never reach `tender_lines_summary_json`, the RT-79 `tenders[]` or Backend-Core. A sale settled after an UNKNOWN resolved as approved carries the card line like any card line. A sale cancelled from UNKNOWN produces no sale.
- **Cart outbox: unaffected.** The cart stays `frozen_handed_off`, as in any started attempt.

---

## 7. Audit records

Local `audit_events`, with the 004 FR-025 attribution and P11 redaction: never a PAN, the reference
redacted as today. New categories need no migration (F11) but must be added to
`PAYMENT_AUDIT_CATEGORIES`.

| Category | When | Payload (beyond the standard attribution) |
|---|---|---|
| `tender.refused` (existing) | declined at entry; resolved declined; manager close | `refusal_reason` ∈ `CARD_LINE_CLOSE_REASONS`, `amount_applied_minor`, `resolved_from?: 'unknown'` |
| `tender.outcome_unknown` (**new**) | "not sure" recorded | `tender_line_id`, `payment_attempt_id`, `amount_applied_minor`, `recorded_at` |
| `tender.outcome_resolved` (**new**) | any `applying` → `applied` / `refused` | `from: 'unknown'`, `to: 'approved' or 'declined' or 'void_attested' or 'unverifiable'`, `attested_by_operator_id`, `approving_supervisor_id?` (manager close), `approval_id?`, `reference_present: boolean`, `unknown_since` |
| `tender.applied` (existing) | resolved approved | adds `resolved_from: 'unknown'` |
| `payment.recovery_cancelled` (existing, RT-441) | manager close | adds `card_outcome_unverifiable: boolean`, `reconciliation_required: boolean` |

**Reconciliation population.**
- `tender.outcome_resolved` with `to = 'unverifiable'` is the local list of possibly-moved card funds (C-4).
- Whether it goes central (RT-160 D-2) is **D-P1-7**.

---

## 8. Cross-repo and contract dependencies

**No Backend-Core, Connector or OpenAPI change is required** for D-P1 (§6, F12). Two items are flagged as decisions, not invented:

1. **D-P1-7: central visibility of UNKNOWN and unverifiable card lines.** RT-160 D-2 decides which local audit categories go to Backend-Core. Today the "possibly charged, sale cancelled" population is visible only on the terminal. Making it central needs a Backend-Core audit-catalogue change first, which is not in this issue.
2. **RT-17 interaction (none expected).** UNKNOWN affects card, not cash, and cash-up reads settled sales. A cancelled-from-UNKNOWN sale contributes nothing. The card-batch versus POS card-total comparison is ERPNext bank reconciliation, out of scope (RT-10 D5).

---

## 9. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| **D-P1-1** | Who resolves UNKNOWN to approved or declined | The original operator, by attestation after checking the terminal or slip (C-3). Otherwise it becomes the stuck attempt → RT-441. |
| **D-P1-2** | Is a reference required when UNKNOWN resolves to approved? | No, it stays optional (I-10). The audit records `reference_present`. |
| **D-P1-3** | Model: persisted `applying` line vs a new `unknown` state | `applying` (§3.1): no state migration, inherits every live-tender guard. |
| **D-P1-4** | Manager close of an unverifiable terminal: new `card_outcome_unverifiable` confirmation on `recovery.cancelAttempt` | Yes. Without it, a dead terminal blocks its till indefinitely. The line is closed `card_unknown_unverifiable` and flagged for reconciliation. |
| **D-P1-5** | Manager **completes** an UNKNOWN sale (new RT-114 kind `recovery.resolve_card_outcome`) | Defer past the pilot. The manager path is cancel-only; the original cashier can still resolve and complete. |
| **D-P1-6** | The S12 heading uses UX-12 «نتيجة الدفع غير مؤكدة» (freeze S12 says «النتيجة غير مؤكدة») | Use UX-12 for the heading and keep M-P9 as the body. |
| **D-P1-8** | Should a **proven decline** keep blocking Back to Sale? RT-26 refuses Back on any tender line (F15). | Keep RT-26 as is: strict proof, no RT-26 change in this issue. Fix only the copy (M-P24). Revisit only if pilot evidence shows friction. |
| **D-P1-7** | Central audit of `tender.outcome_unknown`, `tender.outcome_resolved` and `card_unknown_unverifiable` (RT-160 D-2) | Yes for `tender.outcome_resolved` with `to = 'unverifiable'`. Raise it as a Backend-Core catalogue item after D-P1 ships; it does not block the POS slices. |

---

## 10. Implementation plan

**Goal:** the cashier can record a card terminal outcome as approved, declined or UNKNOWN; UNKNOWN
blocks any re-charge and is resolved by attestation or manager recovery, never reversed
automatically.

**Architecture:**
- A persisted `applying` card line represents UNKNOWN.
- Main adds guards G1–G8, one bridge call (`tender.resolveCardOutcome`) and one outbox kind (`tender.resolve_outcome`).
- RT-441 cancel closes UNKNOWN lines by confirmation.
- The renderer replaces the single card commit with an outcome selector and adds the S11 and S12 surfaces.

**Tech:**
- Electron main (better-sqlite3), shared TS bridge types, React renderer, Vitest.
- Commits only when the implementing issue authorizes them; stage named files only.

**Global constraints:**
- Money is integer minor units.
- No PAN.
- `external_reference` stays `^[A-Z0-9]{0,6}$`, optional, and redacted in logs.
- No raw state reaches the DOM.
- UNKNOWN is never «مرفوض».
- Nothing auto-reverses a live line.
- Every new bridge field goes through the §A4 re-check, and the outbox rebuild through §A2.
- No change to the `tender_lines_summary_json` / capture shape.

**Review focus** (failure modes no single task would otherwise pin; each has a test in its task):

1. A scanner suffix Enter on the selector records nothing. **P1-B:** `selector_ignores_enter_without_choice`.
2. A double-click on «تسجيل النتيجة» records one line. **P1-B** (single-flight) plus **P1-A** idempotency replay.
3. A cash apply after UNKNOWN is refused, which is the double charge. **P1-A:** `apply_refused_while_card_outcome_unknown` (cash and card).
4. A restart between "not sure" and resolution keeps the line `applying` and re-attaches to S12. **P1-V** packaged run plus a **P1-A** held-attempt test.
5. A manager complete on an UNKNOWN attempt leaves the RT-114 approval unconsumed. **P1-C:** `complete_refused_before_approval_consumed`.

### P1-A — Main: outcome recording, guards, resolution (§A2 + §A4)

**Files:**
- Modify:
    - `src/shared/payments/types.ts`: `CARD_TERMINAL_OUTCOMES`, `CARD_LINE_CLOSE_REASONS`, refusal `card_outcome_unresolved`, two audit categories;
    - `src/shared/bridge-api.ts`: `TenderApplyRequest.card_outcome`, the two response kinds, `TenderResolveCardOutcomeRequest/Response`;
    - `src/shared/payments/channels.ts`: `tender:resolveCardOutcome`;
    - `src/main/payments/fsm/tender-line-fsm.ts`: apply branches, `resolveOutcome`, and `hasUnknownCardLine` (one query);
    - `src/main/payments/fsm/payment-attempt-fsm.ts`: G2, G3;
    - `src/main/payments/handlers/tender-apply.ts`: G1, replay (F9);
    - new `src/main/payments/handlers/tender-resolve-card-outcome.ts`: G8;
    - `src/main/payments/action-payload.ts`: outcome in the hash, resolve payload;
    - `src/main/payments/audit-emitter.ts`;
    - `src/main/payments/repositories/payment-action-outbox.repository.ts`: kind union;
    - `src/main/payments/repositories/payment-tender-lines.repository.ts`: an `applying → applied` update that also sets `external_reference`. Today `updateToApplied` writes only `state`, `applied_at` and `last_action_id`, so a reference given at resolution would be dropped silently;
    - preload and IPC registration.
- Create: `migrations/00NN_payment_action_outbox_resolve_outcome.sql`, a rebuild that re-creates the 0016 trigger.

**Interfaces produced:**
- `CardTerminalOutcome = 'approved' | 'declined' | 'unknown'`
- `TenderApplyResponse` adds `{ kind: 'card_declined'; tender_line_id; refused_at }` and `{ kind: 'card_outcome_unknown'; tender_line_id; recorded_at }`
- `tender.resolveCardOutcome({ payment_attempt_id, tender_line_id, resolution: 'approved' | 'declined', external_reference?, idempotency_key })` → `{ kind: 'resolved'; resolution; resolved_at } | PaymentRefusal`
- `TenderLineFsm.closeUnknownInTransaction({ tender_line_id, reason: 'card_unknown_void_attested' | 'card_unknown_unverifiable', action_id, attribution_operator_id, approving_supervisor_id, closed_at })` (used by P1-C)

**Tests** (write each first; fail; implement; pass):
- `card_apply_requires_outcome`: an `external_card_terminal` apply without `card_outcome` → `invalid_input`, and no row is written.
- `card_declined_persists_refused_line`: the line is `refused` with `card_declined_on_terminal`; `settlementSum` stays 0; the response is `card_declined`; `tender.refused` is emitted.
- `card_unknown_persists_applying_line`: the line is `applying` with `applied_at` null; the response is `card_outcome_unknown`; `tender.outcome_unknown` is emitted; the attempt stays `started`.
- `apply_refused_while_card_outcome_unknown`: cash, card and voucher are each refused `card_outcome_unresolved`; no row is written.
- `confirm_refused_while_unknown` (G2) and `cancel_refused_while_unknown` (G3): the line stays `applying` and the attempt stays `started`.
- `reverse_refused_on_applying_line` (G4): `line_not_applied`.
- `reverse_other_line_refused_while_unknown` (G1b): an applied cash line next to an UNKNOWN card line → `card_outcome_unresolved`, and the cash line stays `applied`.
- `resolve_approved`: `applying → applied`, `applied_at` set, optional reference regex-checked and **persisted on the line in the same transaction**. Then confirm settles. The finalize summary contains the card line, **with `external_reference` equal to the value entered at resolution**, and with no reference when none was given.
- `resolve_declined`: `applying → refused` with `card_declined_after_unknown`. Remaining returns to its **pre-apply value**: the envelope minus any earlier applied lines. Cover a card-only case and a cash-then-UNKNOWN split. A new card apply is allowed.
- `resolve_refused_on_non_applying_line`; `resolve_refused_wrong_owner`; `resolve_idempotent_replay`; `resolve_payload_mismatch`.
- `apply_replay_reconstructs_unknown_and_declined` (F9):
    - a replay while the line is `applying` → `card_outcome_unknown`;
    - **a replay after the line was resolved approved, and after it was resolved declined → still `card_outcome_unknown`**, with the original `recorded_at`;
    - a replay of a declined apply → `card_declined`.
- `apply_hash_includes_outcome`: same key, different outcome → `idempotency_payload_mismatch`.
- `unknown_line_counts_as_live_tender`: the held-attempt hold on session end, `session-admission` refusing another cashier, and sign-out refused `payment_in_progress`.
- Migration test: the rebuilt outbox accepts `tender.resolve_outcome` with a line id, refuses it without one, and still refuses UPDATE/DELETE (the trigger survived); existing rows are preserved.

**Done:**
- `npm run typecheck`, `npm run lint` and `npm test -- --coverage` are green.
- §A2 record (outbox rebuild) and §A4 record (`tender.resolveCardOutcome`, new apply field and kinds).
- The CodeScene safeguard passes.

### P1-B — Renderer: selector, S11, S12, copy

**Files:**
- Modify:
    - `src/renderer/ui/payments/ExternalCardTerminalEntry.tsx`: the outcome selector;
    - `src/renderer/ui/payments/PaymentSurface.tsx`: route `card_declined` → S11 and `card_outcome_unknown` or any `applying` card line → S12;
    - the payment store or projection that derives the UNKNOWN flag from `payments.read`;
    - `docs/design/vnext/15-vnext-freeze-package.md` §5: rows M-P8 (final) and M-P19…M-P24.
- Create: `src/renderer/ui/payments/CardOutcomeUnknownPanel.tsx` (S12).

**Consumes:** the P1-A interfaces.

**Tests** (jsdom + axe):
- `selector_has_no_default_choice`: no radio is checked; the commit is disabled; focus is on the legend.
- `selector_ignores_enter_without_choice`: an Enter keydown and a scanner burst ending in Enter → no `tenderApply` call.
- `reference_only_for_approved`: the field is hidden for declined/unknown; a typed reference is not sent.
- `declined_shows_mp8_and_method_picker`: M-P8 text; method picker focused; no card money in the ledger.
- `back_after_decline_shows_mp24_not_mp1`: with only a refused card line, the Back refusal text is M-P24, and «تسجيل مبلغ» is absent.
- `unknown_shows_s12`: heading «نتيجة الدفع غير مؤكدة»; M-P9; no method picker, «إلغاء» or Back rendered; Esc is inert; «مرفوض» is absent from the DOM.
- `s12_resolution_calls_resolve_once`: single-flight; approved → Checkout settle path; declined → S11.
- `cannot_verify_shows_mp22_no_call`.
- `stale_cancel_refusal_shows_mp21`.
- `s12_after_reattach`: a `payments.read` with an `applying` card line renders S12 directly.
- axe is clean on S10, S11 and S12; no raw state strings; `bdi dir="ltr"` on amounts.

**Done:**
- Typecheck, lint and test are green.
- Visual captures for I3-CardFailed and I2-PayUnknown at 1024 and 1280 match the frozen references.

### P1-C — Recovery integration (RT-441 extension; §A4)

**Files:**
- Modify:
    - `src/main/recovery/manager-recovery.ts`: G5 pre-consume check; `stuckView` splits `card_unknown_minor` out of `card_minor`; `confirmationMissing` accepts `card_outcome_unverifiable`; `cancelStuck` closes UNKNOWN lines before `payments.cancel`;
    - the shared recovery request type: `card_outcome_unverifiable?: boolean`;
    - `src/shared/audit/payload-schemas.ts`: `PaymentRecoveryCancelledPayload` gains `card_outcome_unverifiable: boolean` and `reconciliation_required: boolean`, with coverage in `src/shared/audit/__tests__/payload-schemas.test.ts`. The P1-A audit categories (`tender.outcome_unknown`, `tender.outcome_resolved`) get their payload types in the same file if it is the canonical catalogue for them;
    - the recovery renderer confirmations: M-P23.

**Consumes:** `closeUnknownInTransaction` (P1-A).

**Close placement.** The close runs **inside** the cancel's transaction, or the cancel path takes a main-internal option `closeUnknownCard: { reason, approver }` that `payments.cancel` accepts only from the recovery caller and never from IPC. The implementer picks the one that keeps a single transaction, and records the choice in §A4.

**Tests:**
- `complete_refused_before_approval_consumed`: `card_outcome_unresolved`; the approval row still has `consumed_at` null.
- `cancel_unknown_with_void_attested`: line `refused` with `card_unknown_void_attested`; attempt `cancelled`; `tender.outcome_resolved` plus `payment.recovery_cancelled` dual-attributed; the terminal is free.
- `cancel_unknown_unverifiable`: `card_unknown_unverifiable`; `reconciliation_required: true` in the payload, which type-checks against the extended `PaymentRecoveryCancelledPayload`.
- `cancel_unknown_without_confirmation` → `confirmation_required`; no change.
- `cancel_unknown_plus_cash_needs_both`.
- `stuck_view_separates_unknown_card`.
    - Today `stuckView` counts an `applying` line as paid `card_minor` (F7). That is wrong for a manager choosing between "void attested" and "unverifiable", and it breaks UX-07 (UNKNOWN ≠ paid).
    - `RecoveryStuckAttemptView` gains `card_unknown_minor` (a §A4 shape change).
    - The test asserts: an attempt with an UNKNOWN card line of 18 000 reports `card_minor = 0`, `card_unknown_minor = 18000`, and `remaining_minor` excluding it. The recovery panel shows it as M-P9, not as a paid amount.

**Done:** typecheck, lint and test are green; §A4 re-check recorded.

### P1-V — Packaged verification

Run on the bench, packaged build, scanner attached. For each scenario record the DB rows (`payment_tender_lines`, `payment_action_outbox`, `audit_events`) and screenshots at 1024 and 1280:

1. Declined, then card again: approved, then settle.
2. Not sure → restart → owner signs in → S12 → resolve approved → settle; the sale captures with a `card_external` tender.
3. Not sure → resolve declined → cash → settle.
4. Not sure → another cashier's sign-in is refused → manager cancels with void attested.
5. Not sure → manager cancels as unverifiable.
6. A scanner burst on the selector and on S12 records nothing.

Afterwards update the Lab and Bench Runbook (Confluence 18874418).

**Order:**
- P1-A → P1-B and P1-C. P1-B and P1-C can run in parallel because they touch different files.
- Then P1-V.
- P1-C requires RT-441 merged (it is on `main`).
- **P1-B's `s12_after_reattach` and P1-V scenario 2 depend on the S19 renderer re-attach route.** That route adopts `payment_attempt_id` from `getResumeState` and opens Checkout for the stuck attempt (freeze N-05; RT-116 S5 follow-up). No Jira issue for it was found.
    - If it is not built when P1-B starts, P1-B ships without `s12_after_reattach`. The coordinator opens the S19 slice; P1-B does not absorb it.
    - P1-V scenario 2 waits for S19.

---

## 11. RT-250 deliverable cross-check

| Deliverable | Where |
|---|---|
| State mapping onto the existing payment states | §3.1, §3.2 |
| The audit record | §7 |
| How UNKNOWN is resolved later | §4 |
| Interaction with the cancel confirm (RT-116 §3) | §4.4 |
| Tests | §10 (P1-A, P1-B, P1-C, P1-V) |
| No implementation | No code changed |

## 12. Risks and gaps

- **Attestation is trust-based (C-3).** A cashier who wrongly attests "declined" and then re-charges causes a double charge. Mitigations: the M-P20 copy, the audit of the attesting operator, and card-batch reconciliation. A bank API is out of scope (I-10).
- **Without D-P1-4, a dead terminal blocks its till indefinitely.** The UNKNOWN line keeps the attempt stuck and the admission guard refuses everyone except its owner.
- **The `applying` name is overloaded.** It now means "persisted UNKNOWN" for card lines. Any future code that persists `applying` for another tender type must go through this contract.
- **The reconciliation population is local-only** until D-P1-7.
- **No renderer route back to S12 after a restart** until the S19 re-attach route exists (§4.5). Money stays safe in main meanwhile.
- **Visual references:** the I3-CardFailed and I2-PayUnknown frozen references show the heading «النتيجة غير مؤكدة». If D-P1-6 is accepted, the reference caption changes too.

## 13. Next safe action

The owner decides D-P1-1 to D-P1-8. On approval, create **P1-A** as the first bounded
Implementation issue.
