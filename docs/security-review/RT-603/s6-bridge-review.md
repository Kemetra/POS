<!--
RT-603 (VN-S6 S6-2) — §A4 P8 bridge-security review for the terminal status
bridge: `terminalStatus:get` (new invoke) and `terminalStatus:changed` (new push).
Written with the implementation, before merge.
-->

# §A4 — P8 bridge-security review: `terminalStatus.*` (RT-603, VN-S6 S6-2)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-603 — VN-S6 S6-2, the terminal status bridge (get + changed push), preload, shared types |
| Plan | [`docs/design/vnext/24-vn-s6-connection-sync-signal.md`](../../design/vnext/24-vn-s6-connection-sync-signal.md) §3, §5.1, §9 S6-2; decisions D-6-1…D-6-11 approved on RT-599 (2026-10-17) |
| Gate | §A4 — P8 Electron security boundary (one new invoke, one new push) |
| Bridge surface | `api.terminalStatus.get()` over `terminalStatus:get`; `api.terminalStatus.onChanged(cb) → unsubscribe` over `terminalStatus:changed`. No other channel changes. |
| Builds on | RT-601 / PR #724 (`TerminalStatusMonitor`, sync aggregate); RT-602 / PR #729 (liveness probe, `powerMonitor`, `net.isOnline`) |
| Baseline | `origin/main` at `0367669` |
| Prepared by | The implementation agent (Claude Code), 2026-10-17. **Not an independent human review.** |
| Verdict | **Agent-assessed PASS** on A4-1…A4-9. Residual notes in §5. |

## 2. What the bridge does

Main already holds the two axes of the signal (RT-601/602): the connection monitor and the sale
sync aggregate. This slice exposes them to the renderer as one read-only snapshot. Main sends
facts, not copy; no UI is part of this slice (S6-3/S6-4).

| File | Role |
| :-- | :-- |
| `src/shared/terminal-status/types.ts` | Channel names, `ConnectionStateCode` (now the single source; the monitor re-exports it), the paused-reason closed set, `TerminalStatusSnapshot`, `TERMINAL_STATUS_INVALID`. |
| `src/main/terminal-status/terminal-status-publisher.ts` | Builds the snapshot from an allowlist; the device gate; the 1 s get cache; the 1 s refresh that pushes on change, at most once a second. |
| `src/main/ipc/terminal-status.ts` | `terminalStatus:get`: exactly `{}` → `read()`, anything else → `INVALID`. |
| `src/preload/terminal-status.ts` | `parseTerminalStatusSnapshot`, `get()`, `onChanged()`. |
| `src/shared/bridge-api.ts`, `src/preload/index.ts` | `TerminalStatusBridgeAPI` on `window.api.terminalStatus`. |
| `src/main/index.ts` | Registration at app start on `guardedIpcMain`; push to `BrowserWindow.getAllWindows()`; the sync reader bound in the paired sale-sync starter. |
| `src/main/app/bootstrap-workers.ts` | New stop slot `terminal status push`, after the sale-sync interval and before the DB closes. |

## 3. Pre-implementation matrix (doc 24 §3.2)

| # | Control | Required |
| :-- | :-- | :-- |
| A4-1 | Sender | Registered through the `guardedIpcMain` chain, so `assertTrustedSender` applies. Push via `webContents.send` to the app windows only, as `pairing:status-changed` does. |
| A4-2 | Input | The invoke accepts exactly `{}`; anything else gets `INVALID` and reaches nothing. |
| A4-3 | Output, P7 / SEC-1 | Closed-set codes, non-negative integers and ISO timestamps only. Never a URL, host, IP, error, HTTP status, token, tenant / branch / terminal id, sale id or cashier identity. |
| A4-4 | Preload | `parse()` checks every field against its closed set and type and drops unknown fields. The `IpcRendererEvent` is never forwarded. An invalid payload is dropped, never coerced to `online`. |
| A4-5 | Availability | Registered at app start, not in `pairedWorkersLatch`; an unpaired terminal gets `checking`, not a rejected invoke. |
| A4-6 | Session gating | Not session-gated. Not on `LOCKED_ALLOWED_CHANNELS` (D-6-10). |
| A4-7 | Rate | Push ≤ 1/s. The invoke is in-memory plus the sync read, cached for 1 s. |
| A4-8 | Logging | Transitions logged as `terminal_status:transition {from,to}` only. |
| A4-9 | `sales:syncStatus` | Kept unchanged. |

## 4. Post-implementation walk

