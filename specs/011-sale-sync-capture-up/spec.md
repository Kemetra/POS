# Feature Specification: Sale Sync (Capture-UP)

**Feature ID:** 011-sale-sync-capture-up
**Status:** Clarified (via /speckit-specify + /speckit-clarify 2026-06-07; 3 questions resolved; ready for /speckit-plan)
**Created:** 2026-06-07
**Last Updated:** 2026-06-07
**Owner:** (unassigned)

---

## Overview

Feature 011 implements the **capture-UP leg** of the sale-synchronisation pipeline: it drains the
append-only outbox that feature 008 stages on every finalized sale and pushes each sale fact UP to
the Data-Pulse-2 (DP2) backend via `POST /api/pos/v1/sales`.

The DP2 backend is the sole contract boundary. It receives the idempotent sale fact and is
responsible for onward posting to ERPNext through the Retail-Tower-ERP-Next-Connector. The terminal
**never** calls ERPNext directly and **never** constructs an invoice — it emits a sale fact only.

**Key design decision — AUTH DIVERGENCE:** sale capture requires an **operator session token**
(`PosOperatorAuthGuard`) on the DP2 side, not the device pairing token that 010's read-down leg
uses (`PosDeviceAuthGuard`). The terminal must present operator credentials on the POST, not the
device token. This is the headline design constraint and is the primary open question for ratification.

**Known v1 limitation — no tender in v1:** the `captureSale` contract carries **no tender/payment
fields** in v1 (gated to a future DP POS-payments spec). Sales sync without tender breakdown.
This is a conscious bounded-scope decision, called out as a known limitation.

