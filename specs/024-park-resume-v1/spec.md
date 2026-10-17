# Contract Specification: Park / Resume v1 (same-terminal suspend)

**Feature ID:** 024-park-resume-v1
**Jira:** RT-439 (PK-1), Work Mode **Docs (contract-first)**. Decision source: RT-158.
**Status:** Contract — no implementation authorised by this document
**Created:** 2026-10-12
**Owner:** Owner (Ahmed Shaaban)
**Baseline:** `Kemetra/POS` `origin/main` = `3c931a0` (2026-10-12)

---

## 0. Authority and inputs

| Input | Role |
|---|---|
| RT-158 planning record, comment 10765 (K1–K6, contract §3, follow-ups §4) | The decisions this spec commits. **Owner-ratified 2026-10-12** (RT-158 comment 11722). |
| RT-158 description, reconciliation 2026-10-07 | Applied here: K4 shift-close rule keyed to the cash session; Pricing 605–608, 610 at resume. |
| RT-24 I-1, I-2, I-8, I-13 (`docs/design/vnext/08-rt24-invariants.md`) | Behaviour authority. Unchanged. |
| RT-116 contract (Confluence RETAIL 15663113) §3.1, §3.3, §5, §7 | Held-cart binding this spec reuses. Amended by §8 below. |
| RT-114 planning record (comment 10764, ratified 2026-10-12) | Manager approval for `recovery.cancel_held_cart`. Consumed, not designed. |
| RT-245 undo contract (Confluence RETAIL 24248322), RT-254 on `main` | Interaction in §6. |

Precedence follows `docs/design/vnext/15-vnext-freeze-package.md`: RT-24 and approved behaviour contracts, then owner decisions, then this spec.

**Not authorised here:** any code, migration, bridge change or UI. Those are PK-2 (main + bridge), PK-3 (VN-S11 UI) and PK-V (packaged verification); their texts are in RT-158 comment 10765 §4.

---

## 1. Dependency check against `main` (PK-1 acceptance)

PK-1 had to state whether the RT-116 S4 binding that K1 and K5 depend on exists on `main`.

**Verdict: met for what Park v1 needs.** Evidence on `origin/main@3c931a0`:

| RT-116 S4 element | On `main` | Where |
|---|---|---|
| Owner-key index `(tenant_id, branch_id, terminal_id, owning_operator_id) WHERE state <> 'cancelled'` | Yes, as migration **0046** (the contract named it 0037; that number was taken by RT-26) | `migrations/0046_carts_owner_key_index.sql`, RT-352 / #625 |
| Hold a draft cart on session end (`cart.held_on_session_end`), close an empty one | Yes, for `editing` / `discount_pending_attribution` | `src/main/cart/held-carts.ts` `holdOnSessionEnd` |
| Re-attach the newest held draft on admitted sign-in (`cart.reattached`) | Yes | `held-carts.ts` `reattachOnSignIn`, wired on `onStarted` |
| `operator.getResumeState()` | Yes (`payment_attempt_id` always `null` until S5) | `held-carts.ts` `getResumeState`, `src/main/ipc/resume-state.ts` |
| Frozen carts, zero-funds close, stuck attempt (S4 rows 3–4, S5) | **No** — RT-352 is "S4a" and deliberately leaves frozen carts alone | `held-carts.ts` header comment |
| Manager recovery `recovery.listHeld` / `recovery.cancelHeldCart` (S6) | **No**, and gated on RT-114 | — |

Park v1 parks only `editing` drafts (K2), so S4a is the binding it needs. The missing S5/S6 parts affect only the manager rows of K3 (§4.3), which stay gated.

Jira state: RT-352 is In Review (packaged evidence pending). No issue for RT-116 S3, S5 or S6 was found by text search on 2026-10-12.

**Next free migration number on `main`: 0047** (highest is `0046_carts_owner_key_index.sql`). PK-2 must re-check at execution time.

---

## 2. Decisions (K1–K6 as ratified, reconciliation applied)

### K1 — Pilot, as a minimal "Park v1"

