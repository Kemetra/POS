# RT-196: Operator path to resolve a permanently-unknown return

**Status:** PROPOSED planning package for owner review. Nothing here is approved, and it authorizes no implementation.
**Jira:** RT-196 (Epic under RT-6, W6 Returns / Refunds / Shifts). Work Mode: **Planning**. It follows up RT-15 S2.
**Related:**
- RT-15 (Done): the return journal, the dispatcher, the resolver and the payout.
- RT-271 (Done; R-1 to R-12 owner-ratified on 2026-10-15, comments 11872 and 11886). **R-8:** decision 1050 stays POS-enforced in V1, and Backend-Core adds `readReturnByProvenance` for RT-196.
- RT-490 (To Do): RT-271 F-1, the Backend-Core \[GATED] contract. Its scope already names `readReturnByProvenance` and `listSaleReturns`.
- RT-114 (Done): manager approval. MA-1 (RT-438) and MA-2 (RT-443) are on POS `main`.
- RT-530 (In Review): the sale void, whose guard reads `return_journal`.
- RT-577: credit-sale reversal restrictions.

**Baselines verified for this plan (2026-10-18):**
- `Kemetra/POS` `origin/main` `f2e3993e`.
- `Kemetra/Backend-Core` `origin/main` `89837eee`. Contract `pos-sales/sales.yaml` is at `1.12.0-draft`.

**What this package does not do:** it changes no code, schema or contract. Each Backend-Core need below is a **slice for a GATED issue**, not a contract edit.

---

## 0. Summary

1. **The ticket assumed a server read that does not exist.**
   - The `Sale` schema (`additionalProperties: false`) has no `returns[]`. It carries only per-line `returnedQuantity` and `returnableQuantity`.
   - `readReturnByProvenance` is in neither the contract nor the runtime. The only provenance lookup is the private helper `findReturnByProvenance` (`apps/api/src/catalog/sales/sale-returns.service.ts:155`), which serves the replay inside `recordReturn`.
   - The read is planned in RT-490 (To Do). **RT-196's reconcile step is blocked on a GATED Backend-Core contract and runtime.**
2. **The "remaining dependency RT-114" note on RT-196 (comment 11355) is stale.** The approval service, migration `0048` and the 12-kind catalogue are on `main`. No return-related action kind exists yet, so one is proposed here (OD-196-3).
3. **Unknown never touches cash.** Payout needs `confirmed`, so an unknown row has moved no money. The risk is a blocked sale and a confused operator, not a drawer error. The plan keeps it that way:
   - no local confirmation without matching server facts;
   - no payout on anything but `confirmed`;
   - no new state in the `0039` machine.
4. **Proposed resolution path:**
   - Show the row and why it is unknown.
   - Offer **«تحديث الحالة»** (a server read, no write) and **«إعادة الإرسال»** (the same bytes under the same key).
   - When the server proves the outcome, the existing transitions apply: `confirmed` via the dispatcher's own match check, so payout is allowed; or a new **"not recorded, closed"** disposition that frees the sale.
   - A mismatch, or a till that can no longer authenticate, becomes **"needs support"**. Those rows are never paid out and no longer auto-resent.
5. **A first slice needs neither Backend-Core nor a migration.** It records the cause of each unknown attempt as an audit event, fixes one client misclassification (§2.3), and shows the history. Everything that disposes of a row waits for the provenance read.

---

## 1. Scope

**RT-196 owns:**
- the operator view of an unresolved return;
- the reconcile rule;
- the local disposition of a row;
- its audit;
- its refusal copy;
- its effect on new returns, voids and shift close.

**RT-196 does not own:**
- the refund execution or settlement facts (RT-490 / F-2 / F-5);
- the Admin-Console returns view (RT-271 F-9);
- the RT-114 credential;
- card or split returns (R-12: post-pilot).

**Invariants this plan keeps:**
- **D-a:** a return is built only from a live `readSale`.
- **D-c:** a till refunds cash only, and only for a proven all-cash sale.
- **AC8:** the journal is written before the send, and resends are byte-identical under the same `Idempotency-Key`.
- **AC9/AC10:** a timeout is unknown, never success.
- **1050:** an unknown return blocks a duplicate until it is reconciled.
- **R-7:** ERP posting waits for settlement, once F-2 ships.

---

## 2. Verified current state

### 2.1 Journal and states (POS)