**Deployment blocker:** the DP2 `sales.yaml` contract (`captureSale`, `recordVoid`,
`recordRefund`) exists and is implemented in the DP2 monorepo but is **NOT yet deployed** — the
live endpoint returns HTTP 521 as of 2026-06-07 (tracked in issue #349 / DP-015 G9 D-DEPLOY).
Feature 011 can be built and tested with a fake/stub HTTP client but cannot go live until that
deploy lands. All live-fetch wiring is gated on this deploy.

---

## Clarifications

### Session 2026-06-07

- Q: How does the main-process sync engine acquire and refresh the operator session token for `PosOperatorAuthGuard`? → A: The engine reads the operator token from feature 004's **main-process session store in-process** (no IPC copy, no renderer exposure); the drain pauses when no valid operator session is present and auto-resumes on the next successful operator sign-in / token rotation.
- Q: Do DP2 and downstream ERPNext (via the Connector) tolerate a captured sale with a non-zero total but no tender breakdown in v1? → A: **Assumed tolerated** — the sale fact carries totals and line items but no tender and no placeholder tender line. This rests on the `captureSale` contract having no tender fields; it is recorded as a **hard pre-implementation verification gate**: DP2 owners MUST confirm the no-tender sale is accepted end-to-end (capture + ERPNext outstanding-AR posting) before the live-fetch leg is wired.
- Q: Where does mutable sync/retry/dead-letter state live, given 008's `sale_sync_outbox` is enqueue-only (CHECK + UPDATE-refusing trigger, AD-3)? → A: 011 introduces a **companion `sale_sync_state` table** (owned by 011, joined on `sale_id`) for all mutable sync state; 008's `sale_sync_outbox` is read-only to 011 and its enqueue-only invariant is left intact (mirrors 010's `catalogue_sync_state` precedent).

---

## User Scenarios & Testing

### Primary User Story

As a pharmacy operator using the POS terminal offline or online, I want every finalized sale to
reach the backend reliably — even if the network was down when I completed the sale — so that the
pharmacy's sales records in the backend are always complete and no sale is silently lost.

### Acceptance Scenarios

**Given** a sale has been finalized and the outbox contains the staged event,
**When** the sync engine runs and the terminal has a live network connection and a valid operator session,
**Then** the sale is POSTed to `POST /api/pos/v1/sales` with an `Idempotency-Key` header derived
deterministically from the outbox row's `sale_id`, and on HTTP 200/201 the sale's sync state (in
011's own sync-state store — see Open Question 3) is marked `synced` and excluded from future drains.

**Given** a sale was finalized while the terminal was offline,
**When** network connectivity is restored and an operator session is present,
**Then** the sync engine drains all pending outbox entries in FIFO order, retrying with exponential
backoff on transient failures (5xx, network timeout), and no sale is lost or silently dropped.

**Given** the backend returns HTTP 409 (duplicate) for a sale that was already captured,
**When** the sync engine processes that outbox entry,
**Then** the entry is marked `synced` (idempotent success) without creating a duplicate record,
and the terminal does not retry that entry.

**Given** the backend returns HTTP 422 or 400 (permanent failure) for an outbox entry,
**When** the sync engine receives that response,
**Then** the entry is moved to a dead-letter state, an error is logged (no PII, no card data),
and the operator is surfaced a non-blocking notification that the entry requires attention.

**Given** the operator session has expired mid-drain,
**When** the sync engine attempts the next POST,
**Then** the drain pauses, the pending entries remain durable in the outbox, and the engine
resumes automatically once a fresh operator session is acquired (next operator sign-in).

### Edge Cases

- Outbox drain must be strictly FIFO per terminal to preserve ordering guarantees for the backend.
  **Superseded in part (RT-224 step 2):** the drain keeps FIFO **attempt order** (oldest due sale
  first), but it is not a barrier. A sale whose credential is not held right now is skipped
  untouched, so it does not block the sales queued behind it. Examples are a pre-RT-224 or
  manager sale waiting for an operator envelope, or a cashier sale whose cashier cannot be proven
  (held). Each sale is captured independently and idempotently per `externalId`, and Backend-Core
  imposes no cross-sale ordering. The per-sale retry backoff already reordered attempts before
  RT-224.
- A crashed or force-quit terminal between staging and sync must not lose the outbox entry — entries must be persisted in SQLite before the sync attempt, never only in memory.
- The `Idempotency-Key` and the payload's `externalId` field MUST be stable across restarts and retries for the same sale (derived deterministically from `sale_id`, never a fresh UUID at retry time), so the backend's `(tenant, sourceSystem, externalId)` dedup collapses retries to one record.
- The sync engine must not block the operator UI — draining runs in the main process out of band from the renderer interaction loop.
- No tender fields are sent in v1; the sale fact carries line items, totals, and identity fields only.

---

## Requirements

### Functional Requirements

**FR-1** The sync engine MUST read pending outbox entries written by feature 008 from the local SQLite database in FIFO (insertion-order) sequence and POST each to `POST /api/pos/v1/sales` (DP2 `captureSale` operation, `packages/contracts/openapi/pos-sales/sales.yaml`).

**FR-2** Every POST MUST include an `Idempotency-Key` header whose value is a stable, deterministic identifier derived from the outbox row's `sale_id`; the payload's `externalId` field MUST carry the same stable identifier; the same values MUST be used on all retry attempts for the same sale. (The backend dedups on `(tenant, sourceSystem, externalId)`.)

**FR-3** The sync engine MUST authenticate the POST with an **operator session token** (not the device pairing token), read from feature 004's main-process session store **in-process** — the token MUST NOT be copied to the renderer or sent across the bridge. If no valid operator session is present, the drain MUST pause and resume automatically on the next successful operator sign-in / token rotation.

**FR-4** On HTTP 200 or 201 response, the sale's row in 011's `sale_sync_state` table MUST be set to `synced` and excluded from future drain runs. No duplicate POSTs for an already-captured sale. (008's `sale_sync_outbox` row is never mutated.)

**FR-5** On HTTP 409 (conflict / already captured) response, the sale MUST be treated as idempotently synced (same outcome as FR-4). No retry; no duplicate.

**FR-6** On HTTP 5xx or network-timeout transient failure, the engine MUST retry with exponential backoff (configurable base interval, configurable max attempts). Retry state MUST be persisted so that a terminal restart does not reset the attempt counter.

**FR-7** On HTTP 4xx permanent failure (400, 422) the entry MUST be moved to a `dead_letter` state. A non-blocking notification MUST be surfaced to the operator. The entry MUST NOT be silently dropped.

**FR-8** All sync/retry/dead-letter state MUST be stored durably in the local SQLite database under WAL mode (in 011's own sync-state store — see Open Question 3 — since 008's `sale_sync_outbox` is enqueue-only and cannot be mutated). No sync progress may exist only in memory — durability before and across network attempts is mandatory (P3 no silent loss, P18 local durability).

**FR-9** The sale payload sent in v1 MUST NOT include tender or payment breakdown fields (those are gated to a future DP POS-payments spec). The payload includes line items, quantity, unit price (integer minor units), totals (integer minor units), sale timestamp, operator identity, and terminal/branch identity.

**FR-10** Money fields in the payload MUST be integer minor units. No floats anywhere in the pipeline.

**FR-11** The sync engine MUST run in the Electron main process, not the renderer. Renderer-visible status (pending count, last sync timestamp, dead-letter count) is exposed via the typed preload bridge only — no upward-of-bridge IPC.

**FR-12** PII and card data MUST NOT appear in logs at any log level. Logged fields are limited to sale ID, outbox entry ID, HTTP status code, error category, and retry count.

**FR-13** The sync engine MUST be injectable with a fake/stub HTTP client for testing, so that the full drain, retry, and dead-letter logic can be verified in Vitest without a live DP2 endpoint.

### Non-Functional Requirements

**NFR-1** The sync drain MUST NOT introduce perceptible latency on the operator UI; it runs as a background process in the main process event loop and yields between entries.

**NFR-2** Under normal online conditions a finalized sale MUST reach the backend within 30 seconds of finalization (target SLO; not enforced when offline).

**NFR-3** The engine MUST tolerate at least 1000 queued outbox entries without degrading SQLite read performance for 009's catalogue lookups (WAL isolation).

**NFR-4** Exponential backoff MUST cap at a configurable maximum interval (default 5 minutes) to avoid unbounded wait under sustained outage.

---

## Success Criteria

**SC-1** All finalized sales staged in the outbox by feature 008 are successfully POSTed to DP2 and marked `synced` in the happy path (online, valid operator session).

**SC-2** Sales finalized while offline are durably queued and are drained without loss once connectivity and an operator session are restored.

**SC-3** Idempotency holds: re-running the drain for an already-captured sale produces no duplicate on the backend and no error to the operator.

**SC-4** Transient failures trigger retried with backoff; permanent failures produce a dead-letter entry and a visible (non-blocking) operator notification — in both cases no sale is silently dropped.

**SC-5** Operator session expiry mid-drain causes a clean pause; the queue resumes automatically on re-login without manual intervention.

**SC-6** No tender/payment fields reach the backend in v1; the no-tender boundary is enforced at the serialisation layer and covered by tests.

**SC-7** Full drain + retry + dead-letter logic is covered by Vitest tests using a fake HTTP client; tests pass without a live DP2 endpoint.

**SC-8** No money float coercions exist in the payload-serialisation path; all monetary values are integer minor units end-to-end.

---

## Key Entities

| Entity | Description |
|:--|:--|
| `sale_sync_outbox` | Append-only SQLite table (owner: 008, migration 0024). One row per finalized sale (`UNIQUE(sale_id)`, FR-060). Real columns: `outbox_row_id`, `sale_id`, `envelope_handoff_action_id`, `tenant_id`, `branch_id`, `terminal_id`, `state`, `enqueued_at`. **It is ENQUEUE-ONLY (AD-3):** `state` has a `CHECK(state = 'pending')` constraint and a SQL trigger (migration 0024) that REFUSES any `UPDATE`. 011 therefore CANNOT write `synced`/`dead_letter`/`attempt_count` onto this table directly — see Open Question 3. The full sale payload is NOT stored here; 011 reconstructs the capture payload from the durable Sale record keyed by `sale_id`. |
| `SaleSyncEngine` | Main-process service responsible for draining the outbox. Injectable HTTP client for testing. |
| `CaptureSalePayload` | Typed DTO for the `POST /api/pos/v1/sales` request body. No tender fields in v1. Money fields are integer minor units. |
| `CaptureSaleResponse` | Typed DTO for the 200/201 response from DP2. |
| `SyncBridgeApi` | Preload bridge additions exposing a read-only sale-sync status surface (e.g. `sales:syncStatus` — pending count, last successful sync time, dead-letter count) to the renderer. Read-only; no upward-of-bridge IPC; the renderer never triggers or mutates the drain. |
| Operator session token | JWT or equivalent credential from feature 004's operator sign-in flow, required for `PosOperatorAuthGuard` on DP2. |

---

## Assumptions

1. Feature 008's `sale_sync_outbox` is stable, migration-safe, and **enqueue-only** (AD-3: `CHECK(state='pending')` + UPDATE-refusing trigger in migration 0024). 011 reads it but does NOT own and CANNOT mutate it; all mutable sync state lives in an 011-owned store (Open Question 3) via a new 011-owned migration.
2. The operator session token (feature 004) is accessible to the main process without crossing the bridge — it is held in main-process state, not renderer state.
3. DP2's `captureSale` deduplication on `(tenant, sourceSystem, externalId)` is reliable and consistent on the backend; the terminal can treat HTTP 409 as a success without re-reading the sale.
4. `sourceSystem` in the DP2 payload is a fixed constant identifying POS-Pulse (e.g., `"pos-pulse"`); it does not require dynamic configuration.
5. The WAL-mode SQLite instance is shared with 009 and 010; 011 must not acquire exclusive locks that block catalogue lookups.
6. The terminal has only one active operator session at a time (feature 004 constraint); multi-session concurrency is out of scope.
7. **(Clarified 2026-06-07)** The operator token is read in-process from 004's main-process session store; it is never copied to the renderer or sent across the bridge. The drain pauses without a valid session and resumes on next sign-in.
8. **(Clarified 2026-06-07)** All mutable sync/retry/dead-letter state lives in an 011-owned `sale_sync_state` table joined on `sale_id`; 008's `sale_sync_outbox` is read-only to 011 and its enqueue-only invariant (AD-3) is preserved.
9. **(Clarified 2026-06-07)** A no-tender sale is assumed accepted by DP2 + the Connector (outstanding-AR). This is a pre-implementation verification gate, not a settled backend fact — confirmation from DP2 owners is owed before the live leg is wired (see §Open Questions).

---

## Out of Scope

- **Tender/payment sync** — no tender or payment breakdown fields in v1. Gated to a future DP POS-payments spec.
- **Void and refund sync** (`recordVoid` / `recordRefund`) — these operations exist on the same DP2 `sales.yaml` contract but belong to **POS-014** (returns/voids). Mentioned here for awareness only.
- **ERPNext posting** — the Retail-Tower-ERP-Next-Connector handles DP2 → ERPNext translation server-side. The terminal emits a sale fact; it never constructs or posts an ERPNext POS Invoice.
- **Shift-close consolidation** — ERPNext's sales-invoice roll-up at shift close is a server-side responsibility of the Connector.
- **VAT/fiscal fields** — Egyptian VAT is deferred (008 §A5 caveat); 011 does not add VAT fields to the sync payload.
- **Returns/refunds UI** — out of scope for 011; handled by POS-014.
- **Automatic terminal re-pairing** — if the device token is invalid, that is a 002 concern; 011 only handles operator-session expiry.
- **Analytics or reporting** on sync state beyond the operator-visible pending/dead-letter counts.

---

## Dependencies

| Dependency | Status | Notes |
|:--|:--|:--|
| **DP2 `POST /api/pos/v1/sales` deployed** | **BLOCKER — HTTP 521 as of 2026-06-07** | Tracked in issue #349 / DP-015 G9 D-DEPLOY. Live wiring cannot land until this is deployed. Build and test with fake client in the interim. |
| Feature 008 — sale finalization + outbox | Complete (§A5 signed off, merged) | 008 stages the outbox event; 011 drains it. 011 does NOT own the outbox write path. |
| Feature 002 — terminal pairing / device identity | Complete | Provides `tenant_id`, `branch_id`, `terminal_id` for the payload. |
| Feature 004 — operator session | Complete | Provides the operator session token required for `PosOperatorAuthGuard` on DP2. |
| DP2 `sales.yaml` contract (`captureSale`) | Exists in DP2 monorepo, not deployed | Auth: `PosOperatorAuthGuard` (operator token — NOT device token). Idempotency-Key header required. No tender fields in v1. |

---

## Open Questions

All three original open questions were resolved in the 2026-06-07 clarification session (see
§Clarifications). The decisions are reflected in Functional Requirements, Assumptions, and Key
Entities. One **pre-implementation verification gate** carries forward (not an open design
question, an external confirmation owed):

- **[VERIFICATION GATE — not a design question]** DP2 owners MUST confirm, before the live-fetch
  leg is wired, that a no-tender sale (non-zero total, no tender breakdown, no placeholder) is
  accepted end-to-end — captured by `captureSale` AND posted by the Connector as an
  outstanding-AR Sales Invoice without rejection. This is gated alongside the deploy blocker
  (#349). If the backend in fact requires a placeholder, FR-9 and the payload shape must be
  revisited.
