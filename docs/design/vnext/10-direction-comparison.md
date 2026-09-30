# 10 — Layout direction comparison: A (V5-based) vs B (cart-first command bar)

> Added at the owner's request ("we can choose another direction instead of V5 if it is better").
> Both directions share the **same visual language** ([04](04-design-language.md): the shipped 022/023
> teal tokens, type roles, numeral policy, states, RT-24 invariants). They differ only in **layout**.
> Owner decision **OD-7** ([README](README.md#owner-decisions)).

## The two directions

| | **A — V5-based** (what 04 §16 describes) | **B — cart-first command bar** |
|---|---|---|
| Nav | Labelled panel, 208px (1280) / 140px (1024) | Slim icon + label rail, 76px at both widths |
| Adding items | Product rail on the inline-start side (360/300px): scan target, search field, results list, freshness | Full-width **command bar** above the cart: scan target + search field + suspended-sales button; search results drop down over the cart and close on Esc/selection |
| Cart | Centre, shares width with the rail | Takes most of the workspace width |
| Money + primary action on Sale | Totals band + «الدفع» at the bottom of the cart panel | **Money column** on the inline-end side: total at top, «الدفع», suspend, cancel at the bottom |
| Checkout | Summary · tender · ledger (money column on the inline-end side) | Same as A, with more width from the slim nav |
| Sale → Checkout continuity | Total moves from the bottom band to the top of a new column | **Same column, same place**: the Sale total becomes the Checkout amount due; «الدفع» becomes «تأكيد الدفع» |

References: A = `VN-R1-*`, `VN-R2-*`; B = `VN-B1-*`, `VN-B2-*`; long-cart capacity test = `CMP-A-*`,
`CMP-B-*`. Side-by-side: [`references/compare.html`](references/compare.html).

## Measured (same data, same kit, Chromium, 2026-09-30)

A 10-line pharmacy cart with real-length Arabic names (the `CMP-*` captures). Values come from the
build's DOM measurement (`build.cjs`, `console.table`).

| Metric | A 1024 | **B 1024** | A 1280 | **B 1280** |
|---|---|---|---|---|
| Cart rows fully visible (of 10) | 5 | **9** | 6 | **9** |
| Product-name column width | 164px | **248px (+51%)** | 214px | **386px (+80%)** |
| Pay button position (x, y) | (150, 683) | (97, 561) | (237, 707) | (105, 585) |
| Checkout confirm position (x, y) | (161, 587) | (97, 587) | (237, 611) | (105, 611) |
| Pay → confirm vertical move | 96px | **26px** | 96px | **26px** |
| Sale total position → Checkout amount-due position | (404, 702) → (161, 151): moves across and up | **(97, 175) → (97, 151)** | (495, 723) → (237, 105) | **(105, 191) → (105, 105)** |

All positions were measured from the rendered DOM (top-left of the element). At 1024, A's pay button
also drifts inline-end by ~11px when a four-digit total widens the totals box. The nav is on the
inline-end (left) side in both directions, matching `V5Frame.tsx` (screen first, nav second).

**Caveat:** A is the reference kit's reconstruction of the V5 grid, not the live app. The 023
polish review recorded **6–7 rows at 1024** on the real V5 Sale with its data. Before adopting B, one
Electron capture of real V5 with this 10-line cart must confirm the gap (part of VN-S3/VN-S12).

## Qualitative assessment against RT-24 / RT-25

| Criterion (source) | A | B |
|---|---|---|
| Cart, scan/search, total and next action always obvious (RT-24 hierarchy) | ✓ | ✓ |
| Scan owner visible (04 §9) | ✓ in rail | ✓ in command bar, larger |
| Dense but readable long Arabic names (RT-25) | ⚠ names wrap to 2–3 lines at 1024 | ✓ mostly 1–2 lines |
| Low-interruption search (RT-24) | ✓ results never cover the cart | ⚠ dropdown covers the top cart rows while searching |
| Muscle memory Sale → Checkout (P1, I-3) | ⚠ money and primary move | ✓ money and primary stay put |
| Browse without typing (empty-state suggestions, future quick products) | ✓ rail has room | ⚠ needs a dropdown or post-pilot quick-product surface |
| Navigation discoverability | ✓ full labels | ⚠ short labels (12px) under icons; needs 7 new icons |
| Change cost from what ships | Low: incremental on the approved V5 Sale | Medium: re-layout of the approved V5 Sale (same components and behaviour), plus owner re-approval |
| RT-24 behaviour change | None | None (layout only) |

## Recommendation

**Adopt B's layout ideas selectively, and verify before committing:**

1. **Money column on Sale (from B): recommended.** It gives the strongest benefit (same place for
   money and the primary action through the whole journey) at the lowest risk.
2. **Command bar instead of the product rail (from B): recommended for pilot.** Most pharmacy sales
   are scanned. It trades a permanent, mostly-empty rail for cart capacity (9 vs 5–6 rows in the
   kit). Mitigate the dropdown trade-off by capping it at 3–5 results and closing on Esc/selection.
3. **Slim nav (from B): recommended only while a sale is active** — i.e. on Sale, Checkout and
   completion, from the first item until «بيع جديد». Keep the labelled panel on
   non-sale screens (manager/admin), or allow expanding on demand.
4. **Keep A's visual language and every component unchanged.** B changes where components sit, not
   what they are or how they behave.

If the owner prefers minimum change for the pilot, **A stays valid**. Take only point 1 (money
column) and revisit B after the pilot.

## If B is chosen

- 04 §16 (1024/1280 behaviour) and 05 VN-07…VN-11 are amended to the B layout. No other document changes.
- New slice **VN-S12 "Sale layout B"** (Implementation, depends on VN-S2): re-compose the V5 Sale
  into command bar + cart + money column, and the V5 frame into a slim nav on every active-sale
  route (Sale, Checkout, completion) — which is what VN-B2 depicts; VN-S4 still owns Checkout content. Behaviour,
  hooks and tests stay the same. Acceptance: real-app capture shows more visible rows than today at
  1024 with the 10-line cart; owner re-approval of the new Sale captures.
- VN-S3 (Sale refinements) merges into VN-S12.
