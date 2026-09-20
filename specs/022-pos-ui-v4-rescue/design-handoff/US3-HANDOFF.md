# US3 implementation handoff — Checkout / tender

**Status:** PREPARED, **NOT STARTED**. No US3 code has been written.
**Target:** [`../tasks.md`](../tasks.md) → **Phase 7 — US3: Checkout / tender (P1)** (T070–T079, T0E1)
**Visual authority:** [`../visual-references/04-checkout-tender.png`](../visual-references/04-checkout-tender.png)
— the rendered authority. `design-files/Retail Tower POS v4.dc.html` (screen `03 الدفع`) is the
precise source for **values**, but ⚠️ **it does not render** (missing `support.js` — see
[`RECONCILIATION.md`](./RECONCILIATION.md) §Contents). Read it as source text; do not expect to open
screen 03 in a browser.
**Governing rules:** [`RECONCILIATION.md`](./RECONCILIATION.md) §A–§E

> This brief adds **mockup-derived visual detail** to the existing US3 tasks. It does not replace,
> reorder or reinterpret them. Where this brief and `tasks.md` differ, **`tasks.md` wins**.

---

## 1. Supported tenders — exactly three, unchanged

Pinned in source at `src/shared/payments/types.ts`:

```ts
export const TENDER_TYPES = ['cash', 'external_card_terminal', 'internal_voucher'] as const;
```

| Tender | Mockup tile it maps to |
| :--- | :--- |
| `cash` | `نقداً` — the selected tile in the reference |
| `external_card_terminal` | the card tile, **relabelled**; the mockup's `بطاقة مدى` branding is dropped |
| `internal_voucher` | the voucher tile, **relabelled**; not the mockup's `قسيمة هدية` gift-card framing |

**MUST NOT be added** (T071, and §B of RECONCILIATION): `بطاقة ائتمان` (credit),
`شركة تأمين` (insurance), `محفظة رقمية` (Apple Pay / STC Pay), `قسيمة هدية` (gift card),
and the **mada** brand mark.

---

## 2. What to TAKE from the mockup

Geometry, hierarchy, spacing, typography, control sizing, RTL composition and visual density —
subject to §C (tokens) and §E (viewport) of RECONCILIATION.

**Three-column composition.** `392px` / `flex:1, min-width:0` / `400px`, gap `16`, padding `0 18 18`.
Source order left→right is cart summary → methods → amount panel (RTL rule 1: page shells are
ordered in source, not mirrored by `dir` alone). Content blocks inside each column are `dir="rtl"`.

**Amount-due hierarchy (T070, FR-16).** This is the single most load-bearing value in the brief —
the amount due is the dominant numeric on the surface:

| Element | Treatment |
| :--- | :--- |
| Amount due (right panel) | **44/700**, left-aligned in its card, tabular |
| Amount due (cart-summary block) | 24/700 on a teal-tint block, radius 12, padding 16 |
| Received amount field | 26/700, field border 1.5, radius 12, padding 14 |
| Remaining due | 30/700 |
| Section titles | 19/700 |

**Tender grid (T071).** Tile: radius `14`, padding `18 14`, icon `30`, label `15/700`, sub `11`.
Selected state: **2px** primary border + tinted fill + a `20px` check badge at the tile's
inline-start top corner. Note the mockup's selected border is 2px, heavier than the 1.5px used for
selected rows elsewhere — that emphasis is intentional.

> **Grid geometry does NOT transfer.** The mockup lays out 3×2 for six tenders. With three, the row
> reshapes — do not preserve a 3×2 cage, and do not pad it with disabled or placeholder tiles.

**Amount entry (T072).** Quick-amount buttons: radius `10`, padding `10 4`. The mockup groups them
4-up then 3-up; that grouping is presentational and may adapt to the supported denominations.
**Presentation only — no client-side money arithmetic** (T072 is explicit).

**Footer bar.** Note field `flex:0 0 360`; toggle track `44×24` radius `999` with an `18px` knob;
cancel action turns red on hover; primary confirm padding `15 40`, label `16/700`.

**Numerals.** Latin digits, two decimals, thousands separators, `tabular-nums`, and `dir="ltr"` on
money spans (FR-21 already requires the `dir="ltr"` mono treatment).

