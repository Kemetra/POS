# 11 — Operational workflow benchmark (RT-111)

> **Status: Planning deliverable for Jira RT-111, pending owner review.** Nothing here is approved
> and nothing here authorises implementation. This document compares how mature POS products
> handle store **operations**: offline boundaries, permissions, register/shift, device health,
> recovery, returns and reprint. It is **not** another visual audit. RT-104 already did that
> ([03](03-external-reference-audit.md)), and this document links to it rather than repeating it.
>
> **Authority is unchanged.** GitHub `main` is the technical truth. RT-24 governs cashier
> transaction behaviour ([08](08-rt24-invariants.md)). RT-104 / [`docs/DESIGN.md`](../../DESIGN.md)
> govern the visual direction. RT-106 is the umbrella. The architecture stays
> `POS → Backend-Core → ERPNext-Connector → ERPNext/Frappe`. External products are references
> only. They are not authority, and no proprietary UI, wording, screenshots or assets are copied.

## Baseline

| | |
|---|---|
| Repository | `Kemetra/POS` |
| Verified `origin/main` | `4ddfc9561e567a795d30f669b627233919fc41e3` — RT-108 merge (#500), 2026-10-01 |
| Jira read | RT-111, RT-24 (description), RT-104 package on `main`, RT-106, RT-15, RT-17, RT-18, RT-20, RT-28; W6 (RT-6) and W7 (RT-7) child lists; keyword sweep for offline / shift / manager / printer / drawer / diagnostics / reprint |
| Confluence read | RETAIL **Current State** (v18, 2026-10-01), **Risks & Blockers** (v8), **Cashier UX — RT-24 / RT-25 Review Draft 1** (7405593) |
| Code read on `main` | `src/main/operator/{sign-in-handler,check-active-session,inactivity-monitor,session-manager,stuck-shifts-handler,pin-management}.ts`, `src/main/cart/{cart-bridge,session-end-handler}.ts`, `src/main/payments/sweep-stuck-attempt.ts`, `src/main/drawer/drawer-kick.ts`, `src/main/sales-sync/sale-sync-engine.ts`, `src/main/receipts/*`, `src/main/index.ts` wiring, `src/shared/bridge-api.ts`, `src/renderer/router.tsx` |
| External research | Official/public docs for Shopify POS, Square, Toast, Odoo 19 and ERPNext v15. ERPNext v15 source code (GPL-3.0, read only, nothing copied). Daftra marketing pages, the Arabic hub and blog, and docs excerpts. 2026-10-01. Full source list in [§11](#11-sources). |

### Evidence limits (read before approving)

- **No app, test, CI or hardware run** was done for this Planning item. Every `main` claim comes from
  reading the source at the SHA above. Where behaviour depends on runtime wiring that reading
  cannot prove, the row says **needs separate evidence**.
- Each external claim links to its source. Some sources are weak, and those claims are tagged:
  - *(community)*: a vendor-hosted forum, not official docs.
  - *(excerpt)*: a search-result excerpt of an official page whose body could not be fetched.
  - **UNVERIFIED**: no permissible public source was found. RT-111's stop condition forbids
    guessing these.
- Daftra's knowledge base mostly could not be fetched, as in RT-104 ([03 §2.10](03-external-reference-audit.md)).
  Daftra facts are excerpt-level, and the owner walkthrough proposed in VN-S0 is still useful.
- Odoo's offline behaviour is documented only as a single sentence in the official docs. The rest
  is *(community)*.

---

## 1. Reference matrix

Short codes: **SH** Shopify POS · **SQ** Square · **TO** Toast · **OD** Odoo POS 19 · **EN** ERPNext POS v15 · **DF** Daftra.
For ERPNext and Daftra, the RT-104 baseline in [03 §2.9–2.10](03-external-reference-audit.md)
already covers the flow, shortcuts, numpad model and licensing. This table adds only the
operational dimensions RT-104 did not cover.

### 1.1 Sale, search and checkout

| | Scan / search / cart | Tender & split |
|---|---|---|
| SH | Scanner types into the search bar. Search covers barcode, SKU, title and tags. Custom sale can be gated by approval [SH4, SH16, SH17] | Split payment, step by step. "Partially paid" leaves an open balance. Custom payment methods [SH15] |
| SQ | Scan adds the item on recognition. Keyword, UPC or SKU search. Open tickets park carts [SQ8, SQ9] | Split tender by amount only. Must finish within 5 min or earlier payments may void. No split when Square Terminal takes a card [SQ7] |
| TO | Scan matches a SKU, then embedded barcodes. Price edit needs permission 5.7 [TO16, TO11] | Partial "amount tendered" keeps the check open. "Split evenly" [TO19] |
| OD | Tile or scan. Numpad for Qty, %, Price [OD1, OD8] | Multiple methods with split, terminals and cash machines. Gift card as a refund tender [OD1] |
| EN | Customer required before items. Stock and serial checks raise errors [EN5] | Per-profile payment modes, "Allow Partial Payment", write-off limit [EN4, EN7] |
| DF | Scan to line, weight barcodes, hold/resume orders [DF1, DF3] | Cash, cheque and card. Partial payment is a setting [DF2, DF4] |

### 1.2 Offline capability

| | Sale | Card / external | Return / refund | Discount / approval | Close shift | Reprint | Sync & recovery |
|---|---|---|---|---|---|---|---|
| SH | Yes, cash and custom tenders [SH1] | Opt-in offline card with daily-per-device and per-transaction caps. No manual entry or tap. Reconnect within 24 h advised. States: Payment pending / Paid / Card declined [SH2] | **Online only.** Returns, exchanges and voids are blocked [SH1] | Manual discounts work offline. Codes and automatic discounts don't. Offline approval is UNVERIFIED [SH1] | UNVERIFIED | UNVERIFIED (printing works offline) | Auto sync on reconnect. **Logging out or powering off risks losing unsynced orders.** Offline orders get register-prefixed numbers [SH3, SH13] |
| SQ | Yes [SQ1] | Opt-in. Per-transaction cap of $1–$50,000. Up to 72 h to upload before expiry. Seller bears decline risk. Declines are visible only after reconnect [SQ1, SQ2] | Offline payments can't be refunded until uploaded [SQ1] | UNVERIFIED | UNVERIFIED | UNVERIFIED | Pending / Completed / Declined states. **Don't sign out or reset while pending**, because payments would be lost [SQ2] |
| TO | Yes. A banner and a dialog explain what is allowed **for each disruption type** (LAN, internet, Toast platform) [TO1] | Background card processing (deferred authorisation, card data held encrypted). Per-transaction limit, and above it manager approval. Back online within 3 days, ideally 24 h [TO2] | UNVERIFIED | UNVERIFIED | **Shift review is unavailable offline** [TO6] | UNVERIFIED | Yellow Pending (queued) / Red Pending (paused + banner). Declines reopen the check. Don't clear device memory [TO5] |
| OD | Yes, from cached data. Must be opened while online *(community)* [OD1, OD13] | Terminal payments are not cached *(community)* [OD13] | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | Unsynced-order count on the wifi icon. Cleared browser storage can lose orders *(community)* [OD13] |
| EN | No native offline in v15 core (inferred from source and forum, not an official statement) [EN5, EN9] | — | — | — | — | — | Failures surface **at closing**: the Closing Entry goes to `Failed`, stores an error, and offers **Retry** [EN15, EN16] |
| DF | Desktop and mobile apps sell offline from a pre-downloaded catalogue [DF5, DF6] | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | Mobile has per-invoice **Sync** and **Sync All**. Release notes mention retrying failed records *(excerpt)* [DF3, DF18] |

### 1.3 Permissions and manager approval

| | Model | Approval pattern | Audit of sensitive actions |
|---|---|---|---|
| SH | Roles with a unique PIN per staff member. Each action is **Allowed / Denied / Approval required**. "Manager approval" is itself a permission [SH4, SH5] | An approver enters their PIN on the same device. Approval can be required for returns, unverified returns, restock, custom discounts, offline payments, switching to offline checkout, and editing taxes [SH4] | Activity log of voids, refunds, discounts and customer access, **including the approving manager**, kept 1 year. Shared PINs break attribution [SH6] |
| SQ | Permission sets with a 4-digit passcode per member. Owners can require passcodes [SQ3, SQ4] | Restricted discounts need a permitted passcode. Override by another member's passcode is *(community)* [SQ5] | Dashboard activity log *(excerpt)*. Who approved an override is UNVERIFIED [SQ12] |
| TO | Numbered permissions (1.x–8.x) assigned through jobs [TO11] | Discounts carry a per-discount level (any user / manager). Manager approval for voids of unpaid checks, offline card over the limit, and cash over/short over a threshold [TO10, TO11, TO2] | Void, Discount and **No Sale** reports broken down **by approver**. Cash activity audit lists every drawer entry with comments [TO15] |
| OD | Minimal / basic / advanced rights tiers. Employee login by badge, name or PIN [OD2] | Static rights. A cashier without manager rights can't close over the difference threshold [OD1, OD6] | Order list shows the employee. Approval logs are UNVERIFIED [OD5] |
| EN | Static profile flags (edit rate, edit discount, partial payment, "Allow in Returns" per mode) and roles [EN4, EN6] | **No interactive override prompt** (observed in source) | Frappe document history. Per-override audit is UNVERIFIED |
| DF | Per seller, group or shift. A per-user discount limit rejects excess *(excerpt)*. Return creation can be blocked per employee (title only) [DF2, DF7, DF8] | Supervisor override UNVERIFIED | A shortfall at close is posted against a named employee *(excerpt)* [DF9] |

### 1.4 Register / shift / cash drawer

| | Open | During shift | Close / count | Variance & handover |
|---|---|---|---|---|
| SH | Float entered manually, or carried over from the last session's calculated close [SH8] | Add/remove cash. Reason codes when the drawer opens [SH8] | Final count, then a float for the next session. **Closed sessions cannot be reopened or edited.** One session per device [SH8] | Counted vs expected in cash-tracking reports. Blind count UNVERIFIED [SH9, SH10] |
| SQ | Session started only from the POS app [SQ6] | Pay In/Out with a description. "Open Cash Drawer (No Sale)" *(excerpt)* [SQ6, SQ13] | Enter the counted amount and get a report. Remote close from the Dashboard [SQ6] | Starting cash, cash sales, refunds and paid in/out make up expected cash. Blind count not standard *(community)* [SQ6] |
| TO | Starting balance. A drawer can be **locked to one employee** [TO7] | Cash In / Out / Payout (with reasons) / Drop / **No Sale**. Outflows can't exceed the balance [TO8] | **Blind count permission (3.17)** hides the expected amount. Over/short is revealed after counting [TO7] | Over a threshold, manager approval. Shift review order: checks → tips → cash → drawers → clock-out [TO9, TO10] |
| OD | "Open Register" confirms the opening cash [OD1] | Cash in/out ("Manage the cash register") [OD1] | Expected per payment method, coin counter, "maximum difference" tolerance [OD1] | Accounting posts at session close, with a difference line *(community)* [OD14] |
| EN | **Mandatory Opening Entry** with opening balance per payment mode. The POS is blocked until it exists [EN5, EN12] | No cash in/out document in core (UNVERIFIED / absent) | Closing Entry: expected = opening + that user's payments, per mode. Closing typed per mode. Expected is visible (not blind) [EN14, EN15] | Close consolidates into Sales Invoices / Credit Notes. A failed consolidation shows `Failed` + Retry [EN16] |
| DF | New session → choose a shift («الوردية») [DF9] | Cash movement between points of sale [DF10]. In-session cash in/out UNVERIFIED | System computes expected. Cashier enters counted. Positive = surplus, negative = shortage *(excerpt)* [DF11] | Balance goes to **an employee (custody, «العهدة») or the treasury**. «تأكيد غلق الجلسة» confirms close [DF9] |

### 1.5 Returns, receipts, devices and recovery

| | Returns / void boundary | Receipt / reprint / lookup | Device health | Operator recovery |
|---|---|---|---|---|
| SH | Return from the order with qty + restock choice. Refund capped per original method. **No-receipt returns go to a gift card only, under a dedicated permission** [SH11, SH12] | Search by order, receipt number or card last-4, **or scan a receipt barcode**. Reprint any order or return event [SH13, SH14] | Connectivity icon: green = OK, **yellow = hardware disconnected**, red = offline. **"Test Cash Drawer"** in hardware settings [SH18] | Pending / declined badges. Manual customer follow-up. Restart if sync sticks [SH2, SH3] |
| SQ | Return, exchange, or **unlinked refund** (seller-liable, configurable limits) [SQ10] | Transactions → New Receipt [SQ11] | **Test Printer / Test Cash Drawer / Connect Scanner** [SQ14] | Declines appear after reconnect. Manual re-collection, no auto-retry [SQ1, SQ2] |
| TO | **Void** same day before batch close, otherwise **refund** within 90 days. Voiding items doesn't return money [TO12, TO13] | Find Checks with filters. Reprint open, closed or voided checks [TO17] | Printer status, self-test slip, hub LEDs, "Check Status" [TO18] | Status tags, declined → reopened check [TO5] |
| OD | Refund from a paid order (line + qty), or standalone negative lines, producing a credit note [OD1] | Orders → filter Paid → Print Receipt [OD3] | Devices over IoT box / LAN. Status and test actions UNVERIFIED [OD4] | Terminal disconnect auto-cancels. **Gated "Force Done"** when the terminal did charge [OD9] |
| EN | Past Orders → Return (cloned negative qty). A consolidated invoice can't be cancelled until the closing is cancelled [EN7, EN17] | Past Orders search, Print (Ctrl+P), Email [EN17] | Browser print only. No drawer or device status in core | Closing `Failed` + error + **Retry** [EN15] |
| DF | Refund invoice or credit note. Partial or full on mobile [DF12, DF13] | Print from invoice. Auto-print-after-save setting (title) [DF3, DF14] | Auto-open drawer after save, before or after print *(excerpt)* [DF15] | Per-invoice sync / Sync All [DF3] |

---

## 2. Retail Tower gap matrix

Each row has exactly one RT-111 classification: **covered** (already covered), **strengthen**
(strengthen the current plan), **adopt-concept** (a useful pattern to adopt conceptually),
**reject** (reject / not applicable) or **evidence** (needs separate evidence).

Tier uses RT-24's own feature tiering:
- **Pilot** = must-have pilot gap.
- **Post-pilot** = H2.
- **Later** = H3.

"Owner" is the existing Jira issue or VNext slice that already owns the work. Only rows with
**no owner** may appear in [§8](#8-genuine-missing-decisions-and-slices).

| ID | Topic | What `main` / the plan has today | Benchmark signal | Class | Tier | Owner |
|---|---|---|---|---|---|---|
| OB-01 | Offline sale, durable | Local finalize + `sale_sync_outbox` + backoff retry + dead-letter (`sale-sync-engine.ts`) | All but EN sell offline | **covered** | Pilot | 008/011 on `main`; VN-34 visibility |
| OB-02 | Say *which* actions are unavailable offline | VN-34 banner plans "offline selling" only | TO explains what is allowed per disruption type. SH publishes an offline feature list | **strengthen** | Pilot | VN-S6 (banner copy derives from §3) |
| OB-03 | Offline card store-and-forward (SH/SQ/TO) | Card is a standalone terminal. POS records the result only (I-10) | All three hold card data on device and authorise later | **reject** | — | I-10 / RT-111 stop condition (no cardholder data in RT) |
| OB-04 | Record an external-card result while offline | `tender.apply` is a local FSM, so recording needs no RT network. The terminal's own connectivity is the acquirer's concern | — | **covered** | Pilot | 006 on `main`; card settlement still RT-78 |
| OB-05 | **Starting a session offline** | Cashier PIN is checked locally, then **`checkActiveSession` → `backend.getActiveSession`. On `no_connection` sign-in is refused** (`sign-in-handler.ts:337-343`, `check-active-session.ts:39-44`). Manager sign-in is Clerk (online). So no new session can start offline | SH/SQ/TO/DF stay usable offline once set up | **evidence** | Pilot | **none** → [MD-1](#8-genuine-missing-decisions-and-slices) |
| OB-06 | Inactivity with a cart / live tender | `inactivity-monitor.ts` **ends** the session at 15 min (not a lock). `onEnded` fires `sweepStuckAttempt` (`index.ts:923`), which **LIFO-reverses applied tender lines** of a `started` attempt. The session-end **cart** discard subscriber exists but is **not wired** (`session-end-handler.ts:123`, no caller) | — | **evidence** | Pilot | **none** → [V-1](#8-genuine-missing-decisions-and-slices). Conflicts on its face with I-8 and VN-39 |
| OB-07 | In-sale manager approval proven by a credential | Post-handoff cancel accepts a renderer-supplied `attribution_operator_id` with no credential proof (`cart-bridge.ts:225-233`). The renderer always sends `null`, so cashiers are refused and only a signed-in manager acts. No in-sale approval exists (VN-15 "None") | SH/SQ/TO: approver PIN or passcode on the same device, recorded with the actor | **strengthen** | Pilot | VN-S7 + RT-28, blocked by [MD-2](#8-genuine-missing-decisions-and-slices) |
| OB-08 | Per-action tri-state (allowed / denied / approval) | RT-24 classifies actions as cashier-allowed / manager-gated / out of scope | SH's tri-state is the clearest form | **strengthen** | Pilot | This doc's [§4](#4-permission--manager-approval-matrix-target-state) as the reference for VN-S7 / RT-28 |
| OB-09 | Approver + actor in one audit event, reports by approver | `audit_events.approving_supervisor_id` exists. Reports are Admin-Console's | SH activity log. TO reports by approver | **covered** | Pilot (POS side) | 004 audit on `main`; reports RT-18 / Admin-Console |
| OB-10 | Register session: float, cash in/out, expected, count, variance, close | **Not built.** On `main` a "shift" is only the operator session (stuck-shift force-close exists). I-15 formula | All except EN have a full session. EN's opening entry is mandatory | **strengthen** | Pilot | **RT-17** (see [§5](#5-register--shift-lifecycle-target-flow)) |
| OB-11 | Blind count by default | RT-24 names a "blind cash-up" boundary | TO 3.17. OD and EN show expected | **strengthen** | Pilot | RT-17 |
| OB-12 | Variance threshold → manager approval | Not specified | TO and OD | **adopt-concept** | Pilot (threshold value: RT-17 decision) | RT-17, depends on MD-2 |
| OB-13 | Closed session immutable; corrections are new events | I-5 does this for sales, not yet for shifts | SH: no reopen. TO and DF allow reopen before confirm | **strengthen** | Pilot | RT-17 |
| OB-14 | Register session bound to terminal vs operator; handover | Takeover exists for the operator session (004). No register concept | SH per device. TO lock-to-employee. DF «تسليم الوردية» | **strengthen** | Pilot | RT-17 (decision input [§5.3](#53-decisions-rt-17-must-take)) |
| OB-15 | Balance destination (employee custody / treasury) | RT-17: "keep ledger consequences in ERPNext" | DF posts the shortage to an employee | **reject** (in POS) | — | ERP-side. Note for RT-17's contract only |
| OB-16 | No-sale drawer open | Drawer kicks **only** after a committed, printed cash-tender sale (`drawer-kick.ts` three gates). No no-sale action. RT-24 lists no-sale as manager-gated | TO/SQ no-sale + reports. **SQ $0-cash-sale loophole** *(community)* | **evidence** | Post-pilot | **none** → [MD-4](#8-genuine-missing-decisions-and-slices) |
| OB-17 | Pay-in / pay-out with reasons | Not built | SQ/TO/SH, with reasons/comments | **strengthen** | Pilot | RT-17 (I-15 already includes ± pay-in/out) |
| OB-18 | Returns online-only | I-16. Returns not enabled for pilot | SH blocks returns offline | **covered** | Pilot (entry only) | RT-15 / RT-14 |
| OB-19 | No-receipt (unverified / unlinked) returns | RT-14 line-aware contract needs the original sale | SH gift-card only. SQ seller-liable | **reject** | Later | RT-14 contract |
| OB-20 | Exchange as one flow | Return + new sale | SH/SQ | **reject** | Later | — |
| OB-21 | Void vs refund boundary | I-2: Suspend ≠ Cancel ≠ Void ≠ Return | TO's settlement-based boundary | **covered** | Pilot | RT-24 |
| OB-22 | Reprint + lookup by sale number | `receipts.reprint`, `retryPrint`, `manualOverride`, `sales.findByNumber` on the bridge. VN-32 recomposes | All | **covered** | Pilot | VN-S9 |
| OB-23 | Find a sale by scanning the receipt | Not planned | SH scans the receipt barcode | **adopt-concept** | Post-pilot | VN-S9 / RT-15 (needs a receipt code, 008-v2 template) |
| OB-24 | One status indicator for connectivity + hardware | VN-S6 `StatusIndicator` + banners. Today connection is hard-coded `online` (X-2) | SH green/yellow/red. TO banner | **covered** (planned) | Pilot | VN-S6, needs a real signal |
| OB-25 | Hardware **test actions** (test print, test drawer) | None. VN-M5 is diagnostics restyle only. RT-110 bench tests print by hand | SH, SQ, TO self-test | **adopt-concept** | Post-pilot | **none** → [S-1](#8-genuine-missing-decisions-and-slices) |
| OB-26 | Scanner "health" | Keyboard-wedge scanners can't report status | SQ "connect scanner" | **reject** (health light) | — | Use the VN-S3/S5 scan-owner indicator + last-scan acknowledgement instead |
| OB-27 | Queued / retrying / attention states | RT-24 Sync layer. `SaleSyncStatus` unmounted (X-2) | SQ/TO/SH pending/declined tags | **covered** (planned) | Pilot | VN-S6 / VN-35 |
| OB-28 | Alert on unsynced backlog *age* | Backoff retries forever, with no age alert | SQ 72 h expiry. TO "within 3 days" | **adopt-concept** | Pilot | VN-S6 (threshold = [§6](#6-device--hardware-health-target-surface) R-H6) |
| OB-29 | Guard sign-out / unpair / reset while unsynced work exists | The outbox is durable SQLite, so sign-out does not lose it. Whether **unpair / re-pair / reinstall** checks the outbox is not verified | SH and SQ warn of loss | **evidence** | Pilot | **none** → [V-1](#8-genuine-missing-decisions-and-slices) checklist |
| OB-30 | Posting failure is visible and retryable, never re-captured | Dead-letter → ATTENTION. Console posting-failure triage (RT-36). Core rule 3 | EN Closing `Failed` + Retry. DF per-invoice sync | **covered** | Pilot | VN-35 / Admin-Console |
| OB-31 | Ambiguous terminal result | UNKNOWN recovery panel (VN-R3), I-7 | OD gated "Force Done" | **covered** | Pilot | VN-S4 |
| OB-32 | Park / hold sale | I-13 same-terminal suspend | DF hold. SQ open tickets | **covered** (planned) | Pilot if RT-24 §C.4 confirmed | VN-S11 |
| OB-33 | Split tender | I-11 post-pilot | All | **covered** (deferred) | Post-pilot | RT-24 tiering |
| OB-34 | Remote / forced close | Stuck operator shift force-close (004) | SQ/SH remote close of the drawer session | **covered** (operator) | Pilot | 004; register-session close → RT-17/RT-18 |
| OB-35 | Arabic operational terms | Not fixed | DF: «الوردية», «جلسة البيع», «غلق الجلسة», «العجز والزيادة», «درج النقدية», «مرتجع», «العهدة» | **adopt-concept** | Pilot | RT-17 + VN copy ([§9.3](#93-arabic-terminology-input-not-approved)) |
| OB-36 | Shortcut discoverability | RT-24 key map §C.5 open. `F1` help overlay VN-42 | SH Ctrl+K list. EN Ctrl-based | **covered** | Pilot | VN-S5 |
| OB-37 | Price override | RT-24 lists it as manager-gated. No slice | TO 5.7. EN profile flag | **covered** (classification) | Post-pilot | RT-24; no implementation slice needed for pilot |

---

## 3. Offline Capability Matrix (Retail Tower target state)

"Offline" means Backend-Core is unreachable. The local SQLite DB and main process are healthy. The
**Today** column is read from `main@4ddfc95`. The **Target** column is proposed for owner review,
built from RT-24 and the invariants. No row moves money handling, posting or ERP logic into the POS.

| Action | Today on `main` | Target (proposed) | Basis |
|---|---|---|---|
| Continue an already-signed-in session | Yes (local session) | Yes | RT-24 offline rule |
| **Start a cashier session** | **Refused** (`checkActiveSession` needs the backend) | **Decision MD-1** | OB-05 |
| Start a manager/admin session | Refused (Clerk is online-only) | Online only unless MD-1 says otherwise | 004 auth |
| Scan / search / add / edit cart | Yes (local catalogue read model) | Yes. Show catalogue freshness when stale | 009/010 |
| Cancel sale before handoff | Yes | Yes | I-2 |
| Suspend / resume (same terminal) | Not built | Yes, local durable store | I-13 |
| Cash tender + finalize | Yes (local) | Yes | 006/008 |
| Record external-card result | Yes (local FSM) | Yes. RT stores no card data | I-10, OB-03/04 |
| Internal voucher | Disabled for pilot | Disabled | I-11, RT-103 |
| Post-handoff cancel / void | Manager session only | Yes if a manager is signed in. In-sale approval depends on MD-2 | I-6, OB-07 |
| Manual discount | Not built (manager-only by owner decision) | Depends on MD-2. **No cashier fallback offline** | RT-28 |
| Return / refund | Route manager/admin-only. Returns disabled | **Online only** | I-16 |
| Receipt print / retry / reprint (this terminal's sales) | Yes (local print pipeline) | Yes | 008 |
| Look up sales from other terminals | n/a | Online only | — |
| Open register session + float | Not built | Yes, local, synced later | RT-17 (§5) |
| Pay-in / pay-out | Not built | Yes, local with a reason, synced later | RT-17 |
| No-sale drawer open | Not built | MD-4 | OB-16 |
| Count and close the register session | Not built | **Count and close locally.** Variance is final locally. Back-office posting waits for sync. An over-threshold approval needs MD-2 | RT-17 / RT-18 |
| Sync / posting | Queued with backoff, dead-letter on permanent error | Unchanged, plus an age alert (OB-28) | 011 |
| Catalogue refresh | Fails, keeps the last snapshot | Same. Freshness is shown | 010 |
| Force-close a stuck operator shift | Online (backend) | Online | 004 |
| Unlock a locked-out cashier PIN | Manager session on the terminal | Same, so offline only if a manager is already signed in | 004 `pin-management` |

**Rules the target keeps:**
- Offline never widens authority.
- An action that needs authoritative cross-terminal or ERP state (returns, cross-terminal lookup,
  forced close) is **refused with an explanation**. It is never guessed.
- The VN-S6 banner lists exactly the "Online only" rows (OB-02).

## 4. Permission / Manager Approval Matrix (target state)

Legend:
- **A** = allowed.
- **—** = denied.
- **MA** = manager approval required. Approval is bound to the action, the amount or cart version,
  and a reason, and is audited with `approving_supervisor_id` (I-6).
- **M** = only when signed in as a manager or admin.

| Action | Cashier | Manager | Admin | Reason captured | Notes |
|---|---|---|---|---|---|
| Sell, scan, search, edit qty, remove line | A | A | A | — | |
| Cancel sale before handoff | A | A | A | — | ConfirmDialog (VN-S7) |
| Suspend / resume own sale | A | A | A | Optional label | I-13 |
| Checkout: cash, external card | A | A | A | — | |
| Post-handoff cancel / void | MA | A | A | **Yes** | `cart.cancelPostHandoff` gate exists. Approval credential = MD-2 |
| Manual discount (line or sale, any size) | MA | A | A | **Yes** | RT-28: no below-threshold cashier path |
| Price override | MA | A | A | **Yes** | Post-pilot (OB-37) |
| Return / refund | — (pilot) | M | M | **Yes** | Route manager/admin-only today. RT-15 decides the cashier role later |
| Reprint receipt | A | A | A | — | Audit as a reprint. Whether the copy is marked as a reprint: VN-S9 |
| Open register session + float | A | A | A | — | RT-17 |
| Pay-in / pay-out | MA | A | A | **Yes** | RT-17 |
| No-sale drawer open | MA | A | A | **Yes** | MD-4 |
| Close own register session (blind count) | A | A | A | — | RT-17 |
| Accept variance over threshold | MA | A | A | **Yes** | OB-12 |
| Force-close another's stuck shift | — | M | M | Recorded | 004 on `main` |
| Unlock a locked-out cashier PIN | — | M | M | Recorded | 004 on `main` |
| Provision cashier PIN | — | M | M | Recorded | 019 on `main` |
| View sync attention / diagnostics | — (sees the banner only) | M | M | — | VN-35 / VN-M5 |
| Catalogue refresh | A | A | A | — | Not session-gated by design (010) |

**Invariants:**
- Approval never shows the manager's credential to the cashier, and returns to the exact prior
  safe state after approve or deny (RT-24).
- Approval can't override immutability, returnable quantity or core rule 3.
- Customisation can't change this table (I-14).

## 5. Register / Shift Lifecycle target flow

This is an **input to RT-17 and RT-18**, not a new slice. It keeps RT-17's "thin" scope and
ledger-in-ERPNext boundary.

### 5.1 Terms

| Concept | Meaning | On `main` |
|---|---|---|
| **Operator session** | Who is signed in (004). Can end by sign-out, takeover, forced close or inactivity | Yes |
| **Register session** (cash-up) | Accountability for the physical drawer on one terminal, from float to close | **No** (RT-17) |

Keeping these apart is what lets a cashier change mid-day without silently merging two people's
cash. It is the main lesson from SH (per device), TO (lock to employee) and DF (shift handover).

### 5.2 Flow

```text
NO_REGISTER ──open(float counted, operator)──▶ OPEN
OPEN ── sale(cash net of change) / refund(cash) / pay-in / pay-out [reason] / no-sale [MA, reason] ──▶ OPEN
OPEN ──start close──▶ COUNTING   (blind: expected hidden; counted cash entered)
COUNTING ──submit count──▶ COUNTED   (expected and variance revealed;
                                       expected = opening + net cash sales − cash refunds + pay-in − pay-out, I-15)
COUNTED ──|variance| ≤ threshold──▶ CLOSED
COUNTED ──|variance| > threshold──▶ APPROVAL_REQUIRED ──MA approve [reason]──▶ CLOSED
CLOSED  (immutable; corrections are new, attributed events; queued to Backend-Core like sales)
```

Guards to carry into RT-17:
- **Selling requires `OPEN`** when the profile requires a register. This is the VN-06 / VN-R11
  boundary screen.
- **Closing with a non-empty cart, a suspended sale or a live tender** is refused with the reason.
  RT-24 core rule 1 applies.
- **Operator change while `OPEN`:** the decision in 5.3(2).
- **Offline:** every transition above is local, and posting is deferred (§3).
- **RT-18** consumes `CLOSED` records with variance for the Console exception review. The POS
  must not invent fields the contract lacks.

### 5.3 Decisions RT-17 must take

These are already owned by RT-17. They are listed so RT-17 does not start without them:
1. Is a register session required to sell at all, per profile?
2. On a change of cashier while `OPEN`: (a) close and recount (strict), (b) hand over with a
   count (DF), or (c) a shared drawer with each event attributed.
3. Variance threshold and its unit (absolute minor units vs percent).
4. Blind count always, or configurable?
5. Pay-in/out reason list (fixed vs configured).

## 6. Device & Hardware Health target surface

Requirements for VN-S6, plus the S-1 follow-up. The rule throughout is to stay **quiet when
healthy, specific when blocking, and never fake a state** (X-2).

| # | Signal | Source of truth | Cashier sees | Manager sees | Notes |
|---|---|---|---|---|---|
| R-H1 | Backend connectivity | Main-process probe (new signal; VN-S6 dependency) | Indicator + offline banner listing the "Online only" actions (§3) | Same + last success time | Never hard-coded |
| R-H2 | Sync backlog | `sale_sync_state` counts | Nothing until RETRYING / ATTENTION | Counts, oldest age, dead-letter list | |
| R-H3 | Printer | Print pipeline result (`PRINT_FAILED`) | Banner on failure + retry / manual-receipt ack (VN-31) | Last print result | No polling claim. Status comes from the last real job |
| R-H4 | Cash drawer | `drawer_events` (`opened` / `failed`), "not configured" | Banner only when a cash sale's kick failed | Last kick result | Drawer state is not readable (kick only) |
| R-H5 | Scanner | None, since a keyboard wedge can't report | Scan-owner indicator + scan acknowledgement (VN-S3/S5) | — | OB-26 |
| R-H6 | Unsynced age | Oldest unsynced sale timestamp | Warning after *N* h (owner sets *N*) | Same | OB-28 |
| R-H7 | Catalogue freshness | `catalogue_sync_state` | Absolute timestamp (010) | Same + counts | Exists |
| R-H8 | Storage | DB write failure | `STORAGE_BLOCKED` blocking screen (VN-37) | Same | I-8 |
| R-H9 | External card terminal | **Not observable** (standalone) | Nothing. The cashier records the result | — | I-10 |
| R-H10 | Test actions | — | — | **Test print**, **test drawer** (audited, manager-only) | S-1, post-pilot |

## 7. Operator Recovery Center target surface

**Where it lives:**
- A manager-only POS surface (VN-M5 diagnostics, VN-S10 restyle).
- Cross-store posting triage stays in **Admin-Console** (RT-36 PoC; Console owns it).

**What it is:** a list of items that need a human. Each item states what is known, what is safe
to do, and what is forbidden. **No action on it re-captures a sale or re-charges a payment**
(core rule 3), and none of it needs direct DB edits (Risks page).

| Item | State | Safe action | Forbidden | Who |
|---|---|---|---|---|
| Sale queued / retrying | `QUEUED` / `RETRYING` | Wait. Show next retry time | Re-enter the sale | Info to all |
| Sale dead-lettered | `ATTENTION` | Escalate to Console with the sale reference. Export diagnostics | Edit the sale to get past the rejection (RT-24 sync rule) | Manager |
| Payment result unknown | `UNKNOWN` | Check the terminal and record the proven result (VN-R3) | Re-charge on timeout (I-7) | Cashier + manager |
| Finalization failed after settlement | `FINALIZATION_FAILED` | Retry finalization only (VN-29) | New sale | Cashier |
| Print failed | `PRINT_FAILED` | Retry print / manual-receipt ack (`receipts.retryPrint` / `manualOverride`) | Re-finalize | Cashier |
| Stuck payment attempt | `started` orphan | Automatic sweep on session start/end (`sweep-stuck-attempt.ts`) | — | System. **V-1 verifies it doesn't fire on a live tender** |
| Stuck operator shift | backend | Force-close (004) | — | Manager |
| Register session with variance | `APPROVAL_REQUIRED` | MA approve with reason | Edit the count after submit | Manager |
| Restored cart after restart | VN-36 | Continue or cancel explicitly | Silent discard | Cashier |

## 8. Genuine missing decisions and slices

These are the only items with no existing Jira owner. They are proposals for owner review.
Nothing is created from RT-111.

| ID | Kind | What | Why it is not duplicated | Tier |
|---|---|---|---|---|
| **MD-1** | Product decision | **Offline session start.** Should a cashier with a valid local PIN be able to start a session when Backend-Core is unreachable? If so, how is the backend's single-active-session rule reconciled later? Today it is refused (OB-05). | 004 enforces the rule. RT-24 says offline must not block selling but doesn't decide sign-in. No issue owns this | **Pilot** (a shift change during an outage leaves the till unusable) |
| **MD-2** | Contract decision | **Manager approval credential.** How a manager proves approval on the cashier's terminal (a local manager PIN like the cashier PIN, or a Clerk step-up) and whether it works offline. Today the gate accepts an unproven id and the UI sends none (OB-07). | VN-S7 and RT-28 both assume an approval mechanism exists. Neither defines its credential | **Pilot** (blocks VN-S7 and RT-28 implementation) |
| **V-1** | Verification | On Electron, `main@4ddfc95`, check: (a) inactivity timeout with a draft cart (is the cart recoverable after re-sign-in?); (b) inactivity timeout with a `started` attempt holding applied cash / external-card lines (does the sweep reverse them?); (c) unpair / re-pair with a non-empty outbox (OB-29). Report the first failing boundary. **No fix.** | VN-39 says "per RT-24; not verified". No Verification issue exists | **Pilot** (touches core rules 1–2 and I-8) |
| **MD-4** | Product decision | **No-sale drawer open:** in pilot or not. If in: manager-approved, reason, audited, and closing the $0-cash-sale path the drawer gate might allow. | RT-24 lists it as manager-gated. No slice or issue owns it | Post-pilot |
| **S-1** | Slice proposal | **Device test actions:** test print and test drawer kick, manager-only, audited, on the diagnostics surface. | VN-S6 covers indicators, not actions. RT-110 is a one-off bench run | Post-pilot |

Decision inputs that **stay inside existing owners**: §5.3 (RT-17), OB-28 threshold (VN-S6),
OB-23 receipt code (VN-S9 / 008-v2), §9.3 terminology (RT-17 / VN copy).

## 9. Traceability

### 9.1 To RT-24 (behaviour authority, unchanged)

| RT-24 area | Benchmark rows | Effect |
|---|---|---|
| Core rules 1–3 | OB-06, OB-30, OB-31, §7 | Unchanged. V-1 verifies `main` against rules 1–2 |
| Operational cashier lifecycle | OB-05, OB-10–OB-17, §5 | Feeds RT-17. No RT-24 semantics change |
| Manager-gated actions | OB-07, OB-08, OB-16, OB-37, §4 | §4 makes RT-24's classification explicit. MD-2 supplies the missing credential |
| Hardware and peripherals | OB-24–OB-26, §6 | Unchanged rule: quiet when healthy, actionable when blocking |
| Exception and recovery matrix | OB-27–OB-31, §7 | Unchanged |
| Offline behaviour | OB-01–OB-05, §3 | §3 is the explicit matrix RT-24 implied |
| Feature tiering | Tier column | Same tiers |

**Stop conditions checked:**
- No proposal changes RT-24 transaction semantics.
- No proposal bypasses Backend-Core.
- Card store-and-forward is rejected (OB-03), so no cardholder data enters RT.
- Unverifiable competitor features are marked UNVERIFIED, not guessed.
- Nothing here is implementation.

### 9.2 To RT-104 / VNext and existing Jira scope

| Existing owner | Rows routed to it |
|---|---|
| VN-S4 Checkout | OB-31 |
| VN-S5 Scanner & keys | OB-26, OB-36 |
| VN-S6 Operational status | OB-02, OB-24, OB-27, OB-28, §6 R-H1–R-H8 |
| VN-S7 Manager approval | OB-07, OB-08 (blocked by MD-2) |
| VN-S9 Sales lookup / receipt | OB-22, OB-23 |
| VN-S10 / VN-M5 Diagnostics | §7 host |
| VN-S11 Suspend / Resume | OB-32 |
| RT-15 / RT-14 Returns (W6) | OB-18, OB-19 |
| RT-17 Shift cash-up (W6) | OB-10–OB-15, OB-17, §5 |
| RT-18 Console variance (W6) | §5.2 RT-18 consumer note |
| RT-20 Pilot acceptance (W7) | Evidence list should include V-1 results and the §3 offline rows |
| RT-28 Discount authority | OB-07, §4 discount row |
| RT-78 Card settlement | OB-04 |

RT-104's visual references (VN-R7 offline, VN-R11 shift, VN-R6 manager, VN-R5 print failure) are
reused unchanged. This benchmark adds the behaviour tables those references render.

### 9.3 Arabic terminology input (not approved)

The table records observed regional usage only (DF) [DF9–DF11]. Choosing the terms is a copy
decision for RT-17 and VN copy.

| Concept | Observed regional term |
|---|---|
| Shift | الوردية |
| Sales session | جلسة البيع |
| Close session | غلق / إغلاق الجلسة |
| Shift handover | تسليم الوردية |
| Counted cash | النقدية الفعلية |
| Variance | الفرق |
| Shortage / overage | العجز / الزيادة |
| Cash drawer | درج النقدية |
| Return | مرتجع |
| Custody | العهدة |
| Opening float, cash in/out, void, reprint, manager approval | UNVERIFIED (no Daftra term observed) |

## 10. Next safe action

**Owner review of this benchmark.** In that review, decide MD-1 and MD-2, and approve opening V-1
as a bounded Verification issue. V-1 is the most safety-relevant item, because it tests `main`
against RT-24 core rules 1–2.

## Acceptance-criteria trace (RT-111)

| RT-111 acceptance criterion | Where |
|---|---|
| Current RT behaviour and plans verified against Jira, Confluence and GitHub `main`, not memory | Baseline. Code citations in §2–§4 and §7 |
| RT-104 content reused, not repeated | §1 links to 03 §2.9–2.10. §9.2 reuses VN slices and refs |
| Six products compared only on operating workflows | §1 |
| Every external claim traceable or marked unverified | Inline [code] refs, *(community)* / *(excerpt)* / UNVERIFIED tags, §11 |
| Explicit offline capability matrix and manager-approval matrix | §3, §4 |
| Shift/register, device-health and recovery-center target patterns | §5, §6, §7 |
| Improvements preserve RT architecture and RT-24 authority | §9.1 stop-condition check |
| Must-have pilot gaps vs H2/H3 distinguished | Tier column (Pilot / Post-pilot / Later) in §2 and §8 |
| Exactly one next safe action | §10 |
| No implementation | Docs-only change |

## 11. Sources

All accessed 2026-10-01.

**Shopify POS** (help.shopify.com/en/manual)
- SH1: `sell-in-person/shopify-pos/selling-offline/offline-features`
- SH2: `.../selling-offline/offline-payments`
- SH3: `.../selling-offline/offline-checkout`
- SH4: `your-account/users/roles/permissions/pos-permissions`
- SH5: `.../staff-management/understanding-pos-staff-management`
- SH6: `.../staff-management/pos-activity-log`
- SH8: `.../cash-register-management/register-sessions-in-shopify-pos`
- SH9: `.../cash-register-management/cash-tracking`
- SH10: `.../cash-tracking-reports-by-location`
- SH11: `.../order-management/complete-refund-orders`
- SH12: `.../order-management/unverified-returns`
- SH13: `.../order-management/search-orders`
- SH14: `.../receipt-management/managing-receipts`
- SH15: `.../payment-management/multiple-partial-payments`
- SH16: `.../inventory-management/searching-for-products`
- SH17: `sell-in-person/hardware/barcode-scanners`
- SH18: `sell-in-person/hardware/pos-hub` and `.../shopify-pos/troubleshooting`

**Square** (squareup.com/help/us/en/article/…)
- SQ1: 7777 offline mode
- SQ2: 8551 view offline payments
- SQ3: 5822 employee permissions
- SQ4: 8357 require passcodes
- SQ5: 3955 discounts
- SQ6: 8344 cash drawer sessions
- SQ7: 5097 split tender
- SQ8: 8238 build cart
- SQ9: 5143 barcode scanners
- SQ10: 6350 returns / exchanges
- SQ11: 6139 print receipts *(excerpt)*
- SQ12: squareup.com/us/en/staff/advanced-access *(excerpt)*
- SQ13: 5777 retail actions *(excerpt)*
- SQ14: 8354 connect cash drawer

**Toast**
- doc.toasttab.com/doc/platformguide/…:
  - TO1: platformOfflineMode
  - TO2: adminOfflineCCPayments
  - TO5: platformPostOutage
  - TO7: adminCashDrawers
  - TO8: adminCashDrawerPOSOperations
  - TO9: adminCashDrawerOperations *(excerpt)*
  - TO13: adminRefundPermissionsLimitations
- support.toasttab.com/en/article/…:
  - TO6: Using-Toast-in-Offline-Mode
  - TO10: Shift-Review-Overview
  - TO11: Access-Permissions-Reference
  - TO12: Understand-when-to-void-vs-refund
  - TO15: Exceptions-Report-Overview
  - TO16: using-a-scanner
  - TO17: Finding-Checks
  - TO18: My-Printer-Isnt-Working
  - TO19: New-POS-Managing-Payments

**Odoo** (odoo.com/documentation/19.0/applications/sales/point_of_sale/…)
- OD1: use.html
- OD2: extra/employee_login.html
- OD3: use/receipts.html
- OD4: hardware_network.html
- OD5: reporting.html
- OD6: 16.0 point_of_sale.html *(excerpt)*
- OD8: 16.0 shop/barcode.html
- OD9: payment_methods/terminals.html
- odoo.com/forum, all *(community)*:
  - OD13: …offline-mode-working-218314 and …mechanism-of-pos-offline-283217
  - OD14: …difference-at-closing-pos-session-label-235207

**ERPNext v15**
- docs.frappe.io:
  - EN1: erpnext/pos-workflows
  - EN6: erpnext/user/manual/en/pos-profile
- github.com/frappe/erpnext `version-15` source, read only:
  - EN4: accounts/doctype/pos_profile/pos_profile.json
  - EN5: selling/page/point_of_sale/pos_controller.js
  - EN7: accounts/doctype/pos_invoice/pos_invoice.py
  - EN12: pos_opening_entry/pos_opening_entry.json
  - EN14: pos_closing_entry/pos_closing_entry.py
  - EN15: pos_closing_entry/pos_closing_entry.js
  - EN16: pos_invoice_merge_log/pos_invoice_merge_log.py
  - EN17: selling/page/point_of_sale/pos_past_order_summary.js
- EN9: discuss.frappe.io/t/pos-offline-mode-erpnext-14-or-15/121783 *(community)*

**Daftra**
- daftra.com:
  - DF1: /blog/tutorials/شرح-نظام-نقاط-البيع
  - DF2: /en/pos/
  - DF5: /en/pos-desktop-application/
  - DF6: /تطبيق-نقاط-البيع-سطح-المكتب/
  - DF9: Arabic tutorial (same as DF1) *(excerpt)*
  - DF10: /hub/نقاط-البيع
  - DF18: /en/system_updates/ *(excerpt)*
- docs.daftra.com:
  - DF3: en/user_manual/daftra-pos-mobile-app/
  - DF4: en/tag/إعدادات-نقاط-البيع-en/
  - DF7: tutorial/ضبط-وتهيئة-إعدادات-المبيعات *(excerpt)*
  - DF8: en/user_manual/issuing-credit-notes-and-return-invoices/ (title)
  - DF11: en/tutorial/closing-a-pos-session/ *(excerpt)*
  - DF12: en/tutorial/returning-items-in-the-invoice/ *(excerpt)*
  - DF13: tutorial/الفرق-بين-الفاتورة-المرتجعة-والإشعار *(excerpt)*
  - DF14: en/user_manual/setting-up-printing-settings-from-the-pos-app/ (title)
  - DF15: en/user_manual/how-to-automatically-open-the-cashier-drawer-after-saving-the-invoice/ *(excerpt)*