- RT-24 §C.4 is **confirmed for the pilot**.
- Park v1 is **not a pilot-entry gate**. If PK-2/PK-3 slip past pilot readiness, Park v1 moves to post-pilot and does not block the pilot.
- Sequenced after RT-116 S4a (met, §1).

### K2 — What can be parked

**Parkable:** a cart in state `editing` with **at least one active line**, from the Sale screen.

| Not parkable | Why |
|---|---|
| `empty` | Nothing to park. |
| `discount_pending_attribution` | A manager approval is in flight. |
| `handing_off`, `frozen_handed_off` | The cashier goes **Back** to the sale first (RT-26, shipped). Only a cart that is back in `editing` can be parked. |
| any cart with a `started` payment attempt or live tender (RT-116 M7) | I-8, RT-116. A sale with money on it is never parked. |
| any cart already parked | Idempotent replay excepted (§3.1). |

**Limit:** at most **5 parked sales per terminal**, counted across all operators. The 6th is refused `park_limit_reached`. Stale parked sales count.

**Durability:** a parked sale is an ordinary durable cart row. It survives restart, sign-out, session end, lock and takeover.

**Label:** optional, plain text, at most **40 characters**. The UI warns against customer personal data. The label stays on this terminal; it is never written to any audit payload (§7) and never synced.

### K3 — Who may resume

- **Only the same operator**, by owner key, on the same terminal and store.
- A parked sale is never listed for, previewed by or resumed by another operator.
- **Managers** (gated, §4.3): see parked sales as a summary in `recovery.listHeld`, flagged `parked`; may cancel one with a reason through `recovery.cancel_held_cart` with an RT-114 approval; may **not** resume another operator's sale.
- Cross-operator transfer is post-pilot.

### K4 — Expiry, staleness, shift close

- **No automatic expiry or discard.** A parked sale leaves the list only by an explicit, audited action: its owner resumes it (and may then void it with the existing `cart.void`), or a manager cancels it through recovery (§4.3).
- **Revalidation on every resume.** `cart.previewResume` and `cart.resume` always compare the parked lines with the current local catalogue, whatever the age. This satisfies Pricing 605 ("Held carts use a Price Lock TTL"), 606 ("Old held carts require explicit price revalidation") and 607 ("Business-day boundary may trigger revalidation") in their strictest form: no price is ever carried across a park without a check.
- **Stale marker (display only).** A parked sale is shown `stale` when it is older than **12 h**, **or** it was parked on an earlier business day than today (Africa/Cairo calendar, the same rule as D-N1, RT-249 comment 11720). The marker changes nothing in the revalidation.
- **Repricing is explicit** (Pricing 608): the preview shows old price, new price and difference per line; nothing is applied until the cashier accepts.
- **Promotions are out of scope** (Pricing 610): resume revalidates price and availability only. It never re-evaluates or folds in promotion changes; that stays with the Offer Engine.
- **Shift close (reconciled).** The rule is keyed to the **cash session**, not the login operator ("Employee Work Shift ≠ Login Session ≠ Cash Session"). On `main` the cash session is the terminal's open shift (`shift_cashup_opens`, one per terminal). **Closing that shift is refused while any parked sale exists on the terminal, whoever parked it.** A parked cart has no physical cash effect, so it never changes expected cash; the refusal exists so no unpaid sale outlives the cash session unnoticed. The refusal reports how many parked sales block the close (a count only: no owner, label or amount). **Owner decision OP-2 (2026-10-12):** the refusal stays, and the manager cancel path (RT-116 S6, §4.3) must land before the pilot, so an abandoned parked sale can always be cleared.

### K5 — Reuse RT-116, no second mechanism

