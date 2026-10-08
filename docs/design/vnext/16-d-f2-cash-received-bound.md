# D-F2: main-process bound on cash received (RT-248, Planning)

| | |
|---|---|
| Jira | RT-248, Work Mode **Planning (contract)**. No implementation here. |
| Source | [15-vnext-freeze-package.md](15-vnext-freeze-package.md) §7 **D-F2**: "Bound by currency maximum (RT-17 already has a shift-amount bound)". |
| Finding | F-02 (RT-159): a 13-digit barcode in the cash amount field was accepted as `amount_applied_minor ≈ 6.2×10¹⁴` on `main@0028827`. |
| Baseline | `origin/main@2ac05ee` (RT-240 merge, 2026-10-07). |
| Related | RT-239 (UI scan guard, merged), RT-17 (shift-amount bound), RT-24 I-9, RT-159. |

## 1. What is wrong today

| Layer | What it checks | What it lets through |
|---|---|---|
| Renderer `CashEntry` | `parseCurrencyToMinor`: digits, at most 2 decimals, a safe integer | Any number of digits. Scanned or hand-typed digits are read as **major** units, so `6221000000011` becomes `622 100 000 001 100` minor. |
| Renderer scan guard (RT-239) | A wedge burst into the amount field is refused | Hand-typed digits, a paste, or any path that is not a burst |
| Main `tender-apply.ts` | `Number.isSafeInteger(amount) && amount >= 0` (`invalid_input`) | Everything up to 2⁵³ − 1 minor |
| Main FSM (`tender-line-fsm.ts`) | Cash may overpay; the overage becomes `change_due_minor` | No upper bound at all |

**What it damages.**
- The change shown to the cashier (F-02 showed 6,220,999,999,375.00 EGP of change).
- The printed receipt, where `template-engine.ts` prints `change_due_minor`.
- The stored tender line and the sale's frozen tender summary.

The shift's expected cash is **not** damaged: it uses net cash, received minus change (RT-160 D-3).

**RT-17's bound does not catch F-02.** `maxShiftAmountMinor('EGP')` allows 15 integer digits, about 10¹⁵ EGP. The F-02 amount is about 6.2×10¹² EGP, well inside it. A storage-derived bound protects the wire format, not the cashier. D-F2 therefore needs an **operational** maximum.

## 2. Recommendation (as approved: a currency maximum)

**Rule.** For a `cash` line on `tender:apply`:

```
amount_applied_minor ≤ max(maxCashReceivedMinor(currency), remaining)
```

