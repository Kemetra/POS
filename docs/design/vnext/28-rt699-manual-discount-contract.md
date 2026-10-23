# 28 — RT-699 step 1: the manual-discount contract (P-26-6)

> **Status: Planning. Docs only, no code.** This file proposes the contract that gives a manual
> discount a value, a total effect, a capture shape and a receipt line. It also describes the
> cashier-with-approval and manager-direct flows built on RT-114. Money, tax and fiscal rules
> that need the owner are left **Open**. A recommendation is given for each, but nothing is
> decided for the owner. Cross-repo shapes are named as dependencies, not defined here.
>
> **Update 2026-10-24 (P1 close-out).** The owner answered OD-28-1…4, 9 and 11 on 2026-10-19
> (RT-699 comment 12975). Backend-Core shipped the C-A capture shape (RT-740). The §2 table
> records the outcomes. [§11](#11-p1-close-out-2026-10-24) adds the zero-total completion plan
> (**OZ-1 = Z-A**, owner decision 2026-10-24), the Backend-Core verification and the slice → Jira map. Where
> §1–§9 say "Open" or "proposed", §2 and §11 give the current state.
>
> - **Jira:** **RT-699**, step 1 (Work Mode: **Planning**). Source: [26](26-rt536-cashier-feature-completeness.md)
>   §7 **P-26-6**, gap **G-19**, owner decision **OD-26-4 = A** (discount is in pilot scope).
> - **Reconciled against:** RT-28 (Done, authority), RT-114 (approval contract), RT-608 (In
>   Review, merged code: manager-only add), RT-614 (Done, trust check), spec 005 **FR-023** /
>   FR-024 / FR-026.
> - **Baseline:** POS `origin/main@2d3cba07` (2026-10-18). Backend-Core capture contract as
>   vendored in `contracts/backend-core/` (PIN `1711813d`, `pos-sales/sales.yaml` 1.12.0-draft).
>   Backend-Core and ERPNext-Connector were not inspected at their own `main` for this item.

## 1. What `main` does today (verified)

| Area | Today on `main` | Source |
|---|---|---|
| Authority | Every positive manual discount needs manager authority. A cashier's add must carry an `approval_id` for kind `cart.discount.manual`, or it is refused `manager_attribution_required`. A manager or admin session applies directly and is recorded as the approver (D2). The add writes the placeholder, the outbox row and a `cart.discount.manager_authorized` audit row in one transaction. | `src/main/cart/cart-bridge.ts` (`discountPlaceholdersAdd`), RT-608 |
| Approval binding | The subject ref is `<cart_id>_<line_id>_<placeholder_kind>`. Main binds tenant, branch, cart, line, kind and the line `version`. **`amountMinor = null`** (owner decision O1: intent only until math exists). | `src/shared/cart/discount-approval.ts`, `src/main/cart/discount-approval.ts` |
| Trust | A placeholder is trusted only when a `cart.discount.manager_authorized` audit row names it. Handoff refuses `unauthorized_discount` (step 3a). Payment eligibility refuses an untrusted envelope (step 3b). | `src/main/cart/discount-trust.ts`, RT-614 |
| Storage | `cart_line_discount_placeholders`: `placeholder_id`, `cart_id`, `line_id`, **opaque `placeholder_kind` TEXT**, `requires_manager_attribution`, `attribution_operator_id`, `created_at`. **No magnitude column.** | `migrations/0011_cart_line_discount_placeholders.sql` |
| Math | None. `computeLineSubtotal` = `quantity × unit_price_minor` is the only line money arithmetic. The envelope `subtotal_minor` = Σ line subtotals. A placeholder does not change any total. | `src/main/cart/line-subtotal.ts`, `src/shared/cart/handoff-envelope.ts` |
| Renderer | `LiveSaleCart` lists placeholders and offers **remove** only. **Nothing calls `cart.discountPlaceholders.add`.** The snapshot placeholder is opaque (`placeholder_id`, `line_id`, no magnitude). | `src/renderer/v5/sale/LiveSaleCart.tsx`, `src/renderer/sale/useSaleCartController.ts` |
| Sale and capture | The finalized Sale freezes `lines_json` (`line_subtotal_minor` per line) and `subtotal_minor`. `buildCapturePayload` sends `lineAmountMinor = line_subtotal_minor` and `totalMinor = subtotal_minor`. Tenders must sum to `subtotal_minor`. | `src/main/sales-sync/capture-payload.ts` |
| Backend-Core capture | `CaptureSaleLine` is `additionalProperties: false`, with the **RT-105 price invariant `lineAmount = unitPrice × quantity` exactly**. Returns and credit reversal use Σ `lineAmount` as the basis for `posTotal`. **There is no discount field.** | `contracts/backend-core/openapi/pos-sales/sales.yaml` |
| VAT | Deferred. `total_tax_minor` is hardcoded to 0, and receipts carry no tax line (008 §A5 caveat). | spec 008, `CLAUDE.md` |
| Receipt | Lines come from the frozen `lines_json` (`line_subtotal_minor`). There is no discount row. | `src/main/receipts/receipts-payload.ts` |

**Consequence.** A discount cannot reach the capture unchanged today. A line whose `lineAmount`
is less than `unitPrice × quantity` is refused 422 `sale_line_pricing_invalid` (RT-105), and
the request schema rejects any extra field. **A capture-contract change in Backend-Core is a hard
dependency** before a discounted sale can sync (§6, DEP-1).

## 2. Decisions

Status key:

- **Selected — recommended option, owner may revisit:** behaviour or scope that this Planning item
  may set.
- **Open — owner decision:** money, tax or fiscal rules. A recommendation is given, but nothing
  is decided.
- **Open — dependency:** a cross-repo contract. The owning repo decides it.

| ID | Question | Options | Status |
|---|---|---|---|
| OD-28-1 | Discount kind | (A) percent only; (B) fixed amount only; (C) both, one per line | **Decided 2026-10-19: C**, percent or fixed amount, one manual discount per line (RT-699 comment 12975). |
| OD-28-2 | Percent precision and range | (A) whole percent 1–100; (B) basis points 1–10000 | **Decided 2026-10-19: A**, whole percent 1–100. |
| OD-28-3 | Rounding of a percent discount to minor units | (A) round half up; (B) floor (in the store's favour); (C) ceiling (in the customer's favour) | **Decided 2026-10-19: A**, round half up on the discount amount, computed once per line on the line gross (§3.2). |
| OD-28-4 | Maximum discount | (A) up to 100% (a free line is allowed); (B) a cap below 100% set by policy; (C) a tenant cap that is configurable later | **Decided 2026-10-19: C.** Up to 100% now (a free line is allowed), with a per-tenant cap made configurable later. The net ≥ 0 floor is always enforced. **The owner did not take the "refuse a zero cart total" recommendation: a fully discounted sale must complete with no tender.** It completes with no tender (OZ-1 = Z-A, owner decision 2026-10-24, §11.3). |
| OD-28-5 | Scope | (A) per-line only for the pilot; (B) per-line and whole-sale | **Selected — recommended option (A), owner may revisit.** Storage, the approval binding and FR-023 Q2 are already per-line. Whole-sale scope needs an allocation rule across lines (money) and a new approval subject, so it is deferred (§3.4). |
| OD-28-6 | Stacking | (A) at most one manual discount per line; (B) several | **Selected — recommended option (A), owner may revisit.** To change a discount, remove it (D4) and add again with approval. |
| OD-28-7 | A quantity change on a discounted line | (A) refused until the discount is removed; (B) the discount is dropped automatically, with a notice; (C) a percent discount re-applies and an amount discount stays | **Selected — recommended option (A), owner may revisit.** The approved amount must stay equal to the applied amount (RT-114 binding). Option C would change a manager-approved amount with no new approval. |
| OD-28-8 | Where the value is stored | (A) encoded in the existing `placeholder_kind` token, with no schema change (D5 holds); (B) new typed columns, which is a migration and revisits D5 | **Selected — recommended option (A), owner may revisit.** See §3.1. The token is already inside the approval subject ref, so the approval binds the value with no new binding code. |
| OD-28-9 | Reason code | (A) required on both paths, from a closed list; (B) optional | **Decided 2026-10-19: A, with a closed list of four** (§11.2): `promotion` «عرض ترويجي», `loyal_or_contract_customer` «عميل دائم / تعاقد», `near_expiry_or_damaged` «قرب انتهاء / عبوة تالفة», `price_correction` «تصحيح سعر». The add request carries a validated `reason_code` on the direct path (§4.2). |
| OD-28-10 | Discount and VAT | Is the discount applied before VAT (VAT on net) or after? | **Open — owner decision, deferred with VAT** (confirmed 2026-10-19). VAT is not implemented (`total_tax_minor = 0`). Nothing here sets a tax rule. §3.5 states only that the shape does not block either order. |
| OD-28-11 | Receipt wording and fiscal display | Arabic labels and whether the receipt must show gross, discount and net per line | **Decided 2026-10-19: the §5 layout.** One indented «خصم 10%  −9.00» row under each discounted item (an amount discount shows «خصم» and the amount), and one «إجمالي الخصم» row above the total. The fiscal display stays **Open** with 008-v2. |
| OD-28-12 | Capture shape in Backend-Core | §6 options C-A, C-B, C-C | **Resolved: C-A shipped in Backend-Core** (RT-740, Backend-Core#880 `a8a8d309`, `sales.yaml` 1.14.0-draft; 1.15.0-draft on Backend-Core `main@c1d6215f`). See §11.4. |
| OD-28-13 | ERPNext posting of the discount | Item-level discount fields, or the net rate only | **Open — dependency (ERPNext-Connector).** Tracked as RT-857. |

## 3. The math contract (proposed; final numbers wait on OD-28-1…4)

### 3.1 Value encoding (OD-28-8 A)

The placeholder kind becomes a strict, canonical token. Main parses it and refuses anything else.

| Kind | Token | Value range |
|---|---|---|
| Percent | `manual_pct_<P>` | `P` is an integer, 1–100 (OD-28-2 A) |
| Amount | `manual_amt_<M>` | `M` is an integer number of minor units, 1 ≤ `M` ≤ line gross |

- The renderer sends the token. **Main computes the amount**, and the renderer never sends an
  amount.
- No leading zeros, no sign and no other characters. The token fits MA-2's
  `[A-Za-z0-9_-]{1,128}` subject alphabet. A non-canonical token is refused
  (`invalid_payload`, existing code).
- Because the token is part of `<cart_id>_<line_id>_<placeholder_kind>`, **an approval for
  "10%" can never be spent on "20%"**. MA-2 compares the ref exactly.
- The approval subject `amountMinor` changes from `null` to the computed discount amount (§3.2),
  and the subject version adds it. This retires O1's interim "intent only" once math exists, as
  O1 anticipated.
- Older opaque kinds (anything that is not a canonical token) stay untrusted for math. A cart that
  holds one is refused at handoff, the same as an untrusted placeholder.

### 3.2 Computation, in integer minor units only

For a line with `gross = quantity × unit_price_minor` (from `computeLineSubtotal`):

- **Amount:** `discount = M`. Refused if `M > gross`.
- **Percent, round half up (OD-28-3 A):** `discount = floor((gross × P + 50) / 100)`, in integer
  arithmetic. Every intermediate value must pass `Number.isSafeInteger`, otherwise the add is
  refused.
- `net = gross − discount`. The invariant is **0 ≤ net ≤ gross**.
- The amount is computed **once, per line, on the line gross**. It is never computed per unit, so
  there is no per-unit rounding drift.
- The function is pure and deterministic. The same frozen line and token always give the same
  `discount`, so the handoff, the Sale, the capture and the receipt all derive the same number.
- No float, no `toFixed` and no `Math.round` on a fraction. The ≥ 95% money-module coverage rule
  applies.

### 3.3 Totals

- Envelope: `subtotal_minor` stays Σ gross. The envelope gains `discount_total_minor` = Σ line
  discounts and `total_due_minor` = `subtotal_minor − discount_total_minor`. This is a
  POS-internal change to the 005/006 handoff contract
  (`specs/005-sales-cart/contracts/handoff-envelope.md`): a new `envelope_version` or an explicit
  v1 field rule. It belongs to the implementation slice, not to Backend-Core.
- **The amount-due chain on `main` and what each step carries.** Today one value,
  `envelope_subtotal_minor`, flows from the envelope to the Sale, so it must carry the **net**
  (`total_due_minor`) once a discount exists. Otherwise one name means gross in one place and net
  in another:

  | Step on `main` | Today | With a discount |
  |---|---|---|
  | `payments.start` request (`src/main/ipc/payments.ts`) and `cart-payment-eligibility.ts` | renderer sends `envelope_subtotal_minor`; eligibility requires it to equal the envelope `subtotal_minor` | eligibility requires it to equal the envelope **`total_due_minor`** |
  | `payment_attempts.envelope_subtotal_minor` (`payments-start.ts`, repository) | Σ gross | **net** (`total_due_minor`). The I1 slice decides whether to keep the column name with a documented meaning or add an `amount_due_minor` (a migration, so owner authorization) |
  | Tender sufficiency (`tender-line-fsm.ts`, `payment-attempt-fsm.ts`) and voucher apply (`apply-voucher-line.ts`) | against `envelope_subtotal_minor` | unchanged code, now against the net |
  | Finalize (`finalize-dispatch.ts`: `subtotal_minor: attempt.envelope_subtotal_minor`) | Sale `subtotal_minor` = gross | Sale `subtotal_minor` = **net**, matching the tender sum (`capture-payload.ts`) and the receipt total |
  | Manager recovery (`manager-recovery.ts`) | reads the attempt amount | reads the net. I1 checks it has no gross assumption |

  With no discount, net = gross, so every existing sale and test is unchanged.
- Sale: each `lines_json` entry gains an optional `discount` object (`kind`, `value`,
  `amount_minor`, `placeholder_id`, `reason_code`, `authority_source` = `cashier_approval` |
  `manager_session`, `approver_role`, `approver_operator_id`). This is a JSON shape, with no DDL.
  It is frozen at finalize from the placeholder and its `cart.discount.manager_authorized` audit
  row, so the capture builder has a durable source for every §6 fact. **`approver_role` has no
  durable source today on the cashier path.** `manager_approvals` stores only `approver_user_id`,
  the PIN record stores no role, and the audit row's session is the cashier's. I1 must therefore
  write `approver_role` into the `cart.discount.manager_authorized` payload at add time:
  - manager path: the session role;
  - cashier path: the approver's role as main resolves it when the approval is granted or
    consumed.

  If that needs a column on `manager_approvals`, it is a migration and needs owner authorization;
  otherwise the field is dropped from the contract. `sales.subtotal_minor`
  keeps meaning **the amount charged before tax**, which is the net. The implementation slice
  must state this naming explicitly, because the name says "subtotal" while the value is net.
- Tenders must sum to the net total, as they sum to `subtotal_minor` today.

### 3.4 Whole-sale discount (deferred, OD-28-5)

This is not in the pilot. When it is added, it needs:

- an allocation rule that spreads a sale-level amount across lines (largest remainder, by line
  gross), so that the line amounts still sum exactly. This is a money rule (owner);
- a new approval subject bound to the cart version;
- the same capture shape as per-line, because the allocated share lands on each line.

### 3.5 VAT (deferred, OD-28-10)

VAT is not implemented in POS (`total_tax_minor = 0`, the 008 §A5 caveat). **This contract sets no
tax rule.** The per-line net shape works for either order: tax on net (the usual pharmacy
practice) or tax on gross. The choice is made with 008-v2 and Backend-Core's `taxAmount`. Until
then, customer-facing fiscal use stays blocked, as it is today.

## 4. Flows on RT-114

### 4.1 Cashier, with approval

1. The cashier selects a line and opens **«خصم»**. Main does not need to be asked yet.
2. The cashier picks a kind and value (OD-28-1) and a reason (OD-28-9). The sheet shows the
   **preview amount and net**, computed by the same shared pure function as main. The preview is
   presentation only. Main recomputes the amount.
3. The cashier taps **request approval**. The renderer calls `approval.request` with kind
   `cart.discount.manual` and `subject_ref = discountApprovalSubjectRef({cart_id, line_id,
   placeholder_kind: token})` and the chosen `reason_code` (the existing
   `ManagerApprovalRequest.reason_code` field, `src/shared/operator/manager-approval.ts`). For
   `cart.discount.manual`, main refuses a reason outside the closed list (§11.2). The approval
   record keeps the reason, so the approval binds it. The manager picks their name and enters
   their **Manager Approval PIN**. The PIN goes only through the approval bridge. The dialog follows the shipped
   `ManagerApprovalDialog` pattern.
4. Main verifies the PIN and issues a single-use `approval_id` bound to the subject, including
   `amountMinor`. The approver is never the requester (C6). It works offline inside the RT-114 C4
   window (O3).
5. The renderer calls `cart.discountPlaceholders.add` with **only** `cart_id`, `line_id`,
   `placeholder_kind`, `idempotency_key` and `approval_id`. Main recomputes the amount, consumes
   the approval in the add's transaction, and writes the placeholder, outbox and audit rows. The
   reason is the one bound to the approval at request time. If the add also sends a
   `reason_code`, it must equal the approval's reason, or the add is refused `approval_invalid`.
   **Replay identity:** the reason is part of the add's idempotency identity. I1 stores the
   resolved `reason_code` (and the token, already stored) in the outbox payload, and
   `isSameDiscountAddReplay` compares it. Today the replay check runs first and compares only
   cart, line and kind. A retry under the same key with a different reason is then refused
   `idempotency_payload_mismatch`. It does not return success while the audit keeps the original
   reason.
6. The line shows the discount row and the new net. The approver's display name is shown (O2).

### 4.2 Manager or admin, direct (D2)

Steps 1–2 are the same. There is no approval prompt. The add carries no `approval_id`. Main
records the session operator as the approver. The reason code is still required (OD-28-9 A).
There is no approval to carry it, so `CartDiscountPlaceholdersAddRequest` gains an optional
`reason_code`, and the IPC parser stops dropping it. Main validates it against the closed list
(OD-28-9) and refuses a missing or unknown value with `invalid_payload`. The reason is a code, not
free text, so no PII crosses the bridge. This is a POS-internal bridge change (slice I1, with a
§A4 re-check).

### 4.3 Remove (D4)

Any role may remove. Remove is a non-sensitive lifecycle action, and it can only raise the total.
It restores the line net to gross.

## 5. Receipt line (proposed; wording OD-28-11)

Under each discounted item, one indented row:

```
بانادول إكسترا ٢٤ قرص        2 × 45.00        90.00
   خصم 10%                                   −9.00
```

- An amount discount shows `خصم` and the amount only.
- One summary row **«إجمالي الخصم»** appears above the total when any line is discounted.
- The total is the net. The digits follow the shipped money format (Western tabular digits,
  DESIGN.md). The OD-3 numeral check applies.
- The receipt reads only the frozen `lines_json` (it already does). It never re-derives the
  discount from the cart.
- The fiscal display (whether gross, discount and net must each appear, and any e-receipt field)
  is **Open** with 008-v2.

## 6. Capture fields (cross-repo dependency, not defined here)

What the POS Sale **must be able to carry** to Backend-Core, whatever the final shape:

| Fact | Per | Notes |
|---|---|---|
| Gross line amount (`unitPrice × quantity`) | line | Today's `lineAmount` |
| Discount amount, in minor units | line | The computed amount (§3.2) |
| Net line amount | line | gross − discount. This is the refund basis for returns |
| Discount kind and value (`percent` 10, or `amount` 500) | line | Provenance |
| Reason code | line | OD-28-9 |
| Approval attribution: approver role, and whether it came from a cashier approval or a manager session | line | Never a credential and never a PIN. Identity follows Backend-Core's existing attribution rules |
| `posTotal` = Σ net | sale | Tenders sum to it |

Options for Backend-Core (OD-28-12):

- **C-A (recommended): an additive optional `discount` object on `CaptureSaleLine`**
  (`kind`, `value`, `amount`, `reasonCode`, `authoritySource` = `cashier_approval` |
  `manager_session`, `approverRole`), with `lineAmount` = **net**. How the approver's identity
  is sent (for example a user ref under Backend-Core's RT-224 attribution rules) is part of
  DEP-1. The RT-105 invariant
  becomes `lineAmount = unitPrice × quantity − discount.amount` when `discount` is present, and is
  unchanged when it is absent. This keeps `posTotal = Σ lineAmount`, so the returns and
  credit-reversal rules (`returnTotal = Σ lineAmount`) refund the net with no change. The change
  is additive. A sale without `discount` is byte-identical, so the RT-79 / RT-540 cutoff pattern
  is not needed for body stability.
- **C-B:** `lineAmount` stays gross, plus a sale-level discount. This breaks `posTotal = Σ
  lineAmount` and the return basis. Not recommended.
- **C-C:** send a reduced `unitPrice`. This loses the real price, and a percent discount rarely
  divides into a whole minor unit per unit. Not recommended.

**Dependencies (open):**

- **DEP-1, Backend-Core:** the capture contract change above (a `sales.yaml` minor version), the
  DB columns and the RT-105 validator. **Until it ships, POS must not sync a discounted sale.**
  Recommended guard: **hold, do not dead-letter.** A dead letter is terminal: the engine's
  `markDeadLetter` path, used for `TenderNotSendableError`, removes the sale from every later
  drain, so it would never sync after DEP-1. Instead, while a POS capability switch says
  Backend-Core cannot accept discounts, the drain skips discounted sales and leaves them pending.
  The sync status shows them as held, with a named reason. I4 turns the switch on, and the held
  sales then drain normally with no requeue step. Alternatively, keep the POS UI behind a flag
  until DEP-1 lands (choice in slice P1).
- **DEP-2, Backend-Core:** the audit catalogue and OpenAPI accept
  `cart.discount.manager_authorized`. This is already a named RT-608 gate. The payload gains
  `kind`, `value` and `amount_minor`.
- **DEP-3, ERPNext-Connector:** map the line discount to the Sales Invoice Item (for example the
  price-list rate plus a discount amount, or the net rate only) (OD-28-13). The Connector owns
  this. POS never calls ERPNext.
- **DEP-4, Backend-Core sale history and returns:** the sale detail and the return quote must show
  and refund the net. Under C-A this follows from `lineAmount` = net, but it needs verifying.
- **POS returns lookup (in slice I4, not a dependency):**
  - `src/main/returns/returns-verify.ts` (`snapshotKeys`) matches the server's `lineAmount`
    against the frozen gross `line_subtotal_minor`.
  - A discounted sale's server line is net, so `isExpectedSale` would reject every discounted
    sale at return lookup.
  - I4 changes the key to use the frozen `discount` net when present, and adds a
    discounted-return test.

## 7. Refusals and audit

| Case | Result | Code |
|---|---|---|
| Cashier, no `approval_id` | refused, nothing written | `manager_attribution_required` (existing) |
| Approval expired, consumed, wrong kind, wrong subject (other line, other token, other value), stale line version | refused, nothing written | `approval_invalid` / `approval_stale` (existing) |
| Non-canonical token, value out of range, amount > gross, overflow | refused | `invalid_payload` (existing) |
| A second discount on the same line (OD-28-6 A) | refused | **new** code, for example `discount_already_applied`. Needs copy (slice D1) |
| A quantity change on a discounted line (OD-28-7 A) | refused | **new** code, for example `line_discounted`. Needs copy (slice D1) |
| A frozen, parked or other-session cart | refused | existing cart codes |
| Handoff with an untrusted or non-canonical placeholder | refused | `unauthorized_discount` (existing, RT-614) |
| Payment with an untrusted envelope | refused | existing step 3b |

Audit:

- `cart.discount.manager_authorized` is emitted on every add, with `acting_operator_id` (the
  requester), `approving_supervisor_id`, `approval_id` (cashier path), `reason_code`, and the new
  `kind`, `value` and `amount_minor`.
- No PIN, credential or customer data appears in audit rows or logs.
- Remove keeps D4: a non-sensitive record.
- The RT-614 trust predicate is unchanged. It still keys on the audit row.

## 8. Test plan (for the implementation slices)

**Pure math (`shared`, ≥ 95% coverage):**

- percent half-up at the boundary: gross 45, 10% → 5 (4.5 rounds up); gross 44, 10% → 4;
- 1% of 1 → `amount = 0`, allowed (OD-28-4 = C, §11.1);
- 100% → net 0;
- amount = gross → net 0; amount > gross refused;
- overflow near `MAX_SAFE_INTEGER` refused;
- non-canonical tokens refused: `manual_pct_010`, `manual_pct_0`, `manual_pct_101`, `manual_amt_-5`,
  `manual_amt_1.5`, `manual_pct_10x`.

**Main:**

- the three RT-699 paths:
  - cashier with approval: consumed once, and the amount equals the approved `amountMinor`;
  - manager direct: recorded as approver, no approval consumed;
  - refusal: none written;
- an approval for a 10% token cannot be spent on a 20% token;
- an exact replay returns the original outcome with no second consume;
- the envelope `discount_total_minor` and `total_due_minor` are correct;
- payment eligibility uses the net;
- the RT-614 handoff and eligibility tests still pass;
- a quantity change on a discounted line and a second discount are both refused;
- the Sale `lines_json` carries the discount, and the receipt payload shows the discount row and
  the net total;
- with the capability switch off, a discounted sale is held (still pending, never
  dead-lettered, shown as held). With the switch on, the same stored sale drains and sends C-A,
  including attribution (contract-conformance test against the re-pinned `sales.yaml`);
- a manager-direct add with a missing or unknown `reason_code` is refused, and a cashier add
  whose `reason_code` differs from the approval's is refused;
- an idempotent retry with the same key and a different `reason_code` is refused
  `idempotency_payload_mismatch`;
- `approver_role` is frozen correctly on both paths, after a restart between add and finalize;
- a discount that makes the cart total 0 completes with no tender, and its capture carries one
  `cash` 0 tender (OZ-1 = Z-A, §11.3);
- after I4, a return lookup on a discounted sale matches and quotes the net;

**Renderer:**

- the «خصم» control is reachable for cashier, manager and admin;
- the cashier path opens the approval dialog, and the add carries only `approval_id`;
- the manager path shows no dialog;
- the preview equals main's amount;
- refusals use the catalogue copy;
- Arabic-only copy, keyboard and focus, 1024 and 1280.

**Contract:** a §A4 bridge re-check note covers the new token rule, the add request's `reason_code` and any envelope field.

## 9. Bounded follow-up slices

| Slice | Mode | Repo | Content | Depends on |
|---|---|---|---|---|
| **P1** | Planning close-out | POS | The owner answers OD-28-1…4, 9 (list), 10 and 11. Amend spec 005 FR-023 / FR-024 and `specs/005-sales-cart/contracts/handoff-envelope.md` to point at this contract. | This doc |
| **D1** | Docs / design references | POS | The «خصم» sheet (kind, value, reason, preview), the approval prompt reuse, the line discount row, the remove action, the two new refusals, and the receipt rows, at 1024 and 1280. The Arabic copy table is owner-approved. | P1 |
| **I1** | Implementation | POS | The shared pure discount function, token parse, envelope totals, payment amount due, approval `amountMinor`, the add request's `reason_code` (§4.2) and its place in replay identity, the durable `approver_role` (§3.3), the zero-cart-total rule (OD-28-4), the two new refusals, and the audit payload fields. No UI. | P1 |
| **I2** | Implementation | POS | The renderer control and flows (§4), on D1's references. | I1, D1 |
| **I3** | Implementation | POS | Sale `lines_json` discount (with attribution), receipt rows, and the sync hold for discounted sales behind the capability switch (held pending, never dead-lettered, until DEP-1). | I1 |
| **BC-1** | Contract-first, then Implementation | Backend-Core | DEP-1 (capture `discount`, RT-105 invariant), DEP-2 (audit catalogue), DEP-4 (history and returns). | OD-28-12 |
| **CN-1** | Implementation | ERPNext-Connector | DEP-3, the line discount posting. | BC-1 |
| **I4** | Implementation | POS | Re-pin `sales.yaml`, send C-A, turn the capability switch on so held sales drain, and change the returns lookup key (`returns-verify.ts`) to the discounted net, with a test. | BC-1 |

Pilot path: P1 → D1 → I1 → I2 → I3 gives a working till discount whose sales stay **unsynced**
until BC-1 → I4. If the pilot needs synced discounted sales, BC-1 is on the critical path. That is
for the coordinator to schedule.

## 10. Evidence limits

- Only code and contracts on POS `main@2d3cba07` were read. No tests, app run or hardware were
  used, and nothing in `src/**`, `migrations/**`, packages or CI was changed.
- The Backend-Core capture contract was read from the POS vendored copy (PIN `1711813d`), not
  from Backend-Core `main`. ERPNext-Connector was not inspected.
- The ERPNext field mapping in DEP-3 is indicative only. The Connector decides it.

## 11. P1 close-out (2026-10-24)

Baseline: POS `origin/main@be087a4f`; Backend-Core `origin/main@c1d6215f`
(`packages/contracts/openapi/pos-sales/sales.yaml` 1.15.0-draft). Docs only. No test, app run
or hardware was used. Nothing in `src/**`, `migrations/**`, packages or CI was changed.

### 11.1 Owner decisions (2026-10-19, RT-699 comment 12975)

| ID | Outcome |
|---|---|
| OD-28-1 | **C:** percent or fixed amount, one manual discount per line |
| OD-28-2 | **A:** whole percent, 1–100 |
| OD-28-3 | **A:** round half up on the discount amount, once per line, on the line gross |
| OD-28-4 | **C:** up to 100% now (free line allowed), per-tenant cap configurable later, net ≥ 0 always. **A zero cart total must complete** (§11.3) |
| OD-28-5…8 | The selected recommendations stand: per line only, no stacking, a quantity change on a discounted line is refused, the value is encoded in `placeholder_kind` |
| OD-28-9 | **A**, closed list of four (§11.2), required on both paths |
| OD-28-10 | Deferred with VAT |
| OD-28-11 | The §5 layout. Fiscal display open with 008-v2 |

So §3.2 holds with these values, and §8's "1% of 1 → 0" case is **allowed**: a percent that
rounds to 0 gives `amount = 0`, exactly as Backend-Core states for `kind: percent`.

### 11.2 Reason codes

The codes are the ones Backend-Core already validates (`CaptureSaleLineDiscount.reasonCode`),
so POS stores and sends the same strings:

| Code | Arabic label (copy) |
|---|---|
| `promotion` | عرض ترويجي |
| `loyal_or_contract_customer` | عميل دائم / تعاقد |
| `near_expiry_or_damaged` | قرب انتهاء / عبوة تالفة |
| `price_correction` | تصحيح سعر |

### 11.3 Zero-total completion (OD-28-4 = C)

**Verified on `main@be087a4f` (code read, not exercised):**

| Point | Today | Source |
|---|---|---|
| `payments.start` amount | accepts `envelope_subtotal_minor` ≥ 0 | `src/main/ipc/payments.ts` `isValidMinorUnit` |
| Settle | the FSM settles when Σ applied lines **equals** `envelope_subtotal_minor`. With 0 due and no line, Σ = 0 = due, so the FSM itself does not refuse. **No test covers it** | `src/main/payments/fsm/payment-attempt-fsm.ts` (confirm) |
| Cash at 0 due | refused `attempt_fully_tendered`, before any write (RT-339) | `src/main/payments/fsm/tender-line-fsm.ts` |
| Capture tenders | an empty tender summary sends **no** `tenders`, which Backend-Core reads as a **tender-unknown** sale (RT-10 D8) | `src/main/sales-sync/capture-payload.ts` `buildTenders` |
| Backend-Core | a zero-total sale is accepted. Without `tenders` it is tender-unknown. With `tenders`, the list holds **one `cash` entry of amount `0`** | Backend-Core `sales.yaml` 1.15.0-draft, `CaptureSaleLineDiscount` "Zero total" |
| Checkout renderer | whether «تأكيد الدفع» is reachable with no tender line | **Needs verification** (I1 / I2) |
| Cash-up, drawer kick, receipt | how a settled sale with no tender line counts in cash-up, whether anything kicks the drawer, and how the receipt renders an empty tender list | **Needs verification** (I1 / I3). Not read for this item; the Z-A row below states the intended result, not observed behaviour |

**OZ-1: how a zero-total sale completes. Decided 2026-10-24: Z-A** (the owner, in chat;
payment-state semantics, RT-10 / RT-116).

| Option | What happens | Change needed | Assessment |
|---|---|---|---|
| **Z-A (decided 2026-10-24): complete with no tender** | At 0 due, Checkout shows no tender tiles, only one completion action. Main confirms with no tender line, the FSM settles on Σ = 0, and finalize writes an empty tender summary. The capture sends `tenders: [{ method: cash, amountMinor: 0 }]` when the sale total is 0, so Backend-Core records a zero-total sale, not a tender-unknown one. The receipt shows the total 0.00 and no tender row. Cash-up: the sale counts, and expected cash is unchanged. No drawer kick | I1: a zero-due settle test, and a check that no guard assumes at least one line. I2: the Checkout state at 0 due (drawn in D1). I4: the capture rule for a zero total (the sale is held until I4 anyway, because it is discounted) | Smallest change. It keeps RT-339's "cash at 0 due is refused" rule, and matches Backend-Core's documented shape |
| Z-B: record a 0 cash tender line in POS | The cashier applies cash 0, and the sale settles on that line | Lift RT-339's refusal for the 0 case, and decide whether a 0 cash line kicks the drawer | Reopens a guard that exists to stop a stale screen booking change. Not recommended |
| Z-C: refuse a zero cart total | A discount that would make the cart total 0 is refused, while a single free line stays allowed | I1 refusal and copy | The original recommendation. **The owner declined it on 2026-10-19.** It is listed only as the fallback if Z-A's verification fails |

Under Z-A, the §8 case "a discount that would make the cart total 0" becomes: it completes with
no tender, and the capture carries one `cash` 0 tender.

### 11.4 Backend-Core state (verified at `main@c1d6215f`)

- **DEP-1 is delivered** (RT-740, Done). `CaptureSaleLine.discount` carries `kind`, `value`,
  `amount`, `reasonCode`, `authoritySource`, `approverRole` and an optional `approverUserId`.
  `lineAmount` is the net. The RT-105 invariant is `lineAmount = unitPrice × quantity −
  discount.amount`. `approverRole` is `manager` or `admin`.
- In this version the `discount` object is **validated and hashed but not stored, and not
  returned**. `readSale`, sale history and returns work from the net `lineAmount` (DEP-4), but
  they do not show the discount itself.
- **The POS-vendored copy is stale** (PIN `1711813d`, 1.12.0-draft, no `discount`). I4 (RT-858)
  re-pins it.
- DEP-2 (the audit catalogue) was authorized under RT-740 (comment 13207). The I1 slice checks that
  the payload fields it emits are accepted.

### 11.5 Slices → Jira

| Slice | Jira | Work Mode | Blocked by |
|---|---|---|---|
| P1 (this section) | RT-699 | Planning | — |
| D1 | RT-853 | Docs | RT-699 P1 |
| I1 | RT-854 | Implementation | RT-699 P1 |
| I2 | RT-855 | Implementation | RT-854, RT-853 |
| I3 | RT-856 | Implementation | RT-854 |
| BC-1 | RT-740 | — | Done |
| CN-1 | RT-857 | Implementation | owner decision OD-28-13 |
| I4 | RT-858 | Implementation | RT-856, RT-857 |

### 11.6 Still open after P1

- **OZ-1** is decided (Z-A, 2026-10-24), but its "Needs verification" rows in §11.3 still need
  checking: whether Checkout can be reached with no tender, cash-up, the drawer kick, and the
  receipt. RT-854, RT-855 and RT-856 check them. If any of them refuses a no-tender settle, the
  issue stops and reports it; it does not fall back to Z-C on its own.
- **Spec 005 cart-layer scope:** FR-022, NFR-003, the DiscountPlaceholder entity, Out of Scope
  and A2 are amended so the cart layer computes the manual line discount and the two envelope
  totals. Every other discount kind, tax, tender, change and balance stay outside it.
- **OD-28-10**, VAT order, deferred with VAT.
- **OD-28-13**, ERPNext posting, RT-857. What the Connector gets today (read at Connector
  `main@f81c2b7` and Backend-Core `main@c1d6215f`, not exercised):
  - Backend-Core does not store the `discount` (§11.4). The posting feed reads `sale_lines`, so
    the Connector receives only `unitPrice`, `quantity` and the **net** `lineAmount`. It can
    derive the discount amount (`unitPrice × quantity − lineAmount`), but not the kind or the
    reason.
  - The Connector's Sales Invoice builder sets `rate` and `price_list_rate` to `unitPrice`, and
    `amount` to `lineAmount`. On a discounted line these disagree, because ERPNext recomputes
    `amount = rate × qty`.
  - So until RT-857 lands, a discounted sale must not reach posting. RT-858 stays blocked by
    RT-857.
  - If the owner wants the kind and the reason in ERPNext, Backend-Core needs a storage and feed
    change, and no ticket owns that yet. If the derived amount is enough, the Connector can do
    it alone.
- **`approver_role` source** (§3.3): whether I1 needs a `manager_approvals` column. If it does,
  that is a migration and needs owner authorization. Decided inside RT-854.
- **Envelope field rule** (§3.3): whether `discount_total_minor` / `total_due_minor` are a
  v1 extension (FR-036 allows adding fields) or an `envelope_version` bump. Decided inside
  RT-854. See the forward note in `specs/005-sales-cart/contracts/handoff-envelope.md`.
