<!--
RT-196 S1 — §A4 P8 bridge-security record. Written with the implementation, before merge.
Scope: a payload-only re-check of ReturnJournalView on existing returns:* channels, the
main-only audit categories, and the PREPARED (NOT WIRED) returns:resend channel matrix.
-->

# §A4 — P8 bridge-security record: unknown-return cause and resend (RT-196 S1)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-196 — operator path to resolve a permanently-unknown return; slice **S1** (plan POS #774, `docs/superpowers/specs/2026-10-18-rt-196-unknown-return-resolution-design.md`) |
| Status of the slice | **S1-partial.** Resend exists only as a main-process service method. **No `returns:resend` channel is wired.** S1 is NOT complete until that channel lands. |
| Gate | §A4 — P8 Electron security boundary. No new channel in this PR; payload re-check of existing channels; two new main-only audit categories. |
| Bridge surface changed | `ReturnJournalView` (answers of `returns:list`, `returns:submit`, `returns:payout`) gains `attemptCount`, `lastAttemptAt`, `lastCause`. No channel, handler or preload change. |
| Decisions | Delegated rulings from the coordinating session (not owner sign-offs): (a) open as S1-partial; (b) ship the additive payload delta; (c) record under `docs/security-review/RT-196/`. The channel itself still needs the owner's §A4 approval. |
| Prepared by | The implementation agent (Claude Code). A targeted agent review of the diff, **not** the full Electron audit and **not** an independent human review. |
| Verdict | **Agent-assessed PASS** for what ships (payload delta + main-only categories). The `returns:resend` channel is **not approved** here. |

## 2. What ships (and what it exposes)

| # | Surface | Control | Evidence |
| :-- | :-- | :-- | :-- |
| D-1 | `ReturnJournalView` + `attemptCount` (integer), `lastAttemptAt` (ISO string or null), `lastCause` (closed enum or null) | Additive, closed key set. No HTTP body, status text, envelope, `externalId` / Idempotency-Key or request body. `lastCause` is read from local `audit_events` in one batched query, validated against `RETURN_UNKNOWN_CAUSES` (a value outside the set reads as null), and is null once the row is resolved. | `returns-unknown-cause.test.ts`: exact key set, no secret substrings, forged cause reads null. `returns-units.test.ts`: projection equality. |
| D-2 | `returns:submit` / `returns:resolve` answers | `unconfirmed` answers carry `ret.lastCause` (same type, same minimisation). | `returns-unknown-cause.test.ts` |
| D-3 | Audit categories `sale.return.attempt_unknown`, `sale.return.resend_requested` | Added to `MAIN_ONLY_AUDIT_CATEGORIES`, so `operator:emit-audit-event` refuses a renderer-forged one (it feeds `lastCause`, and RT-196 S4 will count auth failures from it). | `operator-emit-audit-event.test.ts` (it.each, never emitted). |
| D-4 | Audit payloads | `attempt_unknown`: `return_id`, `sale_id`, `attempt_no`, `cause`, `operation`. `resend_requested`: `return_id`. Ids and closed codes only; no body, envelope or PIN; the emitter's forbidden-key scan applies. | `returns-unknown-cause.test.ts`, `returns-resend.test.ts` |
| D-5 | Credential handling | Unchanged: the envelope is read only by the authorizer, passed as an argument, never logged, audited, stored or bridged. The client now returns a closed `cause` instead of a bare `unknown`. | `returns-client.test.ts` |

## 3. PREPARED, NOT WIRED — `returns:resend` (needs owner §A4 approval)

| # | Channel | Direction | Payload (closed shape) | Answer |
| :-- | :-- | :-- | :-- | :-- |
| C-1 | `returns:resend` | renderer → main | exactly `{ returnId }`, canonical UUID, closed key set (same reader pattern as `readReprintRequest`) | `ReturnsResendResponse` = `ReturnsSubmitResponse` |

Where a wiring change must touch (verified by reading, none edited):

1. `src/shared/returns/channels.ts` — add `RESEND: 'returns:resend'`.
2. `src/shared/returns/types.ts` — add `resend(req)` to `ReturnsBridgeAPI` (`ReturnsResendRequest/Response` already exist).
3. `src/main/ipc/returns.ts` — `readResendRequest` + handler (copy the `reprintSlip` shape).
4. `src/preload/returns.ts` — one `ipcRenderer.invoke` on the constant channel.
5. `src/main/ipc/session-lock-guard.ts` — nothing to add: `returns:*` channels are default-deny while locked (`session-lock-guard.test.ts` enumerates `RETURNS_IPC_CHANNELS`).
6. `src/main/ipc/recovery-mode-guard.ts` — `returns:` is already a refused SALE namespace prefix; add one assertion.
7. `compose-returns.ts` — move `resend` from `ComposedReturns.resend` into `service`.
8. Tests: `ipc/__tests__/returns.test.ts` (closed shape, non-UUID, extra keys), `preload/__tests__/returns.test.ts`.

Controls the service method already satisfies (all in `returns-resend.test.ts`):

| # | Control | Evidence |
| :-- | :-- | :-- |
| A4-1 | Main is the trust boundary: the renderer names only `returnId`; scope, operator, envelope, Idempotency-Key and body come from main | `ReturnsService.resend` reads the row and applies `isOwnScope` |
| A4-2 | Manager/admin only (D-b), feature flag, lock and shutdown latch before any DB read | tests: cashier `role_denied`, flag off, locked session, `shutting_down` |
| A4-3 | Input validation: non-UUID → `invalid_input`; unknown id or another terminal → `return_not_found` (non-disclosing) | test |
| A4-4 | AC8: identical journaled bytes under the same key; never a rebuilt body | test compares both POSTs byte for byte |
| A4-5 | D-a/D-c: resend never builds from live state or computes money; confirmation only through the dispatcher's own `matchingTotalMinor` | dispatcher unchanged in that respect |
| A4-6 | Never a locally fabricated confirmation; a confirmed / paid-out / refused row → `already_resolved`, nothing sent | test |
| A4-7 | Session binding: re-checked right before the POST; the answer is withheld (`session_changed`) if the session changed during the await | test |
| A4-8 | Audit attributed to the **requesting** operator, payload `{ return_id }` | test |
| A4-9 | RT-741 own-sales rule: deliberately not applied. A cashier never passes `admit`; for manager/admin the rule is the terminal scope, enforced on the journaled row. | code comment in `returns-service.ts` |

## 4. Findings

None from the targeted review. No BrowserWindow, preload, handler or session-lock change in this diff; `src/main/ipc/operator.ts` only gains two entries in a denylist (a tightening).

## 5. Out of scope / follow-up

- The pre-existing `sale.return.*` categories (`attempted`, `refused`, `confirmed`, `payout_ready`, the S4 set) are **not** in `MAIN_ONLY_AUDIT_CATEGORIES`, so a renderer can forge them. Pre-existing; proposed as a separate follow-up.
- Not verified: no UI (S6), no runtime or packaged check; evidence is unit and integration tests on sql.js.
