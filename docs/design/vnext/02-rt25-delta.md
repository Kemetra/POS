# 02 — RT-25 delta report

> RT-25 ("Screen Inventory & Visual UX Blueprint", Done, owner-approved 2026-09-27 as the visual
> planning baseline subordinate to RT-24) is **not silently discarded**. Every numbered inventory
> item (§1–§27), every visual-system requirement and every scenario family is classified below.
>
> **Limitation:** the per-screen atlas (`RT25_Visual_Atlas.pdf`, Confluence page 7405593,
> attachment `att7077909`, 59 pp) could not be downloaded in this session (the egress proxy denies
> `api.media.atlassian.com`). Classification is therefore made at the **RT-25 §-item and S-group
> level** (S01–S48 groups from page 7405593), not per atlas image. The group ranges are from the
> page; the **individual S-numbers assigned to each §-item below are inferred** from those ranges
> (only S20 and S27 are confirmed by name in RT-27). Owner or a session with media access should
> spot-check the atlas against this table before approval.

Legend — **Retained**: carried into VNext unchanged in intent. **Amended**: retained with a named
change (reason given). **Superseded**: replaced by a VNext decision (reason given). **Deferred**:
kept as a future state, out of pilot VNext references.

## A. Screen inventory (§1–§27)

| RT-25 § | Item | S-group | Class | Delta / reason | VNext reference |
|---|---|---|---|---|---|
| §1 | Sign-in / takeover / locked | S01–S07 | **Amended** | Lock screen must show preserved cart + live tender summary («لم يُفقد شيء») — RT-24 inactivity rule made explicit. Sign-in stays on 022 v4 layout until VN-S8; legacy bilingual strings («كود الموظف · Staff code») retired. | VN-R8 (lock) |
| §2 | Shift required / open / opening float | S07 | **Amended** | Now a boundary screen only: shift lifecycle and cash-up are owned by RT-17 (not built; D-003 no open-shift contract). | VN-R11 |
| §3 | Empty Sale | S08 | **Retained** | V5 empty state approved 2026-09-25 (`v5-polish-1024/1280-A-empty`). Adds scan-owner indicator. | VN-R1 (rail) |
| §4 | Active Sale (one / many / long cart) | S09–S10 | **Amended** | Retain V5 cart; add: pinned totals band + CTA with `F8` hint; correct Arabic plurals; thousands grouping in money (OD-3); row flash on scan. | VN-R1 |
| §5 | Scan success / duplicate / unknown / unavailable | S11–S12 | **Amended** | Scan acknowledgement becomes an inline rail notice; duplicate scan = deterministic qty increment (RT-24). **Confirm-first vs direct-add** stays open (RT-24 §C.1) — reference shows direct-add acknowledgement as target only. | VN-R1 |
| §6 | Typed search: empty / results / none / stale / loading / error | S13–S14 | **Retained** | V5 listbox + keyboard-active option (023 polish) retained; adds "scan paused while searching" state. | VN-R1 1024 |
| §7 | Line edit: qty / remove / note | S15 | **Retained** | V5 stepper, note dialog, void confirm retained. Stepper ArrowUp/Down (lost in Slice H, `execution-ledger.md:123`) to be restored in VN-S5. | — (V5 live) |
| §8 | Manager authorization prompt; denied / approved | S16–S17 | **Amended** | Every positive manual discount is manager-only (owner decision, RT-28; RT-27 correction 4). Sheet shows bound action/amount/cart, reason required, returns to exact prior state. | VN-R6 |
| §9 | Suspend confirmation | S18 | **Retained** | Suspend requires durable save before clearing (RT-24). No confirmation dialog when nothing is lost; optional label inline. | — (inventory) |
| §10 | Suspended list: empty / one / many / stale | S18–S19 | **Retained** | Same-terminal only; unpaid; no stock reservation — stated in-list. | VN-R10 |
| §11 | Resume | S20–S21 | **Amended** | Conflict path per RT-27 correction 3: primary «علّق البيع الحالي واستأنف المحدد», secondary «ابقَ على البيع الحالي»; price change shown and explicitly accepted. | VN-R10 |
| §12 | Checkout before tender | S22 | **Superseded (layout)** | Current checkout is legacy 006 inside V5 frame; at 1280 the amount due falls below the fold during cash entry (X-3). VNext Checkout = 3 regions (summary · tender · ledger) at 1280, 2 regions + summary strip at 1024, amount due always pinned. Semantics unchanged. | VN-R2 |
| §13 | Safe Back-to-Sale | S22 | **Retained** | RT-26 semantics; VNext draws enabled / refused states. **Not on `main`** — must not ship enabled before RT-26. | VN-R2, VN-R3 |
| §14 | Tender selection | S22 | **Amended** | Pilot tenders = cash + external card (RT-10 D2); voucher tile stays in slot, disabled «غير متاحة حاليًا» (RT-103). No split / insurance / wallet tiles (022 RECONCILIATION §B). | VN-R2 |
| §15 | Cash: exact / denominations / manual / insufficient / change | S23–S24 | **Amended** | Quick amounts **set** (not add) — stated on screen; shortfall disables confirm with a reason; **no animated change-due roll** (VNext motion rule); financial confirm = `Ctrl+Enter`, not bare Enter. | VN-R2 (both) |
| §16 | Card: waiting / approved / declined / cancelled / timeout / unavailable | S25–S27 | **Amended** | Card reference optional, `^[A-Z0-9]{0,6}$` (RT-27 correction 2); "record the terminal result" framing — no bank API claim. | VN-R4 |
| §17 | Split / partial payment concept | — | **Deferred** | Post-pilot (RT-24 tiering; RT-27 brainstorm). No VNext pilot reference. | — |
| §18 | Payment recovery / stale attempt / retry-safe | S27–S28 | **Amended** | Dedicated UNKNOWN recovery surface (not a decline): no re-charge, record terminal result, manager escalation, back refused. | VN-R3 |
| §19 | Sale complete | S29–S30 | **Amended** | Staged proof list: payment recorded → sale saved → receipt → sync. Sync pending uses **info**, never success (R-C4). Sale/receipt number shown **only when proven** — blocked today (X-4). | VN-R5 |
| §20 | Receipt print / failure / reprint | S31 | **Amended** | Print failure = warning banner + inline retry; sale completion unaffected; "manual receipt handed" acknowledgement. Receipt print is disabled on `main` ("Printing lands in Slice 3"). | VN-R5 |
| §21 | Recent sales / receipt lookup | S32–S33 | **Retained** | Entry point from nav «المبيعات»; legacy `FindSaleReceipt` (Tailwind utilities, English label) to be recomposed (VN-S9). | — (inventory) |
| §22 | Return / Refund entry | S34–S35 | **Amended** | Entry state only, not yet available for pilot (RT-15 not built; returns not enabled for pilot per Confluence Current State). On `main` `/app/returns` is a manager/admin-only placeholder (`shell-routes.ts`); whether cashiers get a returns entry is RT-15's decision. Copy states original sale is never edited. | VN-R12 |
| §23 | Offline / reconnecting / sync backlog | S36–S38 | **Amended** | Persistent frame StatusIndicator (quiet) + banner only when actionable. Requires a real connectivity/sync signal (X-2) — design must not fake «متصل». | VN-R7 |
| §24 | App recovery after restart / crash | S39–S40 | **Amended** | Adds `STORAGE_BLOCKED` blocking screen (stop collecting money) and a route error screen (none exist today). | VN-R9 |
| §25 | Inactivity lock with cart / live tender | S41 | **Retained** | As §1 amendment. | VN-R8 |
| §26 | Too-small / unsupported viewport | S47 | **Amended** | Copy becomes Arabic (today English-only `ScreenTooSmall`); guard added to pairing/sign-in. | — (inventory) |
| §27 | Shift close / cash-up entry → W6 | S43–S44 | **Deferred** | Boundary only until RT-17 defines the flow. Formula invariant I-15 recorded. | — |

