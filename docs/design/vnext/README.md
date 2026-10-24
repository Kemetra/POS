# RT-104 — Retail Tower POS UI VNext rebaseline (Planning package)

> **Status: APPROVED by the owner on 2026-10-01; RT-104 is Done.** Merged to `main` as
> `d04a385` (PR #494). The owner approved OD-1…OD-7 with **Direction B** for the active-sale
> journey (RT-104 comment 10540). The durable decisions are recorded on the Confluence RETAIL
> **Decisions** and **Current State** pages.
>
> This package is the visual and design planning authority for Epic **RT-106**. The operative,
> agent-facing summary is [`docs/DESIGN.md`](../../DESIGN.md). Approval does **not** authorise
> implementation: every follow-up needs its own bounded Jira item
> ([09](09-implementation-slices.md)), the first being VN-S1, Jira RT-107. **RT-24 remains the
> behaviour authority.** The RT-25 amendments and supersessions marked in
> [02](02-rt25-delta.md) are now in effect; RT-25 stays the baseline everywhere else.
>
> The documents below were written as the proposal and are kept as written. Where one still says
> "proposed", "Δ proposal" or "pending owner decision", the decisions table below gives the
> approved outcome. Items the approval did **not** close are listed under
> [Carried forward](#carried-forward--still-open).

## Baseline

| | |
|---|---|
| Repository | `Kemetra/POS` |
| Verified `origin/main` | `28890facaf02d112fba4dec5ce48f4eb6909a12d` — RT-103 merge (#493), 2026-09-30. RT-104's text names `28d8e5e` (RT-79); `28890fa` is the next commit and was used. |
| Authorities read | Jira RT-104, RT-106, RT-24, RT-25, RT-26, RT-27, RT-28, RT-103, RT-10 (with comments); Confluence RETAIL pages Current State, Decisions, Risks & Blockers, Technology & Reference Radar, "Cashier UX — RT-24 / RT-25 Review" (7405593), whiteboard 7864327; repo `CLAUDE.md`, `docs/DESIGN.md`, `.impeccable/design.json`, specs 022/023, `src/renderer/**` |
| Not accessible | Confluence attachments (RT-25 atlas PDF `att7077909`, Tower Blue v3 ZIP `att7864378`) — `api.media.atlassian.com` denied by the session proxy. RT-24's detailed B01–B12 contract and 102-scenario matrix were never uploaded to Atlassian (RT-24 comment 10153). |

## Package contents (RT-104 required deliverables)

| RT-104 deliverable | Where |
|---|---|
| Current-state visual audit against GitHub `main` | [01-current-state-audit.md](01-current-state-audit.md) |
| RT-25 delta report | [02-rt25-delta.md](02-rt25-delta.md) |
| External-reference audit and applicability notes | [03-external-reference-audit.md](03-external-reference-audit.md) |
| Retail Tower POS VNext design principles + design language | [04-design-language.md](04-design-language.md) |
| Updated screen/state inventory | [05-screen-state-inventory.md](05-screen-state-inventory.md) |
| Core Sale + Checkout visual references at 1024 and 1280 | [references/](references/README.md) — approved Direction B: VN-B1 (Sale), VN-B2 (Checkout); Direction A comparison: VN-R1, VN-R2 (+ VN-R4 at 1024) |
| Representative critical failure/recovery references | [references/](references/README.md) — VN-R3, R5–R12, forced-colors captures |
| Component/state inventory | [06-component-state-inventory.md](06-component-state-inventory.md) |
| Current → VNext migration map | [07-migration-map.md](07-migration-map.md) |
| What remains governed by RT-24 and must not change | [08-rt24-invariants.md](08-rt24-invariants.md) |
| Proposed bounded Jira implementation slices | [09-implementation-slices.md](09-implementation-slices.md) |
| Layout direction comparison (A V5-based vs B cart-first) — added on owner request | [10-direction-comparison.md](10-direction-comparison.md), [references/compare.html](references/compare.html) |
| Operational workflow benchmark (RT-111, Planning, owner review complete, merged): offline / permission matrices, register-shift flow, device health, recovery center | [11-operational-workflow-benchmark.md](11-operational-workflow-benchmark.md) |
| Cashier UX / usability audit (RT-159, Planning, **PRELIMINARY — RT-159 stays open pending the post-RT-117 packaged/lab audit**): first runtime audit of the built app — scanner ownership, inactivity, cash/card steps, 1024/1280 capacity, a11y, findings matrix, session script, bounded slices | [12-cashier-ux-usability-audit.md](12-cashier-ux-usability-audit.md); captures in [references/audit-rt159/](references/audit-rt159/) |
| POS simplification & responsibility audit (RT-160, Planning, revision 3 on `main@7384217`, incl. the comment-10724 review corrections, **awaiting final owner review**): essential vs Electron-tax vs incidental complexity, responsibility/owner map (shift/cash-up: POS owns the offline lifecycle, Backend-Core the synced record; pilot-critical via RT-17), change-amplification case studies, reference-first review (ERPNext/Frappe, Odoo, RT-111 references), simplification vs hardening candidates, owner decisions D-1…D-3 recorded (fail-closed cashier profile; privileged-only central audit; keep net tender capture), platform recommendation (keep Electron) | [13-pos-simplification-responsibility-audit.md](13-pos-simplification-responsibility-audit.md) |
| RT-159 packaged re-audit + Impeccable critique (Planning, `main@7b68398`, **evidence, not acceptance**): status of F-01…F-29, new findings N-01…N-15, critique 15/40, owner decision D-C1 (direct add) | [14-rt159-packaged-reaudit.md](14-rt159-packaged-reaudit.md); captures in [references/audit-rt159-pkg/](references/audit-rt159-pkg/) |
| VNext implementation-readiness **freeze package** (RT-159, **owner-approved as written 2026-10-07**; Lane A priority A1 + A3): journey map, state matrix, input/focus/scanner contract, component/token contract, message catalog, visual reference per state, slice map (lanes A/B/C) | [15-vnext-freeze-package.md](15-vnext-freeze-package.md) |
| D-F2 plan: main-process bound on cash received (RT-248, Planning, **awaiting owner decisions**): why RT-17's bound misses F-02, the recommended cap and rule, refusal contract, renderer pre-check, tests | [16-d-f2-cash-received-bound.md](16-d-f2-cash-received-bound.md) |
| D-A1 plan: manager re-auth when the sign-in JWT expires (RT-247, Planning, **owner decisions Q1–Q4 recorded 2026-10-11, as recommended**): affected call sites, why the generic 401 cannot say "expired", the `reauth_required` category, the re-auth dialog and retry rule, sign-out options, tests | [17-d-a1-manager-reauth.md](17-d-a1-manager-reauth.md) |
| G-1 entry-screen references (RT-246, **owner-approved 2026-10-11**): sign-in roster, manager sign-in, PIN, wrong PIN, lockout, roster unreachable / empty, Ready, pairing and manager re-sign-in at 1024 and 1280, with the copy table and RT-244 deltas | [18-g1-entry-screens.md](18-g1-entry-screens.md) · [G1-Spec.html](visual-acceptance/G1-Entry-screens/G1-Spec.html) |
| D-M1 brief: the manager-only cashier PIN-status read (no PIN / ready / locked), the M1–M6 state → action matrix, PIN entry with confirm, the M-K copy and the G-3 references to draw (RT-251, Planning, **owner-approved 2026-10-12**) | [19-d-m1-cashier-pin-status.md](19-d-m1-cashier-pin-status.md) · [G3-Spec.html](visual-acceptance/G3-Cashiers/G3-Spec.html) |
| PK-3 park / resume references (RT-471, Docs / design, **owner decisions OD-1…OD-15 recorded 2026-10-17; merge pending**): the park action and label, the parked list, the resume review and VN-R10 conflict, the refusal states and the shift-close count at 1024 and 1280, drawn only from spec 024 and the RT-440 bridge; the bridge addition for product names and quantities (OD-1, RT-610) blocks RT-445 | [PK3-Spec.html](visual-acceptance/PK3-Park-Resume/PK3-Spec.html) |
| «إلغاء بيع» `/app/void` references on the G-6 vocabulary (RT-654, Docs / design, **owner-approved 2026-10-17: OD-1…OD-8 as drawn**): lookup, found, the void journal (empty, with entries, after a request), every refusal family the shipped RT-530 screen has, and the manager-PIN confirm dialog at 1024 and 1280, light and forced colours. All copy verbatim from `void-copy.ts`; no new strings | [VD-Spec.html](visual-acceptance/VD-Void/VD-Spec.html) |
| G-2 shift family references (RT-658, Docs / design, **owner-approved 2026-10-17: G2-D1…G2-D7 as drawn**): the cashier's open / validation / status / pay-in and pay-out / blind-count close / manager approval / closed result / parked-blocked close and the manager's shift status page at 1024 and 1280, on the G-6 page header and cards; every string verbatim from `shift-copy.ts`, no new strings; decisions G2-D1…G2-D7 | [G2-Spec.html](visual-acceptance/G2-Shift/G2-Spec.html) |
| Manager held-sales recovery references (RT-656, Docs / design, **owner-approved 2026-10-17: decisions as recommended**): `/app/manager/recovery` on the G-6 page header and controls, the RT-441 states (stuck payment, held sales, recovery mode, refusals, the PIN-confirmed action dialogs and their outcomes) at 1024 and 1280 in light and forced colours; every string is the shipped copy, owner decisions OD-1…OD-7 | [RC-Spec.html](visual-acceptance/RC-Recovery/RC-Spec.html) |
| G-6 addendum: the receipt preview in «المبيعات» as a V5 Dialog (RT-659, Docs / design, **owner-approved 2026-10-17: «طباعة» option (A) removed; sale number under the title approved; rest as drawn**): loading, failed and ready states at 1024 and 1280, light and forced colours; zoom and the duplicate ✕ removed; the slip is the engine's unchanged `preview` HTML | [G6P-Spec.html](visual-acceptance/G6P-Receipt-Preview/G6P-Spec.html) |
| G-6 Returns content references (RT-660, Docs / design, **owner-approved 2026-10-17: decisions as recommended**): the RT-15 Returns content on the shared G-6 controls (frozen `g6.css` imported unchanged) — lookup (empty, blank, not found, refused), line selection, quote, outcomes, payout incl. its refusals, history (empty, rows, reprint failed, load failed) and the fail-closed gate at 1024 and 1280, light and forced colours; every string verbatim from `src/renderer/returns/`, decisions RD-1…RD-10 proposed. Replaces the frame-only G6-Returns stand-in for content | [G6R-Spec.html](visual-acceptance/G6-Returns/G6R-Spec.html) |
| RT-497 S10-R G-6 reference coverage map (Docs / design, **coverage check only, nothing drawn**): every manager/admin surface and state RT-497 names mapped to its owner-approved reference on `main` (all 21 in `G6-Manager/`, plus the later G6R, G6P, VD, G2, RC, G3 and PK3 sets); missing: none. Lists the later RT-536 D7 / D8 / D1 decisions that touch G-6 and where each belongs; proposes RT-497 is satisfied | [27-rt497-s10r-reference-coverage.md](27-rt497-s10r-reference-coverage.md) |
| VN-S6 plan: a truthful connection and sync-status signal (RT-599, Planning, **owner-approved 2026-10-17: D-6-1…D-6-11 as recommended**): what main knows today (truthful vs inferred), the signal and its hysteresis, the proposed `terminalStatus` bridge contract with §A4 notes, the state → `StatusIndicator` / `Banner` / M-O\* mapping, the test and bench plan, and slices S6-0…S6-V that retire the 007 `StatusBanner` | [24-vn-s6-connection-sync-signal.md](24-vn-s6-connection-sync-signal.md) |
| UX-03 icon plan: semantic icon registry + Fluent System Icons fit / licence / bundle PoC (RT-263, Planning, **D-263-1…D-263-9 selected as recommended under the owner's standing delegation of 2026-10-17; visual fit owner-approved 2026-10-20**; IC-1 and IC-2 merged): POS + Admin icon inventory, the 53-name registry with RTL mirror rules, sizes and the a11y rule, Fluent coverage / RTL / weight / MIT licence, measured bundle cost of each packaging option, recommendation (vendored path data, no dependency) and slices IC-1…IC-4 | [25-rt263-icon-registry-fluent-poc.md](25-rt263-icon-registry-fluent-poc.md) · [25-rt263-icon-candidates.html](25-rt263-icon-candidates.html) |
| Cashier operational feature-completeness and benchmark gap review (RT-536, Planning, `main@673a8f9`, **applies owner decisions D1–D8 of 2026-10-16; OD-26-1…OD-26-4 selected as recommended, owner may revisit**): the operational-day inventory, the G-01…G-24 parity / gap matrix with evidence levels, 12 cashier journeys (all marked untested on current `main`), the top five gaps, Lightspeed X-Series as the only new benchmark, and proposed slices P-26-1…P-26-6 (none created) | [26-rt536-cashier-feature-completeness.md](26-rt536-cashier-feature-completeness.md) |
| Manual-discount contract (RT-699 step 1, P-26-6 / G-19, Planning, `main@2d3cba07`; **P1 close-out §11, 2026-10-24:** the owner decided OD-28-1 = C, 2 = A, 3 = A, 4 = C (a zero cart total must complete), 9 (closed list of four) and 11 on 2026-10-19. OD-28-12 is resolved by Backend-Core RT-740 (C-A). OZ-1 = Z-A: a zero-total sale completes with no tender (owner decision, 2026-10-24). **Still open:** OD-28-10 (VAT, deferred) and OD-28-13 (Connector posting, RT-857). Slices are RT-853…RT-858): discount kind and token, integer minor-unit rounding, per-line scope, totals, the cashier-approval and manager-direct flows on RT-114, the receipt row, capture facts and options, refusals, audit, test plan, bounded slices, the zero-total plan | [28-rt699-manual-discount-contract.md](28-rt699-manual-discount-contract.md) |
| Shift amount bounds against scanner digits (RT-278, Planning, `main@d63ee893`, **awaiting owner decisions OD-278-1…9**): the four shift money inputs and their bounds today (RT-17's storage bound is 2⁵³ − 1 minor, about 9.0×10¹³ EGP, and misses F-02), risk ranked by damage (counted cash first), flat per-field caps that keep the blind count blind, the `amount_out_of_range` refusal and copy, the S1 slice with its tests, and gated slices S2 (local migration), S3 (Backend-Core contract), S4 (audit sync contract) | [29-rt278-shift-amount-bounds.md](29-rt278-shift-amount-bounds.md) |
| Tenant-logo slot references (RT-832, Docs / design, **owner-approved 2026-10-23, recorded as RT-473 OD-7**; receipt size pending OD-8): boot, pairing, sign-in header and lock at 1024 and 1280, the slot pixel boxes and 1x/2x sizes, placement in RTL, `low_contrast` card, no-logo and powered-by states, forced-colors; receipt size pending OD-8 | [31-rt832-logo-slot-references.md](31-rt832-logo-slot-references.md) · [RT832-Logo-Slots-Spec.html](visual-acceptance/RT832-Logo-slots/RT832-Logo-Slots-Spec.html) |
| G-6 Diagnostics addendum: the catalogue check lists the matched items (RT-859, Docs / design, `main@be087a4f`, **draft, awaiting owner sign-off OD-1…OD-6**): result list (name, pack, SKU, price in the money family), a barcode typed into the search, the 20-row `truncated` list, empty, short query and refused/failed at 1024 and 1280, light and forced colours. Fields are only those `catalogue.search` returns on main: a search row carries `sku` and never `selling_barcode`, so no barcode is drawn (OD-2 asks whether RT-860 adds a barcode path) | [G6C-Spec.html](visual-acceptance/G6-Catalogue-check/G6C-Spec.html) |
| Manual-discount references (RT-853, RT-699 slice D1, Docs / design, `main@146673ba`, **draft, awaiting owner sign-off OD-1…OD-9**): the «خصم» sheet (percent or amount, value, the four reasons, live net preview), the cashier path on the RT-114 approval prompt and the manager/admin direct path, the discount row under a line with «إزالة الخصم», the refusals (amount above gross, quantity change, second discount, approval invalid / stale), zero-total Checkout and Completion (OZ-1 = Z-A) and the receipt rows as a screen preview, at 1024 and 1280, light and forced colours. Every amount computed with the doc 28 §3.2 rule; every new string listed for owner approval | [D1-Spec.html](visual-acceptance/D1-Discount/D1-Spec.html) |
| vNext **Visual Acceptance Pack** (owner-approved; Direction B frozen; imported verbatim, docs only): Iterations 1–3 of the cart-first cashier workspace at 1280×800 and 1024×768, with a two-axis classification (Visual status × Behavior status) and journey map | [visual-acceptance/index.html](visual-acceptance/index.html) — see [Visual Acceptance Pack](#visual-acceptance-pack-owner-approved) |

## Visual Acceptance Pack (owner-approved)

The final owner-approved **Retail Tower POS vNext Visual Acceptance Pack** is vendored, unmodified,
under [`visual-acceptance/`](visual-acceptance/index.html) (entry point:
[`index.html`](visual-acceptance/index.html); classification table:
[`E-Journey-map-and-classification/I3-Classification.html`](visual-acceptance/E-Journey-map-and-classification/I3-Classification.html)).
It was imported byte-for-byte from the owner-supplied archive — nothing in it was redesigned,
regenerated, re-worded or re-classified by the import.

- **Direction B is the frozen visual direction** (cart-first cashier workspace).
- **The pack is a visual / reference authority only.** It carries no behaviour. **RT-24 and later
  approved behaviour contracts remain the behaviour authority.** Anything the pack draws that
  its own classification table does not mark as approved (key caps, hold buttons, focus labels)
  is not a decision.
- **Two independent axes.** *Visual status* (FROZEN / EXPLORATION / CONDITIONAL CONCEPT) says
  whether the drawing is fixed; *Behavior status* (APPROVED / PENDING — RT-xxx) says whether what
  it depicts is approved. **Implementation-safe = Visual FROZEN **and** Behavior APPROVED.** A
  frozen screen with pending behaviour may be built visually but **must not ship its behaviour**.
- **Screens marked Behavior Pending are not implementation-safe until their referenced Jira item
  is resolved.** This import resolves none of them:

  | Behavior pending | Screens affected (per the pack's classification) |
  |---|---|
  | **RT-113** — offline / reconnect / syncing | Offline while selling; Reconnected / syncing (enabled Checkout and «البيع مستمر» included) |
  | **RT-114** — manager approval | Manager approval required (credential type, auth mechanics, retry/lockout, offline auth) |
  | **RT-116** — lock / recovery | Terminal locked, transaction preserved; Post-unlock restored transaction |
  | **RT-158** — held / suspended sale | Held-sale restore concept (Visual = CONDITIONAL CONCEPT) and the hold / held-sales controls drawn on the Sale pane |

- **Implementation-safe today (per the pack):** Sale and Long cart (except the RT-158 hold
  controls), Cash underpaid, Cash change due, Payment UNKNOWN / recovery, Definitive card failure,
  Completed + receipt failure — at 1280 and 1024.
- **Open assumptions carried over unchanged from the pack** — they stay open regardless of either
  axis, and *Behavior APPROVED* never extends to them: digit system (Western vs Arabic-Indic);
  final currency label and placement; keyboard shortcuts (none shown); focus ownership and
  scanner routing (no focus state shown).
- **Reconciliation with OD-3 (digits / currency label).** The pack is preserved verbatim, and its
  "open assumption" wording about the digit system and the currency label and placement does
  **not** supersede the owner decision **OD-3** above. OD-3 remains the current planning authority
  for **Western digits, grouped money formatting and the `EGP` label**. Validation against real
  Egyptian pharmacy receipts remains outstanding, exactly as OD-3 already states
  ([Carried forward](#carried-forward--still-open)). The pack was deliberately not edited to
  resolve this discrepancy; where its drawn numerals or currency text differ from OD-3, OD-3
  governs. The pack's other open assumptions (keyboard shortcuts, focus ownership and scanner
  routing) are unaffected by this note and stay open.
- **Reference precedence.** For the first-wave vNext states the pack covers (Sale, Long cart,
  Checkout, Payment unknown / failed, Offline, Syncing, Manager approval, Locked / restored,
  Receipt failure, Held concept), the Visual Acceptance Pack is the **current visual acceptance
  reference** wherever it overlaps the older [`references/`](references/README.md) material
  (VN-B1, VN-B2, VN-R*). That older material is **retained, not deleted or rewritten**, as prior
  planning / reference / history. This precedence is visual only; behaviour authority is
  unchanged (RT-24 and later approved contracts).
- **Superseded / exploration material is kept, not promoted.** The `Iteration-1-EXPLORATION/`,
  `Exploration-iteration-1/`, `C-Components*/` and `D-State-consistency*/` folders are classified
  EXPLORATION (superseded) and must not be implemented from.
- **Import notes.** The `source/*.dc.html` files are the pack's editable design-canvas sources and
  load a `./support.js` that was not in the archive; they do not render standalone. Every published
  page (everything outside `source/`) is self-contained apart from one Google Fonts stylesheet.

## Headline findings

1. **The design documents are wrong about what ships.** `docs/DESIGN.md` (navy `#1f4e7a`, Inter,
   dark default) and `.impeccable/design.json` (navy, Inter, light-only) both contradict the shipped
   022 tokens (teal `#0f766e`, Dubai, light default) — and each other. Agents reading them will
   design the wrong product. → VN-S1.
2. **Only the Sale screen is V5.** Checkout and completion are legacy 006/v3.5/022 content inside the
   V5 frame; ~12 other surfaces are legacy (English-first); ~7 required capabilities have no UI.
3. **The biggest RT-24 conflict is Checkout at 1280:** the amount due drops below the tender methods
   and off-screen during cash entry (X-3). VNext Checkout pins it in a ledger column.
4. **Operational truth is invisible:** connection is hard-coded `online`, sync status is unmounted,
   no error boundaries. VNext designs the treatment but it needs a real signal (X-2).
5. **Mixed numeral systems on one screen** (Latin money, Arabic-Indic times/counts). VNext proposes
   one policy (OD-3).
6. **The approved direction holds.** VNext is a codification + completion of 022/023 — not a new
   visual identity, and not an all-at-once rewrite.

## Owner decisions

**Approved outcomes (2026-10-01, RT-104 comment 10540):**

| ID | Approved outcome |
|---|---|
| OD-1 | Keep the shipped teal direction. Tower Blue is not adopted as a palette. |
| OD-2 | Keep Dubai for the pilot. No font is bundled. |
| OD-3 | Western digits, grouped money formatting and the `EGP` label. The renderer formatter applies it; `shared/money` `format()` does not yet (see [`DESIGN.md`](../../DESIGN.md) Numerals). Still to be checked against real Egyptian pharmacy receipts. |
| OD-4 | Light-first for the pilot; high-contrast / forced-colors support is required. Dark is maintained but not offered. |
| OD-5 | Keep the in-product name «POS Pulse» for now. |
| OD-6 | Hide unavailable or unauthorised placeholder navigation from the cashier role. |
| OD-7 | **Direction B** for the active-sale journey: cart-first layout, command bar, persistent money column, and slim navigation through Sale, Checkout and completion. |
| RT-24 §C | **Not confirmed** by this approval; see [Carried forward](#carried-forward--still-open). |

The table below is the decision request as originally proposed, kept for its rationale.

| ID | Decision | Recommendation | If rejected |
|---|---|---|---|
| **OD-1** | Colour direction: keep shipped 022/023 pharmacy teal, or adopt RT-27 Tower Blue | **Keep teal.** It is shipped, contrast-measured and owner-approved on production (023, 2026-09-25); Tower Blue's tokens are not retrievable from Atlassian and it is a reference, not authority. | A token-value swap slice after the Tower Blue ZIP is vendored and contrast-validated; components unchanged (token-only theming). |
| **OD-2** | Typeface: keep Windows Dubai (no bundle), or bundle Noto Sans Arabic (OFL) | **Keep Dubai** for pilot; revisit only if target-hardware review finds Dubai + Consolas mixing unacceptable. | Dependency/asset authorisation needed (CLAUDE.md §10); `no-brand-font` test changes. |
| **OD-3** | Numerals + money format: Western digits everywhere, thousands grouping, `EGP` label | **Approve**, after confirming against real Egyptian pharmacy receipts. | Keep today's formatting; still pin one numeral system for times/counts. |
| **OD-4** | Themes: light-only for pilot, dark maintained but not offered; Windows contrast themes required | **Approve.** | A dark QA slice capturing every V5 screen in dark before re-offering it. |
| **OD-5** | Wordmark in product: «POS Pulse» (shipped) vs «Retail Tower POS» | **Keep «POS Pulse»** until a branding decision exists (022 RECONCILIATION marks "Retail Tower POS" as not authorised in product). | Token/asset-only change. |
| **OD-6** | Cashier nav: keep placeholder entries (dashboard, inventory, settings) visible to cashiers, or hide until they are real (returns and audit are already manager/admin-only on `main`) | **Hide placeholders from cashier role**; keep for manager/admin. | Restyle placeholders to Arabic V5 empty states. |
| **OD-7** | Sale layout: A (V5-based product rail, as in 04 §16) or B (cart-first command bar + money column + slim nav during a sale) | **B's money column + command bar**, slim nav only during a sale — after one real-app capture confirms the capacity gap (10). Same visual language and behaviour either way. | Keep A; optionally take only the money column. |
| — | Confirm RT-24 §C items 1 (direct add vs confirm-first), 2 (lazy cart), 4 (same-device suspend/resume), 5 (key map) | Confirm per slice (VN-S0) | Slices keep today's behaviour |

## Acceptance-criteria trace (RT-104)

| RT-104 acceptance criterion | Status in this package |
|---|---|
| Current UI baseline verified against GitHub `main`, not old screenshots alone | Source audit at `28890fa` with `file:line` refs + spot re-verification (01). Screenshots used only as secondary evidence, with staleness caveat. |
| RT-24 preserved as behaviour authority | 08 lists 17 invariants + 6 raised conflicts; every reference is annotated with its RT-24 state. |
| RT-25 classified retained/amended/superseded by section/state | 02: all 27 §-items, 11 visual-system requirements, 14 scenario families (S-level mapping inferred; atlas not downloadable). |
| Every external reference has a reason and boundary | 03 (13 references + Tower Blue). |
| One coherent Retail Tower POS visual language defined | 04. |
| Sale and Checkout have **approved** 1024 and 1280 references | **Approved** 2026-10-01 with Direction B: `VN-B1-*` (Sale) and `VN-B2-*` (Checkout) at 1024 and 1280. VN-R1/VN-R2 remain as the Direction A comparison. |
| Critical recovery/error/manager/offline states represented | VN-R3 (UNKNOWN), R5 (print failure), R6 (manager), R7 (offline), R8 (lock + live tender), R9 (storage blocked), R10 (resume conflict), R11 (shift), R12 (returns gated). |
| Migration avoids a risky all-at-once rewrite | 07 (per-surface categories + order). |
| Follow-up can proceed in bounded Jira slices | 09 (VN-S0…S11 with dependencies and Work Modes). |
| Durable approved decisions reflected in Confluence after owner review | **Done**: RETAIL Decisions page ("POS UI VNext direction — approved 2026-10-01") and Current State page ("POS UI VNext planning state"). |

## Carried forward — still open

The approval did not close these. They stay open until separately evidenced or approved, and the
slices that depend on them must not assume an answer:

- **RT-24 §C confirmations:** item 2 (lazy cart), item 4 (same-device suspend/resume) and item 5
  (key map; D-K1 deferred by the owner on 2026-10-20, wave 1 stays keyless). These gate VN-S5
  (keys) and VN-S11 (suspend/resume). **Item 1 (direct add vs
  confirm-first) is resolved by owner decision D-C1 (2026-10-07):** direct add for scans and
  search picks, with undo (D-U1, shipped in #621 and ratified 2026-10-20; see [14 §5](14-rt159-packaged-reaudit.md) and
  [15](15-vnext-freeze-package.md) §3, §7). See [08](08-rt24-invariants.md).
  The keycaps drawn in the approved references are part of this open key map, not bound
  shortcuts ([references](references/README.md)).
- **OD-3 receipt validation:** the numeral and grouping policy must be checked against real
  Egyptian pharmacy receipts before `shared/money` output changes.
- **VN-S12 capacity capture:** supplied by the RT-159 runtime audit
  ([12](12-cashier-ux-usability-audit.md), A03/A04/A06/A07). Sale layout B has since shipped
  (RT-242, #610 and #611); its packaged evidence is still open (RT-754).
- **Evidence limits** below are unchanged.

## Evidence limits (read before approving)

- No POS tests, CI, Electron run or hardware were run for this Planning item; nothing in
  `src/**` was changed. `node_modules` was not installed.
- References are static HTML renders (Chromium, Playwright) with substitute fonts (IBM Plex Sans
  Arabic / Plex Mono for Dubai / Consolas). Data is illustrative.
- The RT-25 atlas and Tower Blue ZIP could not be opened; RT-24's detailed B01–B12 and 102-scenario
  matrix are not in Atlassian. Classification is at §-item / S-group level.
- Some external sites were blocked by the proxy; unverified facts are marked in 03.
