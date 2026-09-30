# RT-104 — Retail Tower POS UI VNext rebaseline (Planning package)

> **Status: owner-reviewable PROPOSAL.** Jira **RT-104** (Work Mode: Planning), first gate of
> Epic **RT-106**. Nothing here authorises implementation; every follow-up needs its own bounded
> Jira item ([09](09-implementation-slices.md)). **RT-24 remains the behaviour authority.** RT-25
> remains the visual baseline except where [02](02-rt25-delta.md) marks a section amended or
> superseded, which takes effect only once the owner approves this package.

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
| Core Sale + Checkout visual references at 1024 and 1280 | [references/](references/README.md) — VN-R1, VN-R2 (+ VN-R4 at 1024) |
| Representative critical failure/recovery references | [references/](references/README.md) — VN-R3, R5–R12, forced-colors captures |
| Component/state inventory | [06-component-state-inventory.md](06-component-state-inventory.md) |
| Current → VNext migration map | [07-migration-map.md](07-migration-map.md) |
| What remains governed by RT-24 and must not change | [08-rt24-invariants.md](08-rt24-invariants.md) |
| Proposed bounded Jira implementation slices | [09-implementation-slices.md](09-implementation-slices.md) |

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

| ID | Decision | Recommendation | If rejected |
|---|---|---|---|
| **OD-1** | Colour direction: keep shipped 022/023 pharmacy teal, or adopt RT-27 Tower Blue | **Keep teal.** It is shipped, contrast-measured and owner-approved on production (023, 2026-09-25); Tower Blue's tokens are not retrievable from Atlassian and it is a reference, not authority. | A token-value swap slice after the Tower Blue ZIP is vendored and contrast-validated; components unchanged (token-only theming). |
| **OD-2** | Typeface: keep Windows Dubai (no bundle), or bundle Noto Sans Arabic (OFL) | **Keep Dubai** for pilot; revisit only if target-hardware review finds Dubai + Consolas mixing unacceptable. | Dependency/asset authorisation needed (CLAUDE.md §10); `no-brand-font` test changes. |
| **OD-3** | Numerals + money format: Western digits everywhere, thousands grouping, `EGP` label | **Approve**, after confirming against real Egyptian pharmacy receipts. | Keep today's formatting; still pin one numeral system for times/counts. |
| **OD-4** | Themes: light-only for pilot, dark maintained but not offered; Windows contrast themes required | **Approve.** | A dark QA slice capturing every V5 screen in dark before re-offering it. |
| **OD-5** | Wordmark in product: «POS Pulse» (shipped) vs «Retail Tower POS» | **Keep «POS Pulse»** until a branding decision exists (022 RECONCILIATION marks "Retail Tower POS" as not authorised in product). | Token/asset-only change. |
| **OD-6** | Cashier nav: keep placeholder entries (dashboard, inventory, audit) visible to cashiers, or hide until they are real | **Hide placeholders from cashier role**; keep for manager/admin. | Restyle placeholders to Arabic V5 empty states. |
| — | Confirm RT-24 §C items 1 (direct add vs confirm-first), 2 (lazy cart), 4 (same-device suspend/resume), 5 (key map) | Confirm per slice (VN-S0) | Slices keep today's behaviour |

## Acceptance-criteria trace (RT-104)

| RT-104 acceptance criterion | Status in this package |
|---|---|
| Current UI baseline verified against GitHub `main`, not old screenshots alone | Source audit at `28890fa` with `file:line` refs + spot re-verification (01). Screenshots used only as secondary evidence, with staleness caveat. |
| RT-24 preserved as behaviour authority | 08 lists 17 invariants + 6 raised conflicts; every reference is annotated with its RT-24 state. |
| RT-25 classified retained/amended/superseded by section/state | 02: all 27 §-items, 11 visual-system requirements, 14 scenario families (S-level mapping inferred; atlas not downloadable). |
| Every external reference has a reason and boundary | 03 (13 references + Tower Blue). |
| One coherent Retail Tower POS visual language defined | 04. |
| Sale and Checkout have **approved** 1024 and 1280 references | References **produced** (VN-R1, VN-R2). **Approval is the owner's** — pending. |
| Critical recovery/error/manager/offline states represented | VN-R3 (UNKNOWN), R5 (print failure), R6 (manager), R7 (offline), R8 (lock + live tender), R9 (storage blocked), R10 (resume conflict), R11 (shift), R12 (returns gated). |
| Migration avoids a risky all-at-once rewrite | 07 (per-surface categories + order). |
| Follow-up can proceed in bounded Jira slices | 09 (VN-S0…S11 with dependencies and Work Modes). |
| Durable approved decisions reflected in Confluence after owner review | **Not done** — by design, only after owner review. |

## Evidence limits (read before approving)

- No POS tests, CI, Electron run or hardware were run for this Planning item; nothing in
  `src/**` was changed. `node_modules` was not installed.
- References are static HTML renders (Chromium, Playwright) with substitute fonts (IBM Plex Sans
  Arabic / Plex Mono for Dubai / Consolas). Data is illustrative.
- The RT-25 atlas and Tower Blue ZIP could not be opened; RT-24's detailed B01–B12 and 102-scenario
  matrix are not in Atlassian. Classification is at §-item / S-group level.
- Some external sites were blocked by the proxy; unverified facts are marked in 03.