- `maxCashReceivedMinor` is a per-currency operational maximum, as approved.
- `remaining` is the attempt's balance still owed **when this line is applied**: the subtotal less the net of the lines already applied. The FSM already computes it inside the apply transaction.
- The `remaining` term answers the ticket's "large legitimate amounts" question: an exact cash payment of a balance larger than the cap is never refused.
- It must be `remaining`, not the immutable subtotal (review on #571). Example: a 150,000 EGP sale with 149,999 EGP already on card. With the subtotal, cash of 150,000 would pass and record 149,999 of change. With `remaining` (1 EGP) the limit is the cap, and 150,000 is refused.
- When the balance is above the cap, any overpay is refused. The cashier enters the exact amount. Net cash in the drawer is the same either way.
- Below the cap, an overpay up to the cap is still accepted, for example 100,000 received on 1 EGP owed. The cap is a plausibility bound against scanned or typed digits, not a change policy. The change-bound alternative below is the stricter option.

**Value: EGP 100,000.00 (`10_000_000` minor). Owner to confirm.**

| Bound | Reasoning |
|---|---|
| Must be **below** what scanner digits produce | Digits read as major units: Egyptian EAN-13 (prefix 622) gives about 6.2×10¹² EGP; UPC-A gives at least about 10⁹ to 10¹¹ EGP; EAN-8 gives at least 10⁷ EGP. UPC-E (8 digits, leading 0) gives at least 10⁵ EGP unless it has three or more leading zeros. A cap of 10⁵ EGP refuses every EAN-13, UPC-A and EAN-8, and nearly every UPC-E. |
| Must be **above** the largest real cash payment | A pharmacy counter basket is hundreds to a few thousand EGP, and a large chronic or bulk order is tens of thousands. 100,000 EGP leaves headroom. Exact payment of any larger balance is still allowed by the `max(…, remaining)` term. |

No cap catches every possible barcode: a code with many leading zeros reads as a small number. RT-239's UI guard stays the first line of defence. D-F2 is the backstop that stops an absurd amount from being **recorded** whatever path it came from.

**Where the value lives.**
- A new `src/shared/payments/cash-bound.ts` with `maxCashReceivedMinor(currency)` and the rule above as a pure function, imported by both main and the renderer.
- An unknown currency returns 0, so every cash amount above the remaining balance is refused. This fails closed, like `maxShiftAmountMinor`. The product is EGP-only (`CurrencyCode = 'EGP'`).
- It is a code constant, not tenant configuration: no configuration contract exists for it, and a per-tenant setting would be a new cross-repo contract.

### Alternative considered: bound the change, not the amount received

The alternative rule is `amount − remaining ≤ maxChange`. It bounds the overpay directly and would also refuse the 100,000-on-1-EGP case above. It runs in the same place as the recommendation, the FSM cash branch. It is not recommended because it changes the approved rule from "cash received" to "change". Listed so the owner can choose it knowingly.

## 3. Placement and refusal contract

**Entry points that accept a cash amount from the renderer:**

| IPC | Cash amount in the request | D-F2 |
|---|---|---|
| `tender:apply` (`tender_type: 'cash'`) | `amount_applied_minor` | **In scope** |
| `tender:apply` (card, voucher) | `amount_applied_minor` | Already bounded: an amount above the remaining balance is refused as `non_cash_overpayment_refused` |
| `shiftCashup` open, pay-in, pay-out, close (`amountMinor`, `countedCashMinor`) | yes | Out of scope; RT-17 owns these bounds. **Observation for the owner:** RT-17's 15-digit bound has the same F-02 gap for a scanned pay-in or count. Raise it under RT-17 if wanted. |
| `returns:payout` | no (main pays the server-confirmed total) | Not applicable |

**Placement.** The check goes in the FSM's cash branch (`tender-line-fsm.ts`), inside the apply transaction where `remaining` is computed, **before** any `lines.insert` or outbox write. It returns `{ kind: 'refused', reason: 'cash_amount_out_of_range' }` without persisting anything:
- no tender line row, no outbox entry, no `tender.refused` audit (that event is written only for persisted `non_cash_overpayment_refused` rows);
- the attempt is unchanged.

Unlike `non_cash_overpayment_refused`, which persists a refused row, this is an input error, so nothing is written.

**Idempotency (review on #571).** The FSM runs **after** the handler's idempotency replay lookup, so the `tender.apply` replay contract (`specs/006-payments-tender/contracts/bridge-api.md`) holds:
- a line persisted before rollout, replayed with its original key and payload, returns its original outcome;
- a fresh over-cap request writes nothing, so a retry with its key is evaluated again and refused again.

`tender-apply.ts` passes the FSM refusal through unchanged and logs the line below.

**Refusal shape.**
- `{ kind: 'refused', reason: 'cash_amount_out_of_range' }`, named after RT-17's `aggregate_out_of_range`.
- This is a bridge contract change. It must be added to `REFUSAL_REASONS` in `src/shared/payments/types.ts`.
- Implementation must check every exhaustive switch, map or runtime validator over `RefusalReason` (the preload pass-through included) and update it.
- The refusal names a closed reason, never a value (P7, as in RT-17).

**Audit.** No audit event, matching `invalid_input`: nothing was recorded, so there is no tender event to audit. Emit one structured `warn` log line (`event: 'tender.apply.cash_out_of_range'`, `payment_attempt_id`) **without the amount**.

**Owner option:** record it as a fraud/abuse signal (a new audit event type, which is a schema change). Not recommended for the pilot.

## 4. Renderer

- **Pre-check.** `CashEntry` imports the same `cash-bound.ts` rule. Above the bound, the confirm button is disabled and an inline reason is shown under the amount. Main stays the authority.
- **Refusal copy.** Today every `tender:apply` refusal shows the generic «تعذّر تطبيق الدفعة. يرجى المحاولة مرة أخرى.» (retry), which is wrong here because retrying never helps. Instead, `cash_amount_out_of_range` maps to its own line, the amount stays in the field for correction, and focus stays on it.
- **Copy needs a new catalog row (owner to word).** The freeze package §5 has no row for "amount above the cash limit". This plan does not write the copy. The row should say that the amount is above the cash limit, and ask the cashier to check the amount. It should not say "try again".

## 5. Tests to write (implementation slice)

**Shared (`cash-bound.ts`)**
- `maxCashReceivedMinor('EGP') === 10_000_000`; an unknown currency gives 0.
- The rule: `cap` accepted, `cap + 1` refused (remaining below the cap); `remaining` accepted and `remaining + 1` refused (remaining above the cap); 0 accepted.

**Main (`tender-apply`)**
- An F-02-shaped input is refused as `cash_amount_out_of_range`: the barcode `6221000000011` read as EGP is `622_100_000_001_100` minor; on a 636.00 EGP sale it would show F-02's 6,220,999,999,375.00 of change.
- After that refusal: no line row, no outbox row, the attempt state is unchanged, and no `tender.refused` audit is written.
- Boundary at the cap and cap + 1 through the real handler.
- A balance above the cap paid in exact cash is accepted. One minor unit over is refused.
- Card and voucher behaviour is unchanged (exact-only, `non_cash_overpayment_refused`).
- A split sale: 150,000 EGP with 149,999 already on card; cash of 150,000 is refused, cash of 1 is accepted.
- A refused request retried with the same idempotency key is refused again, and nothing is persisted.
- A cash line above the cap persisted before rollout (seeded directly), replayed with its original key and payload, returns its original `ok` outcome.
- The log line carries the attempt id and no amount.

**Renderer**
- Above the bound, confirm is disabled and the inline reason shows. At the bound it is enabled.
- A `cash_amount_out_of_range` refusal shows its own copy, not the generic retry line. The amount is kept and focus stays on the field.
- The RT-240 strict sweep (`latin-leaks.ts`) passes on the new copy.

**Contract**
- `REFUSAL_REASONS` includes `cash_amount_out_of_range`, and every exhaustive mapping compiles.

## 6. Rollout and risk

- No migration, no Backend-Core API change. Sale capture carries no tender.
- One additive IPC refusal value. Main and the renderer ship in the same app build.
- **Risk:** a legitimate overpay on a balance above the cap is refused. Mitigation: the cashier enters the exact amount.
- **Change footprint:** one pre-insert check in the FSM cash branch, with no new state and no new transition.

## 7. Owner decisions

1. Confirm the value of EGP 100,000.00, or give another.
2. Confirm the `max(cap, remaining)` rule, or prefer one of:
   - a strict cap, where a sale above the cap cannot be paid in cash alone;
   - the change-bound alternative (§2).
3. Word the new catalog row for the refusal (§4).
4. No audit event for the pilot: confirm, or ask for a fraud-signal event.
5. Optionally, open the same gap under RT-17 for scanned shift amounts (§3).
