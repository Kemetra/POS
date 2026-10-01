# 05 — Updated screen / state inventory (VNext)

> Supersedes nothing by itself: it **extends** RT-25's inventory (see [02](02-rt25-delta.md)) with
> VNext IDs, the RT-24 state each surface renders, today's generation on `main@28890fa`, and the
> VNext treatment. Tier follows RT-24 feature tiering (Pilot / Post-pilot / Later).
>
> Generation key: **V5** clean-room (023) · **V5-frame/legacy** (V5 chrome around 006/022/v3.5
> content) · **v4** (022) · **Legacy** (002/003/004/006/007/008) · **None** (no UI).
>
> **Direction B amendment (OD-7, approved 2026-10-01).** For VN-07…VN-11, the composition is
> now the approved Direction B layout ([04 §16](04-design-language.md),
> [10](10-direction-comparison.md); references `VN-B1-*`): a command bar holding the scan target
> and search instead of the product rail, a full-width cart, the money column, and slim
> navigation. The rows' states, RT-24 mappings and treatments are unchanged, but wherever a row
> says "rail", read "command bar". The direct-add treatment in VN-09 still waits on RT-24 §C.1.
> **Key hints are excluded from "unchanged":** any key a row names (for example VN-08's `F8`)
> is RT-24's proposed, unconfirmed key map. Show it only once VN-S5 binds that key
> ([`docs/DESIGN.md`](../../DESIGN.md), Keyboard hints).

## A. Cashier journey

| VN ID | Screen / state | RT-24 state(s) | RT-25 § | Today on `main` | VNext treatment | Ref | Tier |
|---|---|---|---|---|---|---|---|
| VN-01 | Boot / route loading | — | — | Legacy: empty `<main>` (`router.tsx:123-125`) | `RouteLoading`: brand + «جارٍ التحميل…»; never blank | — | Pilot |
| VN-02 | Pairing / paired | `SETUP_REQUIRED` | (S01) | Legacy 002/007, no too-small guard | Restyle only; Arabic copy; keep flow | — | Pilot (restyle later) |
| VN-03 | Sign-in: roster → PIN | `ACTIVE` entry | §1 | v4 + legacy children, mixed-language labels | Recompose on V5 vocabulary (`PinPad`, `Dialog`); Arabic-only labels | — | Pilot |
| VN-04 | Sign-in: manager staff code | — | §1 | v4 `.v4-field` | as VN-03; RT-42 trim fix is independent | — | Pilot |
| VN-05 | Takeover pending | `TAKEOVER_PENDING` | §1 | Legacy `TakeoverPrompt` (own dialog) | `Dialog` mechanism; states whose session, what is preserved | — | Pilot |
| VN-06 | Shift required / opening float | (shift, RT-17) | §2 | None (D-003) | Boundary screen; opening float `MoneyField` | VN-R11 | Pilot (RT-17) |
| VN-07 | Sale — empty | Cart `EMPTY` | §3 | V5 | Retain; scan-owner ready | VN-R1 | Pilot |
| VN-08 | Sale — active / long cart | `EDITING` | §4 | V5 | Retain; pinned totals + CTA `F8`; plural/number fixes | VN-R1 | Pilot |
| VN-09 | Scan acknowledged / duplicate (+1 qty) | `EDITING` | §5 | V5 (confirm-first dialog) | Inline rail notice + row flash; direct-add **only if RT-24 §C.1 confirmed** | VN-R1 | Pilot |
| VN-10 | Unknown barcode / unavailable item | `EDITING` | §5 | V5 inline notice | Inline danger/warn notice with the scanned code, LTR-isolated | — | Pilot |
| VN-11 | Search: typing / results / none / loading / error / stale | `EDITING` | §6 | V5 | Retain; scan-paused state while search owns focus | VN-R1 1024 | Pilot |
| VN-12 | Confirm-add dialog | `EDITING` | §5–§6 | V5 `SaleDialog` | Retain; **scanner suspended while open** (X-1 fix) | — | Pilot |
| VN-13 | Line qty / note / remove | `EDITING` | §7 | V5 | Retain; restore stepper ArrowUp/Down | — | Pilot |
| VN-14 | Cancel sale (pre-handoff) | → `CANCELLED` | §7 | V5 void confirm dialog | `ConfirmDialog` danger; safe option default focus | — | Pilot |
| VN-15 | Manager approval: request / approved / denied | manager gate | §8 | None (in-sale) | `ManagerApprovalSheet` | VN-R6 | Pilot |
| VN-16 | Suspend sale | → `PARKED` | §9 | None (D-007) | Button `F4` in cart head; optional label; durable-save-then-clear | VN-R1 (button) | Pilot if RT-24 §C.4 confirmed |
| VN-17 | Suspended list: empty / one / many / stale | `PARKED` | §10 | None | `SuspendedSaleList` | VN-R10 | Pilot (same as VN-16) |
| VN-18 | Resume + conflict + price change | `PARKED`→`EDITING` | §11 | None | `ResumeConflictPanel` (RT-27 corr. 3) | VN-R10 | Pilot (same) |
| VN-19 | Handoff pending | `HANDOFF_PENDING` | §12 | V5 frozen state (`v5-polish-1280-M`) | CTA shows in-progress; cart frozen | — | Pilot |
| VN-20 | Checkout — before tender | `FROZEN`, Payment `NONE`/`OPEN_NO_FUNDS` | §12 | V5-frame/legacy | **Recompose**: 3 regions / 2 regions + strip; amount due pinned | VN-R2 | Pilot |
| VN-21 | Safe back to Sale (enabled / refused) | RT-26 guard | §13 | Not implemented (RT-26 To Do) | Back button `Esc` + refused reason line | VN-R2, VN-R3 | Pilot (RT-26) |
| VN-22 | Tender selection (cash, card, voucher-disabled) | — | §14 | V5-frame/legacy + RT-103 | `TenderPicker` radiogroup; disabled-by-policy tile | VN-R2 | Pilot |
| VN-23 | Cash: entry / exact / quick-set / shortfall / change | `OPEN_NO_FUNDS`→`FUNDS_APPLIED` | §15 | Legacy 006 + v3.5 | `CashEntry` + `QuickAmounts` + `PaymentLedger` | VN-R2 | Pilot |
| VN-24 | Card: waiting for terminal result | `PROCESSING` | §16 | Legacy 006 | `CardTerminalEntry` | VN-R4 | Pilot |
| VN-25 | Card: approved / declined / cancelled | `SETTLED` / `FAILED_NO_FUNDS` | §16 | Legacy 006 | Outcome line in ledger; decline → choose method again | — | Pilot |
| VN-26 | Card: result UNKNOWN | `UNKNOWN` | §18 | None dedicated | `RecoveryPanel` | VN-R3 | Pilot |
| VN-27 | Payment cancelling / reversal pending | `CANCELLING` / `REVERSED` | §18 | Legacy hints (`PaymentSurface.tsx:697-717`) | `RecoveryPanel` variant, plain-Arabic copy (no `LIFO`/`reversal_pending`) | — | Pilot |
| VN-28 | Finalizing sale | `FINALIZING` | §19 | Implicit | Ledger shows «جارٍ حفظ البيع…»; commit disabled; no success colour | — | Pilot |
| VN-29 | Finalization failed | `FINALIZATION_FAILED` | §19 | None | Danger outcome: payment recorded, sale not saved, retry finalization only after SETTLED | — | Pilot |
| VN-30 | Sale complete (+ receipt ready / printing / printed) | `FINALIZED`, `READY`/`PRINTING`/`PRINTED` | §19–§20 | v4 (no sale no., no receipt) | `CompletionPanel` with proof list; New sale `Ctrl+N` | VN-R5 | Pilot (X-4 dependency) |
| VN-31 | Print failed after sale | `PRINT_FAILED` | §20 | Legacy 008 banner (V5 wired) | Warning banner + inline retry + manual-receipt ack | VN-R5 | Pilot |
| VN-32 | Recent sales / receipt lookup / reprint | — | §21 | Legacy 003/008 (`/app/sales`) | Recompose on V5 (`ProductResultList`-style list, `ReceiptPreview`) | — | Pilot (restyle) |
| VN-33 | Return/refund entry (gated) | — | §22 | Legacy placeholder, manager/admin-only route | Entry + gate notice | VN-R12 | Pilot entry only |
| VN-34 | Offline selling | Sync `QUEUED` | §23 | Hard-coded online (X-2) | Banner + StatusIndicator | VN-R7 | Pilot (signal dependency) |
| VN-35 | Sync backlog needs attention | Sync `ATTENTION`/`RETRYING` | §23 | `SaleSyncStatus` unmounted | Danger banner → diagnostics (manager) | — | Pilot |
| VN-36 | Restart recovery (active / suspended cart restored) | Device `ACTIVE` | §24 | `cart.snapshot` hydration (023) | Inline notice «استُعيدت السلة بعد إعادة التشغيل» | — | Pilot |
| VN-37 | Storage blocked | `STORAGE_BLOCKED` | §24 | None | Blocking `ErrorScreen` | VN-R9 | Pilot |
| VN-38 | Route / renderer error | — | §24 | None (React Router default page) | `ErrorScreen` with safe-state statement and support ref | — | Pilot |
| VN-39 | Inactivity lock (cart / live tender) | `LOCKED` | §25 | Per RT-24; not verified | `LockScreen` with preserved summary | VN-R8 | Pilot |
| VN-40 | Screen too small (<1024) | — | §26 | Legacy, English | Arabic copy; guard on all routes | — | Pilot |
| VN-41 | Shift close / cash-up entry | (RT-17) | §27 | None | Boundary only | — | Post RT-17 |
| VN-42 | Shortcut help overlay (`F1`) | — | S45 | None | Lists only **bound** keys for current state | — | Pilot (with key map) |
| VN-43 | Hardware status: printer / drawer not configured / unavailable | — | S42 | Legacy 008 banners | StatusIndicator row + banner only when blocking the current action | — | Pilot |
| VN-44 | Cash in / out (pay-in, pay-out) | (RT-17) | S43 | None | Boundary (RT-17) | — | Post RT-17 |
| VN-45 | Split / multi-tender | — | §17 | None | Deferred | — | Post-pilot |
| VN-46 | Pharmacy extension (unit/pack/batch/expiry) | — | S48 | None | Deferred to RT-50 | — | Later |

## B. Manager / admin surfaces inside the POS (restyle only — no redesign in this item)

| VN ID | Surface | Today | VNext treatment |
|---|---|---|---|
| VN-M1 | Dashboard | Legacy, English "Coming soon" | Retire placeholders from cashier nav or restyle to V5 empty state (owner decision) |
| VN-M2 | Stuck shifts / forced close | Legacy, **unstyled**, English | Recompose on V5 `Dialog`/`Button`, Arabic |
| VN-M3 | Cashier management / PIN provisioning | Legacy 019 | Restyle to V5 vocabulary |
| VN-M4 | Force-fail payment | Placeholder route | Keep hidden until a contract exists |
| VN-M5 | Catalogue diagnostics / sync diagnostics | Legacy, English | Restyle; host the sync-attention details (VN-35) |
| VN-M6 | Audit, inventory, settings | Legacy placeholders, English | Restyle; theme toggle removed from cashier-facing chrome (OD-4) |

Admin-Console is out of scope (RT-104 non-goal).
