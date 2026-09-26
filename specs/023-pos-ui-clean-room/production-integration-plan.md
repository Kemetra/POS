# 023 Sale Production Integration Plan

> Planning handoff only. The approved static proof stays intact; this document authorizes no wiring or cutover.

**Goal:** Connect the approved v5 Sale presentation to the existing POS cart and catalogue engines, prove behavioral parity, then make `/app/cart` a small final composition change.

**Architecture:** Extract renderer orchestration trapped in legacy components into neutral Sale hooks/controllers used by both the legacy screen and a v5 adapter. The adapter projects only display-safe values and callbacks into pure v5 components. Main-process cart, catalogue, payment, offline, security, IPC, and receipt owners stay unchanged.

**Tech stack:** Existing React, TypeScript, Zustand, React Router, Electron bridge, Vitest, and semantic CSS tokens. No dependency, schema, bridge, or feature-flag change.

**Authority:** [spec.md](./spec.md), [plan.md](./plan.md), approved [1024 capture](./screenshots/sale-proof-1024.png) and [1280 capture](./screenshots/sale-proof-1280.png). Product behavior is determined by current source, not the static demo.

## Baseline and non-negotiable boundaries

- Baseline inspected on `feat/023-pos-ui-clean-room-sale-proof`: `ca9486c`; fetched `origin/main` is also `ca9486c`. The only pre-existing changes were `src/renderer/main.tsx`, `specs/023-pos-ui-clean-room/**`, and `src/renderer/v5/**`.
- Keep `src/renderer/main.tsx`'s `#/dev/sale-proof` as a static design preview. It bypasses app bootstrap and operator routing by design; it is unsuitable for functional parity testing.
- Never import `CartWorkspace`, `Workspace`, `CartPane`, `CatalogueSalePane`, `ProductSearchInput`, `SearchResultRow`, `PaymentSurface`, or any `ui/cart/**`, `ui/catalogue/**`, or `shell/**` presentation module into v5. Preserve the existing v5 import/class guard and extend it to the future adapter.
- Do not create a second cart, money, search, payment, persistence, or security engine. No new renderer data source may fabricate product rows, cart metadata, tax, totals, fiscal data, or transaction references.
- No main/preload/IPC/bridge, database, outbox, finalization, receipts, drawer, pairing, operator authorization, or production flag changes are needed by the currently inspected interfaces. If an implementation discovers otherwise, stop that slice and report the exact missing contract.

## Source-backed behavior map

