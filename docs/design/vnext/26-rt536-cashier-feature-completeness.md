# 26 — Cashier operational feature-completeness and benchmark gap review (RT-536)

> **Status: Planning deliverable for Jira RT-536. Nothing here authorises implementation.**
> Every follow-up below is a **proposal**; no Jira issue was created. This is a product-function
> gap review of the cashier's operational day. It is **not** another visual or usability audit.
> Those are already done in [11](11-operational-workflow-benchmark.md) (RT-111),
> [12](12-cashier-ux-usability-audit.md) / [14](14-rt159-packaged-reaudit.md) (RT-159),
> [13](13-pos-simplification-responsibility-audit.md) (RT-160) and the freeze package
> [15](15-vnext-freeze-package.md). This document links to them and does not repeat them.
>
> **Authority is unchanged.** GitHub `main` is the technical truth. RT-24 governs cashier
> behaviour ([08](08-rt24-invariants.md)). The owner-approved VNext freeze ([15](15-vnext-freeze-package.md))
> and [`docs/DESIGN.md`](../../DESIGN.md) govern the visuals. The owner decisions **D1–D8** of
> 2026-10-16 (Confluence *Owner decisions 2026-10-16 — POS pilot cashier scope*, page 40599553;
> RT-536 comments 12024 and 12037) set the pilot scope, and this document applies them. It does
> not reopen them.

## Baseline

