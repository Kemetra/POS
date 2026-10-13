<!--
RT-441 (RT-116 S6) — §A4 P8 bridge-security record for the new recovery.*
bridge namespace (channels recovery:list-held, recovery:complete-attempt,
recovery:cancel-attempt, recovery:cancel-held-cart) and the recovery-mode IPC
guard. Post-merge walk against origin/main with code-line evidence; the code
shipped in PR #655 (db5337f). Docs only.
-->

# §A4 — P8 bridge-security review: `recovery.*` (RT-441)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-441 — RT-116 S6, manager recovery |
| Gate | §A4 — P8 Electron security boundary (preload-bridge expansion) |
| Bridge surface | New namespace `recovery.*`: `listHeld`, `completeAttempt`, `cancelAttempt`, `cancelHeldCart`. Plus a new composition-root IPC wrapper, the recovery-mode guard. |
| Shipped in | PR #655, merge commit `db5337f` |
| Reviewed against | `origin/main` at `df37c57` |
| Review type | Post-merge walk. The code, IPC wiring and tests are on `main`; this record runs the controls against them. |
| Prepared by | The implementation agent (Claude Code), 2026-10-13. **Not an independent review.** It needs the owner's sign-off. |
| Verdict | **Agent-assessed PASS on the bridge controls (15/15), with three findings for the owner (§5).** F-1 is the open design deviation PR #655 already named. F-2 is a gap between the guard and the wording of the acceptance criterion. Neither is a bridge-boundary break: no new renderer capability bypasses main. |

## 2. Code under review

| File | Role |
| :-- | :-- |
| `src/shared/operator/recovery.ts` | Channel names, request and response shapes, refusal reasons. |
| `src/preload/recovery.ts` | Thin `ipcRenderer.invoke` wire-up, exposed as `api.recovery` (`src/preload/index.ts:210`, `contextBridge.exposeInMainWorld('api', api)` at `:213`). |
| `src/main/ipc/recovery.ts` | Closed-shape validators and the four handlers. |
| `src/main/ipc/recovery-mode-guard.ts` | Refuses the sale namespaces while the session carries `recovery_of`. |
| `src/main/recovery/manager-recovery.ts` | The service: admission, subject resolvers, approval consumption, payment calls, cart cancel, audit. |
| `src/main/operator/manager-approval-service.ts` | MA-2, extended with the three recovery kinds and the recovery approver rule. |
| `src/main/operator/session-admission.ts` | Admits a manager or admin in recovery mode (`recovery_of`). |
| `src/main/payments/handlers/payments-force-fail.ts` | `forceFail` restricted (RT-116 §5.2, M10). |
| `src/main/index.ts:737-750, 812, 979-994, 1561-1605` | Composition: the guard chain, the mode probe, the resolvers, the payment port, handler registration. |

## 3. Controls

