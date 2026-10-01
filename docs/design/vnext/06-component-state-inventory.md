# 06 — Component / state inventory (VNext)

> One vocabulary, one implementation per component, under `src/renderer/v5/**` (023 clean-room
> import/class wall retained). "Replaces" lists today's divergent implementations on
> `main@28890fa` (see [01 §5](01-current-state-audit.md)). Every component must render every listed
> state in light and in `forced-colors: active`.
>
> **Shortcuts are conditional.** Every key named below (`F8` on `CheckoutCTA`, `F9` exact cash,
> `Ctrl+Enter` commit and others) is RT-24's proposed, unconfirmed key map (§C.5). A component
> renders the hint and binds the key only once VN-S5 confirms it; until then the control works
> by click or tap and shows no hint ([`docs/DESIGN.md`](../../DESIGN.md), Keyboard hints).
> Suspend-related components (`SuspendedSaleList`, `ResumeConflictPanel`, the suspend button)
> belong to VN-S11.

Common states abbreviated: **R** rest · **H** hover · **F** focus-visible · **P** pressed · **D**
disabled (with reason) · **L** loading/in-progress · **E** error.

## Frame

| Component | States | Rules | Replaces |
|---|---|---|---|
| `Frame` | tier: comfortable ≥1280 / compact 1024–1279 / too-small <1024 | nav 208/140px; workspace = size container | V5Frame (retain), legacy `AppShell` |
| `NavLink` | R H F current D(role-restricted → hidden) | current = `primary-soft` + 2px inline-start bar + `aria-current`; labels always visible | legacy `NavRail` (blank icon tier) |
| `Titlebar` | — | one `h1` per screen; optional step indicator; optional title actions (≤2) | legacy `Workspace` title |
| `StatusIndicator` | per row: healthy / degraded / attention / unknown | dot + text; never color only; click → details (manager) | `ConnectionIndicator` (English), `SaleSyncStatus` (unmounted), `StuckShiftBadge` (unmounted) |
| `Banner` | warn / danger / info | persistent; icon + title + detail + ≤2 actions; never auto-dismiss | `StatusBanner`, `ShiftClosedBanner` (English), `PrinterFailureBanner`, `DrawerFailureBanner`, `InvalidStateBanner` |
| `ScreenTooSmall` | — | Arabic copy | legacy English `ScreenTooSmall` |
| `RouteLoading` | — | never blank | empty `<main>` |
| `ErrorScreen` | route error / storage blocked / fatal | what happened · what is safe · what to do · support ref | none |

## Actions

| Component | States | Rules | Replaces |
|---|---|---|---|
| `Button` | intents primary · secondary · ghost · danger · danger-quiet; sizes md 44 / lg 56; R H F P D L | ≤1 primary per region; D shows reason nearby, no opacity fade; L keeps label + spinner; `forced-colors`: primary gets 3px `ButtonText` border | `.btn*`, 007 `Button` (unused), `.v5-live-btn*`, `.payment-surface__confirm` (×2 blocks), `.quick-amount-btn`, ReceiptPreview inline objects, FindSaleReceipt utilities, unstyled native buttons |
| `Kbd` | — | rendered only for bound keys | static-proof "F2" |
| `IconButton` | R H F P D | 44×44, `aria-label` in Arabic | glyph buttons (✓ ✕ ⌫) |

## Inputs

| Component | States | Rules | Replaces |
|---|---|---|---|
| `SearchField` | empty / typing / results / none / loading / error / stale | 2-char min, debounce 150ms (existing); owns focus ⇒ scan paused | V5 search (retain) |
| `ScanTarget` | ready / paused-by-search / paused-by-dialog / blocked (storage) | exactly one scan owner; state text always visible | V5 scan field (retain + states) |
| `MoneyField` | R F E D | LTR-isolated, tabular, integer minor units; normalises ٠-٩; no key-repeat; scanner never routed here | `CashEntry` input, `AmountPad` display, `MoneyRoll` |
| `CodeField` | R F E | uppercase A–Z0–9, max 6 for card ref; staff code | tender-row inputs, `.pairing-form` |
| `NoteField` | R F E(limit) | 200-char cap (existing) | V5 note textarea (retain) |
| `PinPad` | R F E(wrong PIN) L | LTR grid; digits via keyboard; scanner blocked | `.pin-pad` (004) |
| `AmountPad` | R P D | LTR grid; `00`, `⌫`; 56–64px keys | `.amount-pad` (v3.5) — incl. its `Math.floor` negative-amount bug |

## Sale