## B. Visual-system requirements (RT-25)

| Requirement | Class | VNext location |
|---|---|---|
| Arabic-first RTL; LTR handling for money / IDs / barcodes | **Amended** — adds the numeral policy (one system, Western digits, pinned `ar-EG-u-nu-latn`) | 04 §2, §4.3 |
| Keyboard/scanner-first focus visibility | **Amended** — adds scan-owner indicator and `Kbd` hint rule | 04 §7, §9 |
| Touch-capable hit targets without oversizing | **Retained** — 44px floor; commit 56px; numpad 56–64px | 04 §8 |
| Dense, high-throughput layout, not SaaS cards | **Retained** — density profiles | 04 §5 |
| Primary hierarchy preserves cart, scan/search, total, next action | **Retained** — P1/P2; pinned regions | 04 §1, §16 |
| Operational status visible but quiet | **Amended** — StatusIndicator + banner escalation | 04 §11–§12 |
| Destructive/financial differentiated by consequence | **Retained** | 04 §3, P7 |
| Contrast; color never alone | **Amended** — adds Windows forced-colors requirement | 04 §15 |
| Explicit 1024 and 1280 references | **Retained** | references/ |
| Controlled customization within RT-24 invariants | **Retained** | 04 §17 |
| Optional light/dark/high-contrast only after primary coherent | **Amended** — light is the pilot register; dark maintained not offered (OD-4); forced-colors required | 04 §15 |

