# 023: POS UI clean-room Sale proof

## Goal

Rebuild POS presentation one screen at a time without inheriting legacy screen composition. The first proof is the **Sale Workspace only**, rendered as a static visual screen in the real Electron renderer. The approved `022` visual handoff and `visual-references/03-sale-workspace.png` govern appearance, subject to `design-handoff/RECONCILIATION.md` and current product capability truth.

## Scope and acceptance

- Create a new semantic DOM composition under `src/renderer/v5/` with product discovery and a visually dominant active cart.
- Use Arabic-first Egyptian pharmacy demo content, clearly identified as a design preview. Prices are fixed illustrative display values, not engine results. Show subtotal, a truthful tax-pending line, and an illustrative total equal to the subtotal; no tax calculation.
- Use the existing semantic tokens and preserve measured contrast. The handoff's `tokens.css` is evidence, never an imported production stylesheet.
- Open the proof through a development-only renderer preview. `/app/cart`, production flags, and existing flow remain untouched.
- Provide real screenshots from the running Electron renderer at 1024-class and 1280-class viewports, then compare with the approved Sale reference. Owner visual approval remains a separate gate.

## Immutable behavior

Do not rewrite cart or catalogue behavior, money math, stores, payment logic, offline logic, IPC, bridge contracts, security boundaries, feature flags, or receipt behavior. The proof does not connect to Zustand, IPC, `window.api`, scanner logic, catalogue bridges, databases, production APIs, or cart mutations. It uses one small immutable local demo model.

## Clean-room rule

A screen is **not migrated** merely because colors, tokens, or spacing changed; new CSS wraps old DOM; new classes coexist with old screen components; or tests pass. A clean-room screen requires new DOM composition, visual hierarchy and layout structure, no legacy screen-style dependency, real rendered evidence, and owner visual approval.

Nothing under `src/renderer/v5/**` may import presentation modules from `ui/cart/**`, `ui/catalogue/**`, or `shell/**`. It may not use legacy screen class families such as `sale-layout`, `catalogue-*`, `cart-pane*`, `payment-surface*`, `tender-row*`, `sign-in-route*`, or `placeholder-pane*`. A structural guard enforces this wall; tests do not establish visual quality.

## Visual and accessibility direction

The screen is a light, calm, teal-led desktop pharmacy terminal. The cart carries the main tabular hierarchy: product, quantity, unit price, line price, subtotal, tax status, total, and one checkout action. Search and product rows form the secondary operational region. At 1024-class widths the two regions remain useful without adopting stacked mobile composition. Use semantic landmarks and headings, meaningful labels, visible focus, 44px control targets where controls exist, and explicit LTR isolation for codes and Latin numbers.

Unsupported prototype capability stays absent: Saudi/Riyadh assumptions, SAR, ZATCA, Saudi fiscal QR, 15% VAT, mada, insurance or unsupported card/wallet tenders, gift voucher, loyalty, CRM, prescription workflow, returns, shift close, and fabricated fiscal or transaction data.

## Stop and owner gate

Do not change Checkout, Completion, Sign-in, US5, US6, main/preload/IPC, migrations, packages, CI, or production flags. Do not delete the old Sale UI or CSS. If safe preview routing, dependency-free implementation, or honest screenshot capture is blocked, report the blocker without widening scope. After the static proof and visual comparison, stop. Engine wiring and `/app/cart` cutover require the owner's explicit visual decision: **“Yes — this is the visual direction.”**