| Component | States | Rules | Replaces |
|---|---|---|---|
| `ProductResultList` | idle / results / active option / none / loading / error | listbox + `aria-activedescendant`; fix axe `nested-interactive` | V5 (retain) |
| `CartTable` / `CartRow` | R F just-added (flash) frozen removed-pending Rx/controlled flags | 2-line name clamp; money LTR; row actions 44px; `Delete`/`+/-` only with row focus | V5 `CartLineRow` (retain), `PaymentCartSummary` rows |
| `QtyStepper` | R F D(frozen) | ArrowUp/Down restored; no key-repeat beyond one step per press | V5 stepper |
| `TotalsBand` | normal / frozen / tax-pending | pinned; tax line «قيد الإضافة · لا تُحسب هنا» while VAT deferred | `.v5-sale-totals` (retain), `.payment-cart-summary`, `.amount-due-card` |
| `CheckoutCTA` | R F D(empty cart) L(handoff pending) | the one primary; `F8` | `.v5-sale-checkout` (retain) |
| `SuspendedSaleList` | empty / one / many / stale | time, operator, items, total, optional label | dead `.held-*` CSS |
| `ResumeConflictPanel` | conflict / price-changed / ok | primary suspend-current-and-resume, secondary keep-current | none |

## Checkout

| Component | States | Rules | Replaces |
|---|---|---|---|
| `OrderSummary` | full (1280) / strip + disclosure (1024) | read-only; lock pill «مجمّدة» | `PaymentCartSummary` |
| `TenderPicker` | per tile: R H F selected disabled-by-policy («غير متاحة حاليًا») | radiogroup; disabled tile keeps slot, no opacity fade (RT-103) | `TenderSelection` + `.method-card` (×2 blocks) |
| `CashEntry` + `QuickAmounts` | empty / entered / exact / shortfall / change | chips **set** amount; `F9` exact | `CashEntry`, `.quick-amount-btn` |
| `CardTerminalEntry` | waiting / approved / declined / cancelled | "record the terminal result"; ref optional 0–6 | `ExternalCardTerminalEntry` |
| `PaymentLedger` | due / received / change / shortfall / attempt status / commit / back(enabled/refused) | amount due always visible; commit `Ctrl+Enter` | `.payment-surface__amount`, `.amount-due-card` |
| `PaymentOutcome` | settled-finalizing / finalization-failed / declined | success colour only for proven fact | `.payment-surface__settled-*` |
| `RecoveryPanel` | unknown / cancelling / reversal-pending / stale attempt | no re-charge; plain-Arabic copy; manager escalation | `__bridge-refusal`, `__reversal-pending-hint` |

## Post-sale

| Component | States | Rules | Replaces |
|---|---|---|---|
| `CompletionPanel` | complete + proof list (payment / sale / receipt / sync) | New sale `Ctrl+N` primary; sale no. only when proven | v4 settled panel |
| `ReceiptStatus` | ready / printing / printed / failed / manual-handed | failure never reverses sale | `ReprintAffordance` |
| `ReceiptPreview` | preview / print disabled (not configured) | one styling mechanism; Arabic copy | `ReceiptPreview` inline styles, bilingual «طباعة — Print» |

## Overlays and atoms

| Component | States | Rules | Replaces |
|---|---|---|---|
| `Dialog` | open / closing | one mechanism: focus trap, Esc, focus restore, scanner suspended, first focus on safe control | 007 `Dialog` (unused), V5 `SaleDialog` (basis), `TakeoverPrompt`, `ForcedCloseSurface`, `CashierManagement`, `ReceiptPreview` dialogs |
| `ConfirmDialog` | destructive | states consequence; safe default focus | V5 void dialog |
| `ManagerApprovalSheet` | request / authenticating / approved / denied / cancelled / invalidated (cart changed) | bound to action + amount + cart version; reason required | none |
| `LockScreen` | locked with nothing / with cart / with live tender | preserved summary; same-cashier PIN; takeover path | — |
| `Badge` | info / warn / ok / neutral / danger | text always; 26px; pill | 007 `Badge` (unused), `OperatorBadge` (English roles), `.diagnostics-badge` |
| `StateLine` | tone + icon + text | used in proof lists and ledger | — |
| `Notice` | info / warn / danger / success | inline, in-region, clears with condition | `.v5-live-notice` (retain basis), 006 hints |
| `Toast` | neutral ack | ≤4s, non-financial, user-initiated only | 007 `Toast` (never mounted) |
| `Icon` set | — | extend `V5Icon` (6 glyphs today) with: lock, print, alert, check, x, offline, card, cash, clock, user, pause, shield, db, back (mirrors in RTL) | Unicode glyphs ✓ ✕ ⌫ |
