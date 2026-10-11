# D-A1: manager re-auth when the sign-in JWT expires (RT-247, Planning)

| | |
|---|---|
| Jira | RT-247, Work Mode **Planning**. No implementation here. |
| Source | [15-vnext-freeze-package.md](15-vnext-freeze-package.md) §7 **D-A1**: "Re-auth prompt for pilot; refresh later". Screen states S21 and M6. |
| Finding | N-01 ([14-rt159-packaged-reaudit.md](14-rt159-packaged-reaudit.md)): about 19 minutes after a manager signs in, «Set first PIN» fails with "Action could not be completed. Please try again.", and no retry can help. Sign-out is refused at the backend too, so the next manager sign-in needs a takeover. |
| Baseline | POS `origin/main@0a99967`; Backend-Core contract at `origin/main@a4b1631`. |
| Owner decisions already taken | Copy (2026-10-07, RT-247 comment 11157): **«انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.»** with one named action **«تسجيل الدخول»**. No generic retry. This replaces M-A3 (§5 below). |
| Related | RT-235 (first PIN), RT-214 (roster), RT-159, RT-246 (G-1 visual reference). |

## 1. What happens today

The manager's Clerk JWT is written once into the main-process `operatorJwtHolder`
(`src/main/operator/jwt-holder.ts`) at sign-in (`sign-in-handler.ts:244`) or takeover
(`takeover-handler.ts:300`). Nothing refreshes it.

### 1.1 Where the held JWT is presented

| Manager action | IPC → handler | Backend route (`operator-identity`) | A 401 today becomes | What the manager sees |
|---|---|---|---|---|
| **Set first PIN** | `operator:provision-cashier-pin` → `pin-management.ts:282` (JWT read :324) | `GET /api/pos/v1/operators/roster` | `unauthenticated` → `not_signed_in` (`pin-management.ts:95-109`) | English "Action could not be completed. Please try again." (`CashierManagement.tsx:284-288`) |
| **Stuck shifts list** | `operator:list-stuck-shifts` → `stuck-shifts-handler.ts:37` (JWT read :48) | `GET /api/pos/v1/shifts/stuck` | `refused` → **`invalid_input`** (:54-56). Also sends an empty bearer when no JWT is held | English "Unable to load stuck shifts. Please try again." + Retry (`ForcedCloseSurface.tsx:240-252`) |
| **Sign-out** | `operator:sign-out` → `sign-out-handler.ts:38` (`jwtFor` :47) | `POST /api/pos/v1/operators/sign-out` | `refused`, logged only (:73-76) | Nothing: the renderer always gets `signed_out` |

Not affected, and worth stating so the slice does not touch them:
- **Reset PIN, Unlock cashier, Force-close shift**: local only, no backend call
  (`pin-management.ts:150-251`, `:431-517`; ForcedCloseHandler).
- **Cashier list on the manager screen** (`operator:list-branch-roster`): device-token auth.
- **Takeover confirm and manager sign-in**: they present a JWT exchanged seconds earlier
  (`proto.jwt`, 60 s proto TTL; `exchange.jwt`), never the held one.
- **Sale sync**: uses the envelope holder, a different scheme.

### 1.2 The backend does not say "expired"

Backend-Core knows the reason (`clerk_jwt_invalid`, `operator-context-resolver.ts:163`), but
every `operator-identity` refusal goes out as a **generic 401** (`UnauthorizedException`
in `pos-operators.controller.ts`). The contract makes that deliberate; for example, the
sign-out 401 "does not distinguish between an invalid Clerk JWT, an unknown / already-revoked /
expired session id, …" (`pos-operators.openapi.yaml`). The POS backend client also reads only
the status, never the body (`backend-client.ts:246-266`).

So the POS **cannot** key the prompt on `clerk_jwt_invalid`. On the two routes this plan
retries, a 401 means one of two things: the JWT is stale (re-auth fixes it), or the person's
authority is gone at the backend, for example a disabled user or a revoked membership or role
(re-auth does not fix it).

