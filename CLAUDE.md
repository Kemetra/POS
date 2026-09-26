<!-- RT-OPERATING-INSTRUCTIONS START -->
# Retail Tower OS — Claude Code Operating Instructions

You are working inside the Retail Tower OS multi-repository project.

Your role is an implementation and verification agent. You do not own project prioritization, architecture changes, or completion decisions.

**Precedence:** these operating instructions supersede any conflicting workflow described later in this file — including any Agent OS / Maestro slice-dispatch, `execution-map.yaml`/wave-status bootstrap, or "Execute slice X" workflow. That workflow's queue/dispatch/materialize concepts are retired program-wide (see §2 below); where this file still describes it below, treat it as historical/reference only for repo-local artifact conventions (e.g. spec folder layout), not as the active work-management model. The active unit of work is a Jira issue (`Execute RT-XX`), not a slice ID.

## 1. Management Model

Retail Tower uses the following authority model:

### GitHub `main`
GitHub remote `main` is the only technical source of truth.

Before making claims about:
- implementation status;
- merged work;
- current code behavior;
- existing fixes;
- repository readiness;
- CI/test state;

verify the relevant repository and remote state.

Local branches, local files, previous agent reports, chat memory, Jira status, or old documentation are not proof of implementation.

### Jira — Retail Tower / RT

Jira is the active work-management system.

A Jira issue is the normal unit of work.

Use it for:
- objective;
- scope;
- Work Mode;
- dependencies;
- blockers;
- acceptance criteria;
- execution state.

When instructed:

`Execute RT-XX`

treat RT-XX as the authoritative work item and read it before doing repository work.

### Confluence — RETAIL

Confluence contains durable project-level context:

- Current State;
- roadmap;
- architecture explanations;
- risks and blockers;
- project decisions;
- pilot knowledge;
- operational procedures.

Use it for context, not as proof that code exists.

### Orchestrator

`Kemetra/Orchestrator` is a versioned Technical Handbook only.

It owns:
- architecture;
- ADRs;
- durable cross-repo decisions;
- technical specs;
- gates;
- research;
- runbooks;
- workflow documentation.

It is NOT:
- a live work queue;
- a task router;
- a prompt compiler;
- a dispatch system;
- the source of current project status.

## 2. Retired Workflow

The former Dynamic Kernel workflow is retired.

Do NOT use or recreate:

- `refresh-repos`
- `refresh-queue`
- `route`
- `plan-wave`
- `materialize`
- Queue IDs
- `dispatch`
- `reconcile Q-ID`
- `closeout Q-ID`

Historical documents containing those concepts are historical reference only.

Do not convert Jira work back into the old queue/materialization model.

## 3. Current Repositories and Ownership

### `Kemetra/Orchestrator`

Technical Handbook only.

No production application code belongs here.

### `Kemetra/Backend-Core`

Backend and orchestration boundary.

Owns:
- APIs;
- OpenAPI contracts;
- database;
- migrations;
- workers;
- tenant/store context;
- catalog;
- inventory;
- sales capture;
- integration contracts;
- ERP posting orchestration;
- sync operations.

### `Kemetra/POS`

Windows cashier terminal.

Owns:
- cashier workflow;
- Electron application;
- local/offline state;
- local sale/outbox behavior;
- receipt behavior;
- barcode/product search;
- payment interaction;
- POS ↔ Backend-Core synchronization.

### `Kemetra/Admin-Console`

Admin/operator frontend.

Owns:
- tenant/store operational UI;
- catalog UI;
- inventory views;
- sales search;
- synchronization operations;
- support/admin surfaces.

Do not move backend business logic into Admin-Console.

### `Kemetra/ERPNext-Connector`

The only ERPNext/Frappe adapter.

Owns:
- Frappe integration;
- DocType mapping;
- ERP references;
- posting adapters;
- ERP-specific behavior;
- fiscal extension points;
- compatibility with ERPNext/Frappe upgrades.

## 4. Architecture Invariants

The normal integration path is:

`POS / Admin-Console -> Backend-Core -> ERPNext-Connector -> ERPNext / Frappe`

Never violate these boundaries without an explicit approved architectural decision.

Non-negotiable rules:

- POS must never call ERPNext/Frappe directly.
- Admin-Console must never call ERPNext/Frappe directly.
- Backend-Core is the contract and orchestration boundary.
- ERPNext-Connector is the only ERPNext/Frappe adapter.
- ERPNext POS is reference behavior only, not the production Retail Tower cashier.
- Do not fork ERPNext unless explicitly approved.
- Do not copy ERPNext core code into Retail Tower repositories.
- Prefer upgrade-safe Frappe extension mechanisms.

