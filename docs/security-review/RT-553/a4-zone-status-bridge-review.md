<!--
RT-553 (RT-545 S4) — §A4 P8 bridge-security re-check for the one new channel
`saleHistory:zoneStatus`. Written with the implementation, before merge.
-->

# §A4 — P8 bridge-security re-check: `saleHistory.zoneStatus` (RT-553)

## 1. Metadata

| Field | Value |
| :--- | :--- |
| Work item | RT-553 — RT-545 S4, warn and flag when the Backend-Core `storeTimezone` differs from the fixed Africa/Cairo |
| Gate | §A4 — P8 Electron security boundary (one new read-only preload channel) |
| Bridge surface | `api.saleHistory.zoneStatus({})` over `saleHistory:zoneStatus` (new). No other channel changes. |
| Baseline | `origin/main` at `f787fb12` |
| Prepared by | The implementation agent (Claude Code), 2026-10-16. **Not an independent human review.** |
| Verdict | **Agent-assessed PASS.** |

## 2. What the channel does

Main compares the zone on each validated Backend-Core sale-history page with `STORE_TIME_ZONE`
and keeps one in-memory status (`unknown` / `match` / `mismatch`). The channel returns that status
and the zone the build uses. It reads nothing from the database and exposes no sale data, token,
tenant or terminal. The zone in use never changes and selling is never blocked.

| File | Role |
| :-- | :-- |
| `src/shared/sale-history/types.ts` | `ZONE_STATUS` channel, `SaleHistoryZoneStatus` (closed `status`, `expected`, `reported`). |
| `src/preload/sale-history.ts` | One `ipcRenderer.invoke` on a constant channel. |
| `src/main/ipc/sale-history.ts` | Non-object payload → `invalid_request`; a thrown fault → `unavailable`, logged by error name only. |
| `src/main/sale-history/sale-history-service.ts` | `zoneStatus` runs the RT-546 `admit` with an **empty key allowlist**; `observe` is called only for a page that already passed `pageFitsCredential`. |
| `src/main/sale-history/store-zone-monitor.ts` | Classifier, in-memory flag, one warning per transition. |
| `src/renderer/v5/manager/sales/history/ZoneMismatchNotice.tsx` | Read-only notice. |

## 3. Controls

| # | Control | Evidence | Result |
| :-- | :-- | :-- | :-- |
| Z-1 | **Typed, constant channel; no generic invoke.** | One new member on `SALE_HISTORY_IPC_CHANNELS`; the preload and the IPC registration test enumerate it. | PASS |
| Z-2 | **Main is the trust boundary; the renderer decides nothing.** | Main classifies the zone. The renderer does not read `store_timezone` to compare; it only renders the status main returns. | PASS |
| Z-3 | **Same role / lock gate as the rest of `saleHistory.*`.** | `access.admit('saleHistory.zoneStatus', …)`: no session or locked → `no_session`; role outside the allowlist → `role_denied` (audited as `sale.access.refused`). No second gate. The channel is not on the locked-session allowlist (default deny). | PASS |
| Z-4 | **Request validated, closed shape.** | Only an empty object passes. Any key is refused: a forbidden key → `forbidden_field_in_request`, any other → `invalid_request`; a non-object payload never reaches the service. | PASS |
| Z-5 | **Response validated, closed shape, no secret.** | `status` is one of three literals; `expected` is a build constant; `reported` is a runtime-accepted zone name or `null`. | PASS |
| Z-6 | **Untrusted server text is never echoed.** | The server's zone is shown (bridge and log) only if `Intl.DateTimeFormat` accepts it as a zone name (it also accepts offsets such as `+02:00` and aliases; these are bounded, non-injectable text); otherwise `reported` is `null` and the log carries the fixed marker `invalid`. | PASS |
| Z-7 | **Only a trusted page feeds the flag.** | `observe` runs after the session-still-current check and `pageFitsCredential`; a refused, local, offline or continuation-failed answer neither raises nor clears it. | PASS |
| Z-8 | **No persistence, no new table, no contract change.** | In-memory for the process lifetime; no migration. | PASS |
| Z-9 | **No log spam, no PII.** | One warning per transition into mismatch or change of the mismatching zone, with the zone name only. | PASS |
| Z-10 | **Business-day computation untouched.** | `STORE_TIME_ZONE` and `businessDayOf` are unchanged; a test asserts the day of a fixed instant is the same after a mismatch. | PASS |

## 4. Residual notes

- The flag is per process, not per session: a mismatch seen under one operator stays visible to the next operator of the same terminal. It carries only a zone name, and a terminal is paired to one store.
- The status is per process and is learned from the sale-history read, so a terminal that has not
  read a history page yet reports `unknown`, not `match`. RT-543 verifies the packaged behaviour.
- Matching is by the zone's own name, case-insensitive. A link name for the same zone (for example
  `Egypt`) is reported as a mismatch rather than resolved: link resolution differs across ICU
  builds, and a false "match" would be the unsafe direction.
