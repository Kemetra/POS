<!--
RT-542 (RT-534 S6) — §A4 P8 bridge-security record for the new saleHistory:*
channels, the Backend-Core sale-history client and the OD-534-8 reprint guard.
Written with the implementation, before merge.
-->

# §A4 — P8 bridge-security review: `saleHistory.*` (RT-542)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-542 — RT-534 S6, store-wide sales history, sale detail and reprint via Backend-Core |
| Gate | §A4 — P8 Electron security boundary (preload-bridge expansion + a new Backend-Core client) |
| Bridge surface | `api.saleHistory.list` / `read` / `reprint` over `saleHistory:list` / `saleHistory:read` / `saleHistory:reprint` (new). `receipts.reprint` gains the `sale_voided` refusal. |
| Contract | Backend-Core `sale-history.yaml` (RT-537), vendored in `contracts/backend-core/` and checked by the RT-217 conformance suite. Runtime RT-539 (`1d26d28`). |
| Baseline | `origin/main` at `c94660b8` |
| Prepared by | The implementation agent (Claude Code), 2026-10-16, with an agent security review. **Not an independent human review.** |
| Verdict | **Agent-assessed PASS after fixes.** The agent security review found one HIGH (H1) and one MEDIUM (M1) in the reprint path; both were fixed before merge (§4). No CRITICAL. |

## 2. Code under review

| File | Role |
| :-- | :-- |
| `src/shared/sale-history/types.ts` | Channels, closed refusal set, bridge views (money as integer minor units). |
| `src/preload/sale-history.ts` | Three `ipcRenderer.invoke` calls on constant channels. |
| `src/main/ipc/sale-history.ts` | Non-object payload → `invalid_request`; a thrown fault → `unavailable`, logged by error name only. Registered on `guardedIpcMain`. |
| `src/main/sale-history/sale-history-access.ts` | The gate: forbidden-key scan, closed key allowlist, the RT-546 `admitSession` (reused, not duplicated), session re-check after every await, OD-534-1 ownership via RT-546 `admitSale`. |
| `src/main/sale-history/sale-history-credential.ts` | The credential by role, main-only: envelope (manager/admin) or device token + the session's own `admission_id` (cashier). |
| `src/main/sale-history/sale-history-client.ts` | The Backend-Core client; never logs or stores a credential. |
| `src/main/sale-history/sale-history-wire.ts` | Strict readers of the server answers; one off-contract field makes the answer unreadable. |
| `src/main/sale-history/sale-history-service.ts`, `-detail.ts`, `-cursor.ts`, `-local.ts` | List (server / local fallback), detail, cursor codec, local reads (bound SQL). |
| `src/main/sale-history/sale-history-reprint.ts`, `-slip.ts` | Server-authorized reprint, slip composition, `sale.history.reprinted` audit. |
| `src/main/receipts/receipts-bridge.ts` | `isSaleVoided`: no unmarked duplicate of a voided local sale. |

## 3. Controls

| # | Control | Evidence | Result |
| :-- | :-- | :-- | :-- |
| A4-1 | **Typed, constant channels; no generic invoke.** | The preload exposes three functions on `SALE_HISTORY_IPC_CHANNELS`. | PASS |
| A4-2 | **Main is the trust boundary.** | Every handler runs the RT-546 gate in main before any read or request. The renderer names no tenant, store, terminal, operator, credential, copy number or idempotency key: such keys are `invalid_request`. | PASS |
| A4-3 | **OD-534-1 role matrix, enforced in main as well as on the server.** | Manager/admin: envelope, `visibility` must be `store`. Cashier: device + own admission, `visibility` must be `own_sales` and every row's operator must be the cashier's own backend user, else the page is refused (fail closed). The detail of another operator's sale is the non-disclosing `sale_not_found`, audited `sale.access.refused` / `not_owner`. The local fallback and the unsent-sales merge use the RT-546 `ownerFilter`. | PASS |
| A4-4 | **OD-534-2 reprint authority.** | A cashier reprints only a sale the ownership check passed; manager/admin any visible sale. Every reprint is authorized by Backend-Core (`mode: authorize`) BEFORE printing; the POS prints only the sale, kind and marks the server returned. | PASS |
| A4-5 | **OD-534-3/8 fidelity.** | A duplicate needs `reprint.duplicate = allowed` and every receipt fact recorded (snapshot names, line sequence, tenders, change, header); a voided sale gets only a VOIDED sale record; a returned sale's slip is marked and lists its returns. `receipts.reprint` now refuses a voided local sale (`sale_voided`). | PASS |
| A4-6 | **Credential handling.** | The envelope and device token are read in main per request, passed as arguments, never logged, audited, stored or bridged. The envelope is never sent with `X-Cashier-Admission`. A cashier without an online admission holds no credential (no request). | PASS |
| A4-7 | **Session binding.** | The credential is resolved for the admitted session id; after every await the live session must be the admitted one (same id, operator, role, scope, unlocked), else `session_changed` and nothing is shown or printed. | PASS |
| A4-8 | **Untrusted server data.** | Strict readers (UUIDs, dates, enums, exact decimals → EGP minor units, no float); the answer must name the sale asked for; server text is stripped of control and bidi-override characters before printing. | PASS |
| A4-9 | **Cursor cannot widen access.** | The bridge cursor names its source; the server part must match the contract charset; visibility is re-applied by the server on every request and re-checked in main. | PASS |
| A4-10 | **Bounded work.** | 31 inclusive days, page size 1-100, at most 100 unsent sales shown on page one, one reprint per sale at a time, 15 s request timeout. | PASS |
| A4-11 | **No injection.** | Local reads use bound parameters only (including the `IN (...)` list). | PASS |
| A4-12 | **Honest coverage.** | Online pages say "received by the server up to"; offline says "this device only"; ERP state is labelled operational, not fiscal. | PASS |
| A4-13 | **Audit.** | OD-534-7: Backend-Core audits each detail read and reprint; the POS adds `sale.history.reprinted` (main-only category, in `MAIN_ONLY_AUDIT_CATEGORIES`) under the signed-in operator, with no secrets. | PASS |