ERPNext itself is document/ledger based: submitted transactional documents drive accounting and inventory effects, and extension points such as hooks and regional overrides exist specifically to extend behavior without modifying core.

## 5. Catalog Authority

Retail Tower product authority is:

### Backend-Core Tenant Catalog
Retail/operational product authority.

### Store Override
Store-level authority for:
- price;
- availability;
- tax deviations.

### ERPNext Item
Accounting/posting identity.

ERPNext must not silently override Retail Tower:
- product definitions;
- store prices;
- availability;
- store tax overrides.

POS consumes only the resolved Backend-Core store catalog.

Admin-Console manages Retail Tower operational surfaces.

ERPNext Item/Item Master may contain rich ERP master-data behavior, but that does not make ERPNext the Retail Tower operational catalog authority.

## 6. Work Modes

Every Jira execution item should have one Work Mode.

### Planning

Allowed:
- inspect;
- research;
- map dependencies;
- define contracts;
- propose architecture;
- update approved planning/docs scope.

Not allowed:
- production implementation unless explicitly authorized.

### Verification

Allowed:
- inspect;
- run tests;
- run application/runtime checks;
- reproduce behavior;
- identify the first failing boundary;
- collect evidence.

Do NOT automatically fix a failure.

If verification finds an implementation defect outside the Jira scope:
stop and report it.

### Implementation

Implement only the bounded Jira scope.

Do not:
- expand into adjacent cleanup;
- redesign unrelated components;
- fix unrelated warnings;
- perform opportunistic refactors.

### Docs

The documentation itself is the deliverable.

Do not modify production code.

## 7. Required Pre-flight

Before repository work:

```bash
git status --short
git branch --show-current
git fetch origin
git checkout main
git pull --ff-only origin main
git log -1 --oneline
```

Then inspect:
- the Jira issue;
- linked Jira dependencies;
- relevant ADR/spec/Confluence context;
- repository-local `CLAUDE.md`;
- relevant code/tests.

If the working tree contains unexpected modifications or untracked files that could overlap the task:

STOP.

Do not overwrite, discard, stage, or modify them.

Report the conflict.

## 8. Scope Discipline

One execution task should normally be:

- one Jira issue;
- one primary repository;
- one bounded scope.

Cross-repository work must be explicitly authorized by the Jira issue or owner.

Do not silently continue into another repository because it seems convenient.

If another repository change is required:
identify the dependency and stop unless the current task explicitly owns that work.

## 9. Architecture and Contract Changes

Do not invent cross-repo contracts while implementing.

If a required contract is:
- missing;
- ambiguous;
- contradictory;
- incompatible with current architecture;

STOP and report the decision required.

Contract-first work must precede dependent consumer implementation.

Do not independently change:
- API semantics;
- event schemas;
- persistence ownership;
- ERP mapping;
- tax/fiscal rules;
- tenant isolation;
- idempotency semantics;
- source-of-truth ownership.

unless the Jira issue explicitly authorizes that decision.

## 10. Safety Rules

Unless explicitly authorized by the work item:

Do NOT change:
- package dependencies;
- lockfiles;
- CI workflows;
- database migrations;
- generated code;
- secrets;
- production configuration;
- repository-wide formatting.

Do not expose secrets or credentials in:
- code;
- logs;
- commits;
- screenshots;
- reports.

Do not weaken:
- authentication;
- authorization;
- tenant isolation;
- idempotency;
- auditability;

to make tests pass.

## 11. Git Rules

Never use:

```bash
git add -A
git add .
```

Stage only explicitly intended files.

Never stage unrelated untracked or modified files.

Do not commit unless explicitly requested.

Do not push unless explicitly requested.

Do not open a PR unless explicitly requested.

Do not merge a PR unless explicitly requested.

Never force-push unless the owner explicitly instructs it.

## 12. Testing

Run the narrowest relevant validation first.

Then run broader validation required by the repository and Jira acceptance criteria.

Do not claim a test passed unless it actually ran successfully.

Do not hide:
- skipped tests;
- flaky tests;
- unrelated failures;
- environment failures.

Differentiate clearly between:

- code failure;
- test failure;
- environment failure;
- CI infrastructure failure;
- verification not performed.

## 13. Definition of Done

You do NOT decide that a Jira issue is Done.

Your responsibility is to produce evidence.

For implementation work, evidence normally includes:

- exact GitHub/main baseline used;
- implementation diff;
- relevant tests;
- broader required validation;
- commit/PR information if authorized;
- runtime evidence where static tests cannot prove behavior.

A merged PR alone does not necessarily prove end-to-end behavior.

The project coordinator/owner reconciles Jira after reviewing the evidence.

## 14. Stop Conditions

STOP instead of improvising when:

