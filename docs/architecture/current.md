# POS-Pulse — Current Internal Architecture

**Status:** canonical. This document describes how POS-Pulse works *today*.

> **Authority.** This file is the authority for the current internal architecture of POS-Pulse.
> `specs/**` are feature-by-feature design records, many of them historical — they describe what a
> feature intended at the time it was written, not necessarily what runs now. When this document and
> a spec disagree about present behaviour, **this document wins**; open an issue for the drift.
>
> Scope boundaries:
> - [`synchronization.md`](./synchronization.md) owns the **cross-repo** boundary (POS ↔ Data-Pulse-2 ↔ Connector ↔ ERPNext).
> - [`../../specs/README.md`](../../specs/README.md) is the spec **status index** — which specs are active, implemented, deferred, or superseded.
> - This file owns everything **inside** the POS process.

---

## 1. What POS-Pulse is

An Electron desktop Point-of-Sale terminal for the SmartDataPulse pharmacy platform, packaged for
Windows 10/11 x64. It is **offline-first**: a cashier can ring and finalize a sale with no network,
and the results reconcile to the backend afterwards.

**Platform direction — load-bearing:**

```
POS-Pulse  →  Data-Pulse-2 (Backend)  →  ERPNext Connector  →  ERPNext
```

POS **never** integrates directly with ERPNext. It speaks only to Data-Pulse-2. Anything in POS that
looks like it holds central business authority is, on inspection, an HTTP client to that authority —
see `src/main/payments/voucher-authority-client/`, named to make exactly that point.

---

## 2. Process layout

Three processes, with a strict trust boundary between them.

| Process | Source | Trusted with |
|:--|:--|:--|
| **Main** | `src/main/` | SQLite, secrets, device token, all network I/O, all business writes |
| **Preload** | `src/preload/` | Nothing but the typed bridge surface |
| **Renderer** | `src/renderer/` | UI only. No Node, no direct DB, no direct network |

**Renderer isolation is non-negotiable** (Constitution III). Every `BrowserWindow` sets
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. These are
enforced in `src/main/app/bootstrap-window.ts` and guarded two ways: a runtime test asserting the
flags as passed to the constructor (`src/main/app/__tests__/bootstrap-window.test.ts`) and a
source-text guard (`src/tests/renderer-isolation.test.ts`).

The renderer reaches main **only** through the typed preload bridge declared in
`src/shared/bridge-api.ts`. There is no upward-of-bridge IPC.

### Trust boundary enforcement

- **Navigation allow-list** — `will-navigate` denies any URL outside the resolved renderer origin.
- **No pop-outs** — `setWindowOpenHandler` denies every new-window request.
- **CSP** — two layers: an HTML meta tag and Electron session response headers.
- **IPC sender guard** — `createSenderGuardedIpcMain` validates the sender origin on every channel.