| Behavior | Current source of truth | Required v5 treatment |
| --- | --- | --- |
| Route and flags | `src/renderer/router.tsx` (`/app/cart`, `/app/checkout`); `routes/app/CartWorkspace.tsx`; `stores/feature-flags-store.ts` | Preserve the `cart`, `productSearch`, and `payments` gates and the `/app` operator guard. No flag default change. |
| Session | `routes/operator-route-guard.tsx`; `stores/operator-session-store.ts`; `stores/cart-signout-hook.ts`; main `cart/require-operator-session.ts` | Keep route-level UX guard and main's load-bearing session/role/tenant checks. On session exit, unmount/clear renderer working state. |
| Cart creation | `ui/catalogue/CatalogueSalePane.tsx` | Preserve one eager `cart.create` caller when catalogue is enabled, idempotency key, in-flight dedupe, store update only after `ok`, and retry on later mount after transport failure. |
| Typed search | `ui/catalogue/ProductSearchInput.tsx`; `stores/useDebouncedSearch.ts`; `CatalogueSalePane.tsx`; `stores/catalogueSearchStore.ts` | Reuse debounce and FSM; call existing `catalogue.search`; preserve 2-character UX minimum, normalized minimum in main, response mapping and generic failure recovery. |
| Barcode scan | `ui/catalogue/ScanCaptureField.tsx`; `ProductSearchInput.tsx`; `CatalogueSalePane.tsx`; main `catalogue/catalogue-bridge.ts` | Recreate a focus-confined capture target and Enter handling in v5; reuse immediate debounce-bypass behavior and existing `catalogue.lookupBarcode`. No document-wide key capture. |
| Result selection | `SearchResultList.tsx`, `SearchResultRow.tsx`, `catalogueSearchStore.ts` | New v5 DOM must retain listbox/active-option keyboard semantics, truncated hint, click/Enter selection, and confirm-first transition. |
| Confirm and add | `CatalogueAddController.tsx`; `ProductConfirmPanel.tsx`; `CartPane.tsx` | Extract controller logic; call `cart.lines.add` once on confirm with `product_id`, quantity 1, and idempotency key. Only a bridge `ok` changes the cart line projection/FSM. Refusal stays generic and retryable. |
| Cart lines | `ui/cart/CartPane.tsx` local `lines`; `stores/cart-store.ts`; `shared/cart/bridge-types.ts` | Move the single bridge-confirmed line projection into a neutral hook. The Zustand cart store owns only cart ID/FSM, not lines. Preserve merge, version, note, and last-line behavior. |
| Quantity/remove | `CartPane.tsx`; `QuantityStepper.tsx`; main `cart/cart-bridge.ts` | Keep versioned `lines.update/remove`, idempotency keys, success-only updates, decrement-at-one behavior, note-protection path, and bridge-side quantity guards. Disable repeat while an action is pending if parity tests show re-entry risk; do not change main rules. |
| Money/tax | `CartPane.tsx`; `shared/money.ts`; main `cart/cart-store.ts` and `cart/cart-bridge.ts` | Carry integer minor units only. Project bridge-confirmed line subtotals, sum safely for editing display, and compare frozen `envelope.subtotal_minor`. Tax remains pending; before handoff displayed total equals subtotal, without a fabricated VAT amount. Format via `shared/money.ts` (`EGP`). |
| Notes/void/discount display | `CartPane.tsx`, `LineNotePopover.tsx`, `VoidConfirmation.tsx`, `HandoffSummary.tsx` | Preserve current note, remove, void, manager-only post-handoff void, and opaque discount-placeholder behavior in new v5 DOM before cutover. Do not display attribution IDs or discount magnitude. |
| Handoff/checkout | `CartPane.tsx`; `HandoffSummary.tsx`; `stores/payment-store.ts`; `routes/app/checkout/CheckoutRoute.tsx` | Preserve two phases: `cart.handoff` freezes a versioned envelope, then Continue mounts it in payment store and navigates to `/app/checkout` only when `payments` is enabled. A one-click jump from editing to checkout is not equivalent. Checkout and `PaymentSurface` stay untouched. |
| Catalogue freshness/offline | `CatalogueFreshness.tsx`; main `catalogue/catalogue-bridge.ts`, `catalogue/product-repo.ts`, `catalogue/read-down/**` | Keep truthful never-synced/updated/synced-empty/unavailable states, existing refresh admission semantics, and local read-model behavior. Do not invent idle browse, stock, or category data. |
| Durable offline cart | main `cart/cart-store.ts`, `cart/cart-bridge.ts`, `session-end-handler.ts`; `tests/integration/main/cart/*` | Existing SQLite/outbox/handoff path stays exactly the same. v5 only calls current bridge methods; no renderer persistence or network fallback. |

### Presentation versus engine classification