Neither route looks at the backend **operator session**. The roster (`pos-operators.service.ts`,
`roster`) and stuck-shifts (`pos-shifts.service.ts`) pipelines check the JWT, the user, the
membership and the role, never the `session_id`. The only `operator-identity` route that reads
the operator session is sign-out, and it revokes it. So the POS has **no** request that checks
whether its backend operator session is still valid without ending it (§2.3, §6 Q1).

### 1.3 Sign-out

`sign-out-handler.ts` ends the local session and clears both holders **first** (:52-53), then
calls the backend in the background with a 750 ms race. With a stale JWT the backend call is
refused, so the backend operator session stays alive until its own `expires_at`. The next
manager sign-in on the terminal gets `takeover_required` and the takeover prompt (N-01).

## 2. Recommendation

### 2.1 Detect "re-auth required" in main, two ways

1. **Before the call:** if the held JWT has an `exp` claim in the past, do not send the request.
   Decode the payload only to read `exp`. This is classification, not trust: the backend stays
   the authority and verifies every JWT it receives. If the token has no readable `exp`, skip
   this step and rely on (2). **The marked retry (§2.4) skips this pre-check.** If the
   terminal clock is ahead of Clerk by the JWT lifetime or more, a JWT exchanged seconds ago
   already looks expired; without the bypass the retry would return `reauth_required` again
   without ever sending a request, and the manager could never finish. The retry still goes
   through the 401 fail-closed path of §2.4.
2. **After the call:** a **401** from an `operator-identity` route is treated as re-auth
   required. It is generic (§1.2), so the retry rule in §2.4 decides what to do if re-auth
   does not help.

No Backend-Core change and no new contract is needed.

### 2.2 One refusal category for the renderer

Add **`reauth_required`** to the closed `REFUSAL_CATEGORIES` set
(`src/shared/audit/event-shape.ts:166-176`). Map it in main:

| Handler | Today | After |
|---|---|---|
| `provisionCashierPin` | 401 / no JWT → `not_signed_in` | expired `exp` or 401 → `reauth_required`. No active session or no JWT held → `not_signed_in` (unchanged) |
| `listStuckShifts` | 401 → `invalid_input`; empty JWT still sent | expired `exp` or 401 → `reauth_required`; no JWT held → `not_signed_in`, and no request is sent; 403 and 5xx keep today's `invalid_input` |

The stuck-shifts mapping needs a backend-client change first. `getStuckShifts` calls
`fetchAndInterpret` without a status classifier (`backend-client.ts:327-336`), so every non-2xx
response collapses to the same `{ kind: 'refused' }` and the handler cannot tell a 401 from a
403 or a 5xx. The slice gives it a classifier like the roster's `rosterRefusal`
(`backend-client.ts:431-435`): 401 → `unauthenticated`, 403 → `forbidden`, anything else →
`refused`, with `BackendStuckShiftsResponse` widened to match. Only `unauthenticated` maps to
`reauth_required`. The provision-PIN path already gets `unauthenticated` from `listRoster`.

The audit event records `reauth_required` like any other refusal category. The JWT never
appears in logs, audit events or IPC payloads; `src/tests/operator-redaction.test.ts` must
keep passing.

### 2.3 The re-auth action

Add a new IPC **`operator:reauthenticate`** `{ identifier, password }` → `{ kind: 'reauthenticated' } | OperatorRefusal`.
It reuses the online path of `SessionUnlockHandler` (`session-unlock-handler.ts:128-148`):

- `clerk.exchange({ identifier, password })`.
- **The exchanged `operator_id` must equal the active session's operator.** Re-auth refreshes
  the credential of the person already signed in; it never swaps identity. Another person's
  valid credentials are refused with the **same generic `invalid_input` as wrong credentials**,
  as `SessionUnlockHandler.verifyOnline` already does (`session-unlock-handler.ts:141-145`), so
  the result never reveals that another account's credentials were valid. That person must use
  sign-out and sign-in or takeover.