The navigation allow-list and the IPC sender guard consume the **same** `resolveRendererOrigin()`
(single source of truth, #370), so the two checks cannot drift apart. This is why
`bootstrap-window.ts` takes the resolver as an injected dependency rather than owning a copy.

---

## 3. Composition root

`src/main/index.ts` is the composition root. It wires everything inside a single
`app.whenReady()` chain and owns no process-lifetime mutable state of its own.

Three lifecycle concerns are factored out into `src/main/app/`:

| Module | Owns |
|:--|:--|
| `bootstrap-window.ts` | BrowserWindow construction + the renderer trust boundary |
| `bootstrap-db.ts` | DB handle ownership and close mechanics (open/migrate stay at the root) |
| `bootstrap-workers.ts` | Background-worker teardown: stop order, failure isolation, idempotency |
| `single-instance.ts` | The one-process-per-terminal lock and the second-launch focus (RT-203) |

### Single instance per terminal — load-bearing

`index.ts` calls `app.requestSingleInstanceLock()` (through `acquireSingleInstance`) **before it
builds anything else**, and the whole `whenReady` boot chain hangs off that call's result. A second
launch does not get the lock: it calls `app.quit()` and never opens the database, runs migrations,
starts a worker, registers IPC, builds the printer or drawer ports, or creates a window. The running
instance gets a `second-instance` event and restores (if minimized) and focuses its tracked cashier
window. It does not pick from `BrowserWindow.getAllWindows()`, because the hidden offscreen
receipt-print window is a `BrowserWindow` too.

The lock is per user-data directory, which is where `pos-pulse.db` lives. So "one process per
terminal database" is what it guarantees. These main-process structures are process-local and are
correct **only because of this lock**:

| Structure | Process-local coordination |
|:--|:--|
| Sale sync (`sales-sync/sale-sync-engine.ts`) | in-memory single-flight drain |
| Catalogue read-down (`catalogue/read-down/read-down-driver.ts`) | in-memory single-flight tick |
| Finalize listener (`sales/finalize-listener.ts`) | in-memory single-flight tick |
| Payments deferred-reversal resolver | in-memory `running` flag |
| Returns resolver + dispatcher (`returns/`) | one pass per process; per-return in-flight map (and the returns payout serialization) |
| Drawer kick (`drawer/drawer-kick.ts`) | read-then-write double-kick guard (`UNIQUE(sale_id)` is only the backstop) |
| Receipt printing / drawer hardware | one owner of the device |

Do not remove or bypass the lock without replacing each of these with cross-process (database-level)
coordination. There is no dev or test override: nothing in the repo launches two instances on
purpose (`scripts/dev-electron.cjs` spawns one Electron), so dev runs take the lock too. The wiring is
pinned by the static guard `src/main/__tests__/bootstrap-single-instance.test.ts`; the packaged
Windows behaviour is a lab check.

### Shutdown ordering — load-bearing

Background workers **must** all stop before the DB handle closes, or a mid-flight tick can run
against a closed handle. `closeDbHandle()` preserves that sequencing:

```
updateServiceHandle?.stop() // the updater's scheduled check (RT-772)
workerRegistry.stopAll()   // finalize listener → read-down driver → sale-sync interval
dbHolder.close()           // only then
```

**Shutdown is re-entrant.** On a normal Windows exit the path runs twice (`window-all-closed` →
`app.quit()` → `quit`), and the startup `.catch` may run it before the DB was ever opened. Both the
worker registry and the DB holder are therefore idempotent: each stop callback and the handle close
fire exactly once, a throwing stopper is logged rather than propagated, and closing before opening is
a no-op. These are the two most likely silent regressions in this area and both are directly tested.

---

## 4. Local durability

- **Engine:** `better-sqlite3` in WAL mode, one shared handle for the process lifetime.
- **Migrations:** a custom transactional runner (`src/main/db/migrate.ts`) over numbered SQL files in
  `migrations/`. Applied at startup; a failure halts launch via `app.exit(1)` rather than running on a
  half-migrated database.
- **Roll-forward safety (RT-320, ADR-0006):**
  - **Database ahead of the build:** if `schema_migrations` names a migration this build does not ship, startup is refused with an operator dialog (`SchemaAheadError`, `src/main/app/startup-migrations.ts`). A newer build has migrated the DB.
  - **Pre-migration snapshot:** before the first pending migration on an already-migrated DB, a `VACUUM INTO` snapshot is written to `<userData>/backups/` (newest 3 kept). It is never restored automatically. If the snapshot fails, startup halts.
  - **Shipped migrations are immutable:** a migration file that has shipped in any signed release is never edited, renamed, renumbered or deleted. Corrections go in a new migration.
- **Updater (RT-772 slice 2, ADR-0006; `src/main/update/`):** `UpdateService` is main-process only,
  constructed in the composition root and started after the last IPC registration. It has no renderer
  surface and no UI install trigger.
  - **Guards, in order:** it does nothing unless this is the shipped app, `ELECTRON_UPDATE_FEED_URL`
    is set to an **https** origin, `POS_PULSE_UPDATE_CHANNEL` is a known channel (`lab`, `canary`,
    `stable`; unset means `stable`), and the build's `app-update.yml` pins a publisher. With no
    pinned publisher it reports `verify_unavailable` and never checks: electron-updater skips
    signature verification entirely when none is pinned, so the service never lets it start without one.
  - **Signature verification is ours, and fail-closed.** electron-updater 6.8.10's own Windows
    verifier resolves "valid" whenever its PowerShell check cannot run (old Windows, `ConvertTo-Json`
    unusable, a `Path` missing from the output), so the service installs its own
    (`signature-verifier.ts`) through `verifyUpdateCodeSignature` and reads it back; if the updater did
    not keep it, the service reports `verify_unavailable` and never checks. The verifier returns `null`
    only on positive proof: PowerShell exited cleanly with empty stderr, the output parsed, `Status` is
    exactly 0, the reported `Path` is the downloaded file, and the signer matches a pin (a bare pin
    equals the CN exactly; a full-DN pin needs every key). Anything else is a non-null result.
  - **PowerShell is launched defensively** (`powershell-signature-probe.ts`): the absolute Windows
    PowerShell path (no PATH lookup, no shell), fixed arguments, `PSModulePath` removed, a timeout, and
    the downloaded file passed only through the `POS_PULSE_VERIFY_FILE` environment variable (its name
    comes from the feed, so it never appears in the script text). The script is cmdlet-only. Known
    limits, both fail-closed: Constrained Language Mode or a locked-down policy may refuse the script,
    and a publisher name with non-ASCII characters may not round-trip through the console code page; in
    both cases the terminal shows `verify_unavailable` or `verify_failed` rather than installing.
  - **Roll-forward only:** `allowDowngrade` is forced false after the channel is set (the channel
    setter can flip it) and install-on-quit is off.
  - **Install only at a safe point:** one predicate (`SafePointGate`), true only with no open shift, no
    open cart, no unfinished payment (including a tender line still
    awaiting an external apply or reversal) or return, and no print in flight (counted at the print pipeline, so
    receipts, the cash return slip and sale-history reprints are all covered). An input that cannot be read
    blocks. It is evaluated at two triggers: the update finishing downloading before sign-in (app
    start), and a committed shift close.
  - **A shift close notifies the updater only when its own work is done.** The cashier's close
    notifies (`onShiftClosed`) once it is committed. A manager's forced close drains the shift outbox
    (bounded by `SHIFT_SYNC_DRAIN_TIMEOUT_MS`) and then answers its caller, so `ForcedCloseHandler`
    notifies (`onCloseDelivered`) only after that delivery attempt has finished (sent or queued), never
    during it and never for a refused close. Even then the evaluation is deferred by a short margin
    (`SHIFT_CLOSE_REPLY_MARGIN_MS`) so the answer reaches the renderer before an install quits the app;
    it is coalesced into one timer, cancelled on shutdown, and re-reads the gate when it fires (a
    shift opened meanwhile keeps the update pending).
  - **Failures are visible:** a signature or checksum failure is `verify_failed`, an inability to
    verify (our marker, or a PowerShell failure) is `verify_unavailable`, anything else is `error`. The
    marker is classified first, because electron-updater wraps any non-null verifier result as "not
    signed by the application owner". None installs. All state changes are logged as `update:state`.
  - **Provisioning (RT-322, owner decision 2026-10-21):** the origin and channel are read from the
    process environment only (`resolveUpdateConfig`): no file, registry reader or renderer setter. A
    terminal gets them as **Machine-scope** Windows environment variables set by an administrator
    (`ELECTRON_UPDATE_FEED_URL` https, `POS_PULSE_UPDATE_CHANNEL` `lab|canary|stable`) and a reboot,
    per [`pilot-terminal-provisioning.md`](../runbook/pilot-terminal-provisioning.md); User scope is
    a readiness-check failure. The RT-772 drill set them for one launch only, so the relaunch logged
    `update:disabled reason=no_origin`. The relaunch did not inherit per-launch values, so it
    evidently starts from a fresh environment; Machine scope is expected to survive it because a fresh
    environment includes Machine values. The RT-322 S-D lab drill is what proves it.
    Unset or empty origin disables the service quietly; a non-https origin or an unknown channel
    refuses it, and nothing is contacted.
- **Append-only tables** are enforced by SQLite triggers, not by convention.
- **Money is integer minor units everywhere.** No floats, guarded by `Number.isSafeInteger`.

### Sale finalization

Finalization is a **single atomic transaction** that re-checks idempotency *inside* the transaction,
so a replayed finalize cannot double-write. The Sale is durable before any receipt prints — printing
is dispatched afterwards and is explicitly *not* part of the transaction. An idempotent replay does
not re-print.

---

## 5. Network legs

Both legs are one-directional and go only to Data-Pulse-2.

| Leg | Direction | Driver |
|:--|:--|:--|
| **Catalogue read-down** | DP2 → POS | `src/main/catalogue/read-down/` — snapshot into the local read model |
| **Sale capture-up** | POS → DP2 | `src/main/sales-sync/` — drains the outbox and POSTs finalized sales |

**The enqueue/drain split is intentional.** `src/main/sync-outbox/` is written by 008's finalize
transaction (enqueue-only); `src/main/sales-sync/` is 011's drain engine. They are deliberately
separate: the writer must stay inside the finalize transaction while the drainer must not.

### Transport results

**A network fault must never silently degrade into a business refusal.** That invariant is what keeps
a POS terminal honest when the backend is unreachable. It holds across POS, but it is **not**
implemented by one shared mechanism — so read the table below as describing these three clients, not
as a rule about every outbound path.

For the three clients listed here the invariant is encoded as a **typed result union**: they never
reject, and they never surface a raw response body (P7). There is no single shared union; each models
the outcomes it actually has:

| Path | Result type | Members |
|:--|:--|:--|
| Catalogue read-down | `ReadDownFetchResult` | `ok` · `no_connection` · `failed` |
| Sale capture-up | `SaleSyncResult` | `ok` · `divergent` · `transient` · `permanent` · `no_connection` |
| Voucher authority client | `ValidateVoucherOutcome` / `RedeemVoucherOutcome` / `ReverseVoucherOutcome` | `validated` \| `redeemed` \| `reversed` · `refused` · `authority_unreachable` |

Read them as three expressions of the same invariant. Read-down separates *unreachable*
(`no_connection`) from *reached but failed* (`failed`). Sale-sync separates *unreachable* from a
backend-issued rejection, and additionally splits retryable (`transient`) from terminal
(`permanent`) and payload divergence (`divergent`) — the distinctions its retry policy needs.

The `refused` / `authority_unreachable` pair belongs specifically to the **authority-client**
interactions, where a refusal is a genuine business decision made by Data-Pulse-2 and must never be
manufactured locally from a connection failure. `refused` always carries a closed-set
`VoucherRefusalReason`; no free-text refusal crosses the bridge.

For sale-sync specifically: `transient` and `no_connection` back off and retry, and `permanent`
dead-letters rather than spinning. Idempotent replays are `ok`: Backend-Core answers a same-key
retry with 201 and a provenance replay with 200, both carrying the identical `Sale`. A capture 409
is never success (RT-190). Backend-Core sends it only as `idempotency_key_conflict`, meaning the
key or provenance was already used for a **different** payload. So `divergent` dead-letters the
sale with reason `payload_divergence` (`sale_sync_state.last_error_category`) and never retries
it. The sale is counted in the sync-status `deadLetter` and `payloadDivergence` counts and logged
as `sale_sync:payload_divergence` with only the `externalId` and a closed-set error code. A 409
with a malformed body or another code is treated the same way (fail closed).

A capture 425 `idempotency_in_progress` is never a rejection (RT-194). Backend-Core sends it,
with `Retry-After`, while an earlier request with the same Idempotency-Key is still in flight —
typically the till's own first attempt that hit the client timeout but is still committing. It is
`transient`: the sale stays pending, the next attempt waits at least `Retry-After` (seconds or
HTTP-date, clamped to 5 min; a missing or invalid header falls back to the backoff), and the retry
with the same key gets the 201/200 replay and its `saleRef`. A 429 rate limit is handled the same
way. There is no max-attempts cap, so a transient sale never dead-letters.

**Pairing is outside this table and uses a different transport API.** `src/main/pairing/network.ts`
throws a typed `TransportError` on a transport failure rather than returning a union member. It
upholds the same invariant by a different route — a `TransportError` explicitly means *the request
did not reach a usable response*, which the caller must not conflate with a backend failure envelope
— and it is built so the message and its `toJSON()` can never carry the pairing code, a token, or an
inner cause. So when adding an outbound client, check the API of the specific module you are calling;
do not assume a result union.

---

## 6. Identity and security

**Terminal identity ≠ user identity** (Constitution VIII), and they use different credentials:

| Credential | Scope | Used for |
|:--|:--|:--|
| Device token | The terminal | Catalogue read-down, sign-in attestation, cashier admissions, sale capture of a cashier's sale (with that sale's own cashier `operatorUserId`, RT-224) |
| Operator envelope | The signed-in operator | Sale-sync routes for a sale with no recorded cashier (manager/admin sales, sales finalized before RT-224) |
| Operator JWT | The provider identity | Sign-out, stuck-shifts, roster, takeover-confirm |