| # | Fact | Where |
| --- | --- | --- |
| J-1 | `return_journal` states: `pending`, `unknown`, `confirmed`, `paid_out`, `refused`. The guard trigger allows `pending→{pending,unknown,confirmed,refused}`, `unknown→{unknown,confirmed,refused}` and `confirmed→paid_out`. The `state` CHECK is inline, so any new state needs a SQLite table rebuild. | `migrations/0039_create_return_journal.sql` |
| J-2 | Confirmed facts (`return_ref`, `return_total_minor`, `confirmed_at`) exist exactly when the state is `confirmed` or `paid_out`, and they are immutable once set. No row is ever deleted. | `0039` CHECKs and triggers |
| J-3 | Attempt history is only `attempt_count` and `last_attempt_at`. The cause of an unknown is **not stored**. `markUnknown` writes no audit, and a confirmation mismatch is only `logger.warn('returns:confirmation_mismatch')`. | `returns-repository.ts`; `returns-dispatch.ts` |
| J-4 | The resolver resends `pending` and `unknown` rows: on start, on a background tick with per-row backoff (1 s doubling, capped at 5 min), and on demand. It runs only for a signed-in, unlocked manager or admin with an envelope. There is no end condition, so a permanently-unknown row is retried at least every ~5 min forever. | `returns-resolver.ts` |
| J-5 | `hasUnresolvedForSale(saleId)` refuses a new return with `unresolved_return_exists`. It is scoped by **sale only, not terminal**. | `returns-repository.ts`; `returns-service.ts:350` |
| J-6 | An unknown row also blocks a **void** of that sale. `LIVE_RETURN_SQL` counts `pending`, `unknown`, `confirmed` and `paid_out`. | `sale-void/compose-sale-void.ts:103` |
| J-7 | The renderer labels the row «غير مؤكد». It offers one bar button, «تحقّق من غير المؤكدة», which resends **all** unresolved rows. There is no per-row action, no cause and no attempt count. `ReturnJournalView` carries neither the attempt count nor the cause. | `ReturnsHistory.tsx`; `returns-messages.ts`; `shared/returns/types.ts` |
| J-8 | Return audit categories: `sale.return.attempted`, `.refused`, `.confirmed`, `.payout_ready`, plus the S4 payout and slip set. `audit_events.action_category` has no CHECK, so new categories need no DDL; the closed set lives in `shared/audit/event-shape.ts`. | `0039` header; `event-shape.ts:90-101` |

### 2.2 How a row becomes permanently unknown

| Path | Mechanism | Ends by itself? |
| --- | --- | --- |
| U-1 Revoked device or lost authority after a send | On a resend, `PRE_REPLAY_STATUSES` (401, 403, 404) map to `unknown` because Backend-Core decides them before the provenance replay. | No, while the cause lasts. |
| U-2 Server gate off | `POS_RETURNS_ENABLED` off → 404 → `unknown` on a resend. | Yes, once the gate is back on. |
| U-3 Confirmation mismatch | The 200/201 does not match `externalId`, `saleRef`, currency, lines or quoted total → `unknown` (`matchingTotalMinor`). | No: every replay returns the same projection. |
| U-4 Unreadable 2xx body | `readSaleReturnBody` returns null → `unknown`. | Only if the server's body changes. |
| U-5 No eligible actor | The resolver does not tick without a manager or admin session with an envelope. | When one signs in. |
| U-6 Credit sale refused on a resend | See §2.3. | No. |
| U-7 Re-pair to a new `terminal_id` (not verified) | The terminal id comes from the server at pairing (`pairing/store.ts`). If a re-pair assigns a new one, `listUnresolved` (terminal-scoped) never sees the old rows again. `hasUnresolvedForSale` and the void guard (sale-scoped) still see them. Old sales are not found by `findByNumber` (terminal-scoped) either, so in practice the till cannot reach them. | No. Rows are orphaned. |

### 2.3 Client misclassification found while planning

RT-577's 403 `credit_sale_reversal_restricted` is decided **after** the provenance replay (`sales.yaml` `recordReturn`). It therefore proves that no *ordinary* return is recorded under this key. (A credit-linked return on the same sale also falls through to this 403, so it does not prove that nothing exists under the key.) The POS still maps every 403 on a resend to `unknown`, because it classifies by status and ignores `error.code`. The cash-only rule (D-c) makes this hard to reach, but the fix is small and local: classify by `(status, error.code)`, treating only the credit `error.code` as terminal, never the operator-guard 403. It is folded into slice S1.

### 2.4 Backend-Core

| # | Fact | Where |
| --- | --- | --- |
| B-1 | `readSale` (`GET /api/pos/v1/sales/{saleRef}`, operator auth) returns `Sale`, with no return list. A sale outside the caller's scope is a non-disclosing 404. | `sales.yaml:509-546` |
| B-2 | `recordReturn` order: returns gate (404), sale resolve (404), provenance replay (200 or 409 `conflict`), credit refusal (403), reversal exclusivity (409), line checks, tender check (422). | `sales.yaml:820-830`; `sale-returns.service.ts:95-150` |
| B-3 | No route reads one return or a list of returns. | controller routes; `sales.yaml` paths |
| B-4 | RT-490 scope: "New `readReturnByProvenance` and `listSaleReturns` reads (R-8, for RT-196)". The issue is To Do. | Jira RT-490 |
| B-5 | Until F-2/R-7 ship, acceptance emits the ERP posting in the same transaction (RT-271 BC-7). | `sale-returns.service.ts:118-129` |

### 2.5 Manager approval (RT-114 on main)