- **Binding:** the RT-116 §3.1 owner key, unchanged.
- **No new cart state.** The cart FSM keeps its states; RT-24 I-1's `PARKED` stays a derived concept.
- **Marker:** a cart is *parked* when `state = 'editing'` **and** `parked_at IS NOT NULL`.
- **Persistence (§A2, `[GATED]`, additive, no rebuild),** at the next free number (0047 today):
  - `ALTER TABLE carts ADD COLUMN parked_at TEXT NULL`
  - `ALTER TABLE carts ADD COLUMN park_label TEXT NULL CHECK (park_label IS NULL OR length(park_label) <= 40)`
  - `CREATE INDEX idx_carts_parked ON carts (tenant_id, branch_id, terminal_id, owning_operator_id) WHERE parked_at IS NOT NULL AND state = 'editing'`
  - a new append-only table **`cart_park_actions`** (R-7): `idempotency_key TEXT PRIMARY KEY`, `cart_id TEXT NOT NULL`, `action_kind TEXT NOT NULL CHECK (action_kind IN ('cart.park', 'cart.resume'))`, `request_hash TEXT NOT NULL`, `outcome_json TEXT NOT NULL`, `applied_at TEXT NOT NULL`, with no-update / no-delete triggers on the `cart_action_outbox` pattern. Additive: no rebuild of any existing table.
