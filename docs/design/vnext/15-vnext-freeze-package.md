# 15 — VNext implementation-readiness freeze package (RT-159)

> **Status: APPROVED by the owner as written (RT-159 session, 2026-10-07)**, including the Lane C
> recommendations. Lane A priority: **A1 + A3 first**. This package is the freeze gate RT-159
> requires (comment 10746) before broad VNext cashier implementation. It authorises no
> implementation by itself: each slice in §7 becomes its own Jira issue first.
>
> **Precedence:**
> 1. RT-24 and later approved behaviour contracts (RT-26, RT-116, RT-17, RT-15, RT-10).
> 2. Owner decisions (README OD-1…OD-7, **D-C1** in [14 §5](14-rt159-packaged-reaudit.md#5-owner-decision-recorded-in-this-run-d-c1-2026-10-07)).
> 3. This package.
> 4. The Visual Acceptance Pack (visual only).
> 5. The older `references/`.
>
> Inputs: the packaged re-audit [14](14-rt159-packaged-reaudit.md), the preliminary audit
> [12](12-cashier-ux-usability-audit.md), [05](05-screen-state-inventory.md) screens,
> [06](06-component-state-inventory.md) components, [08](08-rt24-invariants.md) invariants,
> [`docs/DESIGN.md`](../../DESIGN.md), and the pack's journey map and classification
> (`visual-acceptance/E-Journey-map-and-classification/`).
>
> **Freeze rule (RT-159).** Once this package is owner-reviewed, implementation may refine pixels
> and local component mechanics inside it. Changes to journey structure, action hierarchy,
> financial or destructive behaviour, focus/scanner semantics or recovery behaviour need an
> explicit Planning decision.

## 0. What this package closes

| RT-159 freeze item | Before | Now | § |
|---|---|---|---|
| 1. Screen / journey map | Present (pack I3-JourneyMap); entry points partly undefined | Pack adopted; boundaries and 9 entry points fixed with their owners | §1 |
| 2. UI state matrix | Partial (05, pack spec cards) | 22 states with primary action, blocked actions, status, recovery and evidence | §2 |
| 3. Input / focus / scanner / shortcut contract | **Missing** (the pack marks focus and scanner as unresolved on every screen) | Written | §3 |
| 4. Component + token contract | Partial (06, DESIGN.md) | Canonical vocabulary, primitive vs composition, token roles, plus 4 additions | §4 |
| 5. Cashier copy / message catalog | **Missing** | Written (conditional rows marked) | §5 |
| 6. Visual acceptance pack | Present; 5 states behaviour-pending | Wave-1 reference per state, with the deltas an implementer must apply | §6 |
| 7. Implementation slice map | 09 (pre-pack) + 12 §13 (preliminary) | Three lanes; only frozen inputs are admitted to wave 1 | §7 |

The pack's four "unresolved on every screen" assumptions are handled as follows:

- **Digits:** Western digits everywhere, per OD-3 (approved). Validation against real receipts is still pending and gates only `shared/money` grouping.
- **Currency label:** `EGP` (OD-3). The pack's «ج.م» is overridden.
- **Keyboard shortcuts:** the wave-1 key set is frozen in §3.5. The F-key map stays an open decision (D-K1).
- **Focus and scanner:** frozen in §3.

---

## 1. Final screen and journey map

**Adopted:** the pack's `I3-JourneyMap` is the journey map. The main path is Sale → Checkout
(cash / card) → Completion → New sale, with UNKNOWN going to the Recovery workspace and never
repeating a completed sale. The boundaries below are fixed.

| Boundary | Enters by | Leaves by | Rule | Authority |
|---|---|---|---|---|
| **Sale** (`/app/cart`) | sign-in or unlock (cashier lands here, not on Dashboard), «بيع جديد», Back from Checkout | handoff → Checkout | the cart is editable; scan target owns input (§3) | RT-24 §A–§7 |
| **Checkout** (`/app/checkout`) | handoff of a non-empty cart | settle → Completion; Back/Esc → the **same** Sale while no funds are applied (RT-26); cancel | money column persists from Sale (Direction B); amount due and commit never scroll away | RT-24, RT-26, I-3, I-12 |
| **Completion** | finalized sale | «بيع جديد» → empty Sale | read-only; proof list only of proven facts; no edit affordance | I-5, I-7 |
| **Recovery workspace** | payment UNKNOWN or a stuck attempt; a live tender found after restart (N-05) | outcome recorded → Completion or cancelled | never a second charge or a second sale | RT-116, I-7 |

**Entry points** (each is a door from the frame or the Sale screen; the workflow behind it belongs to its owner):

| Entry point | Where | Who sees it | Behaviour owner / status | Reference |
|---|---|---|---|---|
| Returns / refunds | Frame nav «المرتجعات» | manager / admin only | RT-15 **Done** (flow exists; restyle only) | VN-R12 (entry), K19 |
| Held / suspended sales | Sale command bar | — (hidden until decided) | **RT-158 To Do**: not implementation-safe | I3-HeldConcept (concept) |
| Manager approval | In-sale gated actions | cashier requests, manager approves | **RT-114 To Do**: panel frozen, auth not designed | I3-Manager |
| Lock / restored | Inactivity or a manual lock | everyone | RT-116 **Done**, RT-117 Done, RT-161 In Review (privacy) | I3-Locked, I3-Restored |
| Shift / cash-up | Frame «الوردية» and the Sale shift banner | cashier opens and closes; manager sees status | RT-17 **Done** (screens shipped, V5) | VN-R11, K28/K29 |
| Manager → Cashiers (first PIN, reset, unlock) | Frame (manager) | manager / admin | RT-235 merged (functional); **VNext owns final IA** (RT-159 comment 11093) | none yet (see §6 gap G-3) |
| Device revoked / check again | Boot, or any 401 confirm | everyone | RT-215 merged | none (restyle only) |
| Pairing / Ready | First run, re-pair | installer / manager | 002 / RT-202 / RT-228 | none (restyle only) |
| Diagnostics, Audit, Inventory, Settings | Frame | manager / admin only (OD-6) | legacy placeholders | VN-M5/M6 |

**Traceability.** Every transition above cites RT-24 or a later contract. **Two transitions are
not decided and must not be invented by a slice:**
- whether a settled cash sale made before a shift opens counts in that shift's expected cash (N-06, check D-S1). "Shift required" is advisory by design (RT-17 comment 10919), so this is a confirmation, not a gate decision;
- the re-attach route from Sale to a live tender found after restart (N-05, RT-116 S5).

---

## 2. UI state matrix

Columns:
- **Primary**: the one next action.
- **Blocked**: what is visibly unavailable, with a reason.
- **Status**: what the cashier must see.
- **Recovery**: the way out.
- **Behaviour**: the authority and its status.
- **Evidence**: what a slice must capture.

Reference IDs: pack `I2-*` / `I3-*`, older `VN-R*`, re-audit `K*`.

| # | State | Primary | Blocked (shown with reason) | Status shown | Recovery | Behaviour | Ref | Evidence |
|---|---|---|---|---|---|---|---|---|
| S1 | Empty cart | (scan) | «الدفع» (no items) | scan target «جاهز للمسح» | — | RT-24 §3 ✅ | I2-Sale | scan with no click adds a line |
| S2 | Active sale / long cart | «الدفع» | — | total pinned; last-added row flashed and in view | undo last line (D-C1) | RT-24 §4, D-C1 ✅; undo ⏳ D-U1 | I2-Sale, I2-LongCart, K05/K06 | ≥6 rows at 1024 with banners; newest row visible |
| S3 | Scan not found / item unavailable | (keep scanning) | — | inline notice with the scanned code (LTR) | rescan or search | RT-24 §5 ✅ | — (copy §5 M-S3) | burst of an unknown code; focus unchanged |
| S4 | Flagged item (e.g. `prescription_required`) | (keep scanning) | — | line badge «بوصفة طبية» | — | D-C1 ✅ (display only, I-17) | — | flag visible on the row, no blocking |
| S5 | Discount requested | (manager) | discount entry for a cashier | «يحتاج موافقة المدير» | — | **RT-28 In Review, RT-114 To Do** ⏳ | I3-Manager | not implementation-safe |
| S6 | Held / suspended sale | — | — | — | — | **RT-158 To Do** ⏳ | I3-HeldConcept | hidden in wave 1 |
| S7 | Checkout: before tender | choose method | — | amount due (hero), order summary | Back / Esc → same Sale | RT-26 ✅ | I2-CheckoutUnder, VN-B2 | amount due visible at 23 lines, 1024 and 1280 |
| S8 | Cash: entering / shortfall | — | commit (reason «المبلغ أقل من المستحق») | due, received, remaining | Esc closes the entry → Back | I-9 ✅ | I2-CheckoutUnder | wedge burst refused in the amount field |
| S9 | Cash: change due | «تأكيد الدفع» | — | **change = received − due, computed once and shown until completion** | cancel (consequence stated) | I-9 ✅ | I2-CheckoutOver | change after apply equals DB `change_due_minor` |
| S10 | Card: waiting for terminal | record result | Back (an external op is in flight) | «أكمل العملية على جهاز البطاقات» | cancel with the terminal-void warning | I-10 ✅; cancel confirm RT-116 §3 ✅ | VN-R4 | reference field 0–6, optional |
| S11 | Card: declined / definitive failure | choose method again | — | «رُفضت العملية على الجهاز» | method again | **payment contract**: POS has no decline input today (F-13) ⏳ D-P1 | I3-CardFailed | not implementation-safe until D-P1 |
| S12 | Payment UNKNOWN | «متابعة إجراء الاستعادة» | new charge, Back, sign-out | danger «النتيجة غير مؤكدة», never «مرفوض» | recovery workspace | RT-116 / recovery contract ✅ (drawn); trigger path ⏳ D-P1 | I2-PayUnknown | no re-charge path in the UI |
| S13 | Finalizing / finalization failed | — / retry finalization | everything financial | info «جارٍ حفظ البيع…» / danger | retry after SETTLED only | RT-24 §19 ✅ | VN-28/29 | no success colour before persistence |
| S14 | Completion (+ receipt sent / failed) | «بيع جديد» | edits | proof list: payment ✓, sale no. (only if proven), receipt **sent** to printer / failed, sync pending / done; **change to hand back** | reprint, manual receipt | I-5, I-7 ✅; sale no. ⏳ D-N1 | I3-Receipt, VN-R5 | change shown equals DB; no «طُبع» unless proven |
| S15 | Offline while selling | (continue selling) | Checkout tenders per RT-113 | status «غير متصل — البيع محفوظ على الجهاز» | — | **RT-113 In Review** ⏳ (copy conditional) | I3-Offline | real API stop: indicator flips within 30 s |
| S16 | Reconnected / sync pending | — | — | «جارٍ إرسال N عملية…» → healthy | — | sync engine ✅; selling through reconnect ⏳ RT-113 | I3-Syncing | queue drains; indicator returns to healthy |
| S17 | Manager approval required | «طلب موافقة» | the gated action | panel with action, amount, reason | approved → exact prior state; denied → prior state | **RT-114 To Do** ⏳ | I3-Manager | not implementation-safe |
| S18 | Locked / restored | unlock (same cashier PIN) | everything behind the lock | **nothing of the sale visible** (privacy) | takeover by another operator | RT-116 ✅, RT-161 In Review; see §2.1 | I3-Locked, I3-Restored | lock hides lines and amounts |
| S19 | Live tender after restart | «متابعة الدفع المفتوح» | new sale until resolved | «يوجد دفع مفتوح من قبل إعادة التشغيل» | complete or cancel it | **RT-116 S5** ⏳ | — | re-attach proven on packaged |
| S20 | Shift required / closed | «فتح الوردية» | nothing (advisory by design, RT-17 comment 10919; flag off on pilot terminals until RT-17 is accepted) | banner «لا توجد وردية مفتوحة…» | open the shift | RT-17 ✅; attribution check ⏳ D-S1 | VN-R11, K25 | a pre-shift cash sale, then the shift close totals |
| S21 | Session credential expired (manager action) | «تسجيل الدخول مرة أخرى» | the manager action | «انتهت صلاحية دخول المدير…» | re-sign-in | **⏳ D-A1** (OQ-9) | K21 | first PIN 20 min after sign-in |
| S22 | Storage blocked / route error | — | collecting money | blocking ErrorScreen | per screen | I-8 ✅ | VN-R9 | — |

Manager → Cashiers (M-states, manager surface; RT-235 behaviour ✅, VNext presentation):

| # | State | Primary | Blocked | Status | Evidence |
|---|---|---|---|---|---|
| M1 | Roster loading / unreachable | retry | all row actions | «تعذّر تحميل قائمة الكاشير — تحقق من الاتصال» | backend stopped |
| M2 | Cashier with **no PIN on this terminal** | «تعيين أول رقم سري» | unlock, reset | badge «بدون رقم سري» | needs D-M1 (a status read exists? see §6 G-3) |
| M3 | Cashier with a PIN | — | «تعيين أول رقم سري» | badge «جاهز» | — |
| M4 | Cashier locked out | «فك القفل» | — | badge «مقفل» | — |
| M5 | Setting PIN (entry + confirm) | «حفظ» | — | two fields, digits only, **4–6** (the cashier PIN rule: `PIN_RE` in `pin-management.ts`; 6–8 is the separate manager-PIN rule) | mismatch refused inline |
| M6 | Refused (session expired, N-01) | «تسجيل الدخول مرة أخرى» | save | M-A3 copy | per D-A1 |

### 2.1 Lock-screen conflict, resolved explicitly

[08](08-rt24-invariants.md) I-8's *visual-consequence* column says the "lock overlay preserves
visible cart/tender summary". The pack's Locked state hides every line and amount. The owner's
lock decision **L3** (recorded in RT-159 comment 10804) and **RT-161** ("lock screen must hide the
preserved sale") both side with hiding. **This package governs: nothing of the sale is visible on
the lock surface.** The *behaviour* in I-8, that inactivity never discards money or cart, is
unchanged. The 08 visual note is superseded by L3 / RT-161, and 08 is left unedited pending
owner review.

---

## 3. Input, focus, scanner and shortcut contract

### 3.1 Scan ownership (the core rule)

1. **Exactly one scan owner at a time**: the `ScanTarget` in the Sale command bar. Its state is
   always visible: «جاهز للمسح» / «المسح متوقف — البحث مفتوح» / «المسح متوقف — نافذة مفتوحة» /
   «المسح غير متاح».
2. **A wedge burst is a scan, wherever focus is.** Definition (default, to be tuned on the pilot
   scanner, R-hw): 6 or more characters, inter-key gap ≤ 35 ms, terminated by Enter. A burst that
   arrives while focus is on any **button, row control, note field or the page body** is routed to
   the scan owner and **never activates the focused control**. This fixes F-01.
3. **Fields that must never receive a scan:** money fields (cash amount, opening float, counted
   cash, pay-in / pay-out), PIN fields, the card reference. A burst there is rejected with the
   inline notice M-S5 and the field keeps its previous value. This fixes the F-02 UI side; the
   main-process plausibility bound is decision D-F2.
4. **The search field** owns typing. A burst into the search field is treated as a scan (resolved
   barcode → direct add) and the field is cleared. This removes the F-07 failure where the barcode
   went into search.
5. **Dialogs** suspend scanning visibly («المسح متوقف — نافذة مفتوحة»). A burst during a dialog
   is **not** dropped silently: it is refused with notice M-S6 and nothing is added. With D-C1 the
   add-confirm dialog no longer exists, so this applies only to the remaining dialogs (void,
   sign-out, manager approval, cancel after card).
6. **After every action, focus returns to the scan owner**: add, undo, delete, quantity change,
   dialog close, Back from Checkout and «بيع جديد». The exceptions are search, when the cashier is
   typing, and an open entry field.
7. **Direct add (D-C1).** A resolved scan or a picked search result adds immediately (or adds +1
   to an existing line). The acknowledgement is: the row flashes (150 ms, none under
   reduced-motion), the row scrolls into view, and the last-scan line reads «أُضيف: <name>». There
   is no confirm dialog.

### 3.2 Default focus per screen

| Screen | Default focus on entry | Notes |
|---|---|---|
| Sale | scan owner (not a focusable input; the page listens) | arriving from sign-in, unlock, «بيع جديد» or Back |
| Search open | search field | Esc closes the results and returns to the scan owner |
| Checkout | the first enabled tender tile | Back is the first control in the reading order |
| Cash entry | the amount field (typing allowed; bursts refused) | Esc closes the entry; a second Esc = Back if allowed |
| Card entry | the "record result" control; the reference is optional | — |
| Completion | «بيع جديد» | a scan here does not start a sale implicitly; it shows M-S7 |
| Dialog | the **safe** option (cancel / stay) | destructive confirm is never the default (fixes F-22) |
| Lock | PIN | scanner blocked |
| Sign-in | the cashier roster (first tile); PIN pad after selection | the PIN pad must be in view at 1024 and 1280 |

### 3.3 Enter / Esc / Tab

| Key | Sale | Checkout | Dialog | Money field |
|---|---|---|---|---|
| **Enter** | ends a scan burst; in search = pick the highlighted result | activates the focused control only; **never tenders** (I-4) | activates the focused (safe-default) button | does not apply the tender (today's behaviour, kept) |
| **Esc** | closes search results | closes the open entry, then Back (RT-26 layer order) | closes as "cancel" | clears nothing; closes the entry |
| **Tab** | DOM order: command bar → cart (**one tab stop**; rows by ↑/↓) → money column | tender tiles → entry → ledger commit | trapped | — |
| **↑ / ↓** | move the focused cart row; in search, move the highlighted result (fixes "ArrowDown inert") | — | — | no key-repeat on money |
| **Delete** | delete the focused row (with undo) | — | — | — |
| **+ / −** | quantity on the focused row only (I-4) | — | — | — |

### 3.4 Pointer and touch

Pointer and touch may do everything the keyboard does, at 44 px or more. **A click never leaves
focus on a row control after the action:** focus returns to the scan owner (rule 6). **Action
slots are stable:** a commit never moves into a position a destructive or cancel action held in
the previous state of the same region (fixes N-02; see §4 rule A3).

### 3.5 Shortcuts in wave 1

**Frozen for wave 1: only `Esc`, `Enter`, `Tab`, `↑/↓`, `Delete` and `+/−` as above.** No F-key
is bound and no keycap is drawn except `Esc` on Back (bound today). RT-24's proposed map (F1 help,
F2, F3, F4, F8, F9, Ctrl+Enter, Ctrl+N, Ctrl+P, Ctrl+Shift+L) stays **decision D-K1** and needs
conflict testing (Electron/Windows/Arabic layout and the pilot scanner's suffix). Wave-1 slices
must not invent keys.

---

## 4. Component and token contract

The canonical vocabulary is [06](06-component-state-inventory.md). This section only names the
RT-159 freeze terms, says which are **shared primitives** (one implementation under
`src/renderer/v5/**`, used everywhere) and which are **workflow compositions** (built from the
primitives, owned by one slice), and lists the four additions.

| Freeze term (RT-159) | 06 component(s) | Kind | Owner slice |
|---|---|---|---|
| Shell / navigation | `Frame`, `NavLink`, `Titlebar` | primitive | W1-A |
| Command bar | `ScanTarget` + `SearchField` + `ProductResultList` | composition | W1-B |
| Cart line | `CartRow` (+ new `UndoNotice`) | composition | W1-B |
| Quantity control | `QtyStepper` | primitive | W1-B |
| Money column | `TotalsBand` → `PaymentLedger` (same slot Sale → Checkout) | composition | W1-B / W1-C |
| Payment selector | `TenderPicker` | composition | W1-C |
| Status banner / chip | `Banner`, `StatusIndicator`, `Badge` | primitive | W1-A |
| Inline validation | `Notice`, field `E` state | primitive | W1-A |
| Toast | `Toast` (neutral acknowledgements only) | primitive | W1-A |
| Modal / approval surface | `Dialog`, `ConfirmDialog`, `ManagerApprovalSheet` | primitive (+ composition for approval) | W1-A (approval: after RT-114) |
| Empty state | `Notice` (info) inside the region | primitive | W1-A |
| Recovery surface | `RecoveryPanel`, `ErrorScreen` | composition | W1-C / W1-A |

**Additions (not in 06):**
- **A1 `UndoNotice`.** An inline, time-boxed (8 s) «تراجع» for the last add or delete. It is
  focusable and announced politely. **Behaviour is pending D-U1** (no restore-line operation
  exists today).
- **A2 `ActionSlots`.** A region's actions live in fixed slots: inline-end = primary/commit,
  inline-start = cancel/back. A slot that is empty in one state stays empty rather than being
  reused by an action of the opposite consequence (N-02).
- **A3 `ScanStatus`.** The visible state of the scan owner (§3.1) inside `ScanTarget`, with text
  plus an icon and never colour only.
- **A4 `ProofList`.** The completion list of proven facts (payment, sale number, receipt sent,
  sync), built from `StateLine`. It never shows an unproven fact as success.

**Token roles** come from the DESIGN.md frontmatter (values = shipped `tailwind.css`). *VN-S2* adds
the role aliases only, with no value changes:

| Role | Tokens |
|---|---|
| Density | `--space-1…9` (4-px scale); control heights md 44 / lg 56; tender tile 72/84; cart row target **≤ 60 px** at 1280, **≤ 52 px** at 1024 (today 72 px). Keep the 44 px floor |
| Typography | `--type-amount-hero` 44/36, `--type-amount-total` 30/24, `--type-screen-title` 20, `--type-section` 16, `--type-control-lg` 16, `--type-body` 14, `--type-money-row` 14 mono tnum, `--type-meta` 12, `--type-kbd` 11 (keycaps only) |
| Surfaces / elevation | background, surface, surface-elevated, surface-sunken; **one shadow, overlay**; borders before shadows |
| Status | success (proven only) · warning (degraded) · danger (destructive, blocking, UNKNOWN) · info (pending / recorded-not-proven) |
| Focus | 2 px outline in `primary`, 2 px offset, on every focusable element; never box-shadow only |
| Disabled / loading | sunken fill + muted ink + reason in the same region (no opacity fade); loading keeps the label and adds a spinner |
| High contrast | `forced-colors: active` — outlines, `Highlight`/`HighlightText` on selection, a 3 px `ButtonText` border on primary, every state with text or an icon |

---

## 5. Cashier copy and message catalog

**Rules:**
1. Arabic only on cashier and manager surfaces: no bilingual «… (English)» labels, no English
   fallbacks.
2. Money, quantities, IDs, sale numbers, barcodes and times are LTR runs inside `<bdi dir="ltr">`
   with Western digits (OD-3), with `EGP` after the amount (`18.50 EGP`). Punctuation stays
   outside the isolated run.
3. No internal terms or raw states (`reversal_pending`, `LIFO`, `not_signed_in`, `UNKNOWN`,
   `envelope`).
4. Every error says **what happened, what is safe, and what to do**. «حاول مرة أخرى» appears only
   where a retry can succeed.
5. «طُبع» only for a proven print; for OS-print use «أُرسل الإيصال للطابعة».
6. UNKNOWN is never «مرفوض».

Conditional rows (marked ⏳) depend on the named contract and must not ship before it.

| ID | Situation | Copy (Arabic, final unless ⏳) | Tone |
|---|---|---|---|
| **Scanning and sale** | | | |
| M-S1 | Scan owner ready / paused (search) / paused (dialog) / unavailable | «جاهز للمسح» / «المسح متوقف — البحث مفتوح» / «المسح متوقف — نافذة مفتوحة» / «المسح غير متاح» | neutral |
| M-S2 | Item added (direct add) | «أُضيف: ‹الاسم›» · undo «تراجع» ⏳ D-U1 | neutral |
| M-S3 | Unknown barcode | «الباركود ‹code› غير موجود في الكتالوج. امسح مرة أخرى أو ابحث بالاسم.» | warning |
| M-S4 | Item unavailable | «‹الاسم› غير متاح للبيع حاليًا.» | warning |
| M-S5 | Scan into a money / PIN field | «لا يُقبل المسح في هذا الحقل. أدخل المبلغ بالأرقام.» | warning |
| M-S6 | Scan while a dialog is open | «أغلق النافذة أولاً ثم امسح الصنف.» | warning |
| M-S7 | Scan on a completed sale | «هذا البيع مكتمل. اضغط «بيع جديد» ثم امسح الصنف.» | info |
| M-S8 | Line deleted | «حُذف ‹الاسم›.» · «تراجع» ⏳ D-U1 | neutral |
| M-S9 | Prescription flag | «بوصفة طبية» (line badge) | info |
| M-S10 | Catalogue stale / never downloaded | «الكتالوج لم يُحدَّث منذ ‹time›.» / «لم يُنزَّل الكتالوج بعد — جارٍ التحديث…» | warning |
| **Checkout and payment** | | | |
| M-P1 | Back refused (money recorded) | «لا يمكن الرجوع إلى البيع بعد تسجيل مبلغ. أكمل الدفع أو ألغِه.» | info |
| M-P2 | Back refused after a reversal (N-13) | «أُلغي المبلغ المسجَّل. اختر طريقة دفع أخرى أو ألغِ البيع.» | info |
| M-P3 | Back while an entry is open (N-12) | «اضغط Esc لإغلاق إدخال المبلغ أولاً.» | neutral |
| M-P4 | Cash shortfall | «المبلغ المستلم أقل من المستحق بـ ‹amount›.» | warning |
| M-P5 | Change to hand back (ledger and completion) | «الباقي للعميل ‹amount›» | neutral, large |
| M-P6 | Card waiting | «أكمل العملية على جهاز البطاقات، ثم سجّل النتيجة.» | info |
| M-P7 | Cancel after a card was recorded (confirm, RT-116 §3) | «إلغاء الدفع هنا لا يلغي الخصم على جهاز البطاقات. ألغِ العملية على الجهاز أولاً، ثم أكّد.» · actions «رجوع» (default) / «تأكيد الإلغاء» | danger |
| M-P8 | Card declined ⏳ D-P1 | «رُفضت العملية على جهاز البطاقات. لم يُسجَّل أي مبلغ. اختر طريقة دفع أخرى.» | warning |
| M-P9 | Result UNKNOWN | «النتيجة غير مؤكدة. لا تكرر الخصم. تحقق من جهاز البطاقات ثم تابع الاستعادة.» | danger |
| M-P10 | Finalizing | «جارٍ حفظ البيع…» | info |
| M-P11 | Finalization failed | «تم تسجيل الدفع لكن لم يُحفظ البيع. لا تكرر الدفع. أعد محاولة الحفظ.» | danger |
| M-P12 | Live tender after restart ⏳ RT-116 S5 | «يوجد دفع مفتوح بمبلغ ‹amount› من قبل إعادة التشغيل. أكمله أو ألغِه قبل بيع جديد.» | warning |
| **Completion and receipt** | | | |
| M-C1 | Completed | «اكتمل البيع» · «رقم البيع ‹no›» ⏳ D-N1 · «الباقي للعميل ‹amount›» | success (proven only) |
| M-C2 | Receipt sent (OS-print) | «أُرسل الإيصال للطابعة» | info |
| M-C3 | Receipt failed | «تعذّرت طباعة الإيصال. البيع محفوظ. أعد الطباعة أو سلّم إيصالًا يدويًا.» | warning |
| M-C4 | Drawer did not open ⏳ D-B1 (where and for how long it shows) | «لم يُفتح درج النقود. افتحه يدويًا.» | warning |
| **Offline and sync** ⏳ RT-113 | | | |
| M-O1 | Offline | «غير متصل — البيع محفوظ على هذا الجهاز وسيُرسَل عند عودة الاتصال.» | warning |
| M-O2 | Sync pending | «‹n› عمليات بانتظار الإرسال» | info |
| M-O3 | Sync needs attention (manager) | «تعذّر إرسال ‹n› عمليات. راجع المدير.» | danger |
| M-O4 | Healthy indicator | «متصل» (only from a real signal; never hard-coded) | success |
| **Manager approval** ⏳ RT-114 | | | |
| M-A1 | Approval needed | «هذا الإجراء يحتاج موافقة المدير.» | info |
| M-A2 | Approved / denied | «وافق المدير ‹الاسم›.» / «لم يوافق المدير. لم يتغيّر شيء.» | success / neutral |
| M-A3 | Manager session expired ⏳ D-A1 | «انتهت صلاحية دخول المدير. سجّل الدخول مرة أخرى للمتابعة.» | warning |
| **Held sales** ⏳ RT-158 | | | |
| M-H1 | Held / resume | «عُلِّق البيع ‹label›.» / «استئناف البيع» | neutral |
| **Returns entry** | | | |
| M-R1 | Not found | «لا يوجد بيع بهذا الرقم على هذا الجهاز. تأكد من الرقم في الإيصال.» | warning |
| M-R2 | Not available to role | (entry hidden for cashier; no message) | — |
| **Shift** | | | |
| M-W1 | Shift required | «لا توجد وردية مفتوحة على هذا الجهاز. افتح وردية بمبلغ الافتتاح قبل البيع.» (shipped) | warning |
| M-W2 | Shift opened / closed | «فُتحت الوردية.» / «أُغلقت الوردية.» (shipped) | success |
| M-W3 | Blind count hint | «عُدّ النقد في الدرج وأدخله. لا يظهر المبلغ المتوقع قبل تسجيل العدّ.» (shipped) | neutral |
| **Session and lock** | | | |
| M-L1 | Locked | «الطرفية مقفلة. أدخل الرقم السري للمتابعة.» | neutral |
| M-L2 | Sign-out with an open cart | «البيع الحالي لن يظهر بعد تسجيل الخروج حتى يُبنى استئنافه (RT-116 S4). هل تريد تسجيل الخروج؟» ⏳ RT-116 S4. Once it ships: «سيُحفظ البيع الحالي على هذا الجهاز…» · «البقاء مسجّلاً» (default) / «تسجيل الخروج» | warning |
| **Manager → Cashiers** | | | |
| M-K1 | Roster unreachable | «تعذّر تحميل قائمة الكاشير. تحقق من الاتصال ثم أعد المحاولة.» | warning |
| M-K2 | First PIN set | «تم تعيين الرقم السري لـ ‹الاسم›.» | success |
| M-K3 | PIN mismatch | «الرقمان غير متطابقين.» | warning |
| **Frame** | | | |
| M-F1 | Ready after restart (replaces English) | «الجهاز مرتبط وجاهز.» · «متابعة» | neutral |
| M-F2 | Screen too small | «الشاشة أصغر من 1024×768. كبّر النافذة أو استخدم شاشة أكبر.» | warning |

---

## 6. Visual acceptance pack: wave-1 reference per state

The pack is the visual reference wherever it overlaps (README precedence). Each slice captures
its states at **1024×768 and 1280×800**, light and `forced-colors`, and compares them against:

| State | 1280 reference | 1024 reference | Implementation-safe? | Deltas the implementer must apply |
|---|---|---|---|---|
| Default Sale | I2-Sale-1280 | I2-Sale-1024 | ✅ (hold controls excluded) | `EGP` not «ج.م»; «POS Pulse» wordmark (OD-5); no keycaps (§3.5); no confirm dialog (D-C1); scan status (A3); no lock button until RT-116 UI |
| Long cart | I2-LongCart-1280 | I2-LongCart-1024 | ✅ | newest row in view; row ≤60/52 px; ≥6 rows at 1024 **with** a banner present |
| Checkout / cash | I2-CheckoutUnder/Over-1280 | …-1024 | ✅ with deltas | the pack omits the amount input, quick chips, «بالضبط» and the keypad: take them from **VN-R2 / VN-B2** (`QuickAmounts` sets the value; LTR keypad). **Two-step apply → settle stays** (today's contract) unless D-P2 merges it; the pack's single «تأكيد الدفع وإتمام البيع» is not a behaviour change. The disabled voucher tile keeps its slot (I-11) |
| Payment failure | I3-CardFailed | I3-CardFailed-1024 | ⏳ D-P1 | visual frozen; the trigger needs a decline input |
| Payment UNKNOWN | I2-PayUnknown-1280 | I2-PayUnknown-1024 | ✅ visual / ⏳ trigger | never «مرفوض» |
| Offline / sync | I3-Offline, I3-Syncing | …-1024 | ⏳ RT-113 | indicator from a real signal only (X-2) |
| Held sale restore | I3-HeldConcept | — | ❌ concept (RT-158) | not in wave 1 |
| Manager approval | I3-Manager | I3-Manager-1024 | ⏳ RT-114 | panel visual frozen only |
| Lock / recovery | I3-Locked, I3-Restored | …-1024 | ✅ visual (§2.1) | nothing of the sale visible |
| Completion / receipt failure | I3-Receipt-1280 | I3-Receipt-1024 | ✅ with deltas | «أُرسل الإيصال للطابعة» rather than «طُبع» for OS-print (N-09); show «الباقي للعميل»; sale number only per D-N1; drawer warning placement per D-B1 |

**Gaps (no reference exists; new acceptance references needed before those slices):**
- **G-1** Sign-in and PIN (VN-03/04), the F-14 recompose.
- **G-2** Shift open / close / status (RT-17 shipped V5 screens, which are the de-facto
  reference: K28/K29).
- **G-3** Manager → Cashiers (M1–M6). This also needs a **PIN-status read** (D-M1) to show «بدون
  رقم سري» truthfully.
- **G-4** Restart re-attach (S19).
- **G-5** Undo notice (A1).

---

## 7. Implementation slice map (proposed; no issues created)

Three lanes. **Lane A** fixes pilot defects without changing behaviour and can start once the
owner accepts this package. **Lane B** is the VNext composition wave and is admitted only where
every input is frozen. **Lane C** contains decisions and contracts that must close first and
return to Planning.

Every implementation slice:
- cites [08](08-rt24-invariants.md) and §3 of this package;
- captures its states at 1024 and 1280, in light and `forced-colors`;
- includes a keyboard-only walk and a scanner walk (emulated burst + R-hw on the bench);
- runs axe on touched surfaces;
- runs `typecheck`, `lint` and `test --coverage`;
- records an Impeccable `audit`, then `harden` and `polish` before ship;
- gets owner visual approval before merge.

### Lane A — pilot defect fixes (behaviour-preserving)

| Slice | Scope | Findings | Work Mode | Depends on | Refs | Evidence |
|---|---|---|---|---|---|---|
| **A1** Cash change truth | show the change computed at apply (= DB `change_due_minor`) through completion; no money-math change | F-03 (S0) | Implementation | — | I2-CheckoutOver | packaged: change after apply = DB, ×3 amounts |
| **A2** Scanner ownership (direct-add excluded) | burst routing (§3.1 rules 2–6); bursts refused in money/PIN fields; focus return; scan during a dialog refused visibly | F-01, F-02 UI, F-07 | Implementation | — | §3 | emulated + real-scanner matrix (doc 12 §4.2 rows all "ok") |
| **A3** Checkout fit and affordance | amount due and commit pinned (never scrolled at 23 lines); commit with button chrome; stable action slots | F-09, F-10, N-02, N-03 | Implementation | VN-S2 tokens (aliases only) | I2-Checkout*, VN-B2 | 23-line captures 1024/1280; no swap between states |
| **A4** Truthful status copy | Arabic-only Checkout/completion/banner labels; «أُرسل الإيصال للطابعة»; remove the hard-coded «Online» pill (show nothing until VN-S6 / RT-113 provides a real signal) | F-15 (fake part), F-26, N-09, N-13 | Implementation | — | §5 | string tests; captures |

### Lane B — VNext wave 1 (frozen inputs only)

| Slice | Scope | Workflow owner | Work Mode | Depends on | Refs | Evidence |
|---|---|---|---|---|---|---|
| **W1-A** Foundation + frame | VN-S2 (role tokens, forced-colors, RouteLoading, ErrorScreen, Arabic ScreenTooSmall) + `Banner`/`Dialog`/`ConfirmDialog` primitives + cashier lands on Sale + OD-6 placeholders hidden for the cashier role (drawer-banner placement waits for D-B1) | W2 cashier flow | Implementation | owner acceptance of 15 | VN-S2 rows of 09; I2-Consistency | before/after captures identical except intended |
| **W1-B** Sale Direction B + direct add | VN-S12 (command bar, cart-first, money column, slim nav) + **D-C1 direct add** for scan and search pick + `ScanStatus` + newest row in view + ↑/↓ row focus | W2 | Implementation | W1-A, A2; **the direct-add and undo part also depends on D-U1** (the layout part may proceed without it, keeping confirm-first until D-U1 closes) | I2-Sale, I2-LongCart | ≥6 rows at 1024 with a banner; scan-without-click adds; KLM before/after |
| **W1-C** Checkout + completion clean-room | VN-S4 on the frozen states (S7–S10, S12–S14) with `PaymentLedger`, `ProofList`, the M-P/M-C copy | W2 | Implementation | W1-A, A1, A3 | I2-Checkout*, I2-PayUnknown, I3-Receipt | every payment state in the harness; packaged sale |
| **W1-D** Sign-in / Ready / pairing recompose | VN-S8 minus lock; the PIN pad in view; Arabic copy M-F1 | W2 | Implementation | W1-A, **G-1 reference** | new G-1 reference | 1024/1280; roster unreachable state |

### Lane C — decisions and contracts (Planning first; these return to Planning)

| ID | Decision / contract | Blocks | Recommendation |
|---|---|---|---|
| **D-K1** | RT-24 §C.5 key map (F-keys) | VN-S5 keys, keycaps | Keep wave 1 keyless (§3.5); conflict-test on the bench with the pilot scanner suffix |
| **D-U1** | Undo of the last add / delete: restore contract + audit event | A1 `UndoNotice`, M-S8 | Cart-bridge "restore line" with `cart.line_restored` audit; until then delete stays immediate (today) |
| **D-F2** | Main-process plausibility bound on cash received | F-02 main side | Bound by currency maximum (RT-17 already has a shift-amount bound) |
| **D-S1** | Shift is advisory by design (RT-17 comment 10919). Confirm on the bench whether a settled pre-shift cash sale is counted in the next shift's expected cash | S20, N-06 | Bench check under RT-17; only if it is not counted, raise a contract item |
| **D-B1** | Drawer-failure presentation: today a persistent bilingual banner (about 178 px) on every screen, across sessions and restarts (N-08) | W1-A banner work, M-C4 | Show it inside cash completion and in the status indicator; clear it after an acknowledgement or the next successful drawer event. This changes 008's presentation and needs an owner decision |
| **D-A1** | Manager JWT expiry (OQ-9): refresh vs re-auth prompt | N-01, M6, S21 | Re-auth prompt with M-A3 for pilot; refresh later |
| **D-N1** | Sale number display / quotability | S14, returns lookup | Short display form + recent-sales list for returns |
| **D-P1** | External-card decline / UNKNOWN input | S11, S12 trigger | Outcome selector on card entry (approved / declined / not sure) under RT-10 |
| **D-P2** | One-step vs two-step cash commit | W1-C variant | Keep two-step (today); revisit after W1-C |
| **D-M1** | Manager → Cashiers PIN-status read | G-3, M2–M4 | Add a read model; then design the surface |
| **RT-113 / 114 / 116 S4–S6 / 158 / 28 / 161** | existing contracts | S5, S6, S15–S19, M-O*, M-A*, M-H* | Unchanged owners; their UI slices follow their contracts |

**Not proposed:** a big-bang rewrite; any slice touching IPC/DB/API/payment/sync/ERP without its
Lane-C contract; Admin-Console work.

**Exactly one next safe action:** create the Lane A issues from §7, starting with **A1** (cash change truth) and **A3** (Checkout fit, affordance and stable action slots). Each is one issue, one repo (`Kemetra/POS`), Work Mode Implementation, citing this package and 08.