Secrets live in Electron `safeStorage` (DPAPI on Windows). **A production build refuses to start**
if `safeStorage` is unavailable — fail-closed, never a plaintext fallback.

Cashier PINs are hashed locally and never leave the main process. **PII and card data never appear in
logs**, enforced by pino redaction.

---

## 7. Feature flags

Flags are **fail-closed** — every one defaults to `false` (`src/renderer/stores/feature-flags-store.ts`):
`cart`, `payments`, `saleFinalization`, `productSearch`.

This matters when reading the UI: several cashier surfaces are **built and tested but gated off**.
A route rendering a reserved-slot placeholder does not mean the feature is missing — it usually means
the flag is off. `CheckoutRoute` is the clearest example: flag on → the live `PaymentSurface`; flag
off → `CheckoutPlaceholder`, a visual tender-slot reservation that preserves pre-006 behaviour so the
route is never blank.

---

## 8. Testing

Vitest only. CI (GitHub Actions, `windows-latest`) gates on **typecheck, lint, tests, and a package
dry-run**.

Two testing patterns are worth knowing before you change main-process wiring:

1. **`src/main/index.ts` cannot be imported under Vitest** — it calls `app.whenReady()` at module
   load. Its wiring is therefore covered by a *static source-text guard*
   (`src/main/__tests__/bootstrap-wires-operator.test.ts`) that regex-asserts import and call strings.
   **Moving code out of `index.ts` can red that guard even when behaviour is unchanged.** If you
   relocate something it asserts, repoint the guard — do not delete the assertion.
2. **Static guards exist outside `src/main/__tests__/` too.** `src/tests/renderer-isolation.test.ts`
   reads main-process source directly. Grep for `readFileSync` in tests before relocating
   security-relevant code.

---

## 9. Where to look first

| I want to… | Start at |
|:--|:--|
| Understand startup wiring | `src/main/index.ts`, then `src/main/app/` |
| Change the renderer trust boundary | `src/main/app/bootstrap-window.ts` |
| Add an IPC channel | `src/shared/bridge-api.ts`, then `src/main/ipc/` |
| Understand sale durability | `src/main/sales/finalize-transaction.ts` |
| Understand offline reconciliation | `src/main/sync-outbox/` (write), `src/main/sales-sync/` (drain) |
| Understand the cross-repo boundary | [`synchronization.md`](./synchronization.md) |
| Find out if a spec is current | [`../../specs/README.md`](../../specs/README.md) |
