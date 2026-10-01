# Product

## Register

product

## Users

Pharmacy cashiers, shift managers, and admin operators at pharmacy branch terminals on Windows 10/11 desktop workstations. Cashiers use the terminal for eight-hour shifts, scanning barcodes via keyboard-wedge HID devices, processing sales, printing receipts, and opening cash drawers. Managers need clear shift attribution, X/Z-report access, and supervisor override flows. Admins configure terminal pairing and branch assignment. All users operate in Arabic-first environments; RTL layout is the default locale. Users are not power users of software; they are power users of their workflow. The terminal must disappear into their routine.

## Product Purpose

POS-Pulse is the Point-of-Sale desktop terminal for the SmartDataPulse pharmacy platform. It captures sales transactions against a local SQLite store, drives thermal receipt printing, a barcode scanner, and an optional cash drawer, and syncs with the backend when the network is available. It must keep selling when offline. The product replaces a legacy POS (`Data-Pulse/pos-desktop/`) that proved the operational concepts but lacked clean boundaries, audit-quality traceability, and a maintainable foundation. Success means: a cashier completes a sale, prints a receipt, and opens the drawer in under 10 seconds, with every transaction durably recorded and attributable to a named operator at a specific terminal — regardless of network state.

## Brand Personality

Precise, accountable, unhurried. The interface is a precision instrument that earns operator trust by never lying — no optimistic success states, no silent failures, no ornamentation that competes with the task at hand. It is professional in the way a well-calibrated lab instrument is professional: it does what it says, when it says it, and surfaces problems before they become cash-drawer discrepancies. Warmth comes from clarity, not from decoration.

## Anti-references

- Consumer SaaS aesthetics (Notion, Intercom, Loom gradient heroes): the interface is a terminal, not a product landing page.
- Glassmorphism or blur-heavy surfaces: panels must be opaque and legible under overhead pharmacy lighting.
- "Dark because tools look dark" defaults: light-first is deliberate for the pharmacy floor environment (light is the pilot register; the dark register is maintained but not offered).
- SaaS metric-hero cards (big number, gradient accent, decorative shadow flourish): every number on screen carries financial weight and demands unframed legibility.
- Identical icon-heading-text card grids: the system uses functional lists, tabular data, and purpose-built surfaces.
- Generic AI tool aesthetics (purple gradients, neon-on-dark, glassmorphism-as-default): this is a regulated commercial terminal, not a portfolio showcase.

## Design Principles

1. **Honest surfaces.** The interface shows the true state of every operation. No optimistic UI past a durable commit boundary. No success affordances without a confirmed result. If the system does not know, it says so.
2. **The shift is the context.** Every screen is used by someone on their feet, under time pressure, during a live transaction. Efficiency, keyboard operability, and unambiguous affordances take priority over novelty or visual interest.
3. **Failure is loud, never silent.** Hardware faults, sync failures, and degraded states surface persistent banners and retry paths. Quiet degradation is a design defect. The cashier must always know the real state of the terminal.
4. **Additive, not disruptive.** Visual improvements layer onto proven functional foundations. Tokens extend without renaming; components restyle without rewriting; no live surface regresses when the system gains polish.
5. **Arabic-first, globally legible.** RTL layout is the default locale. Money, codes and quantities are Western digits, isolated left-to-right inside Arabic text, for audit compatibility. A single system font stack (Dubai → Segoe UI → Tahoma, all shipped with Windows) renders Arabic properly on any paired Windows terminal without bundling a font. The visual system itself is [`DESIGN.md`](DESIGN.md).

## Accessibility & Inclusion

WCAG 2.1 AA minimum. All cashier-critical paths (sales, refunds, voids, shift actions) are keyboard-operable with no mouse-only flows. Every interactive element meets a 44 × 44 CSS pixel touch-target floor, enforced by a CI invariant test. Color is never the sole differentiator for state: icon and text labels accompany every color-coded affordance. Axe-core smoke checks run on every default-state variant in CI. The reduced-motion media query is respected across all animation; no bounce or elastic easing.
