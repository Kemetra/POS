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

### Shutdown ordering — load-bearing

Background workers **must** all stop before the DB handle closes, or a mid-flight tick can run
against a closed handle. `closeDbHandle()` preserves that sequencing:

```
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
a POS terminal honest when the backend is unreachable, and every outbound path encodes it as a typed
union rather than an exception — none of these clients reject, and none surface a raw response body
(P7).

There is **no single shared union**; each path models the outcomes it actually has:

| Path | Result type | Members |
|:--|:--|:--|
| Catalogue read-down | `ReadDownFetchResult` | `ok` · `no_connection` · `failed` |
| Sale capture-up | `SaleSyncResult` | `ok` · `duplicate` · `transient` · `permanent` · `no_connection` |
| Voucher authority client | `ValidateVoucherOutcome` / `RedeemVoucherOutcome` / `ReverseVoucherOutcome` | `validated` \| `redeemed` \| `reversed` · `refused` · `authority_unreachable` |

Read them as three expressions of the same invariant. Read-down separates *unreachable*
(`no_connection`) from *reached but failed* (`failed`). Sale-sync separates *unreachable* from a
backend-issued rejection, and additionally splits retryable (`transient`) from terminal
(`permanent`) and idempotent-success (`duplicate`) — the distinctions its retry policy needs.

The `refused` / `authority_unreachable` pair belongs specifically to the **authority-client**
interactions, where a refusal is a genuine business decision made by Data-Pulse-2 and must never be
manufactured locally from a connection failure. `refused` always carries a closed-set
`VoucherRefusalReason`; no free-text refusal crosses the bridge.

For sale-sync specifically: `transient` and `no_connection` back off and retry, `permanent`
dead-letters rather than spinning, and `duplicate` is treated as success (the backend already has
the sale).

---

## 6. Identity and security

**Terminal identity ≠ user identity** (Constitution VIII), and they use different credentials:

| Credential | Scope | Used for |
|:--|:--|:--|
| Device token | The terminal | Catalogue read-down, sign-in attestation |
| Operator envelope | The signed-in operator | Sale-sync routes |
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
