# VN-S6 plan — a truthful connection and sync-status signal (RT-599)

> **Work Mode: Planning.** Jira **RT-599** (Epic RT-106). Docs only: no production code, tests or
> configuration. **Status: APPROVED by the owner on 2026-10-17. D-6-1 … D-6-11 are decided as
> recommended (§8).** Each slice in §9 becomes its own bounded Jira issue; no implementation starts
> without one.
>
> Baseline: `Kemetra/POS` `origin/main` = `d2bf51aeb0c3eb806a6fcc1e98c0670a1cdb6613` (RT-593 /
> #715), read on 2026-10-17. Every `file:line` below is at that commit.

## 0. Summary

- **There is no connection signal today.** The renderer's connection store starts at `'online'`
  and nothing real ever changes it. The only writer is the dev-only `?conn=` toggle. Main has no
  health check, no probe, no `net.isOnline()` and no `powerMonitor` (§1.4).
- **The sync data is real but hidden.** `sales:syncStatus` returns true counts, but nothing in
  the renderer calls it, so the `SaleSyncStatus` component is unmounted (§1.1). This is RT-159
  **N-04**: with the API stopped, no cashier surface showed offline or pending.
- **Proposal.** Add one main-process **terminal status signal**. It combines a reachability monitor
  with the sync counts that already exist, and reaches the renderer through one read channel and
  one push channel (§3). The V5 navigation's `StatusIndicator` and the consolidated `Banner` stack
  render it (§4). After that, the 007 `StatusBanner`, the renderer connection store and `?conn=` are
  retired (§6).
- **Stop-condition finding.** An honest signal can be built from existing traffic alone, but it
  cannot meet doc 15's S15 bar ("real API stop: indicator flips within 30 s") on an idle terminal.
  That bar needs an active probe of a Backend-Core liveness endpoint. Whether the POS API host
  serves one is **not confirmed** (§1.4, item 6). This is recorded as owner decision **D-6-1** and
  dependency **DEP-1**. The Backend-Core side is not designed here.

## 1. Inventory — what main knows today (scope item 1)

Legend: **T** = truthful today (read from a real event or DB row). **I** = inferred or incomplete:
it is real data, but it cannot answer the status question by itself. **F** = fabricated or absent.

### 1.1 Sale sync (011 engine, RT-190/221/224)

| Fact | Where | Class | Notes |
|---|---|---|---|
| Pending, dead-letter, payload-divergence and held-previous-pairing counts | `sale-sync-state-repo.ts:318-356` (`readSyncStatus`) | **T** | Counts from `sale_sync_state` |
| Last successful send | same, `MAX(synced_at)` `:337-340` | **T** | |
| Paused: `no_operator_credential` | `sale-sync-engine.ts:119`, `:534-541` | **T** | Read live from the credential holders |
| Per-row `last_error_category` (`transient`, `permanent`, `no_connection`, `device_unauthorized`), `last_attempt_at`, `next_retry_at`, `attempt_count` | `sale-sync-state-repo.ts:64-92` | **T** per row; **not exposed** | So "pending because offline" cannot be told apart from "pending, not tried yet" |
| `no_connection` as a reachability fact | `create-sale-sync-client.ts:590-592` (transport catch) | **I** | The same kind is also returned when no operator token is held (`:691-696`), when no device token is held (`:716`) and when the terminal changed mid-send (`:722-727`). A timeout is also `no_connection`. It is **not** a pure network signal |
| Envelope-path 401/403 | `create-sale-sync-client.ts:507` | **I** | Mapped to `transient`, so it looks like a server blip |
| Drain cadence | `index.ts:2259` (5 s `setInterval`) | **T** | The network is touched only when work is due. No tick on enqueue |
| `sales:syncStatus` IPC | `ipc/sales-sync.ts:30-35`; type `bridge-api.ts:887-907` | **T**, poll only | Registered only once paired (`index.ts:1962`, `:2246-2254`), so on an unpaired terminal the invoke rejects. Not on the locked allowlist (`session-lock-guard.ts:28-44`) |
| Renderer consumer | `ui/sales-sync/SaleSyncStatus.tsx` | **F** | Imported only by its own test. It reads once on mount, ignores `paused` and `heldPreviousPairing`, and imports a main-process type into the renderer (`:3`, `:37`) |

### 1.2 Catalogue read-down freshness (010)

| Fact | Where | Class | Notes |
|---|---|---|---|
| `last_success_at`, `is_empty` | `catalogue:freshness`, `bridge-api.ts:1665-1667` | **T** | Session-gated (`requireCatalogueSession`) |
| `last_attempt_at`, `last_outcome` | `catalogue-sync-state-repo.ts:36-43`, `:127-141` | **T**, not exposed | |
| Why a fetch failed | `read-down-driver.ts:100-111` | **I** | `no_connection`, `failed` and `device_unauthorized` all collapse to outcome `'failed'` before the DB |
| Cadence | `index.ts:1537` (hourly), plus one tick at start and on `catalogue:refresh` | **T** | Too sparse to serve as a reachability signal |
| Renderer | `sale/useCatalogueFreshness.ts` → `LiveProductRail` `FreshnessBar` | **T** | Absolute timestamp. Already shipped and **out of scope** for VN-S6 (R-H7 "exists") |

### 1.3 Shift and void outboxes

| Fact | Where | Class | Notes |
|---|---|---|---|
| Shift queue `{pending, waiting, blocked, envelopePending}`, `stranded` | `shiftCashup:status`, `shared/shift-cashup/types.ts:147-160` | **T** | Behind the `POS_PULSE_FEATURE_SHIFT_CASHUP` flag. Shown only on `V5ShiftManagerRoute`. The per-tick `ShiftDrainStop` report is discarded (`compose-shift-cashup.ts:162`) |
| Void journal `{state, waiting_for, needs_attention}` | `sale-void:list`, `shared/sale-void/types.ts:125-140` | **T** | Flag-gated. `SaleVoidNotice` polls every 15 s |
| Error class | `sale-void-client.ts:139`, `:167-175` | **I** | `no_connection` and `no_credential` are both "unknown" |

### 1.4 Backend reachability and device state

| Fact | Where | Class | Notes |
|---|---|---|---|
| Any health check, ping or probe to Backend-Core | — | **F** | None exists. `app:ping` (`ipc/ping.ts`) is an IPC round-trip only |
| `net.isOnline()`, `powerMonitor`, `navigator.onLine` | — | **F** | Not used |
| Transport-fault classification | every client's `catch` → `no_connection` | **I** | The error is not inspected. Only pairing separates `timeout` from `fetch_failed` (`pairing/network.ts:306-313`) |
| Observation seam for device-bearer answers | `device-auth-detector.ts:349-361` (`observedFetch`) | **T** for HTTP statuses | A transport failure is rethrown unreported, so it sees answers only and never "no connection" |
| Periodic device-bearer traffic | admission heartbeat at TTL/2 (`cashier-admission-keeper.ts:122-126`, only while a session holds an online admission); read-down hourly; drains only when work is due | **I** | No guaranteed traffic on an idle or signed-out terminal |
| Device revoked / unpaired | `PairingStatus` (`shared/pairing-types.ts:31-58`); RT-215 detector; push `pairing:status-changed` (`index.ts:1201-1205`) | **T** | Recovery routing already owns this. The detector's `suspect` state is not exposed |
| Roster source `online` / `offline` | `bridge-api.ts:469-474` | **T** at sign-in time only | A point-in-time fact, not a live signal |
| Backend health path | `src/shared/api-types.ts:5942-6037` (`/health`, `/health/live`, `/health/ready`, …) | **I** | The pinned snapshot looks like the platform API (FastAPI-style operation ids). It has no `/api/pos/v1/sales` and no admission paths. **Not confirmed** that the POS's configured base URL serves `/health/live`, nor what its auth and rate-limit terms are. No code calls it |

### 1.5 Renderer connection state today

- `connection/connection-state.ts:18-23`: a zustand store with the initial state `'online'` and a
  bare setter. Its own header calls `syncing` "visual-only".
- `V5Frame.tsx:52-62` (`useDevConnectionToggle`) is the only writer. It runs in dev builds only
  and reads `?conn=` (`connection/dev-toggles.ts:48-51`).
- `V5Frame.tsx:85-90` renders the 007 `StatusBanner` for any non-`online` state, with the legacy
  copy `CONNECTION_BANNER_MESSAGES` (`connection-state.ts:34-38`). That copy is not the frozen
  M-O\* copy.
- There is **no `StatusIndicator` component** in `src`. `V5OperationalNotices.tsx:56-57`
  deliberately leaves out the legacy «Online» pill.
- Printer and drawer failures reach the renderer through the 1 s poll `sales.subscribe({ topic:
  'banner_state' })` (`shared/sales/types.ts:157-160`). There is no device-status IPC, and the
  printer is not observable except through the result of its last real job.

**So:** in production the cashier sees **nothing** about connection or sync. That is honest
(nothing is shown as «متصل»), but it is silent, which is N-04. In dev, `?conn=` shows a banner
that no real event drives.

## 2. The signal (scope item 2) — proposal

### 2.1 Two axes, one snapshot

The signal is **two independent axes**, plus a device gate that already exists:

1. **Connection**: can this terminal reach Backend-Core now?
   `checking | online | degraded | offline`.
2. **Sync**: what local work is waiting, and does any of it need a human? Counts, oldest pending
   age, paused reason and attention.
3. **Device gate** (already exists): if `pairing` is not `paired` or the device is revoked, the
   pairing push routes to recovery. The signal reports `connection: 'checking'` and the frame
   shows no indicator. It never reports "offline" for a revoked device.

The cashier-facing composite (§4) is derived from the two axes in the renderer by a **pure
mapping function**. Main sends facts, not copy.

### 2.2 Connection states

| State | Meaning (main) | Entered when |
|---|---|---|
| `checking` | No evidence yet: app start, re-pair, or after resume from sleep | Initial. Also after `powerMonitor` `resume` |
| `online` | Backend-Core **answered** recently | A qualifying answer (§2.4) within the freshness window `W` |
| `degraded` | The host is reachable but Backend-Core is failing | HTTP 5xx / 502–504 / 521 / 429, or answers slower than the probe timeout, on `K` consecutive observations |
| `offline` | Backend-Core cannot be reached | `K` consecutive transport faults (DNS, TLS, refused, timeout), **or** `net.isOnline() === false` (fast path to offline only) |

### 2.3 Source of truth in main

A new main-process **`TerminalStatusMonitor`**. It is a pure state machine with an injected clock,
plus two feeders.

- **Passive feeder (no new contract).** An observation seam on the shared device-bearer and
  operator `fetch` paths, next to `observedFetch`. Unlike `observedFetch`, it reports **transport
  faults** as `transport_fault` instead of rethrowing them unseen. It classifies at the **transport
  level**, never from the result-union kinds, because the union's `no_connection` also means "no
  token held" (§1.1).
- **Active feeder (D-6-1).** A small probe that runs only when the passive feeder has seen nothing
  for `P` seconds. It never runs while a drain request is in flight. Its target is the owner
  decision D-6-1.
- **Sync aggregate.** It reads `readSyncStatus` plus two additions on existing data: the oldest
  pending age and the `paused` reason. The oldest age is the minimum **outbox enqueue time** over
  the pending set, because a freshly enqueued sale has no `sale_sync_state` row yet (the pending
  set is the outbox `LEFT JOIN sale_sync_state`). It reads on
  each engine tick that changed a row, and on monitor transitions. **No sync-engine behaviour
  changes** (RT-599 out of scope): this is a read.

### 2.4 What never counts as `online`

- The initial or default value. The store starts at `checking`, never `online`.
- `net.isOnline() === true`. The network interface being up proves nothing about Backend-Core.
- `app:ping`, the local DB, a cached roster, or a successful local finalize.
- **The absence of failures.** No traffic means the state ages to `checking` after `W`. It never
  stays `online` on inertia.
- An answer from an edge or proxy that is not Backend-Core: 502/503/504/521 is `degraded`.
- A `no_connection` result kind caused by a missing token, or by a terminal change mid-send.
- Any dev or test override in a production build (§6, D-6-8).

A qualifying answer is any HTTP response that Backend-Core itself produced. That is 2xx, or a
4xx that carries a Backend-Core error body (401/403/404/409/422). A 401 proves reachability; device
revocation stays the RT-215 detector's job.

### 2.5 Debounce and hysteresis (D-6-3)

The proposed defaults are tuned to doc 15 S15 ("flips within 30 s"):

| Parameter | Proposed | Why |
|---|---|---|
| Probe interval `P` while `online` and idle | 10 s | Bounds detection latency |
| Probe timeout | 4 s | The 15 s client timeouts are too slow to drive a status flip |
| `K` (consecutive bad observations to leave `online`) | 2, the second being a confirmation probe ~3 s after the first | One lost packet must not flash «غير متصل» |
| Worst-case online → offline | ≈ 10 + 4 + 3 + 4 = **21 s** | Inside 30 s with margin |
| Offline → online | 1 qualifying answer, then **hold for 5 s** before the indicator shows «متصل»; meanwhile a non-empty queue shows S16 | Avoids flapping on a bouncing link |
| Freshness window `W` | 3 × `P` = 30 s | No evidence for `W` → `checking` |
| Push coalescing | At most 1 push per second; counts only on change | Bridge budget (§3) |

## 3. Bridge contract (scope item 3) — PROPOSAL ONLY

Nothing here is implemented. The names follow the existing `pairing:status-changed` and
`session-state` push pattern (`preload/pairing-status.ts:30-50`).

### 3.1 Channels

| Channel | Kind | Request | Response / payload |
|---|---|---|---|
| `terminalStatus:get` | invoke | `{}` only; anything else gets `INVALID` (INP-1) | `TerminalStatusSnapshot` |
| `terminalStatus:changed` | push (main → renderer) | — | `TerminalStatusSnapshot` |

```ts
// src/shared/terminal-status/types.ts — PROPOSED
export type ConnectionStateCode = 'checking' | 'online' | 'degraded' | 'offline';

export interface TerminalStatusSnapshot {
  readonly v: 1;
  readonly connection: ConnectionStateCode;
  /** When `connection` last changed (ISO 8601 UTC). */
  readonly connectionSince: string;
  /** Last qualifying Backend-Core answer (ISO), or null if none since start. */
  readonly lastContactAt: string | null;
  readonly sync: {
    readonly pending: number;            // this terminal's unsent sales
    readonly heldPreviousPairing: number;
    readonly deadLetter: number;         // includes payload divergences
    readonly oldestPendingAt: string | null;
    readonly paused: 'no_operator_credential' | null;
    readonly lastSuccessAt: string | null;
  };
}
```

Bridge surface: `window.api.terminalStatus.get()` and `window.api.terminalStatus.onChanged(cb) →
unsubscribe`.

### 3.2 §A4 bridge-security notes

| # | Control | Proposal |
|---|---|---|
| A4-1 | Sender | Registered through the `guardedIpcMain` chain (`index.ts:760-772`), so `assertTrustedSender` applies. Push via `webContents.send` to the app windows only, as `pairing:status-changed` does |
| A4-2 | Input | The invoke accepts exactly `{}` (hand-written check, as in `ipc/shift-cashup.ts:231-233`). No parameters, so there is nothing to inject |
| A4-3 | Output, P7 / SEC-1 | Closed-set codes, non-negative integers and ISO timestamps only. **Never** a URL, host name, IP, error message, HTTP status, token, tenant/branch/terminal id, sale id or cashier identity |
| A4-4 | Preload | `parse()` checks every field against its closed set and type and drops unknown fields. The `IpcRendererEvent` is never forwarded. An invalid payload is dropped (no callback), never coerced to `online` |
| A4-5 | Availability | Registered at app start, **not** in `pairedWorkersLatch`, so an unpaired terminal gets `checking` instead of a rejected invoke (unlike `sales:syncStatus` today) |
| A4-6 | Session gating | **Not** session-gated: device-level health with no PII (Constitution VIII, as for read-down). **Not** on `LOCKED_ALLOWED_CHANNELS` (D-6-10); the lock screen shows nothing of it |
| A4-7 | Rate | Push coalesced to ≤ 1/s. The invoke is cheap (in-memory snapshot plus one indexed count query, cached for 1 s) |
| A4-8 | Logging | Transitions are logged as `terminal_status:transition {from,to}` with closed-set codes only (no PII rule) |
| A4-9 | Existing `sales:syncStatus` | Kept unchanged. It is additive, and manager diagnostics may still use it. Its consumer `SaleSyncStatus` is retired or re-pointed in S6-5 |

The implementing slice records an `s6-bridge-review.md` under `docs/security-review/` with the
pre-implementation matrix and a post-implementation walk, as 010/016 did.

## 4. States → UI (scope item 4)

### 4.1 Composite mapping (pure renderer function)

Evaluated top to bottom; the first match wins for the **banner**. The **indicator** always shows
connection and sync as separate rows.

| # | Condition | Indicator (nav footer) | Banner | Copy | Tone |
|---|---|---|---|---|---|
| U1 | Device not paired / revoked | hidden (recovery route owns the screen) | — | — | — |
| U2 | `deadLetter > 0` **or** oldest pending older than `N` h (D-6-5) | Sync: «تحتاج مراجعة» | **M-O3** «تعذّر إرسال ‹n› عمليات. راجع المدير.» | danger, persistent |
| U3 | `offline` or `degraded` (D-6-2) | Connection: «غير متصل». Sync: M-O2 if `pending > 0` | **M-O1** «غير متصل — البيع محفوظ على هذا الجهاز وسيُرسَل عند عودة الاتصال.» | warning, persistent |
| U4 | `online` and `pending > 0` and not `paused` | Connection: «متصل». Sync: S16 «جارٍ إرسال ‹n› عملية…» | none (quiet: pending is not actionable) | info |
| U5 | `online` and `pending > 0` and `paused` (D-6-6) | Connection: «متصل». Sync: **M-O2** «‹n› عمليات بانتظار الإرسال» | none | info |
| U6 | `online` and `pending = 0` | Connection: **M-O4** «متصل» | none | success (dot), quiet |
| U7 | `checking` | Connection: «جارٍ التحقق من الاتصال» (neutral, no dot colour) | none | neutral |

Rules: text plus icon, never colour alone. Counts and times are LTR-isolated with Western digits
(OD-3). `lastContactAt` is shown as an absolute time in the manager view only (R-H1). The `checking`
string is **new copy** that doc 15 does not contain, so it is part of D-6-2.

### 4.2 `StatusIndicator` (V5 navigation footer)

DESIGN.md §Navigation: "connection, sale sync and printer, each a dot plus text". The proposal:

- The connection row and the sync row come from §4.1.
- The printer row (D-6-7) appears **only while the existing `banner_state` feed reports a print
  failure** («فشل آخر إيصال»). Otherwise there is no printer row. `banner_state` carries failures
  only (`shared/sales/types.ts:157-160`), so a «طُبع» row would need a new read, and that is out
  of scope. It never shows «جاهز»: the printer is not observable (R-H3).
- In the slim rail (active sale) it collapses to dots with an accessible name. In the labelled
  panel it shows the text.
- `role="status"` with polite live updates only on a **connection** change. Count changes are
  not announced.

### 4.3 Banner consolidation (`V5OperationalNotices`)

One stack in the existing `notices` slot, using the V5 `Banner` (`v5/foundation/Banner.tsx`). The
proposed order, with danger first:

1. Sync attention (U2): danger. Manager-facing copy M-O3.
2. Shift closed (`ShiftClosedBanner`): existing.
3. Offline (U3): warning.
4. Printer failure, then drawer failure: existing, unchanged.
5. Shift notice, then void notice: existing, unchanged.

The connection banner **moves** from `V5Frame`'s 007 `StatusBanner` into this stack. The
DESIGN.md Never-Scrolled-Away rule still applies: in the 600–767 px band, a stack that would push
the money column out of view is covered by M-F3 (RT-312/RT-412), which is unchanged.

### 4.4 Doc 15 traceability

| Doc 15 item | Delivered by |
|---|---|
| S15 offline while selling: «غير متصل — البيع محفوظ على الجهاز», flips ≤ 30 s | U3 + §2.5 (needs D-6-1 = A for an idle terminal) |
| S16 reconnected / sync pending: «جارٍ إرسال N عملية…» → healthy | U4 → U6 |
| M-O1 … M-O4 | U3, U5, U2, U6 |
| X-2 "indicator from a real signal only" | §2.4 + the retirements in §6 |
| I3-Offline / I3-Syncing captures | S6-V (§5.2) |

## 5. Test and evidence plan (scope item 5)

### 5.1 Automated (each slice, test-first)

| Layer | Tests |
|---|---|
| Monitor | A fake clock drives every transition in §2.2. `K` = 2 is enforced. Hysteresis holds 5 s. `W` expiry → `checking`. `resume` → `checking`. `net.isOnline() === false` → `offline`, while `true` never yields `online` |
| Classification | A missing token, missing device token or terminal change never feeds `transport_fault`. 521/502/503/504/429 → `degraded`. A Backend-Core 401 counts as reachable |
| Sync aggregate | Oldest-pending age, `paused` and dead-letter counts against a seeded SQLite. No writes (a guard test on statements) |
| Bridge | Sender guard; `{}`-only; closed-set output; no extra fields; preload `parse()` drops malformed payloads; available while unpaired; not on the locked allowlist |
| Renderer | The §4.1 mapping table as a parametrised test. Indicator text for each row. The store's initial state is never `online`. A source-scope guard: nothing in `src/renderer` writes connection state except the bridge subscription |
| Strings | M-O1…M-O4 and S16 match doc 15 verbatim |
| Retirement | No import of `ui/primitives/StatusBanner`, `connection/connection-state` or `dev-toggles` remains (legacy class wall extended) |

### 5.2 Bench (packaged build, rt9 lab; procedure per the Confluence "Lab and Bench Runbook")

| # | Run | Pass condition |
|---|---|---|
| B1 | Signed-in cashier, idle; **stop the Backend-Core API** | Indicator «غير متصل» and M-O1 within 30 s. Main log timestamps the transition |
| B2 | While B1 holds, complete a cash sale | The sale completes. Pending = 1 in the indicator (M-O2). `sale_sync_state` row is `pending` |
| B3 | **Unplug the network cable** (or disable the NIC) mid-sale | Same as B1; `net.isOnline()` fast path observed in the log |
| B4 | Restore API / network | S16 «جارٍ إرسال 1 عملية…» → «متصل». The row becomes `synced`; `lastSuccessAt` advances |
| B5 | Edge up, origin down (521) or 5xx | Treated as offline for the cashier (D-6-2); `degraded` in the log |
| B6 | Restart the app while offline | Starts at «جارٍ التحقق من الاتصال», then «غير متصل». **Never** «متصل» at any frame |
| B7 | Revoke the device | Recovery route. The indicator never shows «غير متصل» for it |
| B8 | A dead-lettered sale (needs a backend that answers permanent 4xx; environment-dependent) | M-O3 danger banner. If the environment cannot produce it, **record it as not performed** |

Evidence: I3-Offline and I3-Syncing captures at 1024 and 1280; `sale_sync_state` reads before
and after; the main log transition lines. The implementing session records the procedure and the
gotchas on the Confluence runbook page (CLAUDE.md §7).

## 6. Retirements

| Item | Retired in | Condition |
|---|---|---|
| 007 `StatusBanner` in `V5Frame.tsx:85-90` | S6-5 | U3 is live in the stack. VN-S10 doc 23 §5.3 hands it over |
| `connection/connection-state.ts` store and `CONNECTION_BANNER_MESSAGES` | S6-5 | Replaced by the bridge-fed store |
| `?conn=` dev toggle (`V5Frame` `useDevConnectionToggle`, `dev-toggles.ts` `conn`) | S6-5 | Per D-6-8 |
| `ui/sales-sync/SaleSyncStatus.tsx` (unmounted) | S6-5 | Either deleted, or re-pointed at the new snapshot for manager diagnostics |
| `ui/tokens/connection-state.ts` four-state enum | S6-5 | Superseded by `ConnectionStateCode` |

Each deleting slice re-greps for consumers at its own baseline.

## 7. Dependencies

| ID | Dependency | Owner | Blocks |
|---|---|---|---|
| **DEP-1** | A Backend-Core **liveness endpoint** on the POS API host: confirm that it exists, its path, that it needs no auth or accepts the device bearer, and that its rate limits allow a 10 s probe per terminal. Only if D-6-1 = A | Backend-Core (cross-repo; **not designed here**) | S6-1b (the active probe) |
| DEP-2 | RT-113 offline cashier continuation | Done | — |
| DEP-3 | Doc 15 M-O\* copy (frozen) | Merged | — |
| DEP-4 | Bench access (rt9 lab, packaged build, ability to stop the API and pull the cable) | Owner / lab | S6-V |

## 8. Owner decisions

**Decided (owner, 2026-10-17): all eleven as recommended**, recorded on RT-599. In short:

- **D-6-1 = A**, in two steps: passive first (S6-1a), then the probe once DEP-1 is confirmed (S6-1b). C is rejected.
- **D-6-2 = a**, plus the new string «جارٍ التحقق من الاتصال».
- **D-6-3:** the §2.5 values, tuned after B1.
- **D-6-4 = a.**
- **D-6-5 = b**, with N = 24 h.
- **D-6-6 = a.**
- **D-6-7 = a.**
- **D-6-8 = a.**
- **D-6-9 = a.**
- **D-6-10 = a.**
- **D-6-11 = a.**

The table below keeps the options as proposed.

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **D-6-1** | Where reachability evidence comes from | **A.** Passive observation of existing traffic **plus** an active probe of a Backend-Core liveness endpoint (DEP-1). **B.** Passive only: no new contract, but an idle terminal ages to `checking` and the 30 s S15 bar is not met. **C.** Probe an existing device-bearer business route (for example catalogue deltas) | **A**, delivered in two steps: build B first (S6-1a, honest and shippable), then add the probe once DEP-1 is confirmed (S6-1b). **Reject C**: it uses a business contract for a purpose it was not designed for, has a cost, and could trip the RT-215 detector |
| **D-6-2** | `degraded` for the cashier | **a.** Show it as offline (M-O1). **b.** A separate cashier copy for "slow / server problem" | **a.** The cashier's action is the same (keep selling, the sale is safe), and doc 15 has no degraded copy. The distinction is kept in the log and the manager view. Also approve the one new string «جارٍ التحقق من الاتصال» for `checking` |
| **D-6-3** | Timing | The §2.5 defaults, or other values | **Approve §2.5** (P = 10 s, timeout 4 s, K = 2, 5 s hold, W = 30 s). Tune after B1 on the bench |
| **D-6-4** | What the sync count covers | **a.** Sales only. **b.** Sales + shift facts + voids | **a.** Shift and void already have their own notices; folding them in would double-signal and couple VN-S6 to two flag-gated features. Revisit when RT-17 is on for the pilot |
| **D-6-5** | Sync attention trigger | **a.** Dead-letter only. **b.** Dead-letter, or oldest pending older than `N` h (R-H6 / OB-28) | **b with N = 24 h** for the pilot. The backoff retries forever (`sale-sync-engine.ts:47-48`), so a day-old pending sale needs a human |
| **D-6-6** | A pending sale that cannot send because the session holds no sale credential (`paused`, RT-224) | **a.** Show M-O2 «بانتظار الإرسال», never S16 «جارٍ إرسال». **b.** Hide it | **a.** It is true and calm. Saying "sending" while paused would be false. The manager view names the reason |
| **D-6-7** | The printer row in the indicator | **a.** Show a row only while the last print failed (from `banner_state`); otherwise no row. **b.** Leave the printer out of the indicator (banner only). **c.** «جاهز» | **a.** It meets DESIGN.md as far as the truth allows, with no new read. **Reject c** (fabricated) |
| **D-6-8** | `?conn=` after retirement | **a.** Remove it; captures come from a real API stop. **b.** Move it to main as a dev-only fake feeder | **a.** X-2 asks for a real signal, and B1/B4 produce the captures honestly. Unit tests inject the monitor state directly |
| **D-6-9** | Should M-O1 list the "online only" actions (OB-02)? | **a.** Not in VN-S6; M-O1 as frozen, and each refused action explains itself inline. **b.** Add a list (new copy) | **a.** The list would be new copy and would change as RT-15/RT-17 land. Raise it as its own copy item later |
| **D-6-10** | Status read while the session is locked | **a.** Not allowlisted; the lock screen shows nothing of it. **b.** Allowlist it | **a.** VN-S8 shows nothing on the lock screen, and a read the screen does not use needs no exception |
| **D-6-11** | M-O3 wording versus DESIGN.md | DESIGN.md says a sync-attention banner "tells the cashier the sale is safe locally"; frozen M-O3 says «تعذّر إرسال ‹n› عمليات. راجع المدير.» **a.** Keep M-O3 as frozen. **b.** Amend M-O3 in doc 15 (a separate docs change) | **a** for VN-S6, because doc 15 is the frozen copy authority. If you prefer b, it is a one-line doc 15 change in its own PR, not part of this plan |

## 9. Bounded slice map (scope item 6)

Each slice is one Jira issue in `Kemetra/POS` unless noted. Implementation issues are created only
after owner approval.

| Slice | Work Mode | Depends on | Scope | Not in scope | Evidence |
|---|---|---|---|---|---|
| **S6-0** | Backend-Core issue (cross-repo) | D-6-1 = A | DEP-1: confirm or provide a liveness endpoint | Any POS change | Backend-Core's own evidence |
| **S6-1a** | Implementation (main) | D-6-1…6-6 | `TerminalStatusMonitor` (pure state machine) + transport observation seam + sync aggregate read (oldest pending, paused) + transition logging | Bridge, UI, sync-engine behaviour, active probe | Unit tests (§5.1 monitor, classification, aggregate) |
| **S6-1b** | Implementation (main) | S6-1a, S6-0 | Active liveness probe on the §2.5 cadence; `powerMonitor` resume → `checking` | Anything Backend-Core | Unit tests; log evidence against a stopped API |
| **S6-2** | Implementation (bridge) | S6-1a | `terminalStatus:get` / `terminalStatus:changed`, shared types, preload parse, `bridge-api.ts`, §A4 review doc | UI | Bridge tests (§5.1); `docs/security-review/…/s6-bridge-review.md` |
| **S6-3** | Implementation (UI) | S6-2, D-6-7 | `StatusIndicator` in the V5 nav footer, bridge-fed store, §4.1 mapping, S16 / M-O2 / M-O4 copy | Banners, retirements | Mapping and string tests; captures of the indicator at 1024 and 1280 |
| **S6-4** | Implementation (UI) | S6-3 | Offline and sync-attention banners in the `V5OperationalNotices` stack (§4.3), M-O1 / M-O3 | Printer, drawer, shift or void banner behaviour | Tests; captures of each banner |
| **S6-5** | Implementation (cleanup) | S6-4, D-6-8 | Retire the 007 `StatusBanner`, the renderer connection store, `?conn=`, the unmounted `SaleSyncStatus`, and the token enum (§6) | Other 007 primitives (VN-S10 / VN-S8) | Legacy class wall extended; grep evidence |
| **S6-V** | Verification | S6-1a … S6-5 (S6-1b for the 30 s bar) | Bench runs B1–B8 on a packaged build; I3-Offline and I3-Syncing captures; Confluence runbook entry | Fixing defects found (report them) | §5.2 |

The recommended first executable slice after approval is **S6-1a**. It needs no cross-repo
contract and makes the passive half of the signal real.

## 10. Evidence limits

- Inventory from source at `d2bf51a` only. No app run, no packaged build and no tests were run
  for this plan.
- The `/health/*` reading (§1.4) comes from the pinned OpenAPI snapshot. Whether the deployed POS
  API host serves those paths was **not verified**, which is why DEP-1 exists.
- The RT-159 N-04 observation is quoted from [14](14-rt159-packaged-reaudit.md), not repeated.
- The §2.5 timings are reasoned, not measured. B1 measures them.
