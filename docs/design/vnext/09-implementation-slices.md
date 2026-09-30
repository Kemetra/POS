# 09 — Proposed bounded Jira implementation slices

> **Proposals only. Do not implement from RT-104.** Each slice becomes its own Jira issue (parented
> under its workflow Epic — W2 for cashier flow, W6 for returns/shifts — and linked to RT-106), with
> one Work Mode, one primary repo (`Kemetra/POS`), and one bounded scope. No slice changes IPC, DB,
> API, payment, sync or ERP contracts unless it names the contract issue it depends on. Every
> implementation slice's acceptance criteria include:
>
> - RT-24 invariants [08](08-rt24-invariants.md) cited and unchanged;
> - captures at **1024×768 and 1280×800** of every touched state (the 023 Electron capture
>   approach, `specs/023-pos-ui-clean-room/screenshots/h-retire-log.json`; no new dependency
>   without authorisation);
> - a `forced-colors: active` capture of touched surfaces;
> - keyboard-only walkthrough; axe clean on touched surfaces; `npm run typecheck`, `lint`,
>   `test -- --coverage` green;
> - Impeccable `audit`/`critique` pass recorded, RT rules winning on conflict;
> - owner visual approval before merge for any visible change (023 precedent).

| Slice | Title | Work Mode | Depends on | Scope (bounded) | Out of scope | Evidence |
|---|---|---|---|---|---|---|
| **VN-S0** | Owner decisions + regional benchmark | Planning | RT-104 review | Resolve OD-1…OD-6 (README); owner/human walkthrough of Daftra public docs (shortcuts, session close vocabulary); confirm Egyptian receipt numeral convention against real pharmacy receipts; confirm RT-24 §C items 1, 2, 4, 5 | Any code | Decisions recorded on Confluence Decisions page + Jira |
| **VN-S1** | Design docs truth | Docs | VN-S0 (OD-1…4) | Replace `docs/DESIGN.md` with the approved language (DESIGN.md format); regenerate `.impeccable/design.json`; fix `docs/product.md:34`; mark `docs/design/pos-v3.5` historical; update repo `CLAUDE.md` design pointers | Production code | Diff; Impeccable reads new file |
| **VN-S2** | Foundation (no visible redesign) | Implementation | VN-S1 | Role type tokens + motion tokens (aliases only); `forced-colors` rules for V5 frame/Sale; `RouteLoading`, `ErrorScreen` (route error boundary), Arabic `ScreenTooSmall` + guard on pairing/sign-in; retire dead CSS (51 classes), dead `tailwind.config.ts` dark mode, undefined `--font-size-base` | Checkout, Sale layout changes, new behaviour | Token parity test; forced-colors captures; before/after captures identical except intended |
| **VN-S3** | Sale refinements | Implementation | VN-S2; OD-3 for money grouping | Numeral policy (pin `ar-EG-u-nu-latn`, Western digits for times/counts); correct Arabic plurals; optional money thousands grouping in `shared/money.format` (receipt/snapshot test impact assessed first); scan-owner indicator states (presentation of existing focus behaviour); retire static proof route | Scanner semantics, direct-add, suspend | Captures VN-R1 states at 1024/1280 |
| **VN-S4** | Checkout + completion clean-room | Implementation | VN-S2; **RT-26** for enabled Back (else Back ships as today's behaviour); X-4 correlation id for sale number (else panel omits it) | Recompose `/app/checkout` + completion on V5 vocabulary: `OrderSummary`, `TenderPicker` (RT-103 disabled tile preserved), `CashEntry`/`QuickAmounts` (set semantics), `CardTerminalEntry`, `PaymentLedger` (amount due pinned), `RecoveryPanel` (UNKNOWN/cancelling/reversal copy), `CompletionPanel`; remove `MoneyRoll` animation and local formatters; delete duplicate CSS blocks | New tenders, split, payment/tender contract changes, main-process voucher enforcement (X-6) | Captures VN-R2/R3/R4/R5 states; every payment state reachable in harness; no amount-due scroll at either width |
| **VN-S5** | Scanner & keyboard hardening | Planning → Implementation (two issues) | RT-24 key map confirmation (VN-S0) | Planning: conflict-test the RT-24 key map on Electron/Windows with Arabic input + wedge scanner. Implementation: bind keys, `Kbd` hints only for bound keys, `F1` help overlay, scanner suspended while dialogs open (fix X-1), stepper ArrowUp/Down, `Ctrl+Enter` financial confirm, no bare-Enter tender | Direct-add switch unless confirmed | Key-map test matrix; scan-during-dialog test |
| **VN-S6** | Operational status truthfulness | Planning → Implementation | A real connectivity + sync-status signal (main-process; may need its own contract issue) | `StatusIndicator` in V5 nav; `Banner` consolidation (connection, sync attention, printer, drawer, shift-closed); mount sync status; Arabic copy | Faking online state; sync engine changes | Captures VN-R7 and each banner; unplugged-network run |
| **VN-S7** | Manager approval & destructive dialogs | Implementation | RT-28 (manager-only discount contract) for discount; existing `cart:cancelPostHandoff` gate otherwise | One `Dialog` mechanism; `ConfirmDialog`; `ManagerApprovalSheet` for existing manager-gated actions (post-handoff cancel first) | Discount math/catalogue; new manager actions | Captures VN-R6 states approved/denied/cancelled; audit attribution visible |
| **VN-S8** | Sign-in, pairing, takeover, lock recompose | Implementation | VN-S2, VN-S7 (Dialog) | Recompose sign-in on V5 vocabulary; Arabic-only labels; `LockScreen` with preserved summary (display only); takeover in `Dialog`; pairing restyle | Auth semantics, PIN storage, RT-42 (separate) | Captures sign-in, PIN error, takeover, VN-R8 |
| **VN-S9** | Sales lookup, receipt, returns entry | Implementation | VN-S4; receipt print slice (008 "Slice 3") for printing | Recompose `/app/sales` + `FindSaleReceipt` + `ReceiptPreview` in one mechanism; gated returns entry (VN-R12) | Returns flow (RT-15), refunds | Captures |
| **VN-S10** | Manager/admin surfaces + legacy shell retirement | Implementation | VN-S2, VN-S7; OD-6 | Restyle/recompose dashboard, stuck-shift, cashier management, diagnostics, settings into V5 frame; retire legacy `AppShell`, `NavRail`, `TopBar`, 007 primitives, `--color-accent`; remove theme toggle from cashier chrome (OD-4) | Admin-Console; new admin features | Captures; legacy class wall test extended |
| **VN-S11** | Suspend / Resume UI | Implementation | A park/resume contract (RT-24 I-13; same-terminal durable store) — own Planning/contract issue first | `SuspendedSaleList`, suspend button, `ResumeConflictPanel` | Cross-terminal resume, stock reservation | Captures VN-R10 states; restart-with-suspended test |

| **VN-S12** *(only if OD-7 = B)* | Sale layout B | Implementation | VN-S2; OD-7 | Re-compose the V5 Sale into command bar + cart + money column; slim nav while a sale is active; hooks/behaviour/tests unchanged; absorbs VN-S3 | Behaviour changes; checkout (VN-S4) | Real-app 10-line cart capture shows more visible rows than today at 1024; owner re-approval |

Dependencies outside this plan (owned elsewhere, not to be pulled in): RT-26 (Back/Esc), RT-28
(discount authority), RT-17 (shift/cash-up), RT-15 (returns flow), RT-50 (batch/expiry), RT-65
(Electron upgrade — may affect capture tooling), 008-v2 (VAT/fiscal receipt).

Recommended first executable slice after approval: **VN-S1** (Docs), then **VN-S2**.