- The same 5-failures / 5-minute lockout as the online unlock, shared with it.
- **One credential attempt at a time.** The single-flight guard that protects the lockout
  today wraps `SessionUnlockHandler.unlock()` (`session-unlock-handler.ts:66-77`), outside the
  online check that re-auth reuses. Sharing only the failure counter would let several
  concurrent `operator:reauthenticate` calls pass the pre-await lockout check and each send a
  password attempt before any failure is recorded. The slice **keeps** the existing guard on
  `unlock()`, which also serialises cashier PIN unlocks (`verifyCashierPin` and its
  read / Argon2 / write failure counter, `session-unlock-handler.test.ts:232-245`), and **adds**
  a shared online gate inside the online-credential check that covers manager online unlock
  and re-auth. A second online attempt while one is in flight is refused `rate_limited` and
  sends nothing.
- **Re-check the session after the exchange.** Snapshot the active session (`id`,
  `backend_session_id`, `operator_id`) before `clerk.exchange`, and after it resolves confirm
  that the same session is still the current one **and still unlocked**
  (`lock_state` is not `locked`), as `SessionUnlockHandler.unlockOnce` already re-checks its own
  state (`isStillLocked`, `session-unlock-handler.ts:89-114`).
  - Sign-out, revocation or takeover during the network call → refuse `not_signed_in` and store
    nothing. A late success must never repopulate credentials for an ended session.
  - An inactivity lock during the call → refuse `state_invalid` and store nothing. `lock()` keeps
    the same session id and only changes `lock_state` (`session-manager.ts:309-313`), and the
    routed surface stays mounted behind the lock overlay, so without this check a late success
    would retry a privileged action behind the lock screen.
  - A confirmed device revocation during the call → refuse `not_signed_in` and store nothing.
    Revocation does not always end the session at once: the revocation flow clears the
    credential holders and latches the session, but `CashierAdmissionKeeper.latchCurrentSession`
    keeps the same unlocked session until its safe point (`src/main/index.ts:997-1018`,
    `cashier-admission-keeper.ts:331-345`). So the check also rejects a session with
    `authority_latch` set, and a device that `pairingStore.isDeviceRevoked()` reports revoked.
- On success: `operatorJwtHolder.set(active.backend_session_id, exchange.jwt)`. No new backend
  session is created. A fresh JWT for the same Clerk user satisfies the backend, which matches
  `session.user_id` to the JWT's user (`pos-operators.service.ts`, sign-out path).

**Re-auth refreshes the JWT only, never local manager authority** (owner decision Q1,
recommended *no*). In particular it does not refresh `manager_signed_in_at`, the timestamp the
2-minute manager-PIN enrolment step-up checks (`manager-pin-enrollment.ts:47`). Re-auth proves
the Clerk credentials, not the backend operator session, and the POS cannot check that session
without revoking it (§1.2). Refreshing the step-up would let `ManagerPinEnrollment` create or
replace a manager PIN entirely locally, valid for up to 30 days (`manager-pin-store.ts:15-18`),
on a backend session that may already have expired or been revoked. That path sends no
`operator-identity` request, so the §2.4 fail-closed rule could never end it. Enrolment more
than two minutes after sign-in therefore keeps today's behaviour: `ManagerPinEnrollment` shows
`reauth_required` (`src/renderer/v5/shift/ManagerPinEnrollment.tsx:66-80`), and the manager
signs out and in again, which creates a fresh backend session. Letting re-auth cover enrolment
needs a Backend-Core route that validates the operator session without revoking it; that is a
new contract, listed as a follow-up in §6, not invented here.

The lock-screen online unlock already does a full `clerk.exchange` and then throws the JWT
away. **Only if the owner accepts Q2** (recommended, not yet decided), it also stores it, so a
manager who unlocked the screen is not asked again minutes later. Until Q2 is accepted, the
online unlock keeps today's behaviour and the slice does not touch it, apart from the shared
in-flight gate. Storing it adds **no** local authority: the online unlock already
unlocks the session today after the same exchange, and storing the JWT only changes which
credential the next `operator-identity` request presents, which the backend still checks. If it
does, it must go through the same path as re-auth: the post-await session check and the one-shot
"just re-authenticated" mark of §2.4. The post-await check shares its identity, latch and
revocation parts with re-auth, but the **expected lock state depends on the operation**:
re-auth expects the session to be still **unlocked**, while an online unlock expects the same
session to be still **locked**, as `unlockOnce` already requires (`isStillLocked`,
`session-unlock-handler.ts:89-114`). An unlock stores the JWT and sets the mark only after that
check passes and the session is unlocked; if the check fails it stores nothing. Without the mark, a JWT refused right after an unlock
would prompt for the password a second time, right after the manager typed it.

