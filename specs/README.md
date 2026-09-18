# Spec Index

A lightweight status index for `specs/**`. Its only job is to tell you, at a glance, **whether a
given spec still describes how POS-Pulse works**.

> **These are design records, not the architecture reference.** A spec describes what a feature
> intended *at the time it was written*. For how the system works **today**, read
> [`docs/architecture/current.md`](../docs/architecture/current.md) — that is the canonical
> current-architecture document. For the cross-repo boundary, read
> [`docs/architecture/synchronization.md`](../docs/architecture/synchronization.md).
>
> Specs are kept **in place, at their original paths**, on purpose: they are the historical record of
> why each decision was made, and the Spec Kit chain (`spec.md` → `plan.md` → `tasks.md` →
> `analysis.md`) is the audit trail for how it was built. Nothing here is deleted or relocated.

## Status meanings

| Status | Means |
|:--|:--|
| **Active** | Currently being specified or implemented. Expect churn. |
| **Implemented** | Shipped. The spec is a historical design record; current behaviour lives in `docs/architecture/current.md`. |
| **Deferred** | Specified but not built. Not a description of current behaviour. |
| **Superseded** | Later work changed the design. Read the successor named in the row. |

---

## Index

| Spec | Status | Notes |
|:--|:--|:--|
| [001-foundation](./001-foundation/) | Implemented | Electron + Vite + TS + tests + CI |
| [002-terminal-pairing](./002-terminal-pairing/) | Implemented | Device token, branch scope |
| [003-pos-ui-shell](./003-pos-ui-shell/) | Implemented | Design tokens, navigation, reserved slots |
| [004-operator-session](./004-operator-session/) | Implemented | Gates §A1 + §A2 cleared |
| [005-sales-cart](./005-sales-cart/) | Implemented | Owns the `resolveItemRef` seam 009 wires into |
| [006-payments-tender](./006-payments-tender/) | Implemented | §A5 signed off 2026-05-26 |
| [007-pos-visual-system](./007-pos-visual-system/) | Implemented | All six slices S0–S6 merged |
| [008-sale-finalization-and-receipts](./008-sale-finalization-and-receipts/) | Implemented | ⚠️ §A5 covers an internal/dev MVP only — **VAT is deferred to 012**, so customer-facing fiscal use remains blocked |
| [009-product-search-and-barcode-lookup](./009-product-search-and-barcode-lookup/) | Implemented | Ships the empty read model 010 fills |
| [010-pos-catalog-read-down-consumption](./010-pos-catalog-read-down-consumption/) | Implemented | Functionally complete + perf-cleared; only rollout-time §A5 remains |
| [011-sale-sync-capture-up](./011-sale-sync-capture-up/) | Active | S1–S4 merged; S5 (live HTTP client wiring) + §A5 readiness outstanding |
| [012-vat-fiscal-receipt](./012-vat-fiscal-receipt/) | Deferred | Blocks customer-facing fiscal use of 008 |
| [013-inventory-awareness](./013-inventory-awareness/) | Deferred | |
| [014-returns-refunds-voids](./014-returns-refunds-voids/) | Deferred | |
| [015-shift-cash-management](./015-shift-cash-management/) | Deferred | |
| [016-operator-envelope-adoption](./016-operator-envelope-adoption/) | Implemented | Two-credential seam: envelope for sale routes, JWT for identity routes |
| [017-offline-pin-reanchor](./017-offline-pin-reanchor/) | Implemented | Migration `0036`; artifacts carry SUPERSEDED-IN-PART banners — as-built design is authoritative |
| [018-pos-cashier-flow-state-machine-and-smoke-contract](./018-pos-cashier-flow-state-machine-and-smoke-contract/) | Deferred | |
| [019-cashier-pin-provisioning](./019-cashier-pin-provisioning/) | Implemented | Born-neutral provisioning; sole writer of cashier PIN rows |
| [020-pos-credit-and-third-party-tender-flow](./020-pos-credit-and-third-party-tender-flow/) | Deferred | |
| [021-pos-maintainability-rescue](./021-pos-maintainability-rescue/) | Active | This feature. R1 (S1–S3) complete; R2 in progress |
| [0xx-insurance-copay](./0xx-insurance-copay/) | Deferred | Unnumbered — not yet scheduled |

---

## Reading a historical spec

Two cautions, both learned the hard way on this repo:

1. **A spec's own status banner can be stale.** 017's artifacts, for instance, carry
   SUPERSEDED-IN-PART banners; the as-built design is the authoritative record. Where a spec and the
   code disagree, the code wins — and `docs/architecture/current.md` should be corrected if it
   disagrees too.
2. **A GitHub issue can be stale relative to the code.** #360 was closed as "already done" after
   verification showed the work had landed in earlier PRs while the issue text still said it hadn't.
   Verify against the source before acting on a status claim from any document.
