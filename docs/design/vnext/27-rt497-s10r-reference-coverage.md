# 27 — RT-497 (VN-S10 S10-R): G-6 reference coverage map

> **Status: coverage check only. Nothing was drawn.** Every manager/admin surface and state that
> RT-497 names already has an owner-approved reference on `main`. This file records that map and
> proposes on Jira that RT-497 is satisfied by the existing references. Done is the coordinator's
> call.
>
> - **Jira:** **RT-497** (Work Mode: **Docs / design references**), parent RT-478 (Done), plan
>   [23](23-vn-s10-manager-surfaces-shell-retirement.md) §7, row S10-R.
> - **Baseline:** POS `origin/main@673a8f9e` (2026-10-18).
> - **Method:** each surface and state in RT-497's scope was matched to a file under
>   [`visual-acceptance/`](visual-acceptance/index.html), and the approval was checked in the spec
>   page, the [README](README.md) row and the Jira record. No app run and no capture was made for
>   this map.

## 1. The surfaces and states RT-497 names

RT-497 lists 21 states at 1024×768 and 1280×800, light and forced colours, with an Arabic copy
table, generator `tools/gen_g6.py` and checker `tools/capture_g6.cjs`. All 21 are in
[`G6-Manager/`](visual-acceptance/G6-Manager/G6-Spec.html), delivered by PR #670 (merged at
`d9cd4f4b`) and **owner-approved as is, with every proposed string, on 2026-10-15** (RT-478 comment
11907). Doc 15 §6 records G-6 closed.

| # | Surface / state (RT-497) | Route | Reference on `main` | Status |
|---|---|---|---|---|
| 1 | Manager home, shift flag on | `/app/dashboard` | `G6-Home-1024/1280` | Approved 2026-10-15 |
| 2 | Manager home, shift flag off | `/app/dashboard` | `G6-HomeNoShift-1024/1280` | Approved 2026-10-15 |
| 3 | Cashier refusal | `/app/dashboard` (cashier) | `G6-CashierRefused-1024/1280` | Approved 2026-10-15 |
| 4 | Sales lookup, empty | `/app/sales` | `G6-Sales-1024/1280` | Approved 2026-10-15 |
| 5 | Sales lookup, found | `/app/sales` | `G6-SalesFound-1024/1280` | Approved 2026-10-15 |
| 6 | Sales lookup, not found | `/app/sales` | `G6-SalesNotFound-1024/1280` | Approved 2026-10-15 |
| 7 | Reprint sent | `/app/sales` | `G6-SalesReprintSent-1024/1280` | Approved 2026-10-15 |
| 8 | Reprint failed | `/app/sales` | `G6-SalesReprintFailed-1024/1280` | Approved 2026-10-15 |
| 9 | Returns, frame placement | `/app/returns` | `G6-Returns-1024/1280` | Approved 2026-10-15 (frame only; content in §2) |
| 10 | Audit | `/app/audit` | `G6-Audit-1024/1280` | Approved 2026-10-15 |
| 11 | Inventory | `/app/inventory` | `G6-Inventory-1024/1280` | Approved 2026-10-15 |
| 12 | Catalogue diagnostics | `/app/inventory/diagnostics` | `G6-Diagnostics-1024/1280` | Approved 2026-10-15 (see §3, D7) |
| 13 | Settings | `/app/settings` | `G6-Settings-1024/1280` | Approved 2026-10-15 |
| 14 | Stuck shifts, list | `/app/manager/stuck-shifts` | `G6-StuckList-1024/1280` | Approved 2026-10-15 |
| 15 | Stuck shifts, close dialog open | same | `G6-StuckOpen-1024/1280` | Approved 2026-10-15 |
| 16 | Stuck shifts, reason chosen | same | `G6-StuckConfirm-1024/1280` | Approved 2026-10-15 |
| 17 | Refused, list refreshed | same | `G6-StuckChanged-1024/1280` | Approved 2026-10-15 |
| 18 | Refused, no refresh | same | `G6-StuckFailed-1024/1280` | Approved 2026-10-15 |
| 19 | Stuck shifts, empty | same | `G6-StuckEmpty-1024/1280` | Approved 2026-10-15 |
| 20 | Stuck shifts, unreachable | same | `G6-StuckUnreachable-1024/1280` | Approved 2026-10-15 |
| 21 | Force-fail notice | `/app/manager/force-fail` | `G6-ForceFail-1024/1280` | Approved 2026-10-15 |
| — | Checkout, payments flag off | `/app/checkout` | copy only in the G-6 copy table (plan 23 §7: no capture, reuses the force-fail notice pattern) | Approved 2026-10-15 |

**Missing: none.**