- Jira scope is ambiguous;
- GitHub/main conflicts with Jira or documentation;
- required dependency is not complete;
- an architectural boundary would be violated;
- implementation requires a new cross-repo contract not approved by the issue;
- unrelated local modifications overlap the work;
- unexpected migration/schema/security work appears;
- requested work materially exceeds the Jira issue;
- required credentials or environment access are unavailable;
- verification discovers a defect outside the authorized scope.

Report the exact blocker and the smallest next safe action.

## 15. Final Report

At the end of every task, report:

### Baseline
- repository;
- branch;
- verified `origin/main` SHA.

### Work item
- Jira issue;
- Work Mode;
- objective.

### Changes
- files changed;
- concise explanation of each change.

### Validation
- tests/checks actually run;
- exact result.

### Evidence
- runtime evidence;
- GitHub/PR evidence where applicable.

### Risks / gaps
- unresolved issues;
- assumptions;
- anything not verified.

### Git state
- commit if created;
- PR if created;
- `git status --short`.

### Next safe action
Exactly one recommended next action.

Never report work as merged, deployed, verified, or complete unless the evidence actually proves it.
<!-- RT-OPERATING-INSTRUCTIONS END -->

# POS-Pulse — Agent Context

POS-Pulse is the desktop Point-of-Sale terminal for the SmartDataPulse pharmacy platform. It is
the POS surface of the platform, packaged as an Electron application targeting Windows 10/11 x64.

## Authoritative documents (read these first)

| Document | Purpose |
|:--|:--|
| `.specify/memory/constitution.md` | Project constitution (v1.3.0). Highest-priority document; principles, hardware matrix, platform integration, governance. |
| [`docs/architecture/current.md`](docs/architecture/current.md) | **Canonical current internal architecture.** How POS-Pulse works today. Read before changing main-process wiring. |
| [`docs/architecture/synchronization.md`](docs/architecture/synchronization.md) | The cross-repo boundary: POS ↔ Data-Pulse-2 ↔ Connector ↔ ERPNext. |
| [`specs/README.md`](specs/README.md) | Spec status index — which specs are Active / Implemented / Deferred / Superseded. `specs/**` are historical design records, **not** the authority for current behaviour. |
| `_reference/Data-Pulse/` | Read-only legacy reference. Gitignored. **Never copy-paste from here** (Constitution Principle IX). |

## Active feature

