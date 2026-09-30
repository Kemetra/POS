# 08 — What remains governed by RT-24 and must not change

> RT-104 may rethink presentation. It may **not** change the behaviour below. Every VNext slice
> must cite this list in its acceptance criteria. Sources: RT-24 description, RT-24 comments
> 10153/10155 (owner approval as planning baseline, 2026-09-27), Confluence page 7405593
> ("Cashier UX — RT-24 / RT-25 Review"), whiteboard 7864327, RT-10 D1–D8, RT-26, RT-27, RT-28,
> RT-103, specs 005/006 on `main@28890fa`.

## A. The three core rules

1. **Never silently lose a valid cart.**
2. **Never claim a payment state that is not proven.**
3. **Never convert a recovery action into a second sale or a second payment.**

## B. Invariants (MUST-NOT-CHANGE)

| # | Invariant | Visual consequence for VNext |
|---|---|---|
| I-1 | State-machine transitions and guards across all layers — Device/Session (`SETUP_REQUIRED`, `ACTIVE`, `LOCKED`, `TAKEOVER_PENDING`, `STORAGE_BLOCKED`), Cart (`EMPTY`, `EDITING`, `HANDOFF_PENDING`, `FROZEN`, `PARKED`, `CANCELLED`), Payment (`NONE`, `OPEN_NO_FUNDS`, `PROCESSING`, `FUNDS_APPLIED`, `SETTLED`, `CANCELLING`, `REVERSED`, `FAILED_NO_FUNDS`, `UNKNOWN`), Sale/Receipt (`FINALIZING`, `FINALIZED`, `FINALIZATION_FAILED`; `READY`, `PRINTING`, `PRINTED`, `PRINT_FAILED`), Sync (`QUEUED`, `ACCEPTED`, `POSTING`, `POSTED`, `RETRYING`, `ATTENTION`). These are RT-24 design concepts, "not a request to copy a new enum without contract review". | Screens render states; they never own transitions. The renderer displays and requests; main/local storage decides. |
| I-2 | **Suspend ≠ Cancel ≠ post-handoff Void ≠ post-completion Return/Refund.** | Four distinct controls, labels and colours; never merged into one "cancel" menu. |
| I-3 | Total, payment action, cancel-or-back, and suspend (where applicable) are always visible and clear. | Pinned regions at 1024 and 1280 (design language §16). |
| I-4 | Scanner/keyboard semantics: shortcuts do not conflict with scanner input; same key = same meaning within a state; no scanner input into PIN/money fields; **no tendering via scanner Enter**; **no key-repeat on money**; `Delete` and `+/-` act only when a cart row has focus; every shortcut has a visible button alternative. | Financial confirm shows `Ctrl+Enter`, never bare Enter; hints only for bound keys. |
| I-5 | Completed-sale immutability; later corrections are explicit events routed to Return/Refund. | Completion panel has no edit affordance; "return" is an entry point, not an edit. |
| I-6 | Manager-gated behaviour: approval bound to action + amount/cart version + reason + audit; manager auth never exposes credentials; returns to the exact prior safe state after approve/deny. **Every positive manual discount is manager-only** (owner decision, RT-28; spec 005 threshold rule on `main` is stale and tracked by RT-28). | `ManagerApprovalSheet` spec (§13 of 04). No "below threshold" cashier path is ever drawn. |
| I-7 | **UNKNOWN is not a decline.** No re-charge on timeout. SETTLED ≠ FINALIZED ≠ PRINTED ≠ POSTED. No "latest sale" guessing for sale/receipt numbers. | Separate UNKNOWN recovery surface (VN-R3 reference); completion shows only proven references. |
| I-8 | Storage failure blocks new collection; no success shown before persistence; inactivity never discards money or cart. | `STORAGE_BLOCKED` blocking screen; lock overlay preserves visible cart/tender summary. |
| I-9 | Cash: **Exact fills the amount only**; quick-amount buttons **set** the received amount, they do not add; change is clear; integer minor units; duplicate-submit prevention. | Quick amounts render as "set" chips with the resulting value; change/shortfall line always visible. |
| I-10 | External card: POS records a result confirmed on the standalone terminal; no bank API is claimed; no PAN/CVV in POS; `external_reference` optional, `^[A-Z0-9]{0,6}$`, non-sensitive, redacted from logs (spec 006, RT-27 correction 2). | Card entry shows "record the terminal result" copy; reference field optional with 0–6 chars; no "min 4 digits". |
| I-11 | Pilot tenders are **cash + card_external** only (RT-10 D2). Internal voucher is disabled for pilot (RT-103, flag `POS_PULSE_FEATURE_VOUCHER_TENDER` default off); tile keeps its slot, disabled, «غير متاحة حاليًا». Split/multi-tender is post-pilot. Credit/third-party payer is not a till tender (ADR-0005). | Tender picker shows cash, card, disabled voucher; no split UI, no insurance/credit tile in pilot references. |
| I-12 | Back/Esc from Checkout (RT-26, approved RT-24 behaviour): return to the **same draft** only while no funds applied and no in-flight/ambiguous external op; prior envelope invalidated atomically; Back and Confirm cannot both succeed; refused once money applied / PROCESSING / SETTLED / CANCELLING / UNKNOWN. **Not implemented on `main`** (RT-26 To Do). | VNext draws the Back control and its refused state; slices must not ship an enabled Back before RT-26 lands. |
| I-13 | Suspend/Resume v1: same terminal/store, unpaid only, optional label; durable save before clearing the surface; no localStorage substitute; no implicit stock reservation; one active owner; conflict = suspend-current-and-resume-selected (primary) or keep-current (secondary); no merge/overwrite; price/availability changes shown and explicitly accepted. **Not implemented** (no park bridge, D-007). | References show it as target state; implementation requires its own contract slice. |
| I-14 | Customization only between transactions; never changes guards, shortcuts, or hides totals/financial actions. | Density/theme switch unavailable while a cart is non-empty. |
| I-15 | Shift expected cash = opening + net cash sales − cash refunds + pay-in − pay-out (do not subtract change twice). Shift lifecycle and cash-up belong to RT-17 (not built). | Shift screens are boundary/entry references only. |
| I-16 | Returns: original sale, lines and quantities, amounts and tender derived from the contract (RT-14/RT-15); refunds pay out `refundTenders` (cash only for pilot); returns online-only; `POS_RETURNS_ENABLED` off. | Returns reference is an entry/handoff state only. |
| I-17 | Pharmacy extension (unit/pack/batch/expiry) only where contracts allow; **no** prescriptions workflow, insurance, therapeutic substitution, or compliance claims. Egyptian product: **no** ZATCA/SAR/15% VAT/mada content (022 RECONCILIATION §B). VAT is deferred (`total_tax_minor` = 0), so the tax line stays «قيد الإضافة · لا تُحسب هنا». | No VAT amounts, QR codes, or fiscal claims on any VNext reference. |