| Current file/component | Class | Behavior owned | Direct v5 reuse? | Smallest seam |
| --- | --- | --- | --- | --- |
| `routes/app/CartWorkspace.tsx` | MIXED | Flags, add callback thread, checkout navigation, legacy layout | No | Keep route as legacy consumer; later make v5 route composition, then cut over the route element. |
| `shell/regions/Workspace.tsx` | PRESENTATION | Shell layout | No | v5 supplies its own screen structure within guarded app route. |
| `ui/catalogue/CatalogueSalePane.tsx` | MIXED | Create, lookup response mapping, focus recovery, legacy UI | No | Extract `useSaleCatalogueController` plus cart lifecycle hook; leave legacy pane consuming them. |
| `ui/catalogue/ProductSearchInput.tsx` | MIXED | Input DOM, debounce and Enter handling | No | Reuse `stores/useDebouncedSearch.ts`; implement v5 input semantics anew. |
| `ui/catalogue/ScanCaptureField.tsx` | MIXED | Wedge buffer/terminator and input DOM | No | Small v5 capture input with the same keyboard contract and tests. |
| `ui/catalogue/SearchResultList.tsx` / `SearchResultRow.tsx` | PRESENTATION with keyboard state | Listbox selection/active row and DOM | No | New v5 listbox/row; preserve keyboard and accessible-state contract. |
| `ui/catalogue/CatalogueAddController.tsx` | MIXED | Confirm-first add orchestration and panel | No | Extract `useConfirmSaleAdd`; legacy and v5 render separate panels. |
| `ui/catalogue/CatalogueFreshness.tsx` | MIXED | Freshness/refresh state and DOM | No | Extract `useCatalogueFreshness` only if v5 shows the indicator; preserve existing timing/test cases. |
| `ui/cart/CartPane.tsx` | MIXED | Local line projection, mutations, handoff, void, notes, totals and DOM | No | Extract `useSaleCartController` in small reviewable moves; legacy pane consumes the hook before v5 does. |
| `ui/cart/LineItemRow.tsx`, `QuantityStepper.tsx`, `HandoffSummary.tsx` | PRESENTATION with UI rules | Row/stepper/frozen summary DOM; decrement-at-one rule in stepper | No | New v5 controls with equivalent callbacks, button guards and focus behavior. |
| `ui/payments/PaymentSurface.tsx` | MIXED downstream | Payment tender/finalization UI | No Sale import | Continue using it only via existing `/app/checkout`. No checkout redesign. |
| `stores/cart-store.ts`, `catalogueSearchStore.ts`, `payment-store.ts`, `useDebouncedSearch.ts` | ENGINE / DOMAIN LOGIC | Renderer FSM/projections/debounce | Yes, in adapter | Do not duplicate or change state ownership. |
| `shared/money.ts`, `shared/cart/**`, `shared/catalogue/**` | ENGINE / DOMAIN LOGIC | Money, cart state and wire shapes | Yes | Import types/formatting only as needed. |
| `main/cart/**`, `main/catalogue/**`, `main/payments/**`, `main/sales/**` | ENGINE / DOMAIN LOGIC | Session-gated local authoritative behavior | Through existing bridge only | No source changes. |

## Target presentation interface

Create a neutral `src/renderer/sale/` controller layer, then `src/renderer/v5/sale/SaleRoute.tsx` as its only v5 consumer. `SaleScreen`, `ProductRail`, and `SaleCart` stay presentation components. Representative *display* interface (names may be refined, semantics may not):

```ts
type SaleView = {
  catalogueEnabled: boolean;
  search: CatalogueSearchState; // existing FSM union; no invented results
  freshness: FreshnessView;
  cartPhase: CartState | 'unavailable';
  lines: readonly {
    lineId: string; // opaque callback key, never printed
    displayName: string;
    quantity: number;
    unitPriceMinor: number;
    lineSubtotalMinor: number;
    note: string | null;
  }[];
  subtotalMinor: number | null; // null -> placeholder, not 0.00
  totalMinor: number | null;
  tax: 'pending';
  canHandoff: boolean;
  canContinueToPayment: boolean;
  pendingAction: 'none' | 'adding' | 'mutating' | 'handing-off';
  error: string | null; // generic operator-safe copy only
  frozenSummary: FrozenSaleSummary | null; // projected; no envelope IDs
};

type SaleActions = {
  onTypedSearch(value: string): void;
  onScan(barcode: string): void;
  onSelectProduct(productId: string): void;
  onConfirmAdd(): void;
  onCancelAdd(): void;
  onIncrement(lineId: string): void;
  onDecrement(lineId: string): void;
  onRemove(lineId: string): void;
  onSaveNote(lineId: string, note: string | null): void;
  onHandoff(): void;
  onContinueToPayment(): void;
  onVoid(): void;
};
```

The adapter retains versions, cart ID, idempotency keys, and the raw envelope in its closure. The presentation receives no session IDs, tenant IDs, refusal reasons, or privileged credentials. Product rows come only from `CatalogueSearchState.results`; idle state shows a search prompt because there is no `catalogue.list/browse` bridge. Real cart add responses contain only the Arabic display name, quantity, integer prices, and version: omit the proof's invented cart barcode, pack, and English metadata. Replace fixed `9 units`, fixed totals, fixed products and read-only search with live projections. Keep optional English/code/pack only on actual catalogue results when present. Use `shared/money.ts` for EGP formatting and invalid-value guarding; never parse display strings back into amounts.

## Extraction seams and parity risks