| # | Control | Evidence | Result |
| :-- | :-- | :-- | :-- |
| P8-1 | **The renderer reaches main only through the typed bridge.** | `src/preload/recovery.ts` only calls `ipcRenderer.invoke` on the four constant channels. No Node API, no `ipcRenderer` object or callback is handed to the renderer. `BrowserWindow` flags are unchanged by this PR. | PASS |
| P8-2 | **Sender origin is checked.** | The handlers are registered on `guardedIpcMain` (`index.ts:1605`). That chain wraps `createSenderGuardedIpcMain(ipcMain, resolveRendererOrigin())` (`index.ts:741-750`), so a frame of another origin is refused before any recovery handler runs. | PASS |
| INP-1 | **Closed request shapes, validated in main.** | `readCompleteAttempt` / `readCancelAttempt` / `readCancelHeldCart` (`ipc/recovery.ts`) reject unknown keys, non-objects and arrays. Ids must match `^[A-Za-z0-9_-]{1,128}$`; approval ids must match `^[0-9a-f-]{36}$` (36 lowercase-hex-or-hyphen characters, a loose UUID check, not a strict one: see the note on approval ids below); confirmations must be booleans; `listHeld` takes no payload. An invalid payload answers `invalid_input` and reaches nothing (test "an invalid payload reaches nothing"). | PASS |
| INP-2 | **Money is integer minor units, bounded.** | `cash_received_minor` must be a safe integer with `0 ≤ n ≤ 1_000_000_000` (the RT-437 cash bound). Amounts in responses come from integer columns. | PASS |
| AUTH-1 | **Only an unlocked manager or admin on a paired terminal.** | `admissionRefusal()` and `manager()` in `manager-recovery.ts` refuse `no_session`, `session_locked` and `role_mismatch`, and refuse `no_session` when `resolveTerminalId()` is null. All four actions are tested for each refusal ("refuses every action when signed out / locked / a cashier"; "refuses on an unpaired terminal"). | PASS |
| LOCK-1 | **A locked session cannot call recovery.** | No `recovery:*` channel is in `LOCKED_ALLOWED_CHANNELS` (`ipc/session-lock-guard.ts:28`), so the lock guard refuses it by default. The service also checks `lock_state` (AUTH-1). | PASS |
| RM-1 | **A recovery-mode session cannot sell.** | `createRecoveryModeGuardedIpcMain` refuses `cart:`, `payments:`, `tender:`, `vouchers:` and `returns:` while `getCurrent()?.recovery_of !== undefined` (`index.ts:812`). It wraps `handle` and `on` once at the composition root, so a handler registered later is covered. The mode is re-read on every call. Tests: `recovery-mode-guard.test.ts`. See **F-2** for what it does not refuse. | PASS (see F-2) |
| APR-1 | **Each action consumes its own approval, bound to kind, subject, version and amount.** | `consume({ approvalId, actionKind, subjectRef, subject, session })`. The subject comes from the resolvers: an attempt's version is its last action id plus every tender line's id, state and amount; a cart's version is its `last_action_id` (or `updated_at`). The amount is the attempt total (complete), the live tender total (cancel) or the cart subtotal (held cart). Tests: approval needed, wrong kind refused, a moved payment refused `approval_stale`, a changed cart refused `approval_stale`. | PASS |
| APR-2 | **Requester ≠ approver.** | The approval is requested on behalf of the original operator (`requesterOperatorId: row.acting_operator_id` / `owning_operator_id`). `approverAllowed()` requires the approver to be the signed-in manager (`manager-approval-service.ts:190-198`). The resolvers return null when the subject belongs to the asker (`othersStuckAttempt`, `othersHeldCart`). Tests: "another manager's PIN is refused", "requested on behalf of the original operator", "never lets an operator recover their own sale from a new session". See **F-1** on what this means in practice. | PASS (see F-1) |
| APR-3 | **Nothing is spent before the checks that can refuse cheaply.** | `cash_insufficient` and `confirmation_required` are returned before `consume`. Tests assert `consumed_at IS NULL` afterwards. | PASS |
| APR-4 | **A held-cart cancel is atomic with its approval.** | `cancelHeldInTransaction` consumes the approval and writes the cart and outbox row in one `db.transaction`. Test: "a stale cart rolls everything back" (cart still `editing`, approval not consumed). | PASS |
| OWN-1 | **Payment ownership (M5) is not relaxed for normal calls.** | The recovery payment port sets a recovery-scoped session (the attempt's own `operator_session_id`, the manager as acting operator) only for the duration of one call, after the approval is consumed. It clears in `finally`. The port is internal to main; the `payments:*` / `tender:*` IPC handlers keep their own session getter. One action runs at a time (`busy`; test "runs one action at a time"). | PASS |
| EXP-1 | **The response carries totals and opaque ids only.** | `RecoveryStuckAttemptView` / `RecoveryHeldCartView` hold ids, `owning_operator_id`, counts, minor-unit totals, timestamps, `kind` and `parked`. They carry no line items, no product names, no park label and no approver identity. Test: "shows the stuck payment and the held carts as a summary, no line items". | PASS |
| ERR-1 | **Refusals and failures leak nothing.** | Refusals are closed category strings. An unexpected throw answers `recovery_unavailable`, and the IPC layer logs only the error's name (`ipc/recovery.ts`, test "a throw answers recovery_unavailable, logged by name only"). The guard throws a generic `RecoveryModeError('recovery_mode')` that never names the channel (test). The service logs `{ err }` through the main pino logger, which applies the base redaction list; no request payload is logged. | PASS |
| AUD-1 | **Audit is main-only and dual-attributed.** | `payment.recovery_completed`, `payment.recovery_cancelled` and `cart.held_cancelled_by_manager` are emitted by the service with `acting_operator_id` set to the original operator and `approving_supervisor_id` set to the manager. The renderer cannot emit them. A sink failure is logged and does not undo the action. Tests assert both ids. | PASS |
| FF-1 | **`forceFail` is restricted.** | `payments-force-fail.ts:135` refuses `recovery_required` when the attempt holds live tender. The composition root wires `bindAttemptHasLiveTender(db)` (asserted by `bootstrap-session-admission.test.ts`). Tests: `bridge.payments-force-fail.role.test.ts` "refuses recovery_required when the attempt holds live tender, and changes nothing" / "still force-fails an attempt with no live tender". | PASS |

## 4. Validation run for this record

Run on `origin/main@df37c57`, Linux, `npm ci --ignore-scripts`:

- Recovery e2e, recovery IPC, recovery-mode guard, 0049, forceFail role and bootstrap wiring tests: **6 files, 79 tests passed.**
- Every test file matching recovery, manager approval or session admission, renderer included: **20 files, 308 tests passed.**
- `npm run typecheck`: clean.
- Not run here: `lint`, full `test --coverage`, CodeScene. CI on `db5337f` and `df37c57` covers those. Packaged and bench behaviour is RT-446.

## 5. Findings for the owner

### F-1 — Recovery entry is not gated by `recovery.unlock_other` (the open design deviation)

RT-116 §5.1 and the RT-441 scope say a manager is admitted in recovery mode with an RT-114 approval (`recovery.unlock_other`). As built, a manager or admin who signs in online on a terminal holding another operator's stuck attempt is admitted in recovery mode by role alone (`session-admission.ts`, `mayRecover`). Each action then needs the manager's own PIN.

Effect: the "two eyes" on a recovery action are one person with two factors (their sign-in, then their PIN), not two people. The original operator is absent by definition. The audit still names both the original operator and the manager. **The owner must accept this or require the entry approval.** PR #655 already lists this under "Open before review".

### F-2 — Recovery mode refuses the sale namespaces, not every non-recovery call

The guard refuses `cart:`, `payments:`, `tender:`, `vouchers:` and `returns:`. That matches the scope text in RT-441 ("every other `cart.*`, `payments.*` and `tender.*` call is refused"). It is narrower than the acceptance criterion ("recovery mode refuses every non-recovery call") and narrower than the header comment of `session-admission.ts` ("every call but recovery is refused").

While a stuck attempt is open, a recovery-mode session can still call, among others: `operator:force-close-shift`, `operator:provision-cashier-pin`, `operator:reset-cashier-pin`, `receipts:reprint` and `catalogue:refresh`. A manager may call these outside recovery mode too, so this grants no new privilege. However, `forced-close-handler.ts` does not check for a started attempt with live tender, so a manager could force-close the absent cashier's shift before the stuck payment is resolved.

**The owner must decide** whether the AC means the sale namespaces (the code and Jira scope agree) or a default-deny allowlist. In the second case, the guard needs a follow-up change.

### F-3 — Attempt actions spend the approval before the payment calls

For `completeAttempt` and `cancelAttempt`, the approval is consumed in its own transaction, then the 006 handlers run. If a payment step is refused, the answer is `payment_refused` and the approval is spent ("ask again"). If the cash apply succeeds and the confirm is then refused, the cash line stays live on the still-`started` attempt. The next try needs a new approval: the version changed, so the old one would be stale anyway. Nothing is lost or double-counted. This is by design (RT-116 runs the standard path unchanged) and recorded only so the behaviour is known.

### Notes

- **`cancelHeldCart` takes no free-text reason.** The reason is the fixed code from the cart's state (`manager_cancelled_held` / `manager_voided_post_handoff`). If RT-116 §5.2's "with a reason" means operator-entered text, this is a gap. If it means the reason code, this is done.
- **Test coverage per action is uneven.** The AC asks for a test per action of approval required, bound to subject and amount, stale subject refused, and requester ≠ approver. All four are explicit for `completeAttempt`. `cancelAttempt` has no explicit stale-subject test, and only `completeAttempt` asserts the stored `requester_operator_id` / `approver_user_id`. These paths share the resolver and `consume` code, so this is a test-coverage gap, not a behaviour gap.
- **The approval-id check is looser than a UUID check.** `APPROVAL_ID = /^[0-9a-f-]{36}$/` in `ipc/recovery.ts` also accepts strings that are not UUIDs, such as 36 hyphens. Such a value passes `invalid_input` and reaches `consume`, which looks it up with a bound parameter (`WHERE approval_id = ?`), finds no row and answers `approval_invalid`. Nothing is spent or written, so this is not a bypass. Tightening the pattern to the 8-4-4-4-12 form is a small follow-up, outside this docs-only record.
- **Parked carts depend on PK-2.** On `main`, `carts.parked_at` does not exist yet (RT-440 is To Do). `listHeld` flags `parked` once the column exists (tested by adding the column in the test). The AC "`cancelHeldCart` on a parked cart unblocks shift close" cannot be shown until PK-2 lands.

## 6. Sign-off

| Role | Name | Date | Decision |
| :-- | :-- | :-- | :-- |
| Agent assessment | Claude Code | 2026-10-13 | PASS on controls; F-1 and F-2 open for the owner |
| Owner | | | *pending* |
