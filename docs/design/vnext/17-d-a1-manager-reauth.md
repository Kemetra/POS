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

So the POS **cannot** key the prompt on `clerk_jwt_invalid`. A 401 on these routes means one
of two things: the JWT is stale (re-auth fixes it), or the backend operator session itself is
gone (`session_expired`, `session_revoked`; re-auth does not fix it).

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
   this step and rely on (2).
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
| `listStuckShifts` | 401 → `invalid_input`; empty JWT still sent | expired `exp` or 401 → `reauth_required`; no JWT held → `not_signed_in`, and no request is sent |

The audit event records `reauth_required` like any other refusal category. The JWT never
appears in logs, audit events or IPC payloads; `src/tests/operator-redaction.test.ts` must
keep passing.

### 2.3 The re-auth action

Add a new IPC **`operator:reauthenticate`** `{ identifier, password }` → `{ kind: 'reauthenticated' } | OperatorRefusal`.
It reuses the online path of `SessionUnlockHandler` (`session-unlock-handler.ts:128-148`):

- `clerk.exchange({ identifier, password })`.
- **The exchanged `operator_id` must equal the active session's operator.** Re-auth refreshes
  the credential of the person already signed in; it never swaps identity. A different person
  is refused (`role_mismatch`) and must use sign-out and sign-in or takeover.
- The same 5-failures / 5-minute lockout as the online unlock, shared with it.
- On success: `operatorJwtHolder.set(active.backend_session_id, exchange.jwt)`. No new backend
  session is created. A fresh JWT for the same Clerk user satisfies the backend, which matches
  `session.user_id` to the JWT's user (`pos-operators.service.ts`, sign-out path).

The lock-screen online unlock already does a full `clerk.exchange` and then throws the JWT
away. It should also store it, so a manager who unlocked the screen is not asked again minutes
later (owner decision Q2).

### 2.4 Retry once, then fail closed

After a successful re-auth, the renderer re-runs the original action **once**.
- If that call succeeds, the flow continues.
- If it returns 401 again, the backend operator session itself is gone (expired or revoked).
  Main ends the local session (`sessionManager.end()`; the existing `operator:session-state`
  push sends the renderer to sign-in), and the sign-in screen shows
  `SIGN_IN_REFUSAL_COPY.not_signed_in`. There is no loop of prompts.

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
| **A.** Skip the backend call when the held JWT is already expired; log `operator.sign_out.backend_skipped` | The backend session lives until its `expires_at`; the next manager sign-in on this terminal gets the existing takeover prompt (today's behaviour, minus a request that can only fail) | **Recommended for the pilot** |
| B. Ask for re-auth before signing out | A manager can't sign out without their password | Rejected: sign-out must always work |
| C. A device-attested sign-out route in Backend-Core | Ends the backend session without the operator JWT | A new cross-repo contract; raise as a Backend-Core follow-up only if takeover friction matters in the pilot |

### 2.7 What stays the same

Refresh tokens (OQ-9 "refresh later"), the Backend-Core contract, cashier flows, takeover and
sign-in.

## 3. Placement (implementation slice)

| File | Change |
|---|---|
| `src/shared/audit/event-shape.ts` | `reauth_required` in `REFUSAL_CATEGORIES` |
| `src/main/operator/jwt-holder.ts` (or a small sibling) | `isExpired(jwt, now)`: decode the payload, read `exp`; unreadable means "unknown", not expired |
| `src/main/operator/pin-management.ts` | Pre-check and 401 → `reauth_required` |
| `src/main/operator/stuck-shifts-handler.ts` | Pre-check, no-JWT guard, 401 → `reauth_required` |
| `src/main/operator/sign-out-handler.ts` | Option A: skip the call when expired, log it |
| `src/main/operator/session-unlock-handler.ts` | Shared online-credential check; store the JWT on success (if Q2 = yes) |
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
- Re-auth: the same operator → the holder is updated for the active `backend_session_id`; a
  different `operator_id` → refused and the holder is unchanged; `no_connection` → refused,
  holder unchanged; the lockout is shared with the online unlock.
- Retry: re-auth, then the call 401s again → the local session ends (`session-state: ended`).
- Sign-out with an expired JWT → local session ended, holders cleared, no backend request,
  `backend_skipped` logged.
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
| Q1 | Does a successful re-auth reset `manager_signed_in_at`, the timestamp the 2-minute manager-PIN enrolment step-up checks (`manager-pin-enrollment.ts:47`)? | **Yes.** Re-auth is a full password check, as strong as a fresh sign-in |
| Q2 | Should the lock-screen online unlock also store its fresh JWT? | **Yes.** It already does the exchange; storing it avoids a second prompt minutes later |
| Q3 | Sign-out with a stale JWT: option A now, C as a Backend-Core follow-up? | **A** for the pilot; open C only if takeover friction shows up |
| Q4 | Re-auth in a dialog on the same surface, or send the manager to the sign-in screen? | **Dialog.** It keeps the manager's place and typed PIN |

## 7. Risks

- **Clock skew.** The `exp` pre-check uses the terminal clock. A fast clock asks for re-auth
  early; a slow one falls through to the 401 path. Neither is unsafe.
- **The JWT lifetime.** It is set by the Clerk configuration (about 19 minutes was observed),
  not by the POS. A short lifetime means frequent prompts; refresh (OQ-9) is the later fix.
- **A generic 401 that is not expiry** (for example, a disabled user) costs one extra prompt
  before §2.4 ends the session. That is acceptable and fails closed.