| Current owner / problem | Target seam and files | Behavior preserved / proof | Risk |
| --- | --- | --- | --- |
| `CartPane.tsx` owns the only bridge-confirmed `lines` array and `AddedLineResult` type | Move types and line reducer/mutation orchestration to `src/renderer/sale/useSaleCartController.ts`; update `CartPane.tsx`, `CatalogueAddController.tsx`, `CartWorkspace.tsx` type imports | Existing `cart-pane-live-lines`, quantity, note, handoff, sign-out and cart-to-checkout tests pass unchanged; new hook tests cover append/merge/version/refusal | Highest: duplicate cart state or stale versions. Keep one controller instance per mounted Sale route; never mount legacy and v5 consumers together. |
| `CatalogueSalePane.tsx` owns eager create and search/scan response mapping | `src/renderer/sale/useSaleCatalogueController.ts`; legacy pane delegates, v5 adapter consumes | Existing `CatalogueSalePane.test.tsx`, `keyboard-walkthrough.test.tsx`, duplicate-scan and offline catalogue tests remain green | Double create, stale search response, lost focus. Preserve current sequencing; document any existing race separately. |
| `CatalogueAddController.tsx` imports a cart presentation type and owns add mutation | `src/renderer/sale/useConfirmSaleAdd.ts`; move the confirmed-result type to neutral Sale module | Existing confirm-first, refusal, retry, double-tap and cancel tests; v5 confirms no write before Add | A second add path or duplicate click. The hook must deliver `ok` once to the single cart controller. |
| `CatalogueFreshness.tsx` couples bridge timing to DOM | `src/renderer/sale/useCatalogueFreshness.ts` if indicator is included | Existing freshness tests verify absolute time, synced-empty and honest refresh feedback | False claim of completed refresh or leaked refusal. |
| `CartPane.tsx` owns frozen envelope and payment-store mount | Same cart controller plus v5 route callback to `navigate('/app/checkout')`; `CheckoutRoute.tsx` unchanged | Existing handoff and cart-to-checkout tests, then v5 route parity test | Navigating before a successful freeze or mounting an unfrozen/incorrect envelope. |

The bridge has no general cart-read/list endpoint (`CartBridgeAPI` provides create/mutate/handoff/subscribe only), so neither UI can reconstruct its renderer line projection after a route switch or renderer restart. Do not add an IPC method in this migration. Test v5 from a fresh Sale mount, and never offer an in-transaction legacy/v5 toggle. If operational recovery of an interrupted draft becomes a cutover requirement, treat the missing read contract as a separate blocker and owner decision.

## Reviewable implementation slices

Each slice below is a future task. No slice is implemented by this document. Run the named existing tests **without weakening them**, add focused v5 tests, then run typecheck and the full relevant suite before its review. Rollback means revert that slice while preserving the preceding reviewed slice; no live cart is switched between UIs.