---

## 3. What to ADAPT or DROP

| In the mockup | Action |
| :--- | :--- |
| `ضريبة القيمة المضافة (15%)` row, and the VAT figure in totals | **DROP.** Egyptian VAT deferred; `total_tax_minor` is 0. Not a TODO. |
| `ر.س` currency unit, `188.03 ر.س` sample amounts | **ADAPT** to the product's configured currency presentation. Sample values are not targets. |
| mada brand mark + `بطاقة الصراف المحلي` | **DROP.** Relabel as `external_card_terminal`. |
| Credit / insurance / wallet / gift-card tiles | **DROP** (T071). |
| `عميل مسجل` registered-customer row | **DROP** — no such capability. |
| `إرسال نسخة رقمية` (SMS/email receipt) toggle | **DROP** — no dispatch capability (see T082's prohibition in US4). |
| Payment-details table with `**** 4582` masked PAN | **ADAPT.** Keep the applied-lines table — it is how split tender stays visible (T075) — but POS-Pulse holds an external reference (`^[A-Z0-9]{0,6}$`), **not** card digits. Never render a PAN. |
| Six-tile 3×2 grid | **ADAPT** to three tiles (§1). |

---

## 4. What must NOT change

- **Payment FSM, money math, tender application, voucher authority.** T074 requires
  `payments/__tests__/**`, `parse-currency-to-minor.test.ts` and the FSM tests pass **unmodified**.
- **Split tender (T075, FR-40).** A shipped capability (006 T154): a part-payment returns to tender
  selection while the applied sum is below subtotal, and the applied-lines list stays visible.
  Restyling must preserve it. It is **not** a Non-Capability item.
- **Voucher authority stays main-process** (T073). No client-side voucher validation.
- **Viewport floor** (§E). Unchanged at 1024px.
- **Tokens** (§C). Any new value lands as a `--*` definition in `tailwind.css`, never inline;
  `token-guard.test.ts` enforces this. Do not adopt a stock Tailwind hex over an
  accessibility-measured repo token.

---

## 5. Arabic-first copy (T076–T079)

The working (pre-settlement) tender flow still carries English-only operator strings, verified in
source: `PaymentSurface.tsx:396` and `:437` render `<h2>Payment</h2>`; `PaymentCartSummary.tsx:42,62`
render `Order summary` / `Subtotal`.

T076 writes the RED assertion (zero English-only operator-facing strings across the working flow);
T077–T079 make it pass. **Copy and presentation only** — no change to amount parsing, tender
application, or any bridge call.

Arabic copy in the mockup may be reused as a *register* reference, but it is Saudi-market copy. Have
it reviewed before shipping, and drop any string naming an unsupported capability.

---

## 6. Acceptance (T0E1)

Capture `u3-checkout-before/after.png` and compare against
`../visual-references/04-checkout-tender.png`. Confirm no English-only operator string remains
visible in the captured working flow.

**Capture preconditions** — from [`../screenshots/README.md`](../screenshots/README.md), re-verified
per launch, not inherited:

- `operator.dev_bypass.active` MUST be observed **in the rotating log file**
  (`<AppData>/Roaming/pos-pulse/logs/main-.<YYYYMMDD>.1.log`) — the main logger never writes to
  stdout, so checking the terminal yields a false STOP.
- Catalogue readiness confirmed (seed line **or** verified row counts).
- `POS_PULSE_DEV_ITEM_RESOLVER` must be **actively unset** — with it set, catalogue products are
  refused `unknown_item` and a non-empty cart cannot be reached.
- Reaching checkout needs a **non-empty cart**, so a product must be searched and confirm-added by
  hand first.
- ⚠️ The dev bypass signs in as **manager**, not cashier. A manager capture cannot evidence
  cashier-role behaviour.

---

## 7. Suggested order

1. T076 (RED, Arabic-first assertion) — establishes the failing test first, per repo TDD rule.
2. T070 amount-due hierarchy → T071 tender grid (three tiles) → T072/T073 entry surfaces.
3. T077–T079 Arabic-first copy to green T076.
4. T074 + T075 verification — payment tests unmodified, split tender intact.
5. T0E1 capture + comparison.