> ⚠️ **FEATURE SNAPSHOT (as of 2026-09-20, historical — for current work source see Jira RT): [`specs/022-pos-ui-v4-rescue`](specs/022-pos-ui-v4-rescue/) — POS UI v4.0 Rescue / Visual Convergence.**
> A **visual/UX** convergence onto the owner-approved light, clinical, pharmacy-teal direction. It
> exposes existing behaviour more clearly and adds **no** business capability (one scoped exception:
> the role-aware `/app` landing, FR-44).
>
> **Status as of this snapshot:** implementation landed for **US4a** (sale-success honesty), **US0** (visual foundation /
> tokens), **US1** (sign-in + role-aware landing) and **US2** (sale workspace, PR #447). Visual-
> acceptance captures remain outstanding across those slices — U2's is deferred to
> [#448](https://github.com/Kemetra/POS/issues/448). Snapshot-time next slice was US3 — Checkout /
> tender (`tasks.md` Phase 7); **current priority and next work item come from Jira RT, not this file.**
>
> **Supplementary visual authority:** the approved Claude Design handoff is vendored at
> [`specs/022-pos-ui-v4-rescue/design-handoff/`](specs/022-pos-ui-v4-rescue/design-handoff/).
> Read its [`RECONCILIATION.md`](specs/022-pos-ui-v4-rescue/design-handoff/RECONCILIATION.md)
> before using it — it is visual authority only and carries Saudi/ZATCA/15%-VAT/mada content that
> is **not** authorised for this Egyptian product.
>
> **The 010 / 011 blocks below are historical record**, retained for their implementation detail.
> They are no longer the active feature.

<!-- SPECKIT START -->
**017/019 arc CLOSED (2026-06-14).** The 2→1→3 unblock sequence is fully merged: Step 2 (POS-019 born-neutral provisioning + additive `user_id` column, migration `0035`, PR #398) → Step 1 (DP-2 034 cashier `user_id` on `PosRosterCashierEntry`, DP-2 #571/#573) → Step 3 (POS-017 PK re-anchor migration `0036`, PR #401, `d1b5778`). See the `017` entry in "Recently closed" for the full record.

**Next feature (planning):** [`specs/011-sale-sync-capture-up`](specs/011-sale-sync-capture-up/) — Sale Sync (Capture-UP). The capture-UP leg: a main-process engine drains 008's read-only enqueue-only `sale_sync_outbox`, reconstructs each sale's payload from the durable Sale (keyed by `sale_id`), and POSTs to DP2 `captureSale` (`POST /api/pos/v1/sales`). **`/speckit-specify` ✅ · `/speckit-clarify` ✅ (3 Q A/A/A) · `/speckit-plan` ✅ · `/speckit-tasks` ✅ (37) · `/speckit-analyze` ✅ (0 CRITICAL, 100% FR/SC)** — spec chain merged (PR #364). **Implementation: S1–S4 (buildable-now core) MERGED via TDD on `feat/011-sale-sync-impl`:** S1 migration `0034_create_sale_sync_state` (companion to 008's enqueue-only `sale_sync_outbox`, AD-3 preserved); S2 `sale-sync-state-repo` (incl. the outbox-LEFT-JOIN drain-eligibility query so freshly-enqueued sales aren't skipped) + `buildCapturePayload` (deterministic `externalId` from `envelope_handoff_action_id`, integer-minor money, NO tender) + `SaleSyncClient` DI seam; S3 `sale-sync-engine` (FIFO drain, single-flight, ok/duplicate→synced, transient/no_connection→backoff-retry, permanent→dead-letter, operator-session pause/resume — token read in-process, never bridged); S4 read-only `sales:syncStatus` IPC + preload + `SaleSyncStatus` UI (impeccable; 4 truthful states, absolute `<time>`). Gates §A2 + §A4 authored, self-assessed PASS (fast-tracked). **Full suite 5062 green.** **Remaining: S5 (live HTTP client `createSaleSyncClient` + composition-root wiring T060–T063) BLOCKED on #349 (backend HTTP 521); §A5 readiness incl. no-tender end-to-end verification.**

**Active feature:** [`specs/010-pos-catalog-read-down-consumption`](specs/010-pos-catalog-read-down-consumption/) — Catalog Read-Down Consumption. The catalogue-sourcing feature 009 named (009 AD-2/AD-3, R-RISK-2): read-down a full per-tenant/branch sellable-catalogue **snapshot** from the SmartDataPulse backend into 009's local SQLite read model (`products`/`product_barcodes`) so barcode/SKU lookup + Arabic/English search work over **real catalogue data, offline**. **Read direction only** (backend → local); out of scope (P16): sale sync, POS→backend writes, VAT/fiscal, inventory mutation, ERP, receipts, tender, reports/analytics, auto-update. **Implementation FUNCTIONALLY COMPLETE end-to-end — all read-down legs merged + live; only §A5 perf bring-up (target hardware) remains.** **`/speckit-specify` ✅** · **`/speckit-clarify` ✅** (2026-06-04; 7 Q resolved) · **`/speckit-plan` v1.1 ✅** (refreshed 2026-06-04 against shipped backend decisions, #350; see [plan.md](specs/010-pos-catalog-read-down-consumption/plan.md)) · **`/speckit-tasks` ✅** (46 tasks, test-first) · **`/speckit-analyze` ✅** (0 CRITICAL; 100% FR/SC coverage). Spec artifacts on **PR #342** (+ independent-review remediation `a065e73`). **Implementation: the offline S1+S2 correctness core MERGED (`5895eba`); the read-down driver + `catalogue:refresh`/`freshness` bridge + freshness UI + invariant guards + polish MERGED (PR #358, `946a013`); the `catalogue.*` IPC surface WIRED LIVE; the live-fetch HTTP client (`createReadDownClient`) + composition-root driver wiring (T020/T021/T039) MERGED (PRs #367/#368) once #349 cleared; `api-types.ts` re-pinned to the deployed read-down contract (T002, #349/PR #406); and the two T039 carry-forwards (post-commit freshness re-read + final §A4 `refresh` re-check → §A4 FULLY CLEARED) closed out (PR #408, see "Recently closed"). A paired terminal now performs the background read-down on app-start + hourly interval; `catalogue:refresh` admits a real tick. Full suite green (5228 tests). **T054 §A5 perf bring-up DONE 2026-06-15 — VERDICT PASS:** NFR-1 (≤0.45 ms p95) / NFR-2 (≤48 ms p95) pass comfortably; the read-down's ~20 s main-thread block (autocommit-per-row staging) was fixed by wrapping staging in one tx (#411/PR #412, ~20 s → ~3.6 s p50, 5.4×) and the residual ~3.6 s atomic block accepted for v1 (background non-session-gated pull; chunked R-RISK-2 declined for v1). **010 is functionally complete + perf-cleared; only rollout-time §A5 production-readiness (runbook/rollback, already authored) remains.**

**010 gate status:** **§A2** (migration-safety for the new staging/sync-state tables `0031`–`0033` + the promote transaction) — ✅ **RATIFIED 2026-06-05** (owner; `branch_id`/store scope = **`NOT NULL TEXT`**, the last held dimension — auth/scope landed via Data-Pulse-2 PR #490). Does NOT inherit 009's §A2; clears the offline S1+S2 correctness core. · **§A4** (P8 bridge-security for the new `catalogue:refresh`/`catalogue:freshness` channels) — ✅ **CLEARED** (2026-06-07; [`security-review/s4-review.md`](specs/010-pos-catalog-read-down-consumption/security-review/s4-review.md): pre-impl 13-control matrix §4 → post-impl walk §10 (13/13 PASS) → post-WIRING re-check §11 (AD-1/SEC-1/INP-1/P17-1 re-verified against the live `ipcMain` handler) → **final `refresh` re-check §12 (2026-06-15, PR #408): SEC-1/refresh-honesty/AD-1 re-verified against the WIRED driver path → §A4 FULLY CLEARED, no residuals**. · **§A5** (production readiness: runbook/rollback/failure-modes + perf bring-up incl. concurrent-lookup-during-promote) — ⏳ rollout-time. · **§A6** (backend catalogue-snapshot OpenAPI op + Constitution V generated types) — ✅ **CLEARED 2026-06-15** (D-DEPLOY done: DP-2 main deployed to the configured backend environment; `api-types.ts` re-pinned to the deployed read-down contract via #349/PR #406). Auth/contract decisions D-AUTH-1/2 **shipped** (Data-Pulse-2 PR #490, issue #488 closed); D-NAME + D-BARCODE **owner-ratified** for v1. Locked design decisions: stage-and-promote (transaction-wrapped `DELETE` live + `INSERT…SELECT` from staging, under WAL), full-snapshot replace, separate `catalogue_sync_state` store, skip-and-log + abort-threshold, paired-terminal background trigger + manual refresh (NOT operator-session-gated, Constitution VIII), timestamp-only freshness with an `is_empty` truthfulness discriminator. **Terminal auth (REVERSED, AD-7): the shipped backend authenticates the device pairing token directly via `Authorization: Bearer <device_token>` — NO operator JWT, and NOT `X-Terminal-Token` (a per-surface exception to the constitution §Auth mandate; #490's `PosDeviceAuthGuard` resolves `(tenant_id, store_id)` from the device row).** Single `name` → both 009 fold inputs (D-NAME, no Arabic split in v1); scanned codes match the untyped `aliases[]` bag (D-BARCODE, lossy — known limitation). Fold columns recomputed locally via 009's `normalize()`.

**010 slice status:** **S1 + S2 + S3 + S4 ALL MERGED + LIVE; catalogue IPC surface WIRED LIVE; only §A5 perf bring-up (hardware) remains.** Slice plan (from [plan.md](specs/010-pos-catalog-read-down-consumption/plan.md) §Phase 2): **S0 re-pin `api-types.ts` (T002, §A6) ✅ MERGED** (#349 / PR #406 — deployed read-down contract `/api/pos/v1/catalog/snapshot`+`/deltas`, stale `/catalog/products` dropped) → **S1 migrations `0031`–`0033` ✅ MERGED** (`5895eba`) → **S2 read-down writer + map + validate + sync-state repo ✅ MERGED** (`5895eba`) → **S3 HTTP client + driver wiring ✅ MERGED:** the driver (T037/T038, fake-client-injected) via PR #358; the **live HTTP client (T020/T021) + composition-root driver wiring (T039) via PRs #367/#368** (`Authorization: Bearer <device_token>` auth, paired-terminal-only, hourly interval, stop-on-quit) → **S4 bridge additions + freshness UI ✅ MERGED (PR #358 `946a013`)** — `catalogue:refresh`/`freshness` channels + handlers + preload + `CatalogueFreshness` (impeccable; three truthful states, absolute auditable timestamp), **registered with `ipcMain` and wired in `index.ts`** (the whole `catalogue.*` surface — incl. 009's lookups — was previously inert; now reachable). `productRepo.countByTenant` added for `is_empty`. **§A4 FULLY CLEARED** (final `refresh` re-check, PR #408 — see "Recently closed"). → S5 production readiness (§A5; runbook/rollback/failure-modes authored; perf bring-up T054 deferred — target hardware). **Also done:** T036 no-outbound-write, T018 redaction smoke; **the two T039 carry-forwards closed (PR #408):** the post-commit freshness re-read (one-shot, no-poll) + the final §A4 `refresh` re-check (5228 tests green). **T054 §A5 perf bring-up ✅ DONE 2026-06-15 — VERDICT PASS** (PR #410 harness + finding; #411/PR #412 fix: staging-in-one-tx, ~20 s → ~3.6 s @ 50k): NFR-1/NFR-2 pass comfortably; the ~3.6 s atomic read-down block accepted for v1 (background non-session-gated; chunked R-RISK-2 declined). **No open 010 engineering items remain** — only rollout-time §A5 production-readiness (runbook/rollback, authored).

**Recently closed:**
- **#360 / T039 010 read-down closeout — MERGED 2026-06-15 (PR #408, `338f617`).** **Key finding: #360 was already done.** The live read-down HTTP client (`createReadDownClient`) + composition-root driver wiring landed earlier in **PRs #367 (`d6bd40f`) + #368 (`5abe692`)** ("wire POS live legs to DP2 configured backend environment"); the GitHub issue text ("no read-down actually fetches yet") was **stale relative to the code** — verified before acting (files exist, typecheck clean, 71 read-down tests green), so no merged code was re-implemented. #408 closed the two genuinely-open carry-forwards: (1) **post-commit freshness re-read** (`CatalogueFreshness.tsx`, `POST_COMMIT_REREAD_DELAY_MS`=3s) — a ONE-SHOT bounded deferred re-read on `started` only, superseded by a later refresh, cancelled on unmount; **NOT a poll** (owner absolute-time/no-poll brief); best-effort (a large paginated promote can exceed 3s → stamp advances on the next natural read). **Contradiction guard** (review catch): the deferred read clears the in-flight `جارٍ التحديث…` feedback **iff the timestamp advanced** (promote landed), so a fresh stamp never shows beside "updating now"; if unchanged (slow promote) the feedback persists (still honest). (2) **§A4 final `refresh` re-check** ([`s4-review.md` §12](specs/010-pos-catalog-read-down-consumption/security-review/s4-review.md)): SEC-1 (device token reaches only the client, never the bridge response) + refresh-honesty (`started`/`already_running` only) + AD-1 (session gate first) all re-verified against the WIRED driver path → **§A4 FULLY CLEARED, no residuals**. Also corrected the now-stale `#349 NOT yet re-pinned` header comment in `read-down-client.ts` (the generated `SellableCatalogRow` matches the local mirror field-for-field; structural page validation retained on purpose — no generated `CatalogSnapshotPage` wrapper). 5 TDD tests; full suite 5228 green; CI green. **011 sale-capture reconciliation STAYS BLOCKED:** #349 re-pinned the **catalog** contract only — there are NO `pos/v1/sales`/`CaptureSale` types in `api-types.ts` (verified grep → 0); 011's wire-body is still validated against the live-smoke gate (PR #367 caveat).
- **#380 F-007 cash-sale settle fix — GUI smoke VERIFIED 2026-06-15.** The P0 fix (PR #403, `7853620`: real `terminal_id` via `PairingStore.getCurrentTerminalId` + `resolveSessionScope`, replacing the `terminal_id=branch_id` stamping that bricked the branch) was merged smoke-pending; this session ran the deciding GUI smoke and verified it end-to-end. **DB proof** (`payment_attempts`, read via Electron `better-sqlite3` — `sqlite3` not on PATH): the post-fix attempt (`190500a3`, `settled_at 2026-06-15T11:21:57`) carries `terminal_id=0556bfa4…` (the **real** terminal) + `state=settled`; pre-fix June-11 rows stamp `terminal_id=637af303…` = `branch_id` (F-007 visible in raw data, one stuck `state=started` forever) — the contrast is the proof. **The smoke was blocked for most of the session by a STALE configured backend environment**, not a POS bug: the fresh POS exe required the `user_id` operator-response field (POS arc 016/017/019; DP-2 033/034), but the droplet ran a 50-commits-behind DP-2 that omitted it → sign-in body rejected → misleading "Credentials not recognised". Updating the droplet then exposed a **real DI bug in DP-2 `main`** (`PosOperatorEnvelopeSaleGuard` used `import type` for `@UseGuards`-by-class-injected deps → erased NestJS metadata → API crash-loop). Fixed via TDD (DP-2 **PR #577**, merge `48f954f`: value imports + `@Inject(OPERATOR_CONTEXT_RESOLVER)`, + a hermetic `sales-module-wiring.spec` regression test closing the CI gap where `module-wiring.spec` never imported `SalesModule`); configured backend environment restored + reconciled to `main`. ⚠️ **DP-2 deploy-vs-source gap:** the running image has only the DI fix; the droplet checkout was reconciled forward to `main` which now carries `feat(035)` + **migration 0027** (unapplied) — the next droplet `git pull`+build ships 035 too, deploy it consciously.
- `specs/016-operator-envelope-adoption` — POS Adopts the Operator Envelope; Device Token Reverts to Device-Scoped (drift **D5+D7**). **Implementation MERGED 2026-06-13 (PR #384, `cfea4a5`).** Unblocked once **DP-2 D1 shipped** (PR #559/`202d253`, spec 031): sign-in/takeover RETURN an opaque `pos_operator` envelope; the three sale routes use the `operatorAuthorization` bearer scheme; `X-Device-Attestation` retired from the sale wire. POS now presents the **envelope** (not the Clerk JWT) on `POST /sales` (D5), and the device token reverts to a pure device-scoped role — read-down Bearer + sign-in attestation only (D7). **Two-credential seam (key design point):** DP-2 splits POS auth into `operatorAuthorization` (envelope, sale-sync routes) and `operator-identity` (provider JWT, for sign-out/stuck-shifts/roster/takeover-confirm) — so POS holds **both**: the JWT stays in `operatorJwtHolder`, a new `operatorEnvelopeHolder` holds the envelope (read only by the sale-sync path). Full speckit chain: `/speckit-plan` ✅ · `/speckit-tasks` ✅ (30) · `/speckit-analyze` ✅ (0 CRITICAL, 100% coverage — caught 2 silent-failure interpreter/takeover bugs pre-code) → TDD impl → **independent external security review** (all 7 sale-wire invariants confirmed; caught + fixed 1 HIGH credential-seam regression that would have 401'd sign-out/stuck-shifts, + 1 MEDIUM pino-redaction gap) → CI green. **§A4 bridge-security re-check** recorded ([`security-review/s-d5d7-review.md`](specs/016-operator-envelope-adoption/security-review/s-d5d7-review.md)). **Carried (non-blocking, owner):** the cashier-only-cannot-sync gap (E-3) persists under **OQ-CARRY** — the cashier PIN path is local-only (`backend_session_id: ''`, no backend call, no envelope acquisition point), so cashier-only terminals still cannot sync; does NOT affect the manager/admin path. OQ-9: no local refresh-token storage (v1 renewal via re-sign-in).
- `specs/017-offline-pin-reanchor` — POS Offline-PIN Re-Anchor off a DP-2 provider-neutral identifier (drift **D6**). **IMPLEMENTATION COMPLETE — MERGED 2026-06-14 (PR #401, `d1b5778`).** Migration `0036_reanchor_cashier_pin_records.sql`: canonical SQLite table-rebuild (`CREATE _new → INSERT…SELECT → DROP → RENAME → rebuild index`). New PK = `(tenant_id, branch_id, terminal_id, user_id)`, `user_id NOT NULL`. `cashier_clerk_user_id` demoted to a **nullable bridge column** (offline-unlock SELECT/UPDATE still key on it — renderer only has the Clerk id offline; `user_id` stays main-side per Constitution VII). PIN secret (`pin_hash`/`pin_salt`) never moves; `pin-credential.ts` untouched. A partial UNIQUE index on `(tenant,branch,terminal,cashier_clerk_user_id) WHERE cashier_clerk_user_id IS NOT NULL` restores the single-row-per-scope-clerk guarantee (security-review MEDIUM finding, fixed before merge). **OQ-D6-1 COLLAPSED** — 019's born-neutral provision handler is the sole writer, so no legacy clerk-only rows can exist; `0036` is a direct rebuild with no dual-key window. P8 security review PASSED ([`security-review/s-reanchor-review.md`](specs/017-offline-pin-reanchor/security-review/s-reanchor-review.md)); 11/11 migration+lookup tests green on `main`. **Remaining (non-blocking, rollout-time only):** T070 production-readiness (runbook/rollback/perf); §A4 bridge re-check = verified no-op (no new IPC channels); T060/T061 secret-free audit event = vacuous no-op (no row transitions at runtime). Full 2→1→3 arc: Step 2 (POS-019 born-neutral provisioning, PR #398) → Step 1 (DP-2 034 cashier `user_id` on roster, DP-2 #571/#573) → Step 3 (this). Speckit chain: `spec.md`/`plan.md`/`tasks.md` carry historical SUPERSEDED-IN-PART banners (PR #395); as-built design is the authoritative record.
- `specs/009-product-search-and-barcode-lookup` — Product Search & Barcode Lookup. Read-only catalogue search + barcode/SKU lookup over a local SQLite read model; confirm-first add into 005's cart via the R7 `resolveItemRef` seam; Arabic-first/RTL, offline-first. **Implementation complete; §A5 SIGNED OFF (caveated) 2026-06-01.** All tasks through T058 merged (S0–S5, #317–#338); §A0/§A1 ✅ 2026-05-30, §A2 ✅ 2026-05-31 (migrations `0029`/`0030`); T054 perf bring-up PASS on target hardware (LENOVO 82K2 / Ryzen 7 5800H, SHA `3461f00`: NFR-1 worst p95 0.160 ms ≤ 50; NFR-2 worst p95 15.170 ms ≤ 150; R-RISK-1/FTS5 not triggered — [`perf-bringup.md`](specs/009-product-search-and-barcode-lookup/perf-bringup.md)). **Caveat:** the manual legs of T050 (screenshot/contact-sheet) + T056 (packaged no-mouse walkthrough) are deferred/waived for the internal/dev surface — jsdom-automated coverage (T050 #330, T051 axe #331, T056 keyboard #333) stands in. **009 is 010's direct upstream:** 010 fills the empty `products`/`product_barcodes` tables 009 ships (009 R-RISK-2).
- `specs/008-sale-finalization-and-receipts` — Sale finalization & receipts. **Implementation complete; §A5 SIGNED OFF (caveated) 2026-05-30** (T529, PR #314). Gates §A0/§A1/§A3/§A4 cleared; §A2 = AD-12-locked no-op. **Rollout caveat (load-bearing):** the §A5 sign-off covers an **internal/dev MVP only** — Egyptian VAT is deferred (`total_tax_minor` hardcoded 0; receipts carry no tax line), so **customer-facing fiscal production use remains BLOCKED pending 008-v2**. Owner hardware target = printer-only / OS-print / BIXOLON SRP-330 II; cash-drawer/DK1 + ESC/POS deferred. See coordination.md + [`a5-verification-findings.md`](specs/008-sale-finalization-and-receipts/a5-verification-findings.md).
- `specs/007-pos-visual-system` — POS Visual System Recovery. Complete; all six slices (S0–S6) merged (PRs #109, #113–#118).

**Previous features (complete)**:
- `specs/001-foundation` — Foundation (Electron + Vite + TS + tests + CI).
- `specs/002-terminal-pairing` — Terminal pairing (device token, branch scope).
- `specs/003-pos-ui-shell` — POS UI shell (design tokens, navigation, role-indicator slot).
- `specs/004-operator-session` — Operator session (complete, §A1 + §A2 gates cleared).
- `specs/005-sales-cart` — Sales cart (complete through S4-b handoff core; owns the `resolveItemRef` seam 009 wires into).
- `specs/006-payments-tender` — Payments + tender (complete; §A5 signed off in PR #234 on 2026-05-26).

**005/006 UI gate:** UNBLOCKED — S1 + S2 + S3 merged with reviewer-ticked T060 criteria. 005 and 006 both consumed the gate; 006 is now closed.
<!-- SPECKIT END -->

## Spec Kit workflow

```
/speckit-specify   →  spec.md                (✅ complete for 001)
/speckit-clarify   →  resolve [NEEDS CLARIFICATION]   (n/a — none open)
/speckit-plan      →  plan.md + research.md + data-model.md + contracts/ + quickstart.md   (✅ complete for 001)
/speckit-tasks     →  tasks.md               (next)
/speckit-analyze   →  cross-artifact validation
/speckit-implement →  execute tasks
```

Trivial fixes (typos, log-message tweaks, dependency bumps) MAY skip the pipeline.

## Key technical decisions (locked)

- Stack: Electron 40 + React 19 + Vite 8 + TypeScript 5.6 (strict) + Tailwind 4.
- Local DB: `better-sqlite3` with a custom transactional migration runner.
- Secrets: Electron `safeStorage` (DPAPI on Windows). Production refuses to start without it.
- Money: integer minor units, `Number.isSafeInteger` guarded; ≥ 95% coverage on the module.
- Tests: Vitest only.
- Codegen: `openapi-typescript` v7 from a pinned snapshot in 001; live fetch later.
- CI: GitHub Actions on `windows-latest`. Gates: typecheck, lint, tests, package dry-run.

See `specs/001-foundation/research.md` for the full rationale on each.

## Hard rules (always in force)

These come from the constitution and are repeated here for quick agent reference:

- **No floats for money.** Money is integer minor units only.
- **`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`** on every BrowserWindow.
- **No upward-of-bridge IPC.** Renderer reaches the main process exclusively through the typed
  preload bridge defined in `src/shared/bridge-api.ts`.
- **No copy-paste from `_reference/Data-Pulse/`.** Re-derive instead.
- **Test-first.** Add the failing test before the implementation; tasks generated by
  `/speckit-tasks` make this explicit per-task.
- **PII / cards never in logs.**

## Useful commands

```bash
npm install                  # install deps
npm run dev                  # open empty Electron window
npm run codegen:api          # regenerate src/shared/api-types.ts
npm run codegen:verify       # CI helper: regen → diff
npm run typecheck            # both tsconfigs
npm run lint                 # eslint + prettier --check
npm test -- --coverage       # full vitest run
npm run package:dir          # electron-builder --win --dir (unsigned)
```