- **No `cart_action_outbox` rebuild** and no new outbox kind for park or resume. Park and resume are recorded in `audit_events` (K6).
- **Idempotency is durable** (R-7): every successful park and resume writes one `cart_park_actions` row in the same transaction, with a hash of the request and its outcome. A key is recognised for as long as the row exists, whatever actions follow. `carts.last_action_id` is still set to the key, which is what closes the Undo window (R-3), but it is **not** the idempotency record. A key already used for a different action kind, in `cart_park_actions` or in `cart_action_outbox`, is refused `idempotency_payload_mismatch`, as the cart bridge does today.
- **Exclusions on `main` that PK-2 must add** (all are read paths that would otherwise treat a parked cart as the operator's live or held draft):

  | Path on `main` | Change |
  |---|---|
  | `held-carts.ts` `ownerCarts` → `reattachOnSignIn` | exclude `parked_at IS NOT NULL`. Auto re-attach takes the newest **non-parked** held draft. |
  | `held-carts.ts` `sessionCarts` → `holdOnSessionEnd` | exclude parked carts: no `cart.held_on_session_end` audit, no change. |
  | `held-carts.ts` `currentDraft` and `otherHeldCount` → `getResumeState` | exclude parked carts. `other_held_cart_count` never counts parked sales. |
  | `cart-store.ts` `findDraftCartBySession` | exclude parked carts, so the session can start a new sale. |
  | every cart mutation (`cart.lines.*`, discount, note, handoff, void, undo) | refuse on a parked cart with `cart_parked`. A parked cart changes only through `cart.resume`. |

### K6 — Audit (local only)

Local `audit_events` rows only. Under RT-160 D-2 ordinary sale operations are not centralised. New categories (no CHECK on `action_category`, RT-116 M12, so no migration):

| Category | Payload |
|---|---|
| `cart.parked` | `cart_id`, `line_count`, `total_minor`, `has_label` (boolean). **Never the label text.** |
| `cart.resumed` | `cart_id`, `parked_for_ms`, `price_changes_accepted` (count), `removed_unavailable` (count), `current_cart` (`'none'` / `'parked'`) |
| `cart.park_refused` | `reason` (closed category only) |

Cancelling reuses existing paths: the owner uses `cart.void` (`cashier_voided`) after resume; a manager uses RT-116 `cart.held_cancelled_by_manager` (§4.3).

---

## 3. Bridge contract (§A4, for PK-2)

All four calls are **main-authoritative**. The renderer supplies ids and its choice; main derives owner, state, totals and prices from its own rows. All are on the locked-session refusal side of the RT-116 §2.5 allowlist (refused `session_locked`). All work offline: no backend call.

### 3.1 `cart.park({ cart_id, label?, idempotency_key })`

Main checks, in one SQLite transaction:

1. The session owns the cart: `cart.operator_session_id === session.id` (existing M4 check).
2. The cart is parkable (K2).
3. The terminal has fewer than 5 parked sales (K2).
4. `label`, if present, is plain text of 1–40 characters after trimming.

Then it sets `parked_at = now`, `park_label`, `last_action_id = idempotency_key`, `updated_at`, and writes `cart.parked`.

- Returns `{ kind: 'parked' }`.
- **The renderer clears the Sale screen only after this returns** (durable save, then clear — I-13).
- **Replay:** a key found in `cart_park_actions` with the same `request_hash` returns its recorded outcome and writes nothing, even after later actions on the cart. The same key with a different request is refused `idempotency_payload_mismatch`. A refusal writes no `cart_park_actions` row, so a retry is evaluated again.
- **Refusals:** `not_parkable`, `park_limit_reached`, `wrong_owner`, `session_locked`, `invalid_label`. Each writes `cart.park_refused` with the reason, except `session_locked` (central refusal, nothing reaches the handler).

### 3.2 `cart.listParked()`

Returns the **current operator's** parked sales on this terminal, newest first:

```
[{ cart_id, label, line_count, total_minor, parked_at, stale }]
```

`stale` follows K4. No other operator's sales, no line items.

### 3.3 `cart.previewResume({ cart_id })`

For a parked cart owned by the current operator, compares each active line with the local catalogue read model:

```
{ changes: [{ line_id, display_name, quantity, old_unit_minor, new_unit_minor }],
  unavailable: [{ line_id, display_name, quantity }],
  diff_token }
```

- **`display_name` and `quantity`** (RT-610, RT-471 OD-1, 2026-10-17) let the review name each product and show how many. Main reads both from the parked line itself (`cart_lines.display_name`, the add-time snapshot, and `cart_lines.quantity`); the renderer never supplies them. They are display only: they are not part of `diff_token` and not an input to `cart.resume`. No `item_ref`, no line or sale total, no owner or label. Bridge-security note: [`security-review/s-preview-resume-name-qty-review.md`](security-review/s-preview-resume-name-qty-review.md).

- A line is **unavailable** only when the catalogue repo answers **`not_found`** for its product: zero active matches against a populated, readable catalogue (`src/main/catalogue/product-repo.ts`, FR-24). An inactive product counts as not found for selling.
- When the repo answers **`unavailable`** (catalogue empty, missing or unreadable), no line is classified. The call is refused **`catalogue_unavailable`**, the same reason the catalogue bridge already uses. An infrastructure failure must never be read as "every product was removed".
- `diff_token` is a digest of `changes` + `unavailable`, by line id and unit prices only (the name and quantity are not in it). It is opaque to the renderer.
- Read only. Writes nothing.
- Refusals: `not_parked`, `wrong_owner`, `catalogue_unavailable`.

### 3.4 `cart.resume({ cart_id, accept_changes, diff_token, current_cart: 'park' | 'keep', idempotency_key })`

**If the current session already has a non-empty `editing` cart** (I-13 conflict, VN-R10):

- `current_cart: 'park'` parks the current cart in the same transaction, under the K2 rules and limit (I-13 primary: suspend current, resume selected). The limit is counted **after** the selected sale leaves the parked set, so a full terminal can still swap.
- `current_cart: 'keep'` refuses `current_cart_active` (I-13 secondary: keep the current sale, resume nothing).

An **`empty`** current cart is not a conflict. It is closed in the same transaction by the mechanism RT-352 already uses for a dead empty cart (`held-carts.ts` `closeEmpty`: cancel + outbox row, no audit), so the resumed cart is the session's only draft (see §5, R-6).

**Other refusals:**

| Refusal | When |
|---|---|
| `checkout_in_progress` | The current cart is `handing_off` / `frozen_handed_off`, or has a `started` attempt. |
| `price_changes_unaccepted` | The recomputed `diff_token` differs from the one supplied, or changes / unavailable lines exist and `accept_changes` is `false`. |
| `catalogue_unavailable` | The catalogue read model is empty, missing or unreadable when the diff is recomputed. Nothing changes; the sale stays parked. |
| `not_parked`, `wrong_owner`, `session_locked` | As named. |

**On success, in one transaction:**

1. Clear `parked_at` and `park_label`. Set `operator_session_id` to the current session and `last_action_id` to the key.
2. Re-price each changed line through the existing `cart.line.update` outbox kind.
3. **Soft-remove each unavailable line through the existing `cart.line.remove` outbox kind** (see §5, R-1). Only `not_found` lines qualify; a catalogue failure has already refused the call.
4. Write `cart.resumed`.

No merge of two carts and no overwrite, ever. Replay follows §3.1: the `cart_park_actions` row returns the first outcome, and a different request under the same key is refused `idempotency_payload_mismatch`. A `current_cart: 'park'` swap is one resume action with one row; it writes no separate park row.

---

## 4. Cross-cutting rules

### 4.1 Locked session

Every park call is refused `session_locked` by the central RT-116 §2.5 allowlist, which stays unchanged.

### 4.2 Offline

Everything is local and works offline. Repricing uses the local catalogue snapshot; a stale snapshot can hide a backend price change (010 freshness rule). That limit is accepted for v1 and stated in PK-3's UI as the catalogue freshness already shown.

### 4.3 Manager visibility and cancel (gated)

The manager rows of K3 exist only once **RT-116 S6** (`recovery.listHeld`, `recovery.cancelHeldCart`) and **RT-114 MA-2** (approval consumption) are on `main`. Until then:

- a manager cannot see or cancel another operator's parked sale;
- a parked sale is cleared only by its owner (resume, then void if wanted).

PK-2 ships without the manager rows. They are added in the S6 slice, which must flag parked carts in `listHeld` and accept them in `cancelHeldCart`.

### 4.4 Keys

F4 (park) and F3 (parked list) from RT-24 §C.5 stay **unbound** until D-K1 (RT-252) closes. PK-3 always provides visible buttons; any key binding is added later.

---

## 5. Resolutions made while committing the contract (owner review requested)

Committing K1–K6 against `main` surfaced points the planning record did not settle. Each is resolved in the narrowest way that adds no new state, column or contract, and is listed here so the owner can overturn it.

| # | Point | Resolution in this spec | Why |
|---|---|---|---|
| R-1 | The record's §3 says resume should *flag* unavailable lines so they block handoff, but K5 adds no column to hold a flag, and its K6 audit field is `removed_unavailable`. | On an **accepted** resume, unavailable lines are **soft-removed** with the existing `cart.line.remove` outbox kind. The preview lists them first, and nothing happens without `accept_changes: true`. | Matches the audit field, needs no column, and handoff on `main` does no availability check that a flag could feed. I-13 "availability changes shown and explicitly accepted" holds. |
| R-2 | RT-26 has shipped (Done), so the record's "until RT-26 ships, a handed-off cart cannot be parked" is out of date. | K2 now says: go Back (RT-26) first; only an `editing` cart parks. | No behaviour change. |
| R-3 | Undo (RT-245 / RT-254) is offered for the last action while the cart is editable. Park and resume both write `carts.last_action_id`. | **Park ends the Undo window, and resume does not reopen it.** No Undo is offered across a park. `undo-last.ts` already refuses when `cart.last_action_id` is not the target action, so this needs no code beyond a test. | Undoing a pre-park line after a resume would act on a cart the cashier has just reviewed and accepted. |
| R-4 | Pricing 607 (business-day boundary) and the fixed 12 h marker. | The `stale` marker is 12 h **or** an earlier Cairo business day; revalidation runs on every resume regardless (K4). | Strictest reading of 605–607 with no new configuration. |
| R-5 | Parked carts are bound to an `operator_session_id` that may end. | Parking leaves `operator_session_id` as it was; resume re-binds it. Session end, restart and re-attach skip parked carts (K5 table). | Matches the record's K5 and RT-352's mechanism. |
| R-6 | Resume while the session holds an `empty` cart. `findDraftCartBySession` returns the newest by `created_at`, so leaving the empty cart would hide the resumed one. | Close the empty cart in the resume transaction with RT-352's existing empty-cart close. No new cancellation reason, so no `carts` CHECK rebuild. | An empty cart has nothing to lose (RT-116 §3.3 row 1). |
| R-7 | Idempotency. The planning record used `carts.last_action_id` alone, but every later cart action overwrites it, so a delayed retry of an old `park(K)` would not be recognised and could park the active sale again (Codex review on #650). | An additive append-only `cart_park_actions` table records each park and resume key with its request hash and outcome (K5). It adds a table to the ratified K5 "two nullable columns", but still rebuilds nothing and adds no outbox kind. | The cart bridge's replay guarantee rests on a durable append-only record; park and resume need the same. |

## 6. Open points (need an owner decision before PK-2)

| # | Point | Recommendation |
|---|---|---|
| OP-1 | None of the RT-116 S3, S5, S6 slices has a Jira issue. Park's manager rows (§4.3) wait on S6. | Create the S6 issue after RT-114 MA-2; it is not blocking PK-2. |
| ~~OP-2~~ | **Shift close vs. abandoned parked sales.** Until §4.3's manager cancel exists, a parked sale whose owner never returns would block closing that terminal's shift indefinitely. | **Decided by the owner 2026-10-12: keep the refusal; RT-116 S6 must land before the pilot.** The warning alternative is rejected. Consequence: if Park v1 ships for the pilot, S6, and its dependencies RT-116 S5 and RT-114 MA-1/MA-2, are pilot-blocking with it. |

---

## 7. Audit and privacy

- No PIN, credential, PAN or customer data in any payload.
- The park label never leaves the `carts` row: not in audit, not in logs, not in sync.
- All payloads follow 004 FR-025 attribution and P11 redaction.

---

## 8. Amendment to the RT-116 contract (§3.1, §3.3)

This section is the RT-439 amendment of the RT-116 contract (Confluence RETAIL 15663113). Until the Confluence page carries it, this section governs where the two disagree.

**§3.1 (binding key and re-attach), added:**

> A **parked** cart (`state = 'editing'` and `parked_at IS NOT NULL`, spec 024) is never re-attached automatically. Re-attach on admitted sign-in takes the operator's newest held draft **that is not parked**. Parked carts are reachable only through `cart.listParked` / `cart.resume`. `operator.getResumeState()` excludes parked carts from `cart_id` and from `other_held_cart_count`.

**§3.3 (on any session end), added row:**

> | `editing`, parked (spec 024) | unchanged: stays parked, keeps its `operator_session_id`. **No** `cart.held_on_session_end` audit. |

**§7.1, corrected for `main`:** the S4 owner-key index shipped as migration **0046**, not 0037. Park v1's additive migration takes the next free number (0047 at the time of writing). The S6 `cancellation_reason` rebuild (named 0038 in the contract) also takes the next free number at execution.

---

## 9. Follow-ups (texts in RT-158 comment 10765 §4, not created)

| Id | Scope | Depends on | Gates |
|---|---|---|---|
| **PK-2** | main + bridge: migration (§K5, incl. `cart_park_actions`); `cart.park` / `listParked` / `previewResume` / `resume`; the K5 exclusions; `cart_parked` refusal on mutations; limit; audit; shift-close refusal with a blocking count (K4, OP-2) | PK-1 (this) | §A2, §A4 |
| **RT-116 S6** | manager recovery (RT-116 §5), including parked carts in `recovery.listHeld` and `recovery.cancelHeldCart` (§4.3) | RT-116 S5, RT-114 MA-1 + MA-2 | §A2, §A4; **before pilot** (OP-2) |
| **PK-3** | VN-S11 UI: `SuspendedSaleList`, park button, `ResumeConflictPanel` (VN-R10), stale badge, durable save then clear; Suspend visually distinct from Cancel and Void (I-2) | PK-2 | owner visual approval |
| **PK-V** | packaged verification: park → next customer → resume; 5 parked then a 6th; restart and sign-out with parked sales; price change between park and resume; another cashier cannot see them; (after S6) manager cancel | PK-3 | — |

PK-2 acceptance criteria (from the record, plus §5): a test for every refusal; a parked cart survives restart, sign-out and lock; it is never auto re-attached; never visible to or resumable by another operator; the 6th park is refused; a price change needs acceptance; an unavailable line is removed only on an accepted resume; a catalogue failure refuses preview and resume with `catalogue_unavailable` and removes nothing; a delayed retry of a park key after later cart actions replays and does not park again; no tender is touched; no Undo across a park.

## 10. Next safe action

OP-2 is decided. Create **PK-2**, and an issue for **RT-116 S6** so the pilot dependency is tracked.