## 2. Other manager/admin surfaces, already covered by later references

These routes sit in the same V5 frame. They are outside RT-497's list but were checked so the map
is complete for every manager/admin route in `router.tsx` at the baseline.

| Surface | Route | Reference on `main` | Jira / PR | Status |
|---|---|---|---|---|
| Returns content (RT-15 flow, replaces the row 9 stand-in for content) | `/app/returns` | [`G6-Returns/G6R-Spec.html`](visual-acceptance/G6-Returns/G6R-Spec.html) | RT-660, #739 | Approved 2026-10-17 |
| Receipt preview dialog in «المبيعات» | `/app/sales` | [`G6P-Receipt-Preview/G6P-Spec.html`](visual-acceptance/G6P-Receipt-Preview/G6P-Spec.html) | RT-659, #738 | Approved 2026-10-17 |
| «إلغاء بيع» | `/app/void` | [`VD-Void/VD-Spec.html`](visual-acceptance/VD-Void/VD-Spec.html) | RT-654, #735 | Approved 2026-10-17 |
| Manager shift status, plus the cashier shift family | `/app/shift/manager`, `/app/shift` | [`G2-Shift/G2-Spec.html`](visual-acceptance/G2-Shift/G2-Spec.html) | RT-658, #736 | Approved 2026-10-17 |
| Held sales / recovery | `/app/manager/recovery` | [`RC-Recovery/RC-Spec.html`](visual-acceptance/RC-Recovery/RC-Spec.html) | RT-656, #737 | Approved 2026-10-17 |
| Manager → Cashiers | `/app/manager/cashiers` | [`G3-Cashiers/G3-Spec.html`](visual-acceptance/G3-Cashiers/G3-Spec.html) | RT-251 | Approved 2026-10-12 |
| Parked sales (park / resume) | `/app/cart/parked` | [`PK3-Park-Resume/PK3-Spec.html`](visual-acceptance/PK3-Park-Resume/PK3-Spec.html) | RT-471, #722 | Owner decisions recorded 2026-10-17 |

Already implemented on `main` against these references: the legacy `AppShell` is gone (S10-Z,
RT-504, #684) and the manager/admin route guards on inventory, diagnostics and settings are in
(RT-597, #721).

## 3. Later owner decisions that touch G-6 but are not RT-497 gaps

These change what some G-6 references show. Each has its own owner and none is a missing RT-497
reference, so none was drawn here.

| Ref | What changes | On `main` at the baseline | Where it belongs |
|---|---|---|---|
| RT-536 **D7** | «فحص الكتالوج» search lists matched items (name, barcode, price), not only «‹n› نتيجة». Amends `G6-Diagnostics` | **Not built.** The page still shows the count only (`v5/manager/diagnostics/diagnostics-copy.ts`) | The D7 implementation issue under RT-536. It needs new column strings, so its reference should be drawn with that work |
| RT-536 **D8** | «سجل المراجعة» and «الإعدادات» hidden from the manager nav; routes stay | **Not built** (`v5/frame/nav-model.ts`) | Same. Only the rail differs; the `G6-Audit` and `G6-Settings` page bodies stay valid |
| RT-536 **D1** | Cashier nav adds «المبيعات» and «إعادة طباعة آخر إيصال» | **Not built** (`CASHIER_NAV` = Sale only) | Same. Cashier chrome, not a manager surface |
| RT-596 / D2 | Store sales-history block on `/app/sales` | Built (RT-541 #694, RT-542 #699) | Owner-accepted deviation, plan 23 §6 |
| RT-595 / D1 | Frame notices strip above the `h1` | Built | Owner-accepted deviation, plan 23 §6; the landmark fix is a separate code PR |

## 4. Proposal

RT-497's acceptance ("owner approves each reference and the copy table; doc 15 §6 records G-6
closed") is met on `main` by `G6-Manager/` (#670). Proposed: RT-497 is satisfied by the existing
references and needs no new drawing.

### Open decisions

- **O-1. Who redraws `G6-Diagnostics` for D7.** *Selected — recommended option, owner may revisit:*
  the D7 implementation issue draws its own result-list reference (it brings the new strings), and
  RT-497 stays closed on the references as approved.
- **O-2. The rail in G-6 after D8.** *Selected — recommended option, owner may revisit:* no redraw;
  once D8 ships, S10-V reads the G-6 rail with «سجل المراجعة» and «الإعدادات» absent, like the
  plan 23 §6 deviations.

## 5. Evidence limits

- Approval status comes from the spec pages, the README rows and the Jira comments; it was not
  re-confirmed with the owner.
- No app run, no packaged build and no new captures. Packaged comparison is RT-505 (S10-V).