| Slice / dependency | Objective and allowed files | Forbidden files | Tests and exit criteria | Rollback point |
| --- | --- | --- | --- | --- |
| A1 — cart lines / none | Move `CartLineItem`/`AddedLineResult` types, bridge-confirmed append/merge projection, quantity/remove/note mutations and version handling from `ui/cart/CartPane.tsx` into `renderer/sale/useSaleCartController.ts`; legacy `CartPane` is its only consumer | `main/**`, `preload/**`, bridge types, DB, v5 visual CSS | Existing cart pane live-line, quantity, note and sign-out tests plus new controller merge/refusal/stale-version tests pass unchanged. One line owner remains. | Restore legacy local-line handling; `/app/cart` still uses it. |
| A2 — cart handoff / A1 | Move subtotal projection, handoff/frozen envelope, void and discount-placeholder state into the same neutral controller; keep legacy rendering and payment-store timing unchanged | Main/payment engines, checkout route, IPC, flags | Existing handoff, void, discount and cart-to-checkout tests plus controller refusal/rollback tests pass unchanged. Frozen subtotal matches envelope. | Restore only A2 orchestration inside legacy `CartPane`; A1 remains reviewed. |
| B — catalogue controllers / A1 | Extract eager cart create, search/scan FSM mapping, confirm-first add, and freshness orchestration to neutral `renderer/sale/` hooks. Make legacy catalogue components consume them | Main catalogue, IPC, flags, v5 DOM | Existing catalogue, freshness, keyboard, duplicate-scan, offline-after-success and add-controller tests pass unchanged. A confirmed add reaches A1 once; no add on select. | Restore legacy catalogue controller implementation; production route remains legacy. |
| C — v5 data adapter / A2+B | Add `v5/sale/SaleRoute.tsx` to consume neutral hooks/stores and project real data into `SaleScreen`, `ProductRail`, `SaleCart`; remove demo data from the live variant only | Static `#/dev/sale-proof` evidence, legacy CSS/classes, `ui/cart/**` and `ui/catalogue/**` imports under v5 | New adapter tests for empty/search/loading/refusal/flags/real optional fields, integer totals, sign-out and no fake rows. Static proof route still renders. | Delete the new live route; static proof and legacy production stay available. |
| D — v5 operator controls / C | Add v5-specific input, scanner capture, result keyboard selection, confirm dialog, quantity/remove/note/void and frozen states under `v5/sale/` | Legacy presentation imports, main/preload/IPC, checkout presentation | v5 keyboard path scan→confirm→add, typed search→select→confirm, Escape/focus return, 44px controls, decrement-at-one/note guard, generic errors, no unsupported capability. | Revert v5 controls; neutral hooks and legacy route still work. |
| E — guarded functional preview / C+D | Add an `import.meta.env.DEV`-only guarded `/app/sale-v5` route in `router.tsx` under the existing `/app` `OperatorRouteGuard`; keep the static `#/dev/sale-proof` separate | `/app/cart` element, production flag defaults, `main.tsx` boot security, payment route | Memory-router tests prove signed-out redirect, flag combinations, no packaged route, no bridge call before guards, and real bridge handoff to existing `/app/checkout`. Use a fresh cart per preview run. | Remove dev route; no production routing changes. |
| F — parity and real Electron gate / E | Exercise both paths against the same scripted bridge cases, then the v5 dev route in real Electron with supported offline scenarios. Capture 1024 and 1280 functional states; compare to approved proof | Engine and security changes to make tests pass | Search, scan, selection, merge, increment/decrement/remove, versions, totals, tax pending, notes/void, frozen summary, checkout, session and offline cases match. Full relevant tests, typecheck, lint, renderer build pass; owner reconfirms if added controls materially alter appearance. | Do not cut over; legacy `/app/cart` remains production. |
| G0 — V5Frame parity / F (added 2026-09-26, owner) | Bring `V5Frame` to what `AppShell` actually does: the `ScreenTooSmall` guard below 1024px (the screen never mounts) and the persistent non-online connection banner. Move the connection store and viewport-tier hook out of `shell/` into neutral `renderer/connection/` and `renderer/viewport/`, with `shell/` re-exports | Main/preload/IPC, legacy shell behaviour, flags | Frame tests for too-small (no nav, no screen mount) and each non-online banner; re-export identity test (one store); v5 import wall unchanged; renderer bundle carries no v5 code | Revert G0; legacy shell imports keep working through the re-exports. |
| G — `/app/cart` cutover / F only | Make the smallest route-element/composition change in `router.tsx`/`routes/app/CartWorkspace.tsx` to mount v5 under the same guard and flags. Keep legacy components in the tree as rollback source | Main/preload/IPC/DB, flags, checkout, receipts, legacy deletion | Routing, security, cart, payment, offline and full suite plus real Electron regression pass. Replace old-heading/old-class test selectors with equally strong semantic route/behavior assertions where cutover changes DOM; do not weaken behavior checks. No live transaction migration or UI toggle. | Revert route composition between transactions; do not hot-switch an active cart. |
| H — retirement / G regression proof | In a separate review, enumerate actual remaining consumers, then remove only unused Sale presentation/CSS | Shared behavior hooks, other screen presentation, engine | Dependency scan, full suite and production Electron smoke remain green. | Revert retirement independently of cutover. |

## Cutover evidence checklist