## C. RT-24 proposals that were approved "as baseline" but should be re-confirmed per slice

RT-24 comment 10153 offered five decisions for approval; comment 10155 approved the behaviour map
as the planning baseline without itemising them. RT-26 treats (3) as approved. VNext draws them as
target behaviour but each implementing slice must confirm:

1. **Direct add on resolved scan** instead of today's confirm-first (009) — VNext references keep
   the **current confirm-first dialog** for search results and show direct-add only as the RT-24
   target for resolved scans (VN-R1 note).
2. **Lazy cart creation** on first add (the review page itself says "not assumed approved").
3. **Back to the same draft** (RT-26 — treated as approved).
4. **Same-device suspend/resume policy** (I-13).
5. **The key map** (F1 help, F2 scan/search, F3 suspended list, F4 suspend, F6 quantity, F8
   checkout, F9 exact cash, Ctrl+Enter visible financial confirmation, Esc close layer/safe back,
   Ctrl+N guarded new sale, Ctrl+P linked receipt, Ctrl+Shift+L lock) — "proposals that need
   conflict testing for Electron/Windows/Arabic input".

## D. Conflicts found by this rebaseline (raised explicitly, not resolved here)

| # | Conflict | Winner today | Needed |
|---|---|---|---|
| X-1 | RT-24 requires "no scanner input captured by unrelated controls or modal traps"; a second scan while the confirm-add dialog is open sends Enter to the focused Add button (`slice-f-visual-review.md:151`, `execution-ledger.md:98`). | RT-24 | Behaviour fix inside VN-S5 (scanner hardening), not a visual change. |
| X-2 | RT-24 perceived-performance + "Offline/Sync visible": connection state is hard-coded `online`, `SaleSyncStatus` unmounted. | RT-24 | VN-S6 needs a real signal; must not render a fake "متصل". |
| X-3 | Checkout at 1280 pushes the amount due below the tender methods and off-screen during cash entry (`tailwind.css:2150-2180`, `h-retire-1280-06`). Violates I-3/P1. | RT-24 | Checkout clean-room (VN-S4). |
| X-4 | Completion shows no sale/receipt reference (blocked on correlation id, `PaymentSurface.tsx:126-140`); receipt print disabled ("Printing lands in Slice 3"). RT-24 post-sale flow requires receipt/print/reprint. | RT-24 | Outside visual scope — contract/implementation dependency, listed in slices. |
| X-5 | Spec 005 threshold discount authority vs owner manager-only decision. | Owner decision (RT-28) | RT-28 reconciliation before any discount UI. |
| X-6 | RT-103 enforcement is UI-only; main-process `tender.apply` still accepts `internal_voucher`. | — | Not a visual issue; noted so VNext does not claim voucher is impossible. |