### 2.4 Retry once, then fail closed

The retried request looks exactly like the first one, so main needs its own record that a
re-auth just happened. Without it a second 401 would only map to `reauth_required` again and
prompt again.

- **The marker.** On a successful `operator:reauthenticate` (and, with Q2, a successful online
  unlock), main marks the held JWT for the active `backend_session_id` as **just
  re-authenticated**, with the time it was set. The mark lives next to the JWT in the holder (for
  example `set(sessionId, jwt, { reauthenticatedAt })`), so it is bound to that session and is
  cleared with it on sign-out, revocation or takeover.
- **Short-lived.** The mark is only valid for `REAUTH_MARK_TTL_MS`, **60 seconds**, measured
  on a monotonic clock. That is long enough for the immediate retry, and short enough that
  "exchanged seconds ago" stays true. An expired mark is treated as absent. Without the limit, a
  mark left by an unlock with no protected call afterwards could survive until the JWT itself
  expires at the backend. A slow terminal clock can hide that expiry from the `exp` pre-check, so
  the eventual 401 would end a healthy session instead of prompting.
- **Consumed by the next call.** The first `operator-identity` request that presents that JWT
  consumes the mark **before** the request is sent, whatever the outcome. The mark is never
  carried by IPC; the renderer cannot set or replay it.
- **Bound to the request's session.** Before sending, the handler snapshots the active
  session's `id` and `backend_session_id`. A 401 acts only on that session. If the session
  has ended or changed while the request was in flight (sign-out and a new sign-in, or a
  takeover), the handler returns `not_signed_in` and does nothing else: it ends no session,
  clears no holder and asks for no re-auth. A late 401 must never end or prompt an unrelated
  operator. `SessionManager.end()` has no session-id guard today (`session-manager.ts:266`), so
  the slice adds a session-id-keyed `endIfCurrent(sessionId, cause)` that ends the session only
  if it is still the current one.
- **What a 401 means.** For a request that consumed the mark, a 401 is not "re-auth
  required": a JWT exchanged within the last `REAUTH_MARK_TTL_MS` was refused, so the person's
  authority is gone at the backend (§1.2) and another password will not help. Main ends that session through
  `sessionManager.endIfCurrent(snapshot.id, …)` (the existing `operator:session-state` push
  sends the renderer to sign-in) and returns `not_signed_in`. `SessionManager.end()` clears only
  `current`; the credential holders are cleared separately by the sign-out and revocation
  wiring. So, only when `endIfCurrent` actually ended the snapshot session, main also clears
  that session's credentials, keyed by `snapshot.backend_session_id`: the JWT and its mark
  (`operatorJwtHolder.clear`) and the envelope (`operatorEnvelopeHolder.clear`), as sign-out does
  (`src/main/index.ts:881-884`). A replacement session's credentials are never touched. The sign-in screen shows
  `SIGN_IN_REFUSAL_COPY.not_signed_in`.
- **Otherwise.** A 401 on a request without the mark, while the snapshot session is still
  current, maps to `reauth_required` as in §2.2.
- **Success.** If that request succeeds, the mark is already gone and the flow continues.

The renderer re-runs the original action **once** after a successful re-auth. The fail-closed
decision is made in main, from the mark, so there is no loop of prompts even if the renderer
retried again.

**The protected handlers re-check the session themselves.** The post-exchange check in §2.3
cannot cover a lock that happens after re-auth returns and before the renderer re-runs the
action. Today `provisionCashierPin` and `listStuckShifts` check only the role. The slice makes
each protected handler (`provisionCashierPin` and `listStuckShifts`) refuse `state_invalid` when the current session is locked (`lock_state === 'locked'`)
or has `authority_latch` set. This applies to every call, not only retries: a privileged action
never runs behind the lock screen or on a latched session.