- [ ] Search, barcode lookup, selection, confirm-first add and duplicate merge work through the existing bridge and FSM.
- [ ] Cart create, add, update, remove, note and void use one controller and current version/idempotency contract; quantity guards and generic refusals remain correct.
- [ ] Displayed integer line values and subtotal match the bridge-confirmed cart projection; frozen summary matches `PaymentIntentEnvelope.subtotal_minor`; tax remains pending.
- [ ] Handoff freezes before payment-store mount; Continue reaches the unchanged checkout flow only when payments are enabled.
- [ ] Signed-out, role, tenant and terminal gates remain effective; renderer sees no new secrets; app-shell banners and sign-out cleanup remain present.
- [ ] Offline local catalogue lookup, cart outbox, frozen envelope and payment handoff tests remain green; no direct renderer network or DB path exists.
- [ ] Keyboard/scanner focus recovery, 1024/1280 real Electron captures, accessibility checks, full relevant tests, typecheck, lint, build and structural import guard pass.
- [ ] Owner visual confirmation is obtained again only if functional states materially change the approved appearance.

## Existing protection to retain

- Search/add: `src/renderer/ui/catalogue/__tests__/CatalogueSalePane.test.tsx`, `CatalogueAddController.test.tsx`, `keyboard-walkthrough.test.tsx`, `duplicate-scan.test.tsx`, `CatalogueFreshness.test.tsx`, and `src/main/catalogue/read-down/__tests__/offline-after-success.test.ts`.
- Cart and money: `tests/unit/renderer/ui/cart/cart-pane-live-lines.test.tsx`, `cart-pane-handoff.test.tsx`, `quantity-stepper.test.tsx`, `tests/unit/main/cart/cart-lines-mutations.test.ts`, `cart-handoff-subtotal.test.ts`, and `tests/unit/shared/cart/**`.
- Payment handoff: `tests/integration/renderer/ui/cart/cart-to-checkout-wiring.test.tsx`, `tests/integration/main/cart/cart-handoff-offline.test.ts`, and payment surface tests under `src/renderer/ui/payments/__tests__/`.
- Security/offline: `src/renderer/routes/__tests__/operator-route-guard.test.tsx`, `tests/integration/renderer/stores/cart-signout-clears-store.test.ts`, `tests/unit/main/cart/cart-role-gating.test.ts`, `tests/integration/main/cart/cart-tenant-isolation.test.ts`, `cart-action-outbox-idempotency.test.ts`, `cart-restart-survival.test.ts`, and `tests/integration/cross-process-redaction-cart*.test.ts`.
- Presentation wall: `src/renderer/v5/__tests__/sale-proof.test.tsx`; extend its scan to new v5 files. Automated tests prove behavior and isolation, not visual quality.

## Known risks and decisions before execution

1. The proof's inert `+` marks and single checkout button cannot simply become active: the production contract requires confirm-first add and a separate handoff/frozen phase. These states need v5 presentation and may need another owner visual look.
2. `CartPane.tsx` currently owns local line snapshots while `cart-store.ts` does not. Extraction is the central risk. Do not seed v5 from the static demo or create a parallel line store.
3. The current cart update response contains only a new version; the renderer derives new quantity/line subtotal from the confirmed operation and stored integer unit price. Preserve this contract and test refusal/stale-version behavior. Never treat a rejected bridge response as a completed mutation.
4. The legacy `CatalogueSalePane.tsx` searching guard prevents transitions from non-searching states but does not identify which of two overlapping in-flight searches responded. This is a pre-existing potential stale-result race. Record a reproducing test before any correction; do not silently change behavior during extraction.
5. The legacy `CartPane.tsx` handoff handler has a refusal rollback but no `catch` around a rejected transport promise. Treat a confirmed rejection problem as a separate focused bug fix with parity tests, not an undocumented refactor.
6. The approved static screenshots contain illustrative product/cart metadata. The live screen must show only fields in `ProductSnapshotDisplay` and bridge-confirmed `CartLinesAddResponse`/envelope. In particular, no idle product browse list and no fabricated cart barcode or English name.
7. The functional preview must live under the guarded app router. The existing static preview deliberately bypasses boot and cannot demonstrate session, pairing, feature flag, or checkout parity.
8. At this pre-flight baseline, repository-wide lint is blocked by an unrelated ignored `.impeccable/hook.cache.json` formatting issue; changed-file lint passes. Keep that cache outside the Sale implementation and report the gate separately until it is resolved without broad unrelated edits.

**Stop point for this handoff:** no code wiring, no `/app/cart` replacement, no legacy deletion, and no commit/push/PR are performed here.