## 4. Findings and their disposition

From the agent security review (opus) and the agent code review (sonnet) of `4b314e68`.

| Severity | Finding | Disposition |
| :-- | :-- | :-- |
| HIGH (H1) | `saleHistory.reprint` did not read this terminal's void journal: a sale with a live local void (pending / unknown) that the server did not know yet could print an unmarked duplicate from the local record (OD-534-8 B). | **Fixed.** `isSaleVoided` (`saleVoidReads.liveForSale`) is injected; a live local void refuses a duplicate and adds VOIDED to the sale record. Tests. |
| MEDIUM (M1) | Printed marks came only from the authorization: an authorization dropping `returned` / `voided` would print a slip weaker than the record. | **Fixed.** `sale-history-marks.ts`: the authorization must carry every mark the detail implies (void summary, `voided`, recorded returns, `returnState`), else nothing prints; the printed marks are the union with the local void; a duplicate is refused if any source says voided. Tests. |
| MEDIUM (M2) | No `record`-mode queue: a local `receipts.reprint` numbers copies locally (`countReprints + 1`) while a store-history reprint prints the server's `copyNumber`, so two slips of one sale can carry the same copy number, and local reprints are not in the server trail. | **Accepted for owner sign-off** (needs a local migration RT-542 does not authorize; follow-up). The contract already states a number can repeat across terminals and the server trail is the authority (Q-5). |
| MEDIUM (code review) | One off-contract money value blanked a whole page: return pricing yields amounts in 10⁻⁴. | **Fixed.** Display-only amounts (line tax, return totals and lines) are rounded half away from zero to the piastre; sale totals, line amounts, unit prices, tenders and change stay exact. Tests. |
| MEDIUM (code review) | "Today" was computed once at mount; a reprint result could land on another sale's detail; "more" could fire twice. | **Fixed.** Day read at click time; the detail is keyed by sale; an in-flight guard on "more". Tests. |
| LOW (L1) | Format characters (U+200E/200F/061C, zero-width, BOM) were not stripped; server text reached the renderer as is. | **Fixed.** The wire reader strips `\p{Cc}` and `\p{Cf}` from every shown string (screen and slip). Test. |
| LOW (L2) | Unbounded body and arrays. | **Fixed.** 2 MB body cap; lines ≤ 500, tenders ≤ 20, returns ≤ 100. Test. |
| LOW (L3) | A duplicate from server facts did not check that lines add up to the total. | **Fixed.** Fails closed. Test. |
| LOW (L4) | An authorized but unprintable slip was not audited. | **Fixed.** Audited `unprintable`. |
| LOW (L5) | The local record was printed without re-checking its seller against a cashier. | **Fixed.** `sale_not_found` (defence in depth). Test. |
| LOW (code review) | A 429 / 5xx on page one read as "no connection"; a refused local cursor offered a retry that could not work. | **Fixed.** `server_unavailable` offline reason and copy; the walk ends. Tests. |
| LOW (L6) | No reprint throttle beyond one-at-a-time per sale. | Accepted: every reprint is authorized and audited by Backend-Core; a rate policy is an owner decision. |
| LOW | A sale received by the server whose local ack was lost shows in both lists until the next sync. | Accepted: transient and labelled as unsent on this device. |

## 5. Out of scope, reported only

- `record`-mode reprints (a local reprint reported to Backend-Core after the fact) need a durable queue, which needs a local migration that RT-542 does not authorize. Local reprints stay audited locally only.
- A device-path 401 from these routes is not fed to the RT-215 device-revocation detector (the routes are shared with the envelope path, and tagging them would widen the detector's sources). The security review judged this LOW and acceptable: a 401 fails closed, and the sendable device-token read already returns null for a known-revoked device.
- `sale-void:lookup` and `returns:lookup` are not role-gated (RT-546 hand-over).

## 6. Sign-off

| Role | Name | Date | Decision |
| :-- | :-- | :-- | :-- |