| # | Evidence | Result |
| :-- | :-- | :-- |
| A4-1 | `registerTerminalStatusHandlers(guardedIpcMain, …)` in `index.ts`; the bootstrap guard test asserts the guarded instance. `ipc/__tests__/terminal-status.test.ts` registers through `createSenderGuardedIpcMain` and shows an untrusted frame rejected with `UntrustedSenderError` before the reader runs. The push loops `BrowserWindow.getAllWindows()` → `webContents.send(TERMINAL_STATUS_IPC_CHANNELS.CHANGED, …)`, the same target set as `pairing:status-changed`; the bootstrap test pins it. The bridge has no renderer → main push listener (`ipcMain.on`): nothing upward besides the one invoke. | PASS |
| A4-2 | `isEmptyObject`: a plain object (prototype `Object.prototype` or null) with zero own keys (`Reflect.ownKeys`, so a `__proto__` own key is caught), and exactly one argument. Tested: no argument, `undefined`, `null`, a string, a number, an array, a key, a `__proto__` key, a `Date`, and `{}` plus a second argument — each returns `{ kind: 'refused', reason: 'invalid_input' }` and the reader is never called. The preload always sends `{}`. | PASS |
| A4-3 | `buildSnapshot` / `toSync` copy named fields only; a test feeds a sync source carrying `terminalId` and `url`, and a connection source carrying `host` and `error`, and asserts the exact key sets and that none of the values appear. A recursive leaf check asserts every string is a connection code, a paused reason or an ISO time, and every number a non-negative safe integer. The sync source is the RT-601 aggregate (counts, ISO times, one closed-set code); no id reaches it. | PASS |
| A4-4 | `parseTerminalStatusSnapshot` rebuilds the object from known fields: `v === 1`; `connection` in the four codes; times must round-trip `Date#toISOString` (UTC, ms; an offset or impossible date fails); counts are non-negative safe integers; `paused` is null or in the closed set. Twenty-one malformed shapes are each dropped by `onChanged` (no callback) and make `get()` reject with the fixed `terminal_status_unavailable`; the `INVALID` refusal also rejects. Unknown fields at both levels are dropped. The callback receives `(snapshot)` only; the fake event's `sender` is never passed. | PASS |
| A4-5 | Registration sits at app start, before the first `pairedWorkersLatch.register(` (bootstrap test). Device gate: `getCurrentTerminalId() === null` or `isDeviceRevoked()` → `connection: 'checking'` whatever the monitor says (tested for `online`, `offline`, `degraded`), so a revoked device never reads `offline` (§2.1). With no sync reader bound (unpaired, or the sale-finalization starter not run) the sync axis is zero counts and null times. `connectionSince` under the gate is when the gate was first seen closed; after it opens it is never earlier than that change. A throwing gate read keeps the last known gate, else fails closed to `checking` (tested). | PASS |
| A4-6 | The handler checks no session. Not added to `LOCKED_ALLOWED_CHANNELS`; a test asserts both channel names are absent and that a locked session gets `SessionLockedError` before the reader runs, while an unlocked one with no session is answered. | PASS |
| A4-7 | `read()`: connection in memory every call; sync aggregate reused up to 1 s, concurrent reads share one query (tested). Refresh every 1 s: sync re-read every 5 s, or at once on a connection-code change (tested). A push only when the serialised snapshot differs from the last push, and only if ≥ 1 s (monotonic) since it; a held change is delivered on the next refresh. A 600-step busy test asserts no two pushes are closer than 1 s. The timer is `unref`ed and stopped in the worker registry before the DB closes; `stop` also unbinds the sync reader so a late invoke never reads a closed DB. | PASS |
| A4-8 | Transition logging is unchanged from RT-601 (`{ from, to }` only). The bridge adds one log line, `terminal_status:sync_read_failed` with an empty object, once per run of failures; a test asserts the error text (`SQLITE_BUSY: /secret/path.db`) appears nowhere in the log call. A throwing `send` is swallowed silently; in `index.ts` each window is sent to independently (destroyed ones skipped), so a closing window cannot starve the others. The timer catches a failed refresh, so it is never an unhandled rejection (tested). | PASS |
| A4-9 | `src/main/ipc/sales-sync.ts`, `sale-sync-status-reader.ts`, the `sales:syncStatus` preload and its tests are untouched by this diff. | PASS |

## 5. Residual notes

- **Pushes continue while locked.** D-6-10 keeps `terminalStatus:get` off the locked allowlist,
  and the lock screen shows nothing of it. The main → renderer push is not an IPC handler, so the
  lock guard does not apply to it; it keeps flowing while locked. The payload is device-level with
  no PII. The renderer (S6-3) should not render it on the lock screen. Raise it if the push must
  also stop while locked.
- **`invalid` pairing statuses other than revoked.** The gate uses the synchronous
  `getCurrentTerminalId()` / `isDeviceRevoked()` reads, not the async `getStatus()` (which
  decrypts the token). A terminal whose pairing row exists but whose token cannot be decrypted
  (`decrypt_failed`, `token_missing`) is not gated; it reports the monitor's real connection, and
  the pairing push already routes it to recovery.
- **Sync axis cadence.** The background refresh re-reads the sale queue every 5 s (the sale-sync
  drain interval), not on each engine tick that changed a row as §2.3 sketched. A new pending sale
  shows within 5 s; a `get()` sees it within 1 s. No engine behaviour changed.
- **Sync read failure** keeps the last known sync axis (or the empty one before any success)
  rather than refusing the invoke; it is logged once per run.
- **No runtime evidence.** Tests are unit and source-level. No packaged build or bench run was
  done; that is S6-V (doc 24 §5.2).
