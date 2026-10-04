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
| OD-3 | Western digits, grouped money formatting and the `EGP` label. Not yet implemented (VN-S3, absorbed into VN-S12); still to be checked against real Egyptian pharmacy receipts. |
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

- **RT-24 §C confirmations:** item 1 (direct add vs confirm-first), item 2 (lazy cart), item 4
  (same-device suspend/resume) and item 5 (key map). These gate VN-S3/VN-S12 (scan
  acknowledgement), VN-S5 (keys) and VN-S11 (suspend/resume). See [08](08-rt24-invariants.md).
  The keycaps drawn in the approved references are part of this open key map, not bound
  shortcuts ([references](references/README.md)).
- **OD-3 receipt validation:** the numeral and grouping policy must be checked against real
  Egyptian pharmacy receipts before VN-S3/VN-S12 changes `shared/money` output.
- **VN-S12 capacity capture:** one real-app Electron capture with the 10-line cart must confirm
  the Direction B capacity gain ([10](10-direction-comparison.md)) before Sale layout B ships.
- **Evidence limits** below are unchanged.

## Evidence limits (read before approving)

- No POS tests, CI, Electron run or hardware were run for this Planning item; nothing in
  `src/**` was changed. `node_modules` was not installed.
- References are static HTML renders (Chromium, Playwright) with substitute fonts (IBM Plex Sans
  Arabic / Plex Mono for Dubai / Consolas). Data is illustrative.
- The RT-25 atlas and Tower Blue ZIP could not be opened; RT-24's detailed B01–B12 and 102-scenario
  matrix are not in Atlassian. Classification is at §-item / S-group level.
- Some external sites were blocked by the proxy; unverified facts are marked in 03.