## C. Scenario families

| SF | Family | Class | VNext references |
|---|---|---|---|
| SF-1 | Fast normal sale | Retained | VN-R1 → VN-R2 → VN-R5 |
| SF-2 | Search-heavy sale | Retained | VN-R1 1024 |
| SF-3 | Barcode-heavy sale | Amended (scan-owner) | VN-R1 1280 |
| SF-4 | Suspend → serve another → resume | Retained | VN-R10 |
| SF-5 | Checkout → safe back → edit → Checkout | Retained (RT-26) | VN-R2 (Back), VN-R3 (refused) |
| SF-6 | Cash with change | Retained | VN-R2 1280 |
| SF-7 | Declined card → recovery | Amended (UNKNOWN distinct from decline) | VN-R4, VN-R3 |
| SF-8 | Connectivity loss while selling | Amended | VN-R7 |
| SF-9 | Printer failure after payment | Retained | VN-R5 |
| SF-10 | Restart with active/suspended cart | Amended (storage-blocked added) | VN-R9 |
| SF-11 | Manager-gated action | Amended (manager-only discount) | VN-R6 |
| SF-12 | Complete → receipt → New Sale | Retained | VN-R5 |
| SF-13 | Entry into Return/Refund | Amended (gated) | VN-R12 |
| SF-14 | Shift open / close | Amended (boundary; RT-17) | VN-R11 |

## D. What no longer matches product/runtime truth (since RT-25 approval, 2026-09-27)

1. Voucher disabled for pilot (RT-103, `28890fa`) — tender grid state changed.
2. Pilot tender enum fixed to cash + card_external (RT-10 D2, approved 2026-09-29).
3. Manual discounts manager-only (owner decision; RT-28 In Review; spec 005 stale).
4. EGP currency code shipped in checkout (RT-23, `37513ed`) — RT-25-era captures showing `¤` are stale.
5. RT-25 references were drawn against `eb4f4a2`; since then V5 Slice H retired the legacy Sale (26 files, 118 CSS rules), so any RT-25 state depicting legacy Sale chrome is superseded by V5.
6. RT-25 had no numeral policy and no forced-colors requirement — both added.
7. Tower Blue handoff (RT-27 v3) is a layout reference only; its token bundle is not adopted (OD-1).
