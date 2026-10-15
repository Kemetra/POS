# Implementation Plan: POS Visual System Recovery

**Feature ID:** 007-pos-visual-system
**Spec:** [./spec.md](./spec.md)
**Plan Version:** 1.0
**Created:** 2026-05-10
**Last Updated:** 2026-05-10
**Constitution version pinned:** v1.5.1
**Branch:** `docs/007-pos-visual-system-plan`
**Specify PR:** [#107 — docs(007): specify POS visual system recovery](https://github.com/ahmed-shaaban-94/POS-Pulse/pull/107) (merged)
**Clarify PR:** [#108 — docs(007): clarify visual references, 005/006 blocking, single light theme](https://github.com/ahmed-shaaban-94/POS-Pulse/pull/108) (merged)

---

## Summary

007 recovers the POS Pulse visual system as **product behaviour and acceptance
rules** before sales / cart / payments UI is built on top. The clarify phase
(2026-05-10) locked three load-bearing decisions: **canonical reference set**
(Claude Design once exported, Figma Make when approved, three repo references
as binding constraints — FR-051), **005 / 006 UI gate** (UI implementation
slices wait until at least 007 Slices S1, S2, and S3 are approved — NFR-014),
and **single polished light theme + Inter primary / system-UI fallback**
(FR-052 / A10).

The plan is intentionally restrained. **No source files are written**, **no
migrations are authored**, **no OpenAPI is mutated**, **no packages are
installed**, **no binary design files are committed** by `/speckit-plan`
itself. Implementation happens in subsequent task-driven slices, each gated
by a screenshot contact-sheet review.

The most important load-bearing finding from this plan phase: **the live
`src/renderer/styles/tailwind.css` and `src/renderer/ui/tokens/` already match
roughly 95 % of Claude Design's token surface**. The visual recovery is
therefore **additive value tuning + a small set of new tokens for sunken
surfaces, motion durations, and rail-text** — not a token-API rebuild.
Existing 003 token names are preserved verbatim (FR-003 — no silent rename /
repurpose / removal); Claude Design's parallel names enter only as additive
new exports, never as replacements for an existing 003 token.

## Technical Context

This plan commits to a **renderer-only** feature in `src/renderer/`. There is
no main-process change, no preload-bridge change, no SecretStore change, no
SQLite change, no OpenAPI change, no CI workflow change.

| Area | Choice | Source |
|:--|:--|:--|
| Runtime / packaging | Electron `^40.9` Windows 10/11 x64 | constitution v1.5.1 / 001 plan |
| Renderer | React `^19.2` + Vite `^8.0` + TypeScript `^5.9` strict | 001 plan |
| Styling | Tailwind `^4.2` (CSS-first) — design tokens already shipping as **CSS variables** + `@theme` block in `src/renderer/styles/tailwind.css`; consumed via `src/renderer/ui/tokens/` (003 module, live) | 003 plan §Technical Context / live code |
| Token policy | **Additive only.** No 003 token name is renamed, repurposed, or removed (spec FR-003). Claude Design tokens that have no 003 counterpart land as new additive exports. Value tweaks to existing tokens land via direct CSS-variable update. | spec FR-003 / advisor guidance / live `tailwind.css` |
| Font stack | Inter Variable (primary) + Inter + system-UI fallback chain, **already shipping** in `--font-family-sans`. JetBrains Mono is preserved as a fallback in `--font-family-mono` only (not a hard dependency). **Inter Tight is rejected** — Claude Design's `--font-display: "Inter Tight"` proposal introduces a second proprietary font dependency that violates spec FR-052; tight display feel is achieved via Inter weight-700 with negative letter-spacing instead. | spec FR-052 / spec A10 / CD `01-design-tokens.md` rejected element |
| Theme count | One polished light theme. Recovered surfaces MUST NOT respond to OS-level `prefers-color-scheme`. No `.dark` block ever ships in 007. | spec FR-052 |
| Density / touch targets | Inherit `comfortable` density; 44 × 44 CSS px floor preserved. PIN keys are 64 × 64 (already ≥ 44). | spec NFR-005 / 003 NFR-5 |
| Connection-state model | Inherit 003's four states (`online`, `degraded`, `offline`, `syncing`). 007 introduces no new connection states. | spec FR-008 |
| Component policy | **Restyle, do not rewrite.** Public prop signatures of every existing 003 / 004 primitive (`Button`, `Card`, `Input`, `Dialog`, `Toast`, `StatusBanner`, `Badge`, `Table`, `LoadingState`, `EmptyState`, `ErrorState`, `OperatorBadge`, `RosterList`, `PinPad`, `TakeoverPrompt`, `ManagerAdminSignInForm`) stay frozen. Only CSS classnames + visual structure change. | spec A1 / CD `02-components.md` line 3 |
| Bridge surface | **Unchanged.** No new IPC channel, no preload-bridge expansion. `operator.*` namespace from 004 is consumed read-only. | spec FR-050 / NFR-001 / NFR-011 |
| Local persistence | **Unchanged.** No SQLite migration, no schema change. | spec FR-047 |
| OpenAPI | **Unchanged.** No new endpoint, no snapshot regeneration. | spec FR-046 |
| CI / packaging | **Unchanged.** Existing `codegen:verify → typecheck → lint → test → package:dir` pipeline gates this feature. No workflow file change. | spec FR-050 / NFR-011 |
| Tests | Vitest only (constitution VI). The existing ≥ 90 % coverage gate on `src/renderer/ui/` and `src/renderer/shell/` is preserved. Per-slice axe-rule pass on default / loading / empty / error variants. | spec NFR-008 / NFR-013 |
| Screenshot tooling | `/speckit-plan` does NOT install any screenshot tool. Each implementation slice picks its tool (Vitest happy-dom render → DOM snapshot, or Playwright via 004's existing setup, or manual browser screenshot) per the slice's contact-sheet requirements. | spec FR-030 / FR-031 |

**No `NEEDS CLARIFICATION` items remain at the spec layer.** All three
clarifications resolved on 2026-05-10 (PR #108). Three forward-looking
ambiguities are recorded in §"Risks & Open Items" below as **R-** items, not
as new NEEDS CLARIFICATION markers.

### Hard Non-Implementation Boundaries

These are restated from spec FR-041 … FR-050 / FR-048a verbatim. Any task
that drifts into them MUST be filed as a separate feature, not folded into
007:

- No sales / cart / receipts / payments business logic.
- No tender, change, or money math; the reserved `tender.*` and `totals.*`
  slots from 003 stay layout-only.
- No inventory mutation, no stock movement, no FEFO logic.
- No reports, KPIs, dashboards, analytics surfaces. **The Claude Design
  contact sheet's screen 10b (manager shell with KPI tiles) is visual
  direction for a future feature, not a 007 deliverable** (advisor flag).
- No backend API call, no new endpoint, no OpenAPI change.
- No database migration, no SQLite schema change.
- No `_reference/Data-Pulse/` change. No Data-Pulse-2 SaaS / dashboard
  repository change (Data-Pulse-2 is owned by a separate codebase).
- No change to Clerk authentication behaviour, operator-session lifecycle,
  terminal-pairing semantics, or the role catalogue from 004 FR-002 /
  FR-002a.
- No new IPC channel, no new preload-bridge surface, no change to the
  existing preload bridge.
- No copy-paste of HTML / JSX / CSS from any external design reference into
  production code (FR-034 / FR-035).
- No binary design file (PNG, JPG, ZIP, PDF, generated source archive)
  committed to the repo. Reference archives stay outside the repo per the
  user's design-artifact rules.

## Visual Reference Adjudication

This is the load-bearing new content this plan adds. It codifies how the
three reference sources interact and what each contributes.

### Source-of-truth order

1. **Repo code + approved Spec Kit artifacts** are the source of truth. If
   any reference contradicts the live `src/renderer/styles/tailwind.css`,
   the live `src/renderer/ui/tokens/`, the live `src/renderer/ui/primitives/`,
   the live `src/renderer/shell/`, the live `src/renderer/ui/operator/`, or
   any approved Spec Kit artifact in `specs/`, **the repo wins**.
2. **Claude Design handoff** is the **primary visual reference**. When
   the repo is silent on a detail (e.g. a specific shadow value, a specific
   eyebrow tracking value, a layout micro-decision), Claude Design's
   handoff documents (`handoff/01-design-tokens.md` …
   `handoff/05-implementation-translation.md`, `ContactSheet.html` printable
   reference) carry the visual decision.
3. **Figma Make package** is the **secondary supporting reference**. Used
   only as a state-inventory cross-check and a contact-sheet structural
   pattern. Figma Make's component code, theme CSS, and implementation
   notes are non-binding.
4. **Generated code from either tool is non-binding and MUST NOT be copied
   into production.** This applies to JSX, HTML, CSS, JavaScript, and any
   archived `src.zip` / `src/` directory inside the reference packages.

### Adopt — from Claude Design (primary)

- **Visual identity as the base direction**: deep enterprise navy
  (`#1F4E7A`) primary, ink-on-white surface, dark rail at `#0E1B2A`–`#0B1726`,
  hairline borders, no left-border accent stripes on cards, calm shadow
  scale, no animation bounce.
- **Token / component / screen handoff as primary visual input**: the
  five-document handoff (`01-design-tokens.md` through
  `05-implementation-translation.md`) is the canonical visual translation
  brief. The repo already shares ~95 % of its token surface with this brief
  (see Research §"Token alignment audit"); the remaining delta is captured
  in §"S1 — Token-layer additive deltas" below.
- **Contact sheet as the canonical screen-look baseline**: the twelve
  screens documented in CD `03-screens.md` plus
  `claude-design/ContactSheet.html` define the per-screen acceptance
  baseline. Each implementation slice renders its surfaces and compares
  against the relevant CD contact-sheet entry.
- **Existing repo constraints from 003 and 004 as binding constraints**:
  the three repo references named in spec FR-051 priority (3) override
  Claude Design on disagreement.

### Adapt — from Figma Make (secondary)

- **Screen coverage / contact-sheet structure** is useful as a cross-check
  for state inventory completeness — Figma Make's `DELIVERABLES.md`
  enumerates 12 screens with viewport notes that mostly overlap with CD's
  twelve.
- **Component treatments only where they improve touch clarity, spacing,
  or hierarchy** AND do not contradict CD or repo. The plan does not
  pre-commit any specific Figma Make adaptation; per-slice decisions
  document the source if any.
- **Prototype flow as a state-inventory cross-check** — confirming that
  the CD state list is complete (e.g. roster empty state, PIN error state,
  takeover modal in-flight state). No flow logic is adopted.

### Reject — explicit

These are non-negotiable rejections, codified here so a reviewer or
implementing slice can cite them by name:

- **Generated React / HTML / JSX / CSS as production source.** This applies
  to:
  - `claude-design/design-system/Components.jsx` (visual reference only).
  - `claude-design/design-system/Screens.jsx`,
    `claude-design/design-system/ExtraScreens.jsx` (visual reference only).
  - `claude-design/design-system/kit-styles.css`,
    `claude-design/design-system/proto-styles.css`,
    `claude-design/design-system/tokens.css` (visual reference only —
    extract values, never copy file).
  - `claude-design/Deck.html`, `Prototype.html`, `ContactSheet.html`,
    `index.html`, `deck-stage.js`, `deck-styles.css` (visual reference
    only).
  - `figma-make/POS-figam-2/src.zip` (generated React app — never extract
    or read into the repo).
  - All `.tsx` / `.css` / `.html` under `figma-make/POS-figam-2/` (generated
    output — non-binding even when extracted).
- **shadcn / default theme copied as-is.** Specifically:
  `figma-make/POS-figam-2/default_shadcn_theme.css` is a 100-line shadcn
  defaults file with `--primary: #030213` (near-black) that contradicts
  CD's navy `#1F4E7A` and the live repo's `#1F4E7A`. The file also ships
  a `.dark` block (rejected by FR-052) and chart / sidebar tokens 007
  does not need. **Reject the file in its entirety.**
- **Dark mode or dark tokens for 007.** The `.dark { … }` block in
  `default_shadcn_theme.css` is forbidden territory. FR-052 is binding.
- **Backend / database / routing / PIN-validation guidance from Figma
  Make.** Specifically:
  `figma-make/POS-figam-2/IMPLEMENTATION_NOTES.md` includes Argon2-flavoured
  PIN-validation patterns, SQLite migration scaffolding, IPC handler
  examples, and React Router proposals — all of which contradict 004's
  AD-1 / AD-2 / Approval Gate §A1, NFR-001, and the spec's renderer-only
  posture (FR-050). **Treat the entire FM `IMPLEMENTATION_NOTES.md` file
  as non-binding.**
- **Dashboard stats, KPIs, sales quick actions, reports, or analytics
  surfaces** are forbidden by spec FR-045. Both CD `03-screens.md` §10b
  (manager shell with KPI tiles) and FM `DELIVERABLES.md`
  §"DashboardContent" describe such tiles; both are visual direction for
  a future feature, not 007 deliverables. The CD §10b sketch is preserved
  in the contact-sheet contract but no 007 slice produces real KPI tiles.
- **Takeover-modal disclosures** that reveal the other terminal name,
  prior-session timestamp, other operator's identity, role details, or any
  "View details" / "Why am I seeing this" / "Show details" affordance.
  Both CD `04-security-and-visibility.md` §C and CD `02-components.md`
  §"Dialogs / modals" already enforce this; the plan re-states it as a
  binding constraint per spec FR-029.
- **Any "production-ready" claim from generated design tools.** FM
  `DELIVERABLES.md` claims "all components production-ready" and "ready
  for implementation handoff" — those claims are noise; the plan ignores
  them.
- **Emoji** in any production code, copy, log, screenshot label, or commit
  message. Both reference packages contain emoji-laden documentation; that
  styling is non-binding. CD's 04-security §A explicitly forbids emoji,
  and the spec inherits.

### Theme decision (re-stated for plan-phase audit)

- **One polished light theme only.** No `.dark` block, no
  `prefers-color-scheme` follower, no per-tenant theme switch.
- **Inter as primary, system-UI as fallback when Inter is unavailable.**
  The live `--font-family-sans` chain (`'Inter Variable', Inter, 'Segoe UI',
  system-ui, -apple-system, sans-serif`) already satisfies this and is
  preserved.
- **No proprietary brand fonts beyond Inter.** Inter Tight is rejected
  (use Inter weight-700 + negative letter-spacing for tight display).
  JetBrains Mono is preserved only as a fallback in `--font-family-mono`
  (`ui-monospace, 'Cascadia Code', 'JetBrains Mono', monospace`); the
  primary mono face is the OS-provided `ui-monospace`. The recovered
  surfaces MUST NOT regress visually if Inter Variable / Inter is missing
  from the target Windows 10 / 11 terminal — the system-UI fallback is the
  acceptance baseline.

## Constitution Check (Initial)

| Principle / Constraint | Status | Notes |
|:--|:--:|:--|
| I. Offline-First | **PASS** | Renderer-only restyle; no network calls introduced. |
| II. Financial Precision | **N/A** | No money math. |
| III. Process-Boundary Discipline | **PASS** | No new IPC channel, no preload-bridge change, no SecretStore change. The 003 static no-touch source-scope guard remains load-bearing (NFR-011). |
| IV. Hardware Loud, Not Silent | **PASS** | 44 × 44 CSS px touch-target floor preserved (NFR-005); PIN keys 64 × 64. |
| V. Type Safety End-to-End | **PASS** | Restyle preserves every primitive's public prop signature. No `any`, no `as` casts. |
| VI. Test-First, Coverage-Gated | **PASS** | ≥ 90 % gate on `src/renderer/ui/` + `src/renderer/shell/` preserved (NFR-013); per-slice axe-rule pass + screenshot contact sheet (FR-030 / FR-031). |
| VII. Observability | **PASS** | No new log lines, breadcrumbs, or Sentry tags. Existing redaction unchanged. |
| VIII. Terminal Identity ≠ User | **PASS** | OperatorBadge restyle preserves the role / display-name only contract from 004 FR-031 / FR-032. No PII, no email, no Clerk user id reachable from the renderer. |
| IX. Reference, Not Inheritance | **PASS** | Load-bearing for 007. Claude Design and Figma Make are reference-only (FR-034 / FR-035 / FR-051). Repo wins disagreements. |
| Platform Integration | **PASS** | No new hosts; no new endpoints; no new IPC. |
| Security | **PASS** | No new attack surface. CSP / contextIsolation / sandbox / nodeIntegration unchanged. PIN dot-only rule preserved (CD `04-security-and-visibility.md` §A). |
| Hardware Matrix | **PASS** | Touchscreen cashier monitor preserved by 44 × 44 px floor. Windows display scaling 100 / 125 % preserved; 150 % not supported for the pilot, and beyond it only where the effective viewport is ≥ 1024 × 600 with the 600–767 band verified (NFR-012, amended 2026-10-15 per RT-312 D8/D15). |
| Domain — Pharmacy POS | **N/A** | Pharmacy-domain entities out of scope. |

**Initial gate result: PASS.** No violations, no waivers required.

## Phase 0 — Research

See [./research.md](./research.md). Five decisions are recorded with chosen
approach, alternatives, and rationale: token-alignment audit (live repo vs
Claude Design), font-policy resolution (Inter Tight rejection), Figma Make
adjudication (which parts adopt, which reject), screenshot-tooling choice
deferral pattern, and per-slice exit-criteria template.

## Phase 1 — Design & Contracts

- **Data model:** **N/A.** This is a UI-only feature with no persisted
  entities. The only conceptual artifacts are the Recovered Visual
  Language, the Token Table, the Route Layout Primitive, the Recovered
  Primitive Inventory, the Recovered Shell Chrome, and the Contact Sheet
  (spec §"Key Entities"). All live in code under `src/renderer/`.
- **Contracts:** [./contracts/](./contracts/). Two contract artifacts:
  1. **`visual-reference-adjudication.md`** — the canonical priority
     ordering, adopt / adapt / reject lists, rejection-by-name catalogue,
     and theme decision (mirrors §"Visual Reference Adjudication" above
     in contract form).
  2. **`screenshot-acceptance.md`** — the per-surface, per-state
     screenshot acceptance criteria, viewport bands, pixel-diff
     thresholds, contact-sheet attachment requirements, reviewer sign-off
     protocol, and forbidden-content rules for screenshots (the FR-013
     forbidden-string set, cashier-forbidden information catalogue,
     PII / credentials / cards exclusion).
- **Quickstart:** [./quickstart.md](./quickstart.md). Reviewer-facing
  walkthrough: how to inspect the design references out-of-tree, how to
  read the slice gates, what each implementation slice's PR must attach,
  what the 005 / 006 UI gate audit looks like.

## Project Layout

Additions are **renderer-only**. Existing 001 / 002 / 003 / 004 structure is
preserved verbatim. The plan does NOT create source files; this layout is
the *target shape* an implementation slice will land into.

```
POS-Pulse/
├── specs/
│   └── 007-pos-visual-system/
│       ├── spec.md                        # (already shipped — PR #107 + #108)
│       ├── plan.md                        # this file
│       ├── research.md                    # NEW (Phase 0 evidence)
│       ├── quickstart.md                  # NEW (reviewer walkthrough)
│       ├── checklists/
│       │   └── requirements.md            # (already shipped — PR #107 + #108)
│       └── contracts/
│           ├── visual-reference-adjudication.md   # NEW
│           └── screenshot-acceptance.md           # NEW
│
├── src/
│   └── renderer/                          # All implementation lives here
│       ├── styles/
│       │   └── tailwind.css               # S1 amends additively; no token rename
│       ├── ui/
│       │   ├── tokens/                    # S1 amends additively; existing exports stable
│       │   │   ├── colors.ts                  (live; preserved + additive entries)
│       │   │   ├── spacing.ts                 (live; preserved)
│       │   │   ├── typography.ts              (live; preserved)
│       │   │   ├── radius.ts                  (live; preserved + additive entries)
│       │   │   ├── shadow.ts                  (live; preserved + additive entries)
│       │   │   ├── density.ts                 (live; preserved)
│       │   │   ├── touch.ts                   (live; preserved)
│       │   │   ├── connection-state.ts        (live; preserved)
│       │   │   └── index.ts                   (live; preserved)
│       │   ├── primitives/                # S2 restyles in place; no API change
│       │   │   ├── Button/                    (live; restyle)
│       │   │   ├── Card/                      (live; restyle)
│       │   │   ├── Input/                     (live; restyle)
│       │   │   ├── Dialog/                    (live; restyle)
│       │   │   ├── Toast/                     (live; restyle)
│       │   │   ├── StatusBanner/              (live; restyle)
│       │   │   ├── Badge/                     (live; restyle)
│       │   │   └── Table/                     (live; restyle)
│       │   ├── states/                    # S2 restyles in place; no API change
│       │   │   ├── LoadingState.tsx           (live; restyle — in-shell + center-stage variants)
│       │   │   ├── EmptyState.tsx             (live; restyle)
│       │   │   ├── ErrorState.tsx             (live; restyle)
│       │   │   └── ScreenTooSmall.tsx         (live; preserved)
│       │   └── operator/                  # S5 restyles in place; no API change
│       │       ├── OperatorBadge.tsx          (live; restyle)
│       │       ├── RosterList.tsx             (live; restyle)
│       │       ├── PinPad.tsx                 (live; restyle — strict dot-only rule)
│       │       ├── TakeoverPrompt.tsx         (live; restyle — minimum-disclosure)
│       │       ├── ManagerAdminSignInForm.tsx (live; restyle)
│       │       └── messages.ts                (live; preserved — closed-set refusals)
│       ├── shell/                         # S3 restyles in place; no API change
│       │   ├── AppShell.tsx                   (live; restyle)
│       │   ├── regions/                       (live; restyle TopBar / NavRail / IdentityStrip / ConnectionIndicator / OperatorSlot)
│       │   ├── connection/                    (live; preserved — no real-sync work)
│       │   └── viewport/                      (live; preserved)
│       └── routes/                        # S4 restyles in place; no route logic change
│           ├── pairing/                       (live; restyle PairingScreen + PairingForm)
│           ├── paired/                        (live; restyle PairedScreen)
│           └── app/                           (live; placeholders restyled to recovered pattern)
│
└── (no changes under src/main/, src/preload/, src/shared/, scripts/, migrations/, .github/workflows/, _reference/, package*.json, vite.config.ts, tsconfig*.json, openapi-snapshot.json)
```

The static no-touch source-scope guard from 003 (forbidden allowlist:
`src/preload/**`, `src/main/ipc/**`, `src/main/pairing/**`,
`src/main/secrets/**`, `src/shared/bridge-api.ts`, `src/shared/api-types.ts`,
`migrations/**`, `scripts/codegen-api.ts`, `scripts/openapi-snapshot.json`,
`.github/workflows/**`) remains load-bearing for every 007 implementation
slice.

## Implementation Slices

`/speckit-plan` defines slices but does **NOT** generate tasks. Each slice
has a definition of done, a screenshot-acceptance gate, and an exact diff
scope. The 005 / 006 UI implementation gate (NFR-014) ties to S1 + S2 + S3
explicitly.

### S0 — Visual reference adjudication + current-UI screenshot baseline

- **Goal:** Lock the priority-ordered reference set in the repo as a
  reviewable contract; capture a "before" screenshot baseline of every
  existing surface so subsequent slices have a deterministic visual
  comparison.
- **Diff scope:** docs only. `specs/007-pos-visual-system/contracts/visual-reference-adjudication.md`,
  `specs/007-pos-visual-system/contracts/screenshot-acceptance.md`,
  `specs/007-pos-visual-system/quickstart.md` already land in this plan
  PR. The S0 implementation slice's PR adds **out-of-tree** "before"
  screenshots referenced from the screenshot-acceptance contract; they
  are NOT committed to the repo (per the user's design-artifact rules
  and FR-033 / NFR-002).
- **Definition of done:**
  - The visual-reference-adjudication contract is merged.
  - The screenshot-acceptance contract names the per-surface viewport
    matrix, pixel-diff thresholds, and forbidden-content rules.
  - A "before" baseline contact sheet exists out-of-tree (path noted in
    the slice PR; never committed). The reviewer confirms the baseline
    covers every existing route at 1280 × 800 and 1024 × 768.
- **Screenshot-acceptance gate:** N/A — S0 *defines* the gate. The
  baseline contact sheet is the reference for S1 + onwards.
- **Approval criteria for the 005 / 006 UI gate:** S0 alone does NOT
  unblock 005 / 006 UI implementation. S1 + S2 + S3 are required.

### S1 — Token layer + global CSS foundation

- **Goal:** Apply additive token deltas + value tweaks to
  `src/renderer/styles/tailwind.css` and `src/renderer/ui/tokens/*.ts`
  so the recovered visual language is available across every primitive
  and every route. **No token name is renamed, repurposed, or removed**
  (FR-003).
- **Diff scope:**
  - `src/renderer/styles/tailwind.css` — value tweaks (e.g. `--color-rail`
    from `#0E1B2A` → `#0B1726` if reviewer prefers CD's exact value;
    confirmed in S1 task), additive new tokens (e.g.
    `--color-surface-sunken` distinct from the existing
    `--color-surface-elevated`; `--duration-1..4` motion tokens;
    `--ease-out` / `--ease-in-out` motion tokens; CD-named radius
    aliases `--radius-1..6` mapping to existing
    `--radius-{sm|md|lg|control|card|pane}` if the implementer chooses
    aliases vs CD-named additions).
  - `src/renderer/ui/tokens/*.ts` — additive new exports for each new
    CSS variable above (preserving every existing export's name and
    `var(--color-…)` reference verbatim).
  - `src/renderer/ui/tokens/__tests__/tokens.test.ts` — extend the
    parity test to cover any new CSS-var ↔ TS-name pair.
- **Definition of done:**
  - Every additive token has both a CSS-var entry and a TS export
    with matching names.
  - Every existing 003 token name is verbatim preserved (verified by
    a token-name audit, file-by-file diff).
  - The compact-density dead-token guard from 003 still passes.
  - `npm run typecheck`, `npm run lint`, `npm test -- --coverage`,
    `npm run package:dir` all pass on `windows-latest`.
  - Every primitive that consumes the recovered tokens via Tailwind
    utility classes (`bg-surface`, `text-text`, etc.) renders without
    visual regression in the existing test suite.
- **Screenshot-acceptance gate:** the implementing PR attaches a
  contact sheet of every existing route at 1280 × 800 (S0 baseline) +
  the 1024 × 768 sample, comparing against the S0 baseline. Pixel-diff
  ≤ 0.5 % for layout-stable surfaces, ≤ 1.5 % for animated regions.
  Reviewer sign-off recorded in the PR description.
- **Approval criteria for the 005 / 006 UI gate (S1 contribution):**
  - Token additivity verified — zero rename / repurpose / removal of
    any existing 003 token (auditable by `git diff` of the touched
    files).
  - The recovered semantic palette covers the FR-005 minimum
    (surface, surface-muted, text-primary, text-muted, primary,
    danger, warning, success, neutral, focus); existing 003 tokens
    already do this, S1 confirms.

### S2 — Shared primitives polish

- **Goal:** Restyle the existing 003 / 004 primitives to the recovered
  visual language. Every primitive's public prop signature stays
  frozen (FR-014 / FR-015 / FR-016 / FR-017 / FR-018 / FR-019 /
  FR-020 / FR-021).
- **Diff scope:** restyle in place under `src/renderer/ui/primitives/`
  and `src/renderer/ui/states/`. Specifically: `Button`, `Card`,
  `Input`, `Dialog`, `StatusBanner`, `LoadingState`, `EmptyState`,
  `ErrorState`, `Badge`, plus `Toast` and `Table` for completeness.
  No new components; no API changes.
- **Definition of done:**
  - Every primitive matches CD `02-components.md` for variants,
    states, padding, radius, focus-ring treatment, and hover behaviour.
  - Every primitive's public prop signature is unchanged
    (verified by typecheck against the existing test suite).
  - 44 × 44 CSS px touch-target invariant test in `Button.test.tsx`
    passes; per-component touch-target assertions where the wrapper
    does not propagate from `Button` (e.g. NavRail icon-only) pass.
  - Visible focus ring on every interactive element (NFR-006);
    spinner / fade motion respects `prefers-reduced-motion`
    (NFR-007); axe baseline holds (NFR-008).
- **Screenshot-acceptance gate:** the implementing PR attaches a
  per-primitive contact sheet covering each primitive's documented
  variants and states. Pixel-diff thresholds per
  screenshot-acceptance contract.
- **Approval criteria for the 005 / 006 UI gate (S2 contribution):**
  - Every primitive 005 / 006 UI will consume (`Button`, `Card`,
    `Input`, `Dialog`, `StatusBanner`, `Badge`, `Table`, plus the
    state primitives) is recovered to the documented look.
  - No primitive's public prop signature changed.

### S3 — Shell, sidebar, topbar, route-layout primitives

- **Goal:** Restyle `AppShell`, `TopBar`, `NavRail`, `IdentityStrip`,
  `ConnectionIndicator`, `OperatorSlot`, plus introduce / restyle the
  three layout primitives named in CD `05-implementation-translation.md`
  §E (`<CenterStage>`, `<AppShell>`, `<Workspace>`).
- **Diff scope:** restyle in place under `src/renderer/shell/`. The
  `<Workspace>` and `<CenterStage>` primitives may be **new files**
  under `src/renderer/shell/regions/` if they don't exist; the plan
  treats them as additive primitives, not renamed existing ones.
  Routes consume them additively in S4 / S5.
- **Definition of done:**
  - Top bar 64 px, rail 248 expanded / 84 icon-only, hidden < 1024 px
    matches CD `02-components.md` and the live `tailwind.css`
    behaviour; `ScreenTooSmall` fallback preserved.
  - The four connection-state visuals (`online` / `degraded` /
    `offline` / `syncing`) render distinctly without colour-only
    signal (NFR-006 + FR-004); `syncing` is the only ambient
    motion (CD `01-design-tokens.md` §"Motion").
  - Cashier identity slot (OperatorBadge) restyle preserves the role
    / display-name only contract from 004 FR-031 / FR-032.
  - Layout uses logical CSS (`inline-start` / `inline-end`) per
    NFR-010.
- **Screenshot-acceptance gate:** the implementing PR attaches a
  contact sheet covering AppShell at 1280 × 800 + 1024 × 768, the
  four connection-state variants of the top bar, and the
  `ScreenTooSmall` fallback < 1024 px.
- **Approval criteria for the 005 / 006 UI gate (S3 contribution):**
  - The shell chrome 005 / 006 UI inherits is recovered to the
    documented look, with the role-indicator slot, connection
    indicator, and identity strip in their final positions.
  - The `<Workspace>` layout primitive is available for 005 / 006
    UI to consume.
  - **At this point, S1 + S2 + S3 are all approved → 005 / 006 UI
    implementation is unblocked**, contingent on each subsequent
    UI slice attaching its own contact-sheet PR.

### S4 — Pairing and terminal-state surfaces

- **Goal:** Restyle the pairing-bypass surfaces — `/pairing`,
  `/paired` — to the recovered visual language without changing
  pairing flow / copy / security (FR-022 / FR-023). The "Continue
  to dashboard →" affordance from 003 O2 fallback is preserved.
- **Diff scope:** restyle in place under `src/renderer/routes/pairing/`
  and `src/renderer/routes/paired/`. Pairing flow, pairing copy, and
  pairing security boundaries are **not touched**.
- **Definition of done:**
  - Pairing card (`pairing-screen__card`), pairing code display
    (mono 36 px / 700 / 0.18em per CD `01-design-tokens.md`), and
    paired-confirmation card all match CD `03-screens.md` §01–§03.
  - Pairing-flow tests (002) still pass; pairing-bypass contract
    holds (unpaired terminals route to `/pairing` and cannot reach
    `/app/*`).
  - No `_reference/Data-Pulse/` import; no copy-paste of HTML/JSX
    from any reference.
- **Screenshot-acceptance gate:** contact sheet covering Unpaired,
  Pairing-in-progress, Paired-ready at 1280 × 800 + 1024 × 768.
  Reviewer sign-off in PR description.
- **Approval criteria:** S4 is **not** part of the 005 / 006 gate.
  005 / 006 UI is already unblocked at S3 approval.

### S5 — Operator sign-in, roster, PinPad, TakeoverPrompt, OperatorBadge

- **Goal:** Restyle the operator-session surfaces from 004 to the
  recovered visual language, preserving every behavioural rule from
  004 FR-005 / FR-006 / FR-013 / FR-024 verbatim. PIN remains
  dot-only (PR-1, CD `04-security-and-visibility.md` §A); TakeoverPrompt
  remains minimum-disclosure (FR-013, CD §C); the role-indicator slot
  remains role / display-name only (004 FR-031 / FR-032).
- **Diff scope:** restyle in place under `src/renderer/ui/operator/`.
  Specifically `RosterList.tsx`, `PinPad.tsx`, `TakeoverPrompt.tsx`,
  `OperatorBadge.tsx`, `ManagerAdminSignInForm.tsx`. `messages.ts`
  (closed-set refusal strings from 004) is **preserved verbatim**.
- **Definition of done:**
  - PIN keypad 64 × 64 keys, sunken container, dot row 6, dot states
    `empty / filled / error`. PIN dot markup carries no `value`
    attribute, no `data-value`, no `title` attribute referencing PIN
    content. Only `data-state` and `aria-label="N of 6 entered"`.
  - TakeoverPrompt copy is the canonical FR-013 strings, byte-for-byte:
    Heading "You are already signed in on another POS terminal in this
    branch.", Body "Continue here and sign out there?", primary
    "Continue here", ghost "Cancel". Forbidden-string assertions
    pass: terminal-A label, prior-session timestamp, other-operator
    name / role, "View details" / "Why am I seeing this" / "Show
    details" all absent from the modal subtree.
  - OperatorBadge displays role + display-name only — no email, no
    phone, no Clerk user id reachable via the rendered DOM.
  - Roster grid 3-column at ≥ 1280 px, 2-column at 1024–1279 px;
    tile 84 px tall; `EmptyState` for an empty roster.
  - The `messages.ts` closed-set refusal copy is unchanged.
  - Cashier-Forbidden Information catalogue (004 FR-015) remains
    walled off — no manager-only surface reachable from a cashier
    role's render tree.
- **Screenshot-acceptance gate:** contact sheet covering Cashier
  roster, Manager / admin sign-in, PIN entry, PIN error,
  Takeover-required modal, signed-in shell (cashier role) at 1280 × 800
  + 1024 × 768. The takeover screenshot's DOM is asserted against the
  forbidden-string set per the screenshot-acceptance contract.
- **Approval criteria:** S5 is **not** part of the 005 / 006 gate.
  005 / 006 UI is already unblocked at S3 approval.

### S6 — Screenshot / contact-sheet acceptance + regression checklist

- **Goal:** Lock the per-PR screenshot acceptance gate, the
  regression checklist for every subsequent UI feature (005, 006,
  and any future UI slice), and the reviewer sign-off protocol.
  This slice closes 007 by promoting the screenshot-acceptance
  contract from a planning artifact into an enforced merge gate.
- **Diff scope:** docs only. The screenshot-acceptance contract may
  receive its final amendments based on lessons learned in S1–S5.
  No code changes.
- **Definition of done:**
  - The screenshot-acceptance contract is the single canonical
    reference for "what an implementing PR attaches".
  - Every implementing PR for a subsequent UI feature (005, 006,
    or any future UI slice) cites the contract in its PR template
    and attaches the required artifacts.
  - The regression checklist explicitly enumerates: token additivity
    (no rename / repurpose / removal), forbidden-string assertions
    on TakeoverPrompt subtrees, Cashier-Forbidden Information
    walling, PIN dot-only markup, no `prefers-color-scheme` follower,
    no proprietary brand fonts beyond Inter.
- **Screenshot-acceptance gate:** N/A — S6 *finalises* the gate.
- **Approval criteria:** S6 is **not** part of the 005 / 006 gate.

## 005 / 006 UI implementation gate (auditable)

Per spec NFR-014, **the UI implementation slices of 005-sales-cart and
006-payments-tender are held until at least 007 Slices S1, S2, and S3
are approved**. The gate is auditable because each of S1, S2, S3 has
explicit definition-of-done + screenshot-acceptance criteria above; a
reviewer can tick each criterion against the implementing PR's evidence.

| 007 slice | Required for 005 / 006 UI gate? | Evidence the reviewer ticks |
|:--|:--:|:--|
| S0 | No (sets up the gate; not part of it) | — |
| **S1** | **YES** | Token additivity verified; semantic palette covers FR-005; tokens.test.ts parity test passes; existing 003 tokens preserved verbatim |
| **S2** | **YES** | Every primitive 005 / 006 will consume is restyled to CD; public prop signatures unchanged; touch-target invariant + axe baseline pass |
| **S3** | **YES** | Shell chrome restyled; `<Workspace>` layout primitive available for consumption; role-indicator slot in final position; four connection-states render distinctly |
| S4 | No (independent surface) | — |
| S5 | No (independent surface) | — |
| S6 | No (closes 007's screenshot gate; not part of unblocking 005 / 006) | — |

**Non-UI 005 / 006 work — explicitly NOT held by this gate:** planning,
specification, contract design, data-model work, money-math wiring,
audit-attribution wiring, backend / IPC integration design. Those may
proceed in parallel with 007. The 005 / 006 specs (already shipping
under `specs/005-sales-cart/` and `specs/006-payments-tender/` since
2026-05-09) are unaffected by this plan.

## Test Strategy

| Surface | Framework | What it covers | Gate |
|:--|:--|:--|:--|
| `src/renderer/ui/tokens/__tests__/tokens.test.ts` | Vitest | CSS-var ↔ TS-name parity (existing + additive); semantic-palette completeness; touch-target constant === 44; compact-density dead-token guard | parity guard |
| `src/renderer/ui/primitives/*/__tests__/*.test.tsx` | Vitest + RTL + happy-dom | Each primitive's variants × states; touch-target invariant on Button (and propagated wrappers); focus-ring visible; axe-clean on default / loading / empty / error variants | ≥ 90 % line + branch |
| `src/renderer/ui/states/__tests__/states.test.tsx` | Vitest + RTL | Loading (in-shell + center-stage variants), Empty, Error, ScreenTooSmall — each rendered for every placeholder pane | ≥ 90 % |
| `src/renderer/shell/**/__tests__/*.test.tsx` | Vitest + RTL | TopBar + NavRail + AppShell + IdentityStrip + ConnectionIndicator + OperatorSlot at expanded / icon-only / too-small viewports | ≥ 90 % |
| `src/renderer/ui/operator/__tests__/*.test.tsx` | Vitest + RTL + user-event | RosterList grid; PinPad dot-only markup (no `value`, no `data-value`, no `title`); PinPad keyboard-parity (0–9 / Backspace / Enter); TakeoverPrompt forbidden-string assertions on the modal subtree; OperatorBadge role + display-name only | ≥ 90 % |
| `src/renderer/routes/**/__tests__/*.test.tsx` | Vitest + RTL | Each restyled route renders default + state variants; pairing-bypass contract holds; cashier-forbidden information walling holds | ≥ 90 % |
| **TakeoverPrompt forbidden-string guard** | Vitest + RTL | Asserts the modal subtree under `[data-testid="takeover-prompt"]` contains zero of: `POS-` (terminal label prefix), substring `ago`, `Cashier ` / `Manager` / `Admin` (other-operator role), 4-digit time pattern `\d{2}:\d{2}`, `View details` / `Why am I seeing this` / `Show details` | guard (must be no-op) |
| **PIN dot-only guard** | Vitest + RTL | Asserts the PIN dot row markup carries no `value`, no `data-value`, no `title`; only `data-state` and `aria-label="N of 6 entered"` | guard (must be no-op) |
| **No `prefers-color-scheme` follower guard** | Vitest (static-analysis style) | Asserts no source file under `src/renderer/` references `prefers-color-scheme` outside the explicit "ignore OS preference" media-query if any (007 commits to no such follower) | guard (must be no-op) |
| **No proprietary brand font guard** | Vitest (static-analysis style) | Asserts no new `@font-face` declaration referencing Inter Tight, JetBrains Mono as a primary face, or any other proprietary brand font is added by S1 | guard (must be no-op) |
| **Static no-touch source-scope guard (003 inheritance)** | Vitest (static-analysis style) + PR review checklist | Asserts no diff lines under the forbidden allowlist (`src/preload/**`, `src/main/ipc/**`, `src/main/pairing/**`, `src/main/secrets/**`, `src/shared/bridge-api.ts`, `src/shared/api-types.ts`, `migrations/**`, `scripts/codegen-api.ts`, `scripts/openapi-snapshot.json`, `.github/workflows/**`) for any 007 implementation slice | guard (must be no-op) |
| Per-pane / per-surface axe smoke | Vitest + axe-core | Each restyled surface in default / loading / empty / error variants: zero `serious` or `critical` violations | smoke |

**Coverage roll-up:** `src/renderer/ui/` ≥ 90 % line + branch (NFR-013);
`src/renderer/shell/` held to the same gate.

## CI / Build / Package

**No workflow file change.** The existing `.github/workflows/ci.yml`
pipeline applies unchanged:

```
checkout → setup-node → npm ci → npm run codegen:verify → npm run typecheck → npm run lint
       → npm test -- --coverage → npm run package:dir → upload-artifact
```

This feature is fully contained in the renderer; `codegen:verify` is a
no-op for it (no OpenAPI delta) and `package:dir` exercises the new
visual paths only as part of the bundle build.

## Risks & Open Items

- **R1 — Token-name drift between live `tailwind.css`, the 003 contract
  snapshot, and Claude Design's handoff.** *Mitigation:* the
  token-additivity policy (FR-003-safe) means every existing 003 token
  name is preserved verbatim; CD's parallel names land as additive new
  exports only. The S1 task's tokens.test.ts parity test asserts every
  CSS-var in `tailwind.css` has a TS export with the matching name; a
  drift detector test runs in CI.
- **R2 — Inter Tight desire creep.** A future contributor may want CD's
  display-typeface look. *Mitigation:* FR-052 is binding; the plan
  rejects Inter Tight explicitly and prescribes Inter weight-700 + tight
  letter-spacing as the substitute. The "no proprietary brand font
  guard" test enforces it.
- **R3 — Figma Make `IMPLEMENTATION_NOTES.md` bleeding in.** A future
  reviewer may copy fragments from FM's notes into a 007 implementing
  PR. *Mitigation:* the visual-reference-adjudication contract names
  the file as non-binding by name; the PR review checklist cites the
  contract; the static no-touch source-scope guard catches any IPC /
  preload / migration / OpenAPI drift.
- **R4 — Screenshot tooling cost.** Per-PR contact sheets at multiple
  viewports could become expensive. *Mitigation:* the
  screenshot-acceptance contract names a deliberately small per-slice
  surface inventory; viewports are 1280 × 800 + 1024 × 768 only;
  Windows display scaling 100 % is the default. Tooling choice (RTL +
  happy-dom DOM snapshot, Playwright, or manual capture) is a per-slice
  decision.
- **R5 — 005 / 006 UI gate vibes-tick risk.** A reviewer may approve
  S1 + S2 + S3 without ticking each definition-of-done item. *Mitigation:*
  the per-slice "Approval criteria for the 005 / 006 UI gate"
  paragraphs above name explicit auditable evidence; the PR review
  checklist requires each item to be ticked against the implementing
  PR's diff and tests.
- **R6 — Reduced-motion regression.** Slot-row dashed underlines,
  spinner, modal fade, and rail expand-transition all touch motion.
  *Mitigation:* NFR-007 + axe-color-contrast smoke test catch the
  obvious cases; per-PR contact sheet covers a `prefers-reduced-motion`
  variant of any surface that animates.
- **O1 — Pixel-diff threshold tuning.** The plan suggests ≤ 0.5 % for
  layout-stable surfaces and ≤ 1.5 % for animated regions, mirroring
  004's S0 thresholds. The S0 implementation slice MAY tune these
  per-surface based on the "before" baseline. Final values are pinned
  in `screenshot-acceptance.md`.
- **O2 — `<Workspace>` and `<CenterStage>` layout primitives:
  introduce in S3 vs S5.** The plan introduces them in S3 because
  the shell consumes `<AppShell>` already and `<Workspace>` is the
  natural layout primitive the shell wraps. S5's surfaces consume
  `<CenterStage>` (sign-in surfaces are center-stage per CD
  `03-screens.md` §05–§09). The S1–S5 contributions are independent
  enough to live in either S3 or S5; the S3 task picks.

## Phase 2 — Implementation outline

The work decomposes into the seven slices above (S0–S6). `/speckit-tasks`
will expand each slice into concrete, test-first tasks. Order matters:
S1 must precede S2; S2 must precede S3; S4 / S5 may run in parallel after
S3 lands (their surfaces are independent of each other); S6 closes 007.

The first implementing PR (S0 baseline + S1 token deltas) MAY be a single
PR if scoped tightly; otherwise S0 lands as a standalone reviewer-baseline
PR and S1 follows.

---

*This plan is the source for `/speckit-tasks`. Changes to scope or
technical approach after task generation MUST update this plan and re-run
task generation. The 005 / 006 UI gate is load-bearing and any change to
S1 / S2 / S3 's definition-of-done or approval criteria invalidates the
gate audit.*