- `ManagerApprovalService.request/consume` provides single-use approvals: a 120 s TTL, bound to `action_kind`, `subject_ref`, `subject_version` and `amount_minor`. The `policy_version` is `'rt114-2026-10-07'`.
- **C6:** a manager or admin session acts directly. Only these kinds bind an approval for a manager session:
  - `session.self_unlock`;
  - the recovery kinds (the approver is the session's own manager);
  - `sale.void` (four-eyes against the requester and the selling operator).
- The returns domain already requires a manager or admin session (D-b).
- There are 12 action kinds (`shared/operator/manager-action-kinds.ts`), none for returns. The catalogue "grows by contract only".

### 2.6 Shift close and cash

- Cash-up counts a refund only from a **completed** payout (`return_payouts.paid_at`). That payout exists only for a `confirmed` row (`shift-cashup-sources.ts`).
- `pendingDrawerActivity` counts started-but-incomplete payouts and unfinalized sales. **An unknown return blocks nothing at close today.**
- A row confirmed late is paid out, if at all, in the shift where the payout completes, and it is counted there. Under R-9 (RT-490 / F-3), that return ref is claimed by that shift's close.

---

## 3. Proposed design

### 3.1 What the operator sees (S1, S4)

Each row in «سجل المرتجعات على هذا الجهاز» opens a **recovery panel** (UX-07). Only manager and admin sessions can open it, as today. The panel shows:
- sale number, quoted total, lines, created at;
- state label (UX-12 names an unknown as unknown):
  - «غير مؤكد» (unknown);
  - «لم يُسجَّل — مغلق» (not recorded, closed);
  - «بانتظار الدعم» (needs support);
- attempt history, human-first: each attempt's local time and a cause line. The evidence sits next to it: the HTTP status class and the cause code, never a body or an envelope.
- the actions, each named for what it does:
  - **«تحديث الحالة»** reads the server truth. It never sends the return and changes no return or sale state on the server. It does write one ref-only `pos_sales.return_read` audit record (BR-5).
  - **«إعادة الإرسال»** sends the identical request again, for this row only.
  - **«إغلاق كمرتجع غير مسجَّل»** appears only after a read answered *not recorded*.
  - **«تحويل إلى الدعم»** marks the row needs-support.

### 3.2 Reconcile rule options (OD-196-1)

The evidence each verdict needs:

| Verdict | Required evidence | Local effect |
| --- | --- | --- |
| **Confirmed** | The provenance read returns a `SaleReturn` that passes the dispatcher's **existing** match: `externalId`, `saleRef`, currency, lines and `returnTotal` = `quoted_total_minor`. The plan reuses `matchingTotalMinor` and does not write a second matcher. | The existing `markConfirmed` plus the `confirmed` and `payout_ready` audits in one transaction. Payout is then allowed as today. |
| **Not recorded** | The read answers an **affirmative** `not_recorded`, distinct from the gate 404 and the scope 404 (requirement BR-2), **and** the quiet period has passed (OD-196-5) with no send in flight. | First recommend «إعادة الإرسال»: the same key converges. If the manager instead closes the row, a `not_recorded_closed` disposition is written (§3.4). The row stays `unknown` in `0039`, the sale is freed, and the row is never resent. **Retry hold:** the first `not_recorded` read writes an automatic `retry_hold` disposition. Background and bar resends then stop, so `last_attempt_at` stops moving and the quiet period can elapse. The close needs a **second, fresh** `not_recorded` read at close time, at least the quiet period after `last_attempt_at`. A manual per-row resend voids the hold. |
| **Mismatch** | The read returns a `SaleReturn` under this key that fails the match. | A `needs_support` disposition. No payout while it lasts. Background resends stop. The sale stays blocked (OD-196-4). It is **not terminal**: a later matching read or manual resend confirms the row, and a later `not_recorded` read allows a close. |
| **Inconclusive** | Offline, 401/403, gate off, 5xx or an unreadable body. | No verdict, and nothing changes from the read itself. Refusal copy names the cause. The one exception is send-side and automatic: the §3.6 `auth_failure` flag. |

**Options:**

- **A. Recommended: server truth by provenance read, plus a POS quiet period.**
  - A verdict comes only from the BC read.
  - "Not recorded" frees the sale only through an explicit, approved close.
  - **Residual risk: a late commit.** A POST already in flight can still commit on the server after the read.
    - The POS 15 s timeout bounds only how long the till waits. It does **not** bound Backend-Core processing.
    - The quiet period therefore only *reduces* the race. It eliminates it only when Backend-Core guarantees that a `recordReturn` request cannot commit later than a stated bound shorter than the quiet period. That guarantee is BR-7 (GATED, part of S2/S3).
    - Without BR-7, the owner must explicitly accept the risk under OD-196-1. If it happens, no cash moved: a closed row never pays out.
    - Once R-7 is live, the server shows it as accepted-not-settled (F-9). Before R-7, it leaves an ERP credit note posted as paid (B-5, §9).
    - Option B (a tombstone) removes the race entirely.
- **B. A plus a Backend-Core tombstone.** The `not_recorded` answer atomically reserves the provenance key, so a later POST with it gets 409. This is the strongest guarantee, but it adds a BC write and a \[GATED] migration. Recommended as post-pilot hardening, not for V1.
- **C. Rejected: manager attestation with no server read.** It closes a row on a human's word. Before R-7, a row the server did record keeps an ERP credit note posted as paid while no cash left the drawer (B-5).
- **D. Rejected: infer from `readSale` `returnedQuantity`.** The count aggregates every return on every till and cannot attribute one return to one key. At most it is shown as a hint.

### 3.3 Approvals (OD-196-3)

| Action | Recommended authority | Why |
| --- | --- | --- |
| View, «تحديث الحالة», «إعادة الإرسال» | The manager or admin session directly, audited (C6). | They are non-destructive. A resend is the same idempotent request the resolver already sends. |
| A confirm that results from a read | No extra approval. | The server proves it. It is the same transition the dispatcher writes. |
| «إغلاق كمرتجع غير مسجَّل», «تحويل إلى الدعم» | A bound approval of a new kind, `return.resolve_unknown`. Subject: `return_id`. `subject_version`: the state + `attempt_count` + the last read verdict id. `amount_minor` = `quoted_total_minor`. **Recommended:** four-eyes against the row's original `operator_id`, following the `sale.void` pattern. | Closing frees a sale for a second return of money, which is a terminal judgement. |

**Four-eyes needs the originating user.** `return_journal.operator_id` is the provider operator id, not `users.id`. `createSellingUserIdResolver` maps a *sale's* selling cashier, not a return's operator. So S4 durably captures the requester's `users.id` with each new return, in `return_journal_origin`, written in the journal insert transaction. Rows journaled earlier have no origin user: four-eyes then excludes only the current requester, and the audit says so (§9).

**Alternatives for the close approval:**
- (b) The session manager's own PIN, recovery-style. Cheaper at night with one manager, but no second person checks it.
- (c) No PIN (plain C6).

### 3.4 Local persistence (OD-196-2)

**Recommended: leave `0039` untouched and add one append-only side table** (\[GATED] local migration, next free number at execution; `0056` today):

`return_journal_dispositions`:
- columns: `disposition_id` (uuidv7 PK), `return_id` (FK), `kind` (`not_recorded_closed` | `needs_support` | `retry_hold`), `verdict_source`, `reason` (`mismatch` | `auth_failure` | `operator` | `not_recorded`), `read_verdict_at` (nullable), `approval_id`, `actor_operator_id` (nullable for automatic raises), `created_at`;
- `verdict_source` values:
  - `provenance_read`: a status-read verdict (including the automatic `retry_hold` written on a `not_recorded` read);
  - `send_response`: a mismatch received on a send (U-3/U-4);
  - `auth_failure`: the automatic §3.6 flag;
  - `operator`: a manager's own support raise.
- CHECK rules:
  - `approval_id IS NULL` exactly for the automatic kinds: `needs_support` from `send_response` or `auth_failure`, and `retry_hold`.
  - `not_recorded_closed` requires `verdict_source = 'provenance_read'` and a non-null `approval_id`;
- a partial unique index allows **at most one `not_recorded_closed` per row**. `needs_support` may appear more than once, and may be followed by a close;
- triggers: no UPDATE, no DELETE. No insert once the row has a `not_recorded_closed` disposition or has left `pending`/`unknown`;
- an insert is allowed only while the header is `unknown` or `pending` with `attempt_count > 0`.

**`retry_hold`** is an automatic, restrict-only flag written on a `not_recorded` read. It is effective only while it is newer than `last_attempt_at`, and only an explicit per-row resend can move `last_attempt_at` while a hold is effective, because background and bar sends are deferred at the commit point (below). So only a manual resend voids the hold, without an UPDATE. It never frees the sale.

**Only `not_recorded_closed` is terminal.** `needs_support` is a flag that stops background resends. A matching read or a manual resend still confirms the row, and a later `not_recorded` read still allows a close.

**Readers that change:**
- `hasUnresolvedForSale` excludes a `not_recorded_closed` row and keeps blocking a `needs_support` row (per OD-196-4).
- The resolver's background tick skips **every** row with a disposition (for `retry_hold`, only while it is effective). The on-demand bar pass skips them too. A `needs_support` row is resent only by its own per-row «إعادة الإرسال». A closed row is never resent by any path: that is the safety property. Filtering the lists is not enough, because the resolver snapshots its rows and then sends them one by one. So the safety property is enforced at the **dispatch commit point**: right before the POST, `sendOnce` re-reads the disposition in the same synchronous step as its authorization recheck, and answers `deferred` for: (a) a closed row, on **every** path; and (b) a row with an effective `retry_hold` or any `needs_support`, when the send comes from a background tick or the bar pass. The dispatcher gains a third operation, `resend` (the explicit per-row «إعادة الإرسال»), beside `submit` and `resolve`, and only `resend` passes rule (b). A stale pass therefore cannot POST a row that was held or flagged after its snapshot, and so cannot move `last_attempt_at` past a hold. A close is also serialized against sends: it is refused with `send_in_flight` while the dispatcher's per-return single-flight map holds that `return_id`. Because the main process is single-threaded, a close that commits before that synchronous check is always seen, and a close attempted after it is refused.
- The void guard `LIVE_RETURN_SQL` excludes `not_recorded_closed`.
- The `markConfirmed` / `markRefused` guards refuse a row with a `not_recorded_closed` disposition. A late answer is logged as `returns:late_answer_after_close` and surfaced, never applied. A `needs_support` row confirms normally.

**Attempt history:** recommended as audit events, with no table (S1). The alternative is a `return_journal_attempts` table (\[GATED]), worth it only if the audit retention window is shorter than a row's life.

**Rejected:** rebuilding `return_journal` with new states. It is a 12-step SQLite rebuild of a money table, and it re-tests every `0039` trigger.

### 3.5 Offline behaviour

- Returns are online-only (I-16), and so is resolution.
- Offline, the panel is **read-only**. The local history and causes still show, and every action is refused with `offline` before any write.
- No disposition is ever written from local evidence alone, with two automatic `needs_support` exceptions. Both are raised from send responses the till actually received: a mismatch (`send_response`), and the repeated authentication failures of §3.6 (`auth_failure`). Neither enables a payout or frees the sale.

### 3.6 Revoked device or no envelope (OD-196-6)

- With a revoked device, or a session that cannot authenticate (U-1), the till **cannot** read the server truth, so it cannot close the row.
- **Recommended:**
  - **An automatic flag, as an explicit authority exception.** A row whose resends answer a pre-replay 401/403 on **3 consecutive attempts spanning at least the quiet period** gets an automatic `needs_support` disposition. Its fields: `verdict_source = auth_failure`, `reason = auth_failure`, no approval, no actor. The till shows «بانتظار الدعم» with copy that sends the manager to support.
  - It needs no approval because it only *restricts*. It stops background resends, it never frees the sale, and it never enables a payout. A later matching read or resend still confirms the row (§3.4).
  - A 404 from the gate (U-2) does not raise it, because it heals once the gate is back on.
  - Support resolves it through Backend-Core truth: the F-9 Admin-Console view, or an operator query until F-9 exists.
  - After the device is restored, «تحديث الحالة» settles the row normally.
- U-7 orphans (if re-pair changes `terminal_id`) are a support item, not a till item.

### 3.7 Audit events (local; central per RT-160 D-2 later)

Each is a new `sale.return.*` category in `event-shape.ts`, with no DDL. Payloads carry ids and codes only: no body, no envelope, no PIN.

| Category | When | Payload |
| --- | --- | --- |
| `sale.return.attempt_unknown` | Each send that leaves the row unknown | `return_id`, `sale_id`, `attempt_no`, `cause` (`timeout`, `network`, `server_5xx`, `rate_limited`, `pre_replay_401`, `pre_replay_403`, `pre_replay_404`, `confirmation_mismatch`, `unreadable_body`, `local_commit_failed`), `operation` |
| `sale.return.status_read` | Each «تحديث الحالة» | `return_id`, `verdict` (`recorded_match`, `recorded_mismatch`, `not_recorded`, `inconclusive`), `cause` when inconclusive |
| `sale.return.resend_requested` | Per-row «إعادة الإرسال» | `return_id` |
| `sale.return.closed_not_recorded` | Disposition written | `return_id`, `approval_id`, `read_verdict_at` |
| `sale.return.needs_support` | Disposition written | `return_id`, `approval_id \| null`, `verdict_source`, `reason` (`mismatch`, `auth_failure`, `operator`) |

The existing `sale.return.confirmed` gains `via: 'send' | 'status_read'`, and the approval consumption carries `approving_supervisor_id` (RT-114 C7).

### 3.8 Shift close and cash variance (OD-196-7)

- **No drawer effect.** An unknown, closed or needs-support row never paid out, so Expected Cash is unchanged. Nothing is ever recorded retroactively in a past shift.
- **Late confirmation.** A row confirmed by a read becomes payable in the **current** shift. It is counted there, and claimed by that shift's close under R-9.
  - If the customer is gone, the row stays confirmed-unpaid. That is the R-7 visible exception, not a till error.
- **Cash handed over off-system.** If a cashier paid cash while the row was unknown, the till cannot know. The close shows a shortage, explained by variance reason only.
  - Copy must keep saying «لا تصرف أي نقد» while a row is unknown.
  - Resolution never back-fills a payout into that earlier shift.
- **Recommended: close is not blocked.** The close summary shows "N unresolved returns, M awaiting support" as a warning, and the counts go into the local close audit. Nothing changes in the `pos-shifts` close request, so there is no contract growth.
- **Alternative: block close** while any row is `pending` or `unknown` without a disposition. A revoked device (U-1) could then never close.

### 3.9 Copy (Arabic; added to `returns-messages.ts`)

**Labels:**
- `status.not_recorded_closed`: «لم يُسجَّل — مغلق»
- `status.needs_support`: «بانتظار الدعم»
- `action.read`: «تحديث الحالة»
- `action.resend`: «إعادة الإرسال»
- `action.close`: «إغلاق كمرتجع غير مسجَّل»
- `action.support`: «تحويل إلى الدعم»

**Outcomes:**
- `readConfirmed`: «أكّد الخادم أن هذا المرتجع مسجَّل. يمكنك الآن صرف النقد للعميل.»
- `readNotRecorded`: «يؤكد الخادم أن هذا المرتجع لم يُسجَّل، ولم يُصرف له أي نقد. أعد إرساله، أو أغلقه بموافقة مدير ثم أنشئ مرتجعًا جديدًا.»
- `readMismatch`: «سجّل الخادم مرتجعًا بهذا الرقم لكنه لا يطابق ما على هذا الجهاز. لا تصرف أي نقد، وحوّل الحالة إلى الدعم.»
- `closed`: «أُغلق المرتجع كغير مسجَّل. يمكن الآن إرجاع هذا البيع من جديد.»
- `supportRaised`: «حُوّل المرتجع إلى الدعم. يبقى هذا البيع موقوفًا عن المرتجعات حتى يُحسم.»
- `unknownDoNotPay`: «النتيجة غير مؤكدة. لا تصرف أي نقد حتى تتأكد الحالة.»

**Refusals:**
- `offline`: «تعذّر الوصول إلى الخادم. لا يمكن التحقق من حالة المرتجع الآن، ولم يتغيّر شيء.»
- `read_unauthorized`: «لا يملك هذا الجهاز أو هذه الجلسة صلاحية التحقق الآن. سجّل الدخول من جديد، وإن تكرر فتواصل مع الدعم.»
- `returns_unavailable`: «المرتجعات متوقفة على الخادم الآن، فلا يمكن التحقق من الحالة.»
- `reconcile_too_soon`: «أُرسل هذا المرتجع قبل قليل. انتظر حتى {time} ثم حدّث الحالة.»
- `send_in_flight`: «يجري إرسال هذا المرتجع الآن. انتظر حتى ينتهي ثم حدّث الحالة.»
- `already_resolved`: «حُسمت حالة هذا المرتجع من قبل. حدّث السجل.»
- `close_needs_not_recorded`: «لا يُغلق المرتجع إلا بعد أن يؤكد الخادم أنه لم يُسجَّل. حدّث الحالة أولًا.»
- Approval refusals reuse the RT-114 generic copy (`approval_unavailable`, `approval_invalid`, `approval_stale`).

**Changed copy:** `unresolved_return_exists` gains the next step: «لهذا البيع مرتجع سابق لم تتأكد نتيجته بعد. افتحه في سجل المرتجعات وحدّث حالته أولًا.»

---

## 4. Backend-Core requirements (feed RT-490 / F-2)

These requirements are this plan's input to RT-490. RT-196 does not edit the contract.

- **BR-1 Route.** `readReturnByProvenance`: `GET /api/pos/v1/sales/{saleRef}/returns/by-provenance?sourceSystem=…&externalId=…`, operator auth like `readSale`. A tenant-wide route is the alternative, but the sale-scoped one reuses the existing scope check.
- **BR-2 An affirmative answer.** `200 { status: 'recorded', saleReturn: SaleReturn }` or `200 { status: 'not_recorded' }`. It is decided **after** the returns gate and the sale resolve. A 404 therefore keeps meaning only "gate off or sale out of scope" and is never read as not recorded.
- **BR-3 Same projection.** `saleReturn` is the exact `SaleReturn` that `recordReturn` returns, so the POS reuses its matcher and `returns-wire.ts` reader.
- **BR-4 Credit-linked returns.** A key that belongs to a credit reversal (RT-577) answers `recorded`, with a flag the POS treats as a mismatch. The till never pays a credit reversal.
- **BR-5 Audit.** Each authorized 200 writes one `pos_sales.return_read` event, ref-only (the RT-548 pattern).
- **BR-6 No migration.** The read uses the existing `(tenant, source_system, external_id)` unique index, so the runtime can ship **before F-2** (OD-196-8).
- **BR-7 A processing bound (GATED).** The contract states the maximum time after receipt within which a `recordReturn` request either commits or is abandoned, for example a transaction or statement timeout. That bound must be shorter than the POS quiet period (OD-196-5). Without it, the late-commit race in §3.2 is an owner-accepted risk (OD-196-1).

---

## 5. Owner decisions

| ID | Decision | Recommended | Alternatives |
| --- | --- | --- | --- |
| **OD-196-1** | Reconcile rule | **A:** server truth via the provenance read, plus the POS quiet period, plus the BR-7 server bound. A close needs an affirmative `not_recorded`. If BR-7 is not delivered, the owner explicitly accepts the residual late-commit risk. | B: A + BC tombstone (post-pilot hardening). C: manager attestation (rejected). D: `returnedQuantity` inference (rejected). |
| **OD-196-2** | Local persistence | An **append-only `return_journal_dispositions` side table**, with `0039` untouched; attempt causes go in audit events. | Rebuild `return_journal` with new states; an attempts table. |
| **OD-196-3** | Authority | Read and resend directly (C6, audited). Close and needs-support take a bound approval of a **new kind `return.resolve_unknown`**, four-eyes against the original operator. | Session manager's own PIN (recovery-style); no PIN. |
| **OD-196-4** | Does `needs_support` keep blocking new returns and voids on the sale? | **Yes** (decision 1050). Only server truth unblocks it. | Free the sale; the server cap still prevents an over-return. |
| **OD-196-5** | Quiet period before a close | **15 min** since `last_attempt_at` (≥ 60× the 15 s request timeout), with no send in flight. | 5 min; 1 h; the next business day. |
| **OD-196-6** | Revoked device or unauthenticated till | An **automatic `needs_support` flag** (`auth_failure`) after 3 consecutive pre-replay 401/403 resends spanning the quiet period. It is an authority exception: no approval, because it only restricts. It is resolved via Backend-Core truth (F-9 or a support query) or a later matching read. No till-side close. | A till-side close on manager attestation (conflicts with OD-196-1 A). |
| **OD-196-7** | Shift close | **Warn, don't block.** Counts go in the close summary and the close audit. | Block close while any undisposed `pending`/`unknown` row exists. |
| **OD-196-8** | Backend-Core packaging | Split `readReturnByProvenance` out of RT-490/F-2 as its **own contract + runtime slice** (no migration), so RT-196 does not wait for the execution migration. | Ship it with RT-490 and F-2 as planned. |
| **OD-196-9** | The §2.3 credit-403 classification fix | Fold it into S1 (classify by status + `error.code`). | A separate bug ticket. |

---

## 6. Slices

**GATED** marks a slice that needs explicit owner approval at PR time: a contract, a migration or a local schema change.

| Slice | Repo | Gate | Depends on | Content | Acceptance |
| --- | --- | --- | --- | --- | --- |
| **S1** Unknown causes + per-row resend | POS | none | — | `sale.return.attempt_unknown` with `cause` (§3.7), written in the same transaction as `markUnknown`, and only when that guarded UPDATE changed the row (the confirm and refuse pattern). The §2.3 classification fix. A per-row `returns.resend({ returnId })` that reuses the dispatcher. `ReturnJournalView` gains `attemptCount`, `lastAttemptAt` and `lastCause`, read from the audit. | Each U-path test writes exactly one `attempt_unknown` with the right cause. The resend is byte-identical under the same key (the existing dispatcher test). On a resend, only the credit 403 `error.code` → refused; the operator-guard 403 and every pre-replay 401/403/404 → unknown. Resending a `confirmed` or `refused` row is refused `already_resolved`. |
| **S2** Read contract | Backend-Core | **GATED contract** | OD-196-8 | BR-1 to BR-5 and BR-7 in `pos-sales/sales.yaml`. While the runtime is absent, the op carries `x-runtime-status: contract-only`. | oasdiff is additive only. Contract suites are green. The `not_recorded` vs 404 rule is stated normatively. |
| **S3** Read runtime | Backend-Core | **GATED runtime** (reads only, no migration; ships after S2 is approved) | S2 | Controller + service on the existing provenance index. Gate, scope, then the read. Audit as BR-5. Enforce the BR-7 bound on `recordReturn`. | Tests: recorded, not recorded, gate off (404), sale out of scope (404), cross-tenant (404), credit-linked flag. Tenant isolation (RLS). |
| **S4** Dispositions table | POS | **GATED local migration** | OD-196-2 | `return_journal_dispositions` (§3.4) with its triggers. Also `return_journal_origin` (`return_id` PK/FK, `requester_user_id`), written in the journal insert transaction (§3.3). Plus the dispatcher's commit-point disposition check (with the new `resend` operation), the **automatic dispositions the dispatcher writes**, and the reader changes. A mismatching or unreadable 2xx on any send writes `needs_support` / `send_response` in the same transaction as `markUnknown`. The §3.6 count writes `needs_support` / `auth_failure`. The reader changes are: `hasUnresolvedForSale`, `listUnresolved`, `LIVE_RETURN_SQL`, and the `markConfirmed`/`markRefused` guards. | Migration round-trip test. UPDATE and DELETE are denied. At most one `not_recorded_closed` per row (partial UNIQUE). Repeated `needs_support` rows are accepted and may be followed by a close. The `verdict_source`/`approval_id` CHECKs hold. A closed row is never listed by the resolver. A row closed after the resolver snapshot is **not** POSTed (`deferred` at the commit point). A row given a `retry_hold` or `needs_support` **after the resolver snapshot** is not POSTed by that background or bar pass, and its hold stays effective. An explicit `resend` of the same row is POSTed. A direct send that receives a mismatching 2xx (U-3) writes exactly one `needs_support` / `send_response`, and later ticks skip the row. Three auth-failed resends spanning the quiet period write `needs_support` / `auth_failure`, and two do not. A close during an in-flight send is refused `send_in_flight`. A new return's `requester_user_id` is written in the journal insert transaction. A closed row frees new returns and voids. `needs_support` still blocks (per OD-196-4). A late confirm after a close does not apply, while a `needs_support` row still confirms. The bar pass and background tick skip disposed rows. |
| **S5** Reconcile service | POS | contract growth (action kind) | S1, S3, S4, OD-196-3 | Client `readReturnByProvenance`. `returns.readStatus({ returnId })`. `returns.close({ returnId, approvalId })` and `returns.raiseSupport({ returnId, approvalId? })`. The new `return.resolve_unknown` action kind, its approval resolver and its consume step, in one transaction with the disposition and its audit. The kind is added to `mayRequest` (which today refuses a manager session for ordinary kinds) and to `approverAllowed`. Four-eyes compares `users.id` against `return_journal_origin.requester_user_id` (S4), never against the provider `operator_id`. | Each §3.2 verdict maps to the right effect. A confirm via a read reuses `matchingTotalMinor` and writes `confirmed` + `payout_ready` once. A `not_recorded` read writes `retry_hold`, and background ticks stop resending that row, so the quiet period elapses (tested with a running resolver). End to end, a hold written **after the resolver snapshot** survives that pass, and the close becomes possible after the quiet period. A close is refused without a fresh `not_recorded` read at close time, before the quiet period, without a `not_recorded` read, or while a send is in flight. A mismatch never confirms and never pays out. needs_support → a matching read → confirmed. needs_support → `not_recorded` → close. Offline refuses with no write. Each RT-114 refusal applies (expired, stale, four-eyes). |
| **S6** Recovery panel | POS (renderer) | none | S5 (S1 for the history-only part) | Per-row panel (§3.1), copy (§3.9), RT-114 approval sheet reuse, state labels. | RTL a11y scope tests. The copy registry has no duplicate lines. Each action is disabled offline. The visual-acceptance captures follow the RT-501 pattern. |
| **S7** Shift-close warning | POS | none | S4 | Close summary counts and close-audit fields (OD-196-7). | A close with an unknown row succeeds and records the counts. Expected Cash is unchanged by unknown, closed or needs-support rows. |
| **S8** Packaged verification | POS | none | S5–S7 | Lab scenarios: U-3 mismatch → needs support; a lost answer → read → confirmed → paid out in the current shift; not recorded → close → new return accepted; offline read-only; revoked device → 3 auth-failed resends over the quiet period → automatic needs support → device restored → read → confirmed. | A witnessed run is recorded on RT-196. |

**Order:** S1 first. It has no dependencies and gives operators the cause today. Then S2 → S3 (Backend-Core) and S4 in parallel. Then S5 → S6 → S7 → S8.

---

## 7. Global constraints (every slice)

- The till never writes `confirmed` without a server `SaleReturn` that passes `matchingTotalMinor`. It never writes `refused` with a locally invented reason.
- Payout stays possible only from `confirmed`. A disposition never enables a payout.
- A row closed as not recorded is never sent again. A needs-support row is never auto-resent, only by its own per-row resend.
- Returns and resolution are online-only. Offline is read-only.
- No PII, body, envelope or PIN goes in an audit payload or a log.
- All Arabic copy lives in `returns-messages.ts`, with each line distinct from every other line.

## 8. Review focus (conditions no slice test obviously owns)

1. **A late answer races a close.** A POST in flight before the close lands after it. Expect: the disposition holds, the late answer is logged and surfaced, and nothing is paid out. Owned by S4/S5 tests.
2. **The clock steps back.** `last_attempt_at` lies in the future and the quiet period never elapses. Expect: fail safe, treat it as too soon, and show the time. Owned by S5.
3. **Two managers act on one row at once.** Expect: one close (partial UNIQUE), the second answers `already_resolved`. Two `needs_support` raises are harmless. A needs-support row a later read matches is confirmed, not left stuck. Owned by S4/S5.
4. **The resolver tick runs during a read.** Expect: single-flight per return across both the read and the send. Owned by S5.
5. **A sale with a confirmed return and an unknown return.** Expect: closing the unknown frees only that row, and the void guard still sees the confirmed one. Owned by S4.

## 9. Risks / not verified

- **U-7 is unverified.** It is not known whether a re-pair assigns a new `terminal_id`. If it does, old rows are unreachable from the till by design, and support must resolve them.
- Option A's residual race (§3.2) is bounded, not eliminated. Option B removes it.
- Before F-2/R-7 ship, a server-recorded return that the till closed would keep its ERP credit note posted as paid (B-5). OD-196-1 A makes this need both an affirmative `not_recorded` and a POST committing after the quiet period. Only BR-7 or Option B bounds that; without either, the risk is owner-accepted.
- Rows journaled before S4 have no `requester_user_id`. For them, four-eyes can only exclude the current requester, and the approval audit records `origin_user_unknown: true` (OD-196-3).
- No tests were run. This is a reading of `origin/main` at the baselines above.

## 10. Next safe action

The owner rules on OD-196-1 to OD-196-9. S1 can then start at once. S2 is raised as its own Backend-Core \[GATED contract] item (OD-196-8), or folded into RT-490.