An entry check alone is not enough, because the handlers await before they act.
`provisionCashierPin`, for example, awaits `pairingStore.getStatus()` (`pin-management.ts:313`)
before the roster request, then awaits that request before writing the PIN. So each handler
snapshots the session (`id`, `backend_session_id`) at entry and repeats the check after every
`await`, in particular **immediately before the backend call** and **immediately before any
local side effect** (the PIN write). If the session changed, locked or latched in between, it
refuses (`not_signed_in` if the session changed or ended, otherwise `state_invalid`) and does
nothing further. One helper (for example `stillActive(snapshot)`) keeps the check identical
everywhere.

### 2.5 UX (screen states S21 and M6)

On the manager surface where the action failed (`CashierManagement`, `StuckShiftSurface`), show
an **inline warning**, not a toast:

- Text: «انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.»
- One primary action: **«تسجيل الدخول»**. No «حاول مرة أخرى» (§5 rule 4) and no English
  fallback (§5 rule 1). The raw category never appears (§5 rule 3).

«تسجيل الدخول» opens a **re-auth dialog on the same surface**, so the manager keeps their
place and what they typed:

- The manager's name is shown read-only; there are fields for the identifier and password.
- Wrong credentials use the existing sign-in refusal copy (`SIGN_IN_REFUSAL_COPY`).
- Modal behaviour per UX-11: focus on the first field, Escape cancels, Tab is trapped, focus
  returns to the action on close.
- On success the dialog closes and the action re-runs (§2.4):
  - **First PIN:** the PIN and its confirmation stay in the component's state while the dialog
    is open, and are submitted again. They are cleared on cancel, as today.
  - **Stuck shifts:** the list reloads.

The G-1 visual reference for this state (RT-246) uses this copy.

### 2.6 Sign-out

Sign-out must never depend on the network or on credentials, so it **keeps clearing locally
first**. Options for the backend session when the JWT is stale:

| Option | What happens | Recommendation |
|---|---|---|
| **A.** Skip the backend call when the held JWT is already expired; log `operator.sign_out.backend_skipped`. A JWT with a fresh mark (§2.4) is not skipped: as in §2.1 it bypasses the `exp` pre-check, so a manager who just re-authenticated or unlocked online on a fast-clock terminal still ends the backend session | The backend session lives until its `expires_at`; the next manager sign-in on this terminal gets the existing takeover prompt (today's behaviour, minus a request that can only fail) | **Recommended for the pilot** |
| B. Ask for re-auth before signing out | A manager can't sign out without their password | Rejected: sign-out must always work |
| C. A device-attested sign-out route in Backend-Core | Ends the backend session without the operator JWT | A new cross-repo contract; raise as a Backend-Core follow-up only if takeover friction matters in the pilot |

### 2.7 What stays the same

Refresh tokens (OQ-9 "refresh later"), the Backend-Core contract, cashier flows, takeover and
sign-in.

## 3. Placement (implementation slice)

| File | Change |
|---|---|
| `src/shared/audit/event-shape.ts` | `reauth_required` in `REFUSAL_CATEGORIES` |
| `src/main/operator/jwt-holder.ts` (or a small sibling) | `isExpired(jwt, now)`: decode the payload, read `exp`; unreadable means "unknown", not expired. The per-session one-shot "just re-authenticated" mark (§2.4): set on re-auth, consumed before the next `operator-identity` request, cleared with the session |
| `src/main/operator/pin-management.ts` | Locked or latched session → `state_invalid` at entry and again after each await (before the roster request, before the PIN write); pre-check (skipped for the marked retry) and 401 → `reauth_required` |
| `src/main/operator/backend-client.ts` | A status classifier for `getStuckShifts` (401 → `unauthenticated`, 403 → `forbidden`, else `refused`), like `rosterRefusal`; widen `BackendStuckShiftsResponse` |
| `src/main/operator/stuck-shifts-handler.ts` | Locked or latched session → `state_invalid` at entry and again before the request; pre-check (skipped for the marked retry), no-JWT guard, `unauthenticated` → `reauth_required` |
| `src/main/operator/sign-out-handler.ts` | Option A: skip the call when expired (unless the JWT carries a fresh mark), log it |
| `src/main/operator/session-unlock-handler.ts` | Shared online-credential check with a new shared online in-flight gate covering manager online unlock and re-auth; the existing `unlock()` guard stays (it serialises cashier PIN unlocks); if Q2 = yes, store the JWT on success through the same path as re-auth (post-await check incl. latch and revocation, one-shot mark); no local authority is refreshed |
| `src/main/operator/session-manager.ts` | `endIfCurrent(sessionId, cause)` for the §2.4 fail-closed path. Nothing refreshes `manager_signed_in_at` (Q1 = no) |
| new `src/main/operator/reauth-handler.ts` + `src/main/ipc/operator.ts` + `src/shared/operator/channels.ts` + `src/shared/bridge-api.ts` + preload | `operator:reauthenticate` |
| `src/renderer/ui/operator/messages.ts` | The owner-approved copy and the action label |
| `src/renderer/routes/app/manager/CashierManagement.tsx`, `src/renderer/ui/operator/ForcedCloseSurface.tsx` | The inline warning, the dialog, retry once |
| new `src/renderer/ui/operator/ReauthDialog.tsx` | The dialog |

## 4. Tests to write (implementation slice)

Main (vitest, `src/main/operator/__tests__/`):
- `isExpired`: past `exp` → true; future → false; no `exp`, malformed or non-JWT → unknown
  (never throws).
- Provision PIN and stuck shifts: expired JWT → `reauth_required` **and no request sent**;
  backend 401 → `reauth_required`; no JWT held → `not_signed_in`.
- Stuck shifts never sends an empty bearer.
- Backend client `getStuckShifts`: 401 → `unauthenticated`, 403 → `forbidden`, 500 →
  `refused`. In the handler only `unauthenticated` becomes `reauth_required`; 403 and 5xx keep
  today's mapping.
- Re-auth: the same operator → the holder is updated for the active `backend_session_id`; a
  different `operator_id` → refused and the holder is unchanged; `no_connection` → refused,
  holder unchanged; the lockout is shared with the online unlock.
- Re-auth race: the session ends, is revoked or is taken over while `clerk.exchange` is in
  flight → refused `not_signed_in`, and neither the JWT nor the mark is stored. The session
  **locks** while the exchange is in flight → refused `state_invalid`, nothing stored, and no
  retry runs behind the lock.
- Re-auth race: a device revocation is confirmed while `clerk.exchange` is in flight and the
  session is kept latched until its safe point → refused `not_signed_in`, nothing stored.
- Concurrency: two `operator:reauthenticate` calls at once → the second is refused
  `rate_limited` and sends no exchange; the same between a manager online unlock and a
  re-auth. Concurrent cashier PIN unlocks stay serialised by the `unlock()` guard (the existing
  `session-unlock-handler.test.ts:232-245` keeps passing).
- Protected handlers: a locked or latched session → `state_invalid`, and no request sent.
  Lock between a successful re-auth and the renderer's retry → the retry is refused
  `state_invalid` and nothing runs. Lock or latch while `pairingStore.getStatus()` is awaited
  → no backend request. Lock or latch while the roster request is in flight → no PIN is
  written. The session ends and a new one starts during either await → `not_signed_in`,
  nothing written.
- Another operator's valid credentials → `invalid_input`, the same as wrong credentials; no
  distinct refusal reveals that they were valid.
- Q1 = no: re-auth leaves `manager_signed_in_at` unchanged, and manager-PIN enrolment more than
  two minutes after the original sign-in is still refused `reauth_required` after a successful
  re-auth.
- If Q2 = yes: a successful online unlock of a session that is still locked after the exchange
  stores the JWT and sets the one-shot mark (the locked success path). If the session ended,
  changed, was already unlocked or was latched during the exchange, the unlock refuses and
  stores nothing. Re-auth uses the same shared checks with the opposite lock expectation.
- Retry (§2.4): after re-auth, a 401 on the next call ends the local session
  (`session-state: ended`) and returns `not_signed_in`, not `reauth_required`. The mark is
  consumed **before** that request is sent: a second call after it maps a 401 to
  `reauth_required` again. A successful call also consumes it. Sign-out, revocation and
  takeover clear it. No IPC payload can set it.
- Retry-request race: the session ends and a new one starts (sign-out then sign-in, or a
  takeover) while the marked request is in flight, then the old request gets a 401 → returns
  `not_signed_in`, the new session is **not** ended, its holders and mark are untouched and no
  end hooks run. The same race without the mark → `not_signed_in`, not `reauth_required`.
- `endIfCurrent`: ends the session for a matching id; no-op for any other id.
- Fast clock: a marked JWT whose `exp` is already in the past by the terminal clock (fake clock
  ahead of the JWT lifetime) → the retry is still sent; a 401 on it still fails closed.
  Without the mark, the same JWT → `reauth_required` with no request sent.
- Mark TTL: a mark older than `REAUTH_MARK_TTL_MS` (fake monotonic clock) is ignored, so a 401
  maps to `reauth_required` and the session is not ended.
- Sign-out with an expired JWT → local session ended, holders cleared, no backend request,
  `backend_skipped` logged. Sign-out with a JWT that looks expired by a fast clock but carries a
  fresh mark → the backend sign-out request is sent.
- Fail-closed end (§2.4): after `endIfCurrent` ends the snapshot session, its JWT, mark and
  envelope are cleared. When the session already changed, `endIfCurrent` is a no-op and the
  replacement session's JWT, mark and envelope are untouched.
- Redaction: no JWT, identifier or password in logs or audit events
  (`src/tests/operator-redaction.test.ts`).

Renderer:
- `CashierManagement`: a `reauth_required` refusal shows the Arabic copy and only
  «تسجيل الدخول»; no «حاول مرة أخرى», no English. Success re-submits the PIN once; cancel clears
  the PIN fields.
- `StuckShiftSurface`: same copy; success reloads the list.
- `ReauthDialog`: focus, Escape, Tab trap, focus return; wrong credentials show sign-in copy.

Bench (packaged, RT-246 / G-1): sign in as manager, wait past JWT expiry (or shorten it on the
lab Clerk instance), then set a first PIN: the prompt appears, re-auth succeeds, the PIN is set
without leaving the screen.

## 5. Catalogue change in this plan

[15-vnext-freeze-package.md](15-vnext-freeze-package.md) §5 **M-A3** now reads
«انتهت جلسة الدخول. سجّل الدخول مرة أخرى للمتابعة.» (owner decision 2026-10-07, UX-12 wording,
which ranks above the freeze package). S21 and M6 point here.

## 6. Owner decisions

| # | Question | Recommendation |
|---|---|---|
| Q1 | Does a successful re-auth reset `manager_signed_in_at`, the timestamp the 2-minute manager-PIN enrolment step-up checks (`manager-pin-enrollment.ts:47`)? | **No.** Re-auth proves the Clerk credentials but not the backend operator session, and enrolment is local only, so a refresh could mint a 30-day manager PIN on an expired or revoked backend session (§2.3). Enrolment keeps requiring a real sign-in. A "yes" needs a Backend-Core route that validates the operator session without revoking it (a new contract, follow-up) |
| Q2 | Should the lock-screen online unlock also store its fresh JWT? | **Yes.** It already does the exchange; storing it (with the one-shot mark and the post-await check) avoids a second prompt minutes later |
| Q3 | Sign-out with a stale JWT: option A now, C as a Backend-Core follow-up? | **A** for the pilot; open C only if takeover friction shows up |
| Q4 | Re-auth in a dialog on the same surface, or send the manager to the sign-in screen? | **Dialog.** It keeps the manager's place and typed PIN |

## 7. Risks

- **Clock skew.** The `exp` pre-check uses the terminal clock. A fast clock asks for re-auth
  early, and the marked retry skips the pre-check (§2.1), so even a clock ahead by more than
  the JWT lifetime cannot trap the manager in a loop; a slow one falls through to the 401 path.
  Neither is unsafe.
- **The JWT lifetime.** It is set by the Clerk configuration (about 19 minutes was observed),
  not by the POS. A short lifetime means frequent prompts; refresh (OQ-9) is the later fix.
- **The backend operator session is not checked by these routes** (§1.2). A manager whose
  backend session expired but whose Clerk account is still valid can keep using the roster and
  stuck-shift routes after re-auth, as they can today before the JWT expires. This plan does not
  change that, and keeps it out of local-only authority (Q1 = no).
- **A generic 401 that is not expiry** (for example, a disabled user) costs one extra prompt
  before §2.4 ends the session. That is acceptable and fails closed.