| | |
|---|---|
| Repository | `Kemetra/POS` |
| Verified `origin/main` | `673a8f9e8780286422fa5b485c93d0aae3565f57` — RT-676 (#754), 2026-10-18 |
| Earlier RT-536 review | The owner-private review behind D1–D8 used `main@5e4bb189`. This document re-checks every row against `673a8f9` and records the change since then. |
| Jira read | RT-536 (description, comments 12024 and 12037), RT-106, RT-24, RT-15, RT-17, RT-28, RT-114, RT-158, RT-247, RT-248, RT-249, RT-250, RT-276, RT-439, RT-440, RT-441, RT-445, RT-446, RT-471, RT-478, RT-500, RT-503, RT-530, RT-531, RT-534 and children RT-537…RT-548, RT-550, RT-551, RT-556, RT-599, RT-600, RT-608, RT-654, RT-656, RT-658, RT-659, RT-660 (statuses as of 2026-10-18) |
| Confluence read | Owner decisions D1–D8 (40599553) |
| Code read on `main` | `src/renderer/router.tsx`, `src/renderer/v5/frame/nav-model.ts`, `specs/003-pos-ui-shell/contracts/shell-routes.ts`, `src/renderer/v5/checkout/{TenderPicker,PaymentLedger,RecoveryPanel}.tsx`, `src/renderer/v5/manager/diagnostics/DiagnosticsPanels.tsx`, `src/renderer/v5/{void/SaleVoidNotice,shift/ShiftNotice}.tsx`, `src/main/sale-history/{sale-history-service,sale-history-access}.ts`, `src/main/sales/sale-access-policy.ts`, `src/main/returns/{returns-service,returns-tender}.ts`, `src/main/index.ts` (feature flags, held-cart wiring) |
| External research | Lightspeed Retail X-Series official help centre only (2026-10-18), because RT-111 did not cover it. Square and Odoo are already in [11 §1](11-operational-workflow-benchmark.md#1-reference-matrix) and are not re-researched. Sources are listed in [§8](#8-sources). |

### Evidence levels used in this document

| Code | Meaning |
|---|---|
| **S** | Source read on `main@673a8f9`. Proves the code exists. Does not prove runtime behaviour. |
| **P-old** | Packaged Windows evidence from [14](14-rt159-packaged-reaudit.md) at `main@7b68398`. **Stale** wherever the surface was recomposed since then. |
| **J** | Jira evidence comment (packaged or lab). Taken as written; not re-run here. |
| **D** | Owner decision or approved design only. Nothing is built. |
| **—** | No evidence. The capability is untested. |

**No app, packaged build, test suite or hardware was run for this Planning item.** No live
packaged Windows terminal is reachable from this session. So no journey below has new packaged
proof. Each journey is marked with the best evidence that exists, and **untested** where none does
(RT-536 acceptance: "checked or clearly marked untested"). No Jira "Done" is used as proof that
something is implemented.

---

## 1. The cashier's operational day (inventory)

Each step lists the entry point a cashier uses on `main` today. **Ref** is the closest reference
flow ([11](11-operational-workflow-benchmark.md) for Shopify / Square / Toast / Odoo / ERPNext /
Daftra; **LS** for Lightspeed X-Series, added in [§5](#5-lightspeed-x-series-the-only-new-benchmark)).

| # | Step | Cashier entry point on `main` | Ref | Evidence |
|---|---|---|---|---|
| 1 | Pairing, first catalogue | `/pairing` → `/paired`. Read-down runs after pairing | 11 §1.5 | S, P-old (14 #0) |
| 2 | Sign-in (roster + PIN) | `/sign-in` | 11 §1.3 | S, P-old (14), G-1 (doc 18) |
| 3 | Open shift / float | `ShiftNotice` link in the frame → `/app/shift`. Advisory (D3) | 11 §5 | S, P-old (14 #16) |
| 4 | Scan / search / add | Sale `/app/cart`, scan field, search, D-C1 direct add | 11 §1.1 | S, P-old (14 #1–2) |
| 5 | Cart mutations (qty, remove) | Cart row controls | 11 §1.1 | S, P-old (14 #4) |
| 6 | Park / resume | Park control in the Sale → `/app/cart/parked` (RT-445) | 11 §1.1, LS-1 | S (#730) |
| 7 | Discount with manager approval | **No entry point.** Main enforces RT-28 (a cashier's discount needs a manager's RT-114 approval PIN; a manager or admin applies directly) through RT-608, but the Sale offers only «إزالة الخصم» and the renderer never calls `cart.discountPlaceholders.add`. Discount math is not defined either (spec 005 FR-023: `amount_minor = null`) | 11 §4 | S (#723, #727) |
| 8 | Tender: cash, split | `/app/checkout`, `TenderPicker`, `PaymentLedger` split lines | 11 §1.1 | S, P-old (14 #6) |
| 9 | Card / UNKNOWN outcome | «بطاقة» tile is shown; no outcome input (RT-250). **Out of pilot (D4)** | 11 §1.5 | S, P-old (14 #7–8) |
| 10 | Receipt, reprint | Completion print. Reprint only from «المبيعات», which the cashier nav does not show | 11 §1.5, LS-2 | S |
| 11 | Sales history / receipt review | `/app/sales` (store-wide, RT-542). Route admits cashier; **no cashier nav entry** | LS-2 | S (#699) |
| 12 | Return / refund | `/app/returns`, manager/admin only (D6), cash refund only | 11 §1.5, LS-4 | S, P-old (14 #15) |
| 13 | Void a finalized sale | `SaleVoidNotice` link → `/app/void`, another manager's PIN (RT-530) | 11 §4 | S (#743) |
| 14 | Offline sale, sync | Local-first sale + outbox; `StatusIndicator` in nav footer + notices stack (RT-604, RT-605) | 11 §3, LS-3 | S (#732, #734), P-old (14 #9) |
| 15 | Restart / inactivity / recovery | Lock screen (RT-593), held cart outlives the session (RT-352 / RT-442), manager recovery (RT-656) | 11 §7 | S, P-old (14 #10–13) |
| 16 | Cash movement (pay-in / pay-out) | `/app/shift` «إيداع نقدي» / «سحب نقدي» | 11 §5, LS-5 | S |
| 17 | Shift close, discrepancy | `/app/shift` blind count, manager approval rules (RT-17 policy) | 11 §5, LS-5 | S, P-old (14 #16) |
| 18 | Follow-up review (next day) | Manager: Dashboard, «المبيعات», shift status. Cashier: none except own sales by URL | LS-2 | S |

---

## 2. Feature parity / gap matrix

Status vocabulary (RT-536 §3): **Implemented** · **Designed only** · **Planned** ·
**Hard to discover** · **Verified missing** · **Unsupported (by decision)** · **Needs verification**.
Severity: **S0** blocks a pilot sale or loses money/data · **S1** pilot workflow broken or
unreachable · **S2** workaround exists but costly · **S3** friction · **S4** polish.
Pilot class from D1–D8 and RT-20.

| ID | Capability | Status on `main@673a8f9` | Evidence | Packaged proof | Existing issue | Operator impact | Sev | Pilot | Owner / mode |
|---|---|---|---|---|---|---|---|---|---|
| G-01 | Cashier «المبيعات» nav entry (D1) | **Verified missing.** `CASHIER_NAV = {'cart'}` in `nav-model.ts`; the route and main gate (RT-546) admit the cashier | S | — | RT-534, RT-249 (D1); RT-546 gate merged (#692) | Cashier cannot find own sales or a receipt without a manager | S1 | **Pilot must** | POS / Implementation |
| G-02 | «إعادة طباعة آخر إيصال» quick action (D1) | **Verified missing.** No action in the Sale or Completion; reprint exists only inside «المبيعات» (RT-542) | S | — | RT-249 (D1) | Customer asks for a copy; cashier must call a manager | S1 | **Pilot must** | POS / Implementation |
| G-03 | Store-wide date-range history (D5) | **Implemented (source)**, store-wide via Backend-Core with local fallback and truthful coverage labels | S (#699) | — (RT-543 To Do) | RT-534 → RT-542 In Review, RT-538 In Review, RT-543 To Do | Manager can answer "what sold yesterday on till 2" | — | Pilot must | Verification: RT-543 |
| G-04 | Cashier's history scope | **Implemented**: own sales only, reprint own only (OD-534-1/2 = A, `sale-access-policy.ts`) | S | — | RT-546 | As designed | — | Pilot must | — |
| G-05 | Receipt line order in history | **Verified missing (Backend-Core)**: `readSale` orders lines by name | J | — | RT-547 To Do | Reprinted slip differs from the original | S2 | Pilot must (receipt fidelity) | Backend-Core / Implementation |
| G-06 | Park / resume (D2) | **Implemented (source)**: RT-440 main/bridge, RT-445 UI (#730), RT-610 names | S | — (RT-446 To Do) | RT-445, RT-440 In Review; RT-446 To Do | — | — | Pilot must | Verification: RT-446 |
| G-07 | Keep card out of pilot use (D4) | **Verified missing.** `TenderPicker` always renders CASH, CARD, VOUCHER; card has no flag of its own (PAYMENTS covers cash too) | S | — | **None** (proposed in RT-536 12037) | A cashier can take a card with no outcome input or UNKNOWN recovery (14 #7–8) | S1 | **Pilot must** | POS / Planning → Implementation (new **P-26-1**) |
| G-08 | Card outcome input + UNKNOWN recovery | **Planned**, moved post-pilot by D4 | D | — | RT-250 To Do | — | — | Post-pilot | RT-250 |
| G-09 | Split tender | **Implemented** for cash + card + voucher lines (`PaymentLedger` split lines). With D4 the pilot split is cash-only, i.e. effectively one tender | S | — | RT-243 (freeze) | — | — | Optional in pilot | — |
| G-10 | Catalogue check lists matched items (D7) | **Verified missing.** Diagnostics search shows a result line (count) only | S | — | RT-478 / RT-503 Done (amend), proposed in 12037 | Manager cannot confirm a price or barcode from the till | S2 | Pilot must (manager) | POS / Docs → Implementation (new **P-26-3**) |
| G-11 | Hide empty «سجل المراجعة» / «الإعدادات» (D8) | **Verified missing.** Both still in `shellNavEntries` for manager/admin | S | — | RT-478 (amend), proposed in 12037 | Manager lands on empty pages | S3 | Pilot must (cheap) | POS / Implementation (new **P-26-4**) |
| G-12 | Returns, manager only, cash refund (D6) | **Implemented (source)**; card-paid sales refused (`card_tender_blocked`) | S, P-old (14 #15) | Old only; recomposed since (RT-660) | RT-15 Done, RT-660 In Review, RT-531 In Review (dependency) | — | — | Pilot must | Verification (see **P-26-5**) |
| G-13 | Void a finalized sale | **Implemented (source)** behind `SALE_VOID`; link always visible to signed-in operators when on | S | — | RT-530 In Review | — | — | Pilot (flag is owner's call, RT-530) | — |
| G-14 | Shift open / cash movement / close with discrepancy (D3) | **Implemented (source)**, advisory | S, P-old (14 #16) | Old only; recomposed since (RT-658) | RT-17 Done, RT-276 To Do | — | — | Pilot must | Verification: RT-276 |
| G-15 | Offline sale is visibly offline | **Implemented (source)**: `StatusIndicator` (RT-604), notices stack (RT-605). Closes 14 #9 in source | S | Old proof shows the gap; no new proof | RT-599 Done; RT-604 / RT-605 merged | — | — | Pilot must | Needs verification (**P-26-5**) |
| G-16 | Restart with live tender shows the payment | **Implemented (source)** by RT-352 / RT-442 (held cart and its attempt outlive the session) and manager recovery RT-441 / RT-656 | S | Old proof shows the gap (14 #13); no new proof | RT-441 In Review, RT-656 In Review | Money-at-risk path if it regresses | S0 if broken | Pilot must | Needs verification (**P-26-5**) |
| G-17 | 20+ line cart: newest line in view | **Needs verification.** 14 #3 found the newest line not scrolled into view at `7b68398`; the cart was recomposed since and no new capture exists | P-old | — | Freeze 15 Lane A / RT-243 (reconcile) | Cashier cannot see the item just scanned | S2 | Pilot must | Verification (**P-26-5**) |
| G-18 | "Printed" means spooled | **Needs verification.** 14 #12 recorded success with a paused queue | P-old | — | Reconcile against RT-159 freeze Lane A | Cashier believes a receipt printed | S2 | Pilot must | Verification (**P-26-5**) |
| G-19 | Manager-approved discount | **Verified missing (UI and math).** Main authority exists (RT-608, RT-614), but no renderer path adds a discount (`LiveSaleWorkspace` exposes only `onRemoveDiscount`; nothing calls `cart.discountPlaceholders.add`). The discount itself is still a placeholder: FR-023 leaves kind, math and catalogue to a future checkout feature (`amount_minor = null`), so an added discount would not change the total | S | — | RT-28 Done, RT-608 In Review, RT-614 Done: none owns the entry UI or the math | No discount can be given at the till, by either role | S1 | Pilot must (OD-26-4) | POS (+ Backend-Core capture) / Planning first (new **P-26-6**) |
| G-20 | Cash drawer optional | **Planned / in review** | J | — | RT-531 In Review | Forced attestation without a drawer | S2 | Pilot must (D6 dependency) | RT-531 |
| G-21 | Store business day = Africa/Cairo | **Implemented** (RT-550, RT-551, RT-553); lab TZ confirmation open | S | — | RT-544 To Do | Wrong day on sale numbers | S1 if wrong | Pilot must | Pilot ops: RT-544 |
| G-22 | Customer attach, loyalty, gift card, layaway, on-account | **Unsupported (by scope)**. Not in RT-24 or pilot | — | — | — | — | — | Optional / post-pilot | Not proposed |
| G-23 | Unreferenced (no-receipt) return | **Unsupported (by decision)**: returns need the sale (RT-15) | S | — | RT-15 | — | — | Post-pilot, owner call | Not proposed |
| G-24 | Exchange (return + new sale in one) | **Unsupported**: two separate journeys (return, then sale) | S | — | — | Two steps, two receipts | S3 | Post-pilot | Not proposed |

---

## 3. Reality check: 12 operator journeys

None of these was run in this session (see Evidence levels). Each row is the best evidence that
exists and what is still untested on `main@673a8f9`. Steps and entry points come from source.

| J | Journey | Entry → steps on `main` (source) | Keyboard / scanner | Role | Best evidence | Result |
|---|---|---|---|---|---|---|
| J1 | Normal cash sale | Sale → scan (direct add) → «الدفع» → cash → apply → complete | Scan-owned field (freeze 15 §3.1) | Cashier | P-old (14 #1, #6), S | **Untested on current `main`** (cart and checkout recomposed) |
| J2 | 20+ scan cart | as J1 with 23 lines | Scanner | Cashier | P-old (14 #3) | **Untested**; G-17 open |
| J3 | Interrupted / parked sale | Sale → park → new sale → `/app/cart/parked` → resume review | Keyboard per PK-3 refs | Cashier (own parks) | S (#730) | **Untested**, owned by RT-446 |
| J4 | Split tender | Checkout → cash part → second tender | — | Cashier | S | **Pilot: N/A by D4** (cash only). Untested |
| J5 | Previous sales by date + receipt detail | Manager: nav «المبيعات» → date range → sale → preview / reprint. Cashier: **no nav entry**; route only by typed URL (G-01) | Keyboard | Manager / admin; cashier own only | S (#699, #742) | **Untested**, owned by RT-543 (two terminals) |
| J6 | Reprint last receipt | Today: manager J5 path. Quick action missing (G-02) | — | Cashier | S | **Verified missing** (source) |
| J7 | Offline sale | Stop API → sell → indicator / notice → API back → synced | Scanner | Cashier | P-old (14 #9) showed no signal; S now has one | **Untested** with the new signal |
| J8 | Card UNKNOWN recovery | — | — | — | P-old (14 #8): no UI path | **Out of pilot (D4)**; G-07 must stop the tile being used |
| J9 | Return and refund | Manager: «المرتجعات» → sale number → lines → quote → cash payout | Keyboard | Manager / admin | P-old (14 #15), S (#746) | **Untested** on recomposed screen |
| J10 | Void a finalized sale | Link → `/app/void` → find → second manager PIN | Keyboard | Any signed-in, another manager approves | S (#743) | **Untested**, owned by RT-530 |
| J11 | Restart with a live tender | Close app mid-tender → relaunch → held cart / recovery | — | Cashier → manager | P-old (14 #13) showed the gap; S has the fix | **Untested**; G-16 S0 if regressed |
| J12 | Shift close with cash discrepancy | `/app/shift` → blind count ≠ expected → close (manager approval per RT-17) | Keyboard | Cashier, manager | P-old (14 #16) | **Untested**, owned by RT-276 (D3) |

Step counts and timing need a run. The only measured counts are the old ones in 14 §1 (for example
2 actions per scanned item before D-C1). They are not repeated as current.

---

## 4. Top five missing or fragmented cashier workflows

1. **Card can still be taken in a cash-only pilot (G-07, S1).** D4 removed card from the pilot, but
   the «بطاقة» tile is always rendered and there is no card-only flag. A card taken today has no
   outcome input and no UNKNOWN recovery (G-08). No issue owns this yet.
2. **The cashier cannot reach their own sales or reprint a receipt (G-01, G-02, S1).** The
   store-wide history, the role gate and the reprint are built (RT-542, RT-546), but D1's two entry
   points are not. The capability is there; the cashier cannot discover it.
3. **The money-at-risk recovery paths are fixed in source but unproven packaged (G-16, G-15).**
   Restart with a live tender and the offline signal were the worst packaged findings in
   [14](14-rt159-packaged-reaudit.md). Both have source fixes and no packaged re-run.
4. **History is not yet proven end to end (G-03, G-05).** RT-543 (two-terminal packaged walk) is
   To Do and RT-547 (line order) breaks reprint fidelity from Backend-Core.
5. **A discount cannot be given at the till (G-19, S1).** RT-28 / RT-608 / RT-614 built the
   authority and its main-side checks, but no screen starts a discount, so the enforcement is
   unreachable. The discount is also still a placeholder with no amount or math (FR-023). No
   issue owns the entry UI or the math.

Also open but smaller: the manager follow-up surfaces are half-honest (G-10, G-11). The catalogue
check shows only a count, and two nav entries lead to empty pages. Both are decided (D7, D8) and
unticketed.

---

## 5. Lightspeed X-Series: the only new benchmark

RT-111 ([11 §1](11-operational-workflow-benchmark.md#1-reference-matrix)) already covers Square and
Odoo. Lightspeed X-Series was not covered, so only it is added. Only the official help centre was
used. Nothing is copied: no screenshots, wording or assets. Lightspeed is a reference for
**workflow shape**, not authority, and its UI is proprietary.

| Ref | Lightspeed X-Series behaviour (official docs) | Applies to Retail Tower? | Pattern taken / rejected |
|---|---|---|---|
| LS-1 | Park a sale and retrieve it from the Sell screen; parking does not move stock; retrieval only in the outlet where it began [LS1, LS2] | Yes, matches spec 024 (same-terminal, own parks) | Confirms RT-445. Nothing new |
| LS-2 | One **Sales history** page holds history, open (parked) sales, returns and reprint; reprint opens from the expanded sale [LS3, LS4] | Yes, D1 / D5 | Taken: reprint and returns start from the sale in history. Rejected: merging parked sales into history (spec 024 keeps them in the Sale) |
| LS-3 | Offline: cash sales and parking only; no gift cards or loyalty; desktop cannot search by name offline; sales sync on reconnect and can be retried from a Status page; long offline periods cause errored sales [LS5] | Yes | Confirms the cash-first offline rule ([11 §3](11-operational-workflow-benchmark.md#3-offline-capability-matrix-retail-tower-target-state)). Retail Tower is stronger: local name search works offline |
| LS-4 | Return from the original sale in Sales history; an item returns once; split card + other refunds to the original card first [LS6] | Partly | Taken: return starts from the sale, once per line (RT-15 already). Card-to-original refund: post-pilot with RT-250 |
| LS-5 | Register closure explains counted vs expected cash with named causes (missed sale, wrong register, date) [LS7, LS8] | Yes, RT-17 / RT-276 | Candidate only: a cause hint on a discrepancy close. Not proposed now; RT-24 / RT-17 decide copy |
| LS-6 | Unreferenced (no-receipt) refunds must be enabled by the vendor [LS6] | No | Rejected for the pilot (G-23) |

**Licence / design boundary.** Docs read for behaviour only. No Lightspeed UI, text, icon or flow
diagram is reproduced. ERPNext POS stays a business reference only (CLAUDE.md §4).

---

## 6. Conflicts and decisions

### 6.1 Conflicts with RT-24, the freeze or W2/W6

| Conflict | Resolution |
|---|---|
| OD-6 / UX-09 said the cashier nav is the Sale only; D1 adds «المبيعات» | **Resolved by the owner** (D1 amends the cashier part). No new decision |
| Freeze 15 lists the card tile in the wave-1 checkout; D4 removes card from the pilot | Not a freeze conflict if the tile is hidden by a flag: the frozen drawing stays valid when the flag is on. See OD-26-1 |
| None found against RT-24 transaction semantics, permissions, fiscal, payment or catalogue authority | — |

### 6.2 Owner decisions (selected as recommended; the owner may revisit)

| ID | Question | Options | Selection |
|---|---|---|---|
| OD-26-1 | How is card kept out of pilot use (D4)? | (A) a new card-only feature flag, default **off**, that hides the tile **and** makes main refuse a `tender.apply` with `tender_type = external_card_terminal`; (B) hide the tile in the renderer only; (C) pilot procedure only | **A — Selected, recommended option; owner may revisit.** It is fail-closed in main (CLAUDE.md: main is the load-bearing check), and the freeze drawing stays valid with the flag on. B is bypassable; C is unenforced |
| OD-26-2 | Where does «إعادة طباعة آخر إيصال» live? | (A) on the Completion panel and as a Sale action while the cart is empty; (B) only inside «المبيعات» | **A — Selected, recommended option; owner may revisit.** D1 asks for a *quick* action; B is the existing path. Reuses RT-542 reprint and the RT-546 own-sale gate, so no new contract |
| OD-26-4 | Is a manager-approved manual discount in the first pilot? | (A) yes: run P-26-6 (math contract, then entry UI) before the pilot; (B) post-pilot: keep the main authority and add no UI | **A — Selected, recommended option; owner may revisit.** RT-28 / RT-608 were driven for the pilot, and pharmacy tills routinely need a manager-approved price reduction. The math is a contract decision (CLAUDE.md §9: money, capture and ERP effects), so it starts in Planning and may push the UI past the pilot date. If the owner picks B, G-19 moves to Post-pilot and P-26-6 is dropped |
| OD-26-3 | One combined packaged pilot-day walk, or each verification issue alone? | (A) one session runs RT-446, RT-543, RT-276 and the untested journeys J1, J2, J7, J9, J11 on one build; (B) separate sessions | **A — Selected, recommended option; owner may revisit.** One build and one lab setup; each issue still gets its own evidence comment |

---

## 7. Proposed bounded follow-up slices (not created)

Each slice is one repo and one bounded scope. Reconcile against existing issues before creating
anything; where an existing issue owns the work, the slice is a scoped comment on it, not a new
issue.

| Slice | Title | Repo | Work Mode | Reuse or new | Depends on | Acceptance |
|---|---|---|---|---|---|---|
| **P-26-1** | Keep card out of the pilot: card-only flag (OD-26-1) | `Kemetra/POS` | Planning (flag name, refusal reason, §A4 note) → Implementation | **New** (D4 follow-up in 12037; no owner today) | OD-26-1 | With the flag off: the «بطاقة» tile is not rendered; `tender.apply` with `tender_type = external_card_terminal` is refused in main with a typed reason and audited (the tender type first crosses the bridge there; `payments.start` stays tender-neutral and unchanged); cash and voucher are unchanged; with the flag on, behaviour and the frozen checkout drawing are unchanged; tests for both states |
| **P-26-2** | Cashier «المبيعات» nav entry + reprint last receipt (D1, OD-26-2) | `Kemetra/POS` | Implementation | **Reuse**: scope comment on RT-249 / RT-534 | RT-546 (gate, In Review), RT-542 (In Review) | `CASHIER_NAV` adds `sales`; Audit, Inventory, Settings stay hidden from the cashier; the reprint action reprints only the cashier's own last finalized sale through the existing RT-542 reprint; refusals use existing copy; no new bridge channel; nav and reprint tests |
| **P-26-3** | Catalogue check lists matched items (D7) | `Kemetra/POS` | Docs (G-6 Diagnostics reference addendum) → Implementation | **Reuse**: amend RT-478 / RT-503 via a child slice | Owner sign-off on the addendum | The result lists name, barcode and price for each match from the existing `catalogue.search`; empty and refused states drawn; no contract change |
| **P-26-4** | Hide «سجل المراجعة» and «الإعدادات» from the manager nav (D8) | `Kemetra/POS` | Implementation | **New** small child of RT-478 | — | Both entries absent from the nav for every role; routes and guards unchanged; nav-model test updated |
| **P-26-5** | Packaged pilot cashier-day walk (OD-26-3) | `Kemetra/POS` (lab rt9) | Verification | **Reuse** RT-446, RT-543, RT-276; one **new** issue only for J1, J2, J7, J9, J11 (G-15…G-18) which no issue owns | P-26-1, P-26-2, RT-531 merged; RT-544 confirmed | Each of J1–J12 has packaged evidence on one named SHA or a recorded first failing boundary; G-15…G-18 closed or turned into defects; procedure and lessons recorded on the Lab and Bench Runbook page |
| **P-26-6** | Manual discount: math contract, then entry UI on RT-28 / RT-114 (OD-26-4) | `Kemetra/POS` (Backend-Core capture as a named dependency) | **Planning** (discount kind and math, the capture fields Backend-Core and ERPNext-Connector receive, receipt line) → Docs (visual references) → Implementation | **New**; reconciled against RT-28 / RT-608 first (they own authority, not the UI or the math) | RT-608 merged; OD-26-4 = A; the math decision | Planning: an approved discount contract (kind, rounding, per-line scope, capture and receipt). Implementation: a control in the Sale for **both** roles, per FR-023 / D2. A cashier's request opens the RT-114 approval prompt and the add carries only the `approval_id`. A manager or admin applies directly as the approver. Main refusals use existing copy; the RT-614 trust check still holds at handoff; tests for the cashier-with-approval, manager-direct and refusal paths |
| — | Receipt line order from `readSale` | `Kemetra/Backend-Core` | Implementation | **Existing** RT-547 | — | As RT-547 |

Already proposed in RT-536 comment 12037 and **not repeated here**: header unification on
`ScreenSection`, the sale-sync status in the frame (largely delivered by RT-604 / RT-605; reconcile
before creating), and removal of orphan components. These are not cashier feature gaps.

### Pilot / post-pilot / optional summary

| Class | Items |
|---|---|
| **Pilot must** | G-01, G-02, G-07, G-19 (new work); G-10, G-11 (decided, small); G-03, G-06, G-12, G-14, G-15, G-16, G-17, G-18 (verification); G-05, G-20, G-21 (existing issues) |
| **Post-pilot** | G-08 card outcome / UNKNOWN (RT-250), card-to-original refunds, G-23, G-24 |
| **Optional** | G-09 split tender in the pilot (cash only), LS-5 discrepancy cause hint, G-22 customer features |

---

## 8. Sources

Lightspeed Retail X-Series help centre (official), read 2026-10-18:

- [LS1] Continuing saved sales on the Sell screen — https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534210016539-Continuing-saved-sales-on-the-Sell-screen
- [LS2] Making sales — https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534025069723-Making-sales
- [LS3] Understanding and managing the Sales history page — https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534095402907-Using-the-sales-history
- [LS4] Printing or emailing sales receipts — https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534036856219-Customer-receipts-in-Retail-POS-X-Series
- [LS5] Selling in offline mode — https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534272395163-Selling-in-offline-mode-in-Retail-POS-X-Series
- [LS6] Processing returns and refunds — https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534237536411-Returning-a-sale-in-Retail-POS-X-Series
- [LS7] My counted cash is not matching my expected cash — https://x-series-support.lightspeedhq.com/hc/en-us/articles/25533957655579-My-counted-cash-is-not-matching-my-expected-cash
- [LS8] What does each cash movement mean from the register closure report? — https://x-series-support.lightspeedhq.com/hc/en-us/articles/25534268781851-What-does-each-cash-movement-mean-from-the-register-closure-report

All other references are in [11 §11](11-operational-workflow-benchmark.md#11-sources).

## Acceptance-criteria trace (RT-536)

| RT-536 criterion | Where |
|---|---|
| Reuses RT-24/25/104/111/159, product-function gaps only | Header, §1 Ref column, §5 (Lightspeed only) |
| Evidence separates source, packaged, design and tickets; Jira Done not used as proof | Evidence levels; §2 Evidence and Packaged proof columns |
| 8–12 journeys checked or marked untested, incl. RT-534 date-range history | §3 (12 journeys; J5 is RT-534) |
| Every proposal traces to existing Jira or a justified new slice | §7 Reuse-or-new column |
| No change to transaction semantics, permissions, fiscal/payment, inventory/catalogue authority | §6.1; P-26-1 restricts a tender in the pilot by owner decision D4 and adds no new semantics |
