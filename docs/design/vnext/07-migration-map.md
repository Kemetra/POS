# 07 — Current → VNext migration map

> Strategy: **no all-at-once rewrite.** V5 is already live for Sale and owner-approved; VNext grows
> it one surface at a time behind the 023 clean-room wall, each slice with 1024/1280 captures and
> its own Jira item. Legacy surfaces keep working until their slice replaces them.
>
> Categories: **Keep** (as-is) · **Restyle** (same DOM/behaviour, VNext tokens/copy only) ·
> **Recompose** (clean-room rebuild on the V5 vocabulary, same behaviour) · **Retire** (delete once
> unreferenced) · **Defer** (no work until its dependency/contract exists).

## A. Screens

| Surface (today) | Category | Why | Slice |
|---|---|---|---|
| V5 Sale `/app/cart` (023, approved 2026-09-25) | **Keep** + small additions | Approved baseline. Additions: scan-owner states, bound `Kbd` hints, plural/number fixes, stepper arrows. | VN-S3, VN-S5 |
| V5 Frame / nav | **Keep** + StatusIndicator | Approved; needs truthful status cluster. | VN-S6 |
| Checkout `/app/checkout` (006 `PaymentSurface` + v3.5 kit + 022 in V5 frame) | **Recompose** | Mixed generations; amount due off-screen at 1280 (X-3); duplicate CSS blocks; bilingual headings. Behaviour unchanged. | VN-S4 |
| Completion (v4 US4a in V5 frame) | **Recompose** | Proof list; sale/receipt references when available (X-4). | VN-S4 (panel) + dependency |
| Sign-in (v4 + 004 children) | **Recompose** (later) | Works; mixed vocabulary; bilingual labels. Not pilot-blocking. | VN-S8 |
| Pairing / paired (002/007) | **Restyle** | Rare, works; add too-small guard + Arabic copy. | VN-S8 |
| Takeover prompt (004) | **Recompose** into `Dialog` | Own dialog mechanism. | VN-S8 |
| Shift-closed banner (004, English) | **Restyle** → `Banner` | English inside Arabic frame. | VN-S6 |
| Printer / drawer banners (008) | **Restyle** → `Banner` | V5 wiring retained; legacy no-op reprint dies with AppShell. | VN-S6 |
| Offline/connection banner (003) | **Recompose** → `Banner` + `StatusIndicator` | Needs real signal (X-2). | VN-S6 |
| Sales / receipt lookup (003/008) | **Recompose** | Three styling mechanisms; English labels. | VN-S9 |
| Returns placeholder | **Restyle** to gated entry | Pilot-gated; full flow = RT-15. | VN-S9 (entry) / RT-15 |
| Dashboard, inventory, audit, settings placeholders | **Restyle** (Arabic copy, V5 empty state) or remove from cashier nav | Owner decision OD-6. | VN-S10 |
| Manager: stuck shifts / forced close (unstyled) | **Recompose** | Unstyled English; manager-critical. | VN-S10 |
| Manager: cashier management | **Restyle** | Works. | VN-S10 |
| Force-fail route | **Keep hidden** | No contract. | — |
| Catalogue diagnostics | **Restyle** | English; hosts sync-attention detail. | VN-S10 |
| Screen too small | **Restyle** | English → Arabic. | VN-S2 |
| Boot loading / error boundaries | **Recompose (new)** | Blank frame; no boundaries. | VN-S2 |
| Suspend / resume / suspended list | **Defer → build** | Needs park contract (RT-24 I-13; D-007). | VN-S11 |
| Shift open / close / cash in-out | **Defer** | RT-17. | RT-17 |
| Split tender, insurance/credit | **Defer** | Post-pilot; ADR-0005. | — |
| Static V5 proof `#/dev/sale-proof` | **Retire** | Superseded by live V5 Sale; carries unbound "F2" and «ج.م». | VN-S3 |

## B. Design assets and code vocabulary

| Asset | Category | Note |
|---|---|---|
| `src/renderer/styles/tailwind.css` token values (022) | **Keep** | Source of values. |
| `docs/DESIGN.md` (navy/Inter/dark) | **Retire → replace** with the approved 04 language in DESIGN.md format | VN-S1 |
| `.impeccable/design.json` (navy/Inter/light-only) | **Retire → regenerate** from approved language | VN-S1 |
| `docs/product.md:34` "Inter" | **Restyle** (text fix) | VN-S1 |
| `docs/design/pos-v3.5/**` | **Keep as history** | Mark historical in its README (VN-S1). |
| `specs/022…/design-handoff/**`, Tower Blue (RT-27) | **Keep as reference** | Not authority. |
| 007 primitives `ui/primitives/*` (unused in prod) | **Retire** once `StatusBanner` replaced | VN-S6 |
| `.btn*`, `.v4-*`, v3.5 `method-card`/`tender-row`/`quick-amount-btn`, legacy `Workspace` | **Retire** as each consuming screen migrates | per slice |
| 51 dead CSS classes (`account-row*`, `held-*`, `v4-stepper*`, `badge--*`) | **Retire** | VN-S2 hygiene |
| `tailwind.config.ts` `darkMode:'class'` (dead) | **Retire** | VN-S2 |
| `--color-accent` (== primary) | **Retire** after legacy rail | VN-S10 |
| Off-scale font sizes (34), hard-coded durations (~20), undefined `--font-size-base` | **Restyle** to role/motion tokens inside touching slices | per slice |
| `AmountPad`/`MoneyRoll` local money formatters (`Math.floor` negative bug) | **Retire** in favour of `shared/money` | VN-S4 |
| `ThemeToggle` on cashier-facing chrome | **Retire** from cashier chrome (OD-4) | VN-S10 |

## C. Order of migration (why this order)

1. **VN-S1 Docs truth** first — agents otherwise keep reading navy/Inter/dark and re-inventing.
2. **VN-S2 Foundation** (role tokens, forced-colors, error/loading screens, hygiene) — no visible
   redesign, unblocks everything.
3. **VN-S3 Sale refinements** — smallest visible change on the approved screen.
4. **VN-S4 Checkout recompose** — the biggest RT-24 conflict (X-3); depends on RT-26 for Back.
5. **VN-S5 Scanner/keyboard hardening** — needs the key map conflict test.
6. **VN-S6 Status truthfulness** — depends on a real connectivity/sync signal.
7. Remaining surfaces (S7–S11) as their contracts land.
