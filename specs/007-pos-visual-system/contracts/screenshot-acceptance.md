# Contract — Screenshot Acceptance

**Feature:** 007-pos-visual-system
**Plan:** [../plan.md](../plan.md)
**Status:** planning-time contract. Once S6 finalises this contract,
the canonical merge gate for every subsequent UI feature is this
document.

This contract codifies the per-surface, per-state screenshot acceptance
criteria, viewport bands, pixel-diff thresholds, contact-sheet
attachment requirements, reviewer sign-off protocol, and forbidden-
content rules. It is the canonical reference for any 007 implementing
PR (S0–S6) and for every subsequent UI feature (005, 006, and any
future UI slice) that inherits the recovered visual system.

---

## Per-PR contact sheet — what every implementing PR attaches

Every 007 implementation slice's PR (S0 baseline, S1 token deltas, S2
primitives polish, S3 shell, S4 pairing surfaces, S5 operator
surfaces, S6 contract finalisation) — and every subsequent UI feature
inheriting 007's visual recovery — attaches:

1. **A contact sheet** of the surfaces the slice or feature touches.
2. **The per-surface, per-state, per-viewport screenshot files**
   referenced by the contact sheet.
3. **A reviewer sign-off note** in the PR description, recording which
   reviewer verified the contact sheet and on what date.
4. **A forbidden-content audit** confirming the screenshots contain
   no items from the forbidden-content list below.

---

## Viewport matrix (mandatory)

Every contact sheet covers, at minimum, these two viewports:

| Viewport | Use | Display scaling tested |
|:--|:--|:--|
| **1280 × 800** | Primary cashier monitor (≥ 1280 px expanded rail) | 100 % (default), 125 %, 150 % (150 % only as spec NFR-012 allows: not a pilot configuration) |
| **1024 × 768** | Secondary supported viewport (icon-only rail) | 100 % (default) |

Viewports below 1024 px are NOT a target production viewport and are
covered by the `ScreenTooSmall` fallback in the shell. No mobile
hamburger drawer is ever rendered.

If a slice changes a layout that responds to Windows display scaling,
the contact sheet additionally covers 125 % and 150 % at 1280 × 800 (150 % only as NFR-012 allows: not a pilot configuration, and only where the effective viewport is ≥ 1024 × 600).
Otherwise the 100 % capture is sufficient.

---

## Per-surface state matrix (mandatory)

Every surface a slice touches gets at least these states in its
contact sheet:

| Surface category | Required states |
|:--|:--|
| Pairing screens | default, pairing-in-progress, paired-ready, paired-failed |
| Cashier roster | default (with cashiers), empty roster, roster-picked |
| Manager / admin sign-in | default, entering, submitting, generic-failure (variants A / B / C) |
| PinPad | default, dot-row 1-of-6 entered, dot-row full, error flash, locked-out, submitting |
| TakeoverPrompt | default (modal open), confirming, cancel-pressed, error |
| Signed-in shell (cashier) | default (operator badge cashier), connection-online, connection-degraded, connection-offline, connection-syncing |
| Placeholder routes | default, loading, empty, error |
| Status banner | success, warning, danger, syncing |
| Dialog | default open, action-pressed, dismiss-pressed |
| Reduced-motion variants | every surface that contains animation (spinner, modal fade, rail expand) — captured with `prefers-reduced-motion: reduce` |

Slices that touch only a subset of surfaces attach only the relevant
states.

---

## Pixel-diff thresholds

The implementing PR's contact-sheet review compares the new
screenshots against the S0 baseline (or, for surfaces introduced after
S0, against the slice's own immediate-prior baseline).

| Surface category | Threshold |
|:--|:--|
| Layout-stable surfaces (default, roster-picked, paired-ready, sign-in default, takeover default-prompt) | **≤ 0.5 %** per-pixel diff |
| Surfaces with animated regions (submitting, confirming, modal fade-in, spinner-active) | **≤ 1.5 %** per-pixel diff |
| Surfaces with `prefers-reduced-motion` variant | the reduced-motion variant has a **separate baseline**; the active-motion variant compares against the active-motion baseline only |

The S0 implementing slice MAY tune these thresholds per-surface based
on the "before" baseline if happy-dom or Playwright produces
sub-pixel rendering noise that would otherwise spuriously fail at
0.5 %. Any tuning is recorded in the S0 PR description and propagated
into this contract via S6's amendment.

---

## Forbidden content in screenshots

A screenshot attached to any 007 implementing PR (or any subsequent
UI feature inheriting 007's recovery) MUST NOT contain:

### Cashier-reachable surface screenshots — no Cashier-Forbidden Information

Screenshots of any cashier-reachable surface MUST NOT depict items
from the 004 FR-015 catalogue:

- Shift totals
- Expected drawer cash
- Expected change-fund
- Declared cash count
- Shortage
- Overage
- Variance
- Reports of any kind
- KPIs of any kind
- Manager-review data
- Audit log surfaces
- Admin / configuration surfaces
- Other operators' shift data

Manager-only or admin-only surfaces MAY depict these items, but the
implementing PR's reviewer must redact / mock financial values before
attaching when the screenshot might surface in a public review channel.

### TakeoverPrompt screenshots — minimum-disclosure forbidden strings

A screenshot of any TakeoverPrompt state's modal subtree
(`[data-testid="takeover-prompt"]`) MUST NOT contain:

- The string `POS-` (terminal-label prefix from 003's pairing).
- The substring `ago` (any timestamp-relative wording).
- The substrings `Cashier ` (with trailing space), `Manager`, `Admin`
  (other-operator role).
- Any 4-digit time pattern matching the regex `\d{2}:\d{2}` (e.g. a
  timestamp like `14:23`).
- The strings `View details`, `Why am I seeing this`, `Show details`
  (or any equivalent expandable-affordance label).

The S5 implementing slice's test suite includes a render-time DOM
assertion confirming these strings are absent from the modal subtree.

### Per-screenshot generic forbidden content

Every screenshot, regardless of surface:

- No PII beyond an operator's display name (first name + last initial
  is the maximum; no email, no phone, no address).
- No Clerk JWT, no `device_token`, no session token, no API key.
- No PIN value, no PIN hash, no credential fragment.
- No raw cardholder data (PAN, CVV, expiry).
- No raw error payload (e.g. `INVALID_CREDENTIALS`, `401`, `409`,
  stack trace, trace ID).
- No emoji.
- No mockup-only artifacts (`Lorem ipsum…`, `placeholder`, the strings
  "TODO" / "FIXME" / "XXX").

---

## Reviewer sign-off protocol

The implementing PR's description records:

1. **Reviewer name and date** for each contact-sheet entry.
2. **Confirmation that the forbidden-content audit was performed** and
   no items from the lists above appear in any attached screenshot.
3. **Confirmation that the pixel-diff threshold was met** for every
   captured surface.
4. **Any threshold tuning** recorded in this PR (referencing the S6
   amendment in the contract).

The reviewer is a designated person (typically the product owner, a
senior engineer, or a designer); the implementing PR's author may NOT
self-approve the contact sheet.

---

## Tooling — deferred per slice

This contract does NOT pin a single screenshot tool. Each slice picks
its tool based on the surfaces it touches:

- **State-variant primitives** (Loading / Empty / Error /
  ScreenTooSmall): Vitest + happy-dom + RTL render + DOM snapshot is
  sufficient. Pixel-diff is asserted by serialising the rendered DOM
  to a stable string and comparing.
- **Shell chrome and route layouts** (S3 + S4 + S5): Playwright (if
  available) or manual browser capture. PNG artifacts attach to the
  PR description. PNG files are NOT committed to the repo.
- **Animated regions**: capture a fixed-frame screenshot via
  `page.locator(...).screenshot()` with `animations: 'disabled'`
  (Playwright) or render with `prefers-reduced-motion: reduce`.

The S0 implementing slice may pick a tool for the baseline contact
sheet; subsequent slices match the S0 tool unless a documented reason
applies.

---

## Storage of attached screenshots

Per the user's design-artifact rules and spec NFR-002:

- **Screenshots are NOT committed to the repo.** No PNG, JPG, ZIP, or
  PDF is staged or committed by any 007 implementation slice.
- **Screenshots attach to the PR description** via GitHub's upload
  surface (drag-and-drop into the PR description body). GitHub
  hosts the files; the repo references them only by URL.
- **The contact-sheet "index"** (a markdown table or list summarising
  every screenshot) MAY appear in the PR description, but does NOT
  land in the repo as a file.

This rule preserves the no-binary-design-files-committed discipline.

---

## 005 / 006 UI gate audit

A reviewer auditing whether 005 / 006 UI implementation may begin
walks the gate criteria from the plan's per-slice "Approval criteria
for the 005 / 006 UI gate" sections, against the relevant S1 / S2 / S3
implementing PR's evidence.

The reviewer ticks the criteria in the 005 / 006 implementing PR's
description, citing the three 007 slice PRs (S1 PR #, S2 PR #, S3 PR #).

---

## Amendment history

### S6 — 2026-05-10 — Final accepted evidence types and forbidden-content lessons (S0–S5)

**Motivating slice:** S6 docs/007-s6-visual-recovery-final-gate

#### Accepted evidence types per slice

| Slice | Evidence format | Storage location |
|:------|:----------------|:-----------------|
| S0 | Visual reference adjudication decision table embedded in PR body | PR 109 body |
| S1 | Token delta table (tokens added, sample usage) embedded in PR body | PR 113 body |
| S2 | Shared-primitives coverage table (component × variant) embedded in PR body | PR 114 body |
| S3 | Shell layout contact sheet table (surface × viewport) embedded in PR body | PR 115 body |
| S4 | 16 Playwright PNG screenshots (8 surfaces × 2 viewports) stored out-of-tree | `Downloads/pos-007-after-s4/` (local only, not committed) |
| S5 | 19 Vitest happy-dom HTML serialisations + `CONTACT-SHEET-S5.md` evidence index stored out-of-tree | `Downloads/pos-007-after-s5/` (local only, not committed) |

Out-of-tree storage (S4, S5) is intentional: binary and heavyweight HTML artefacts are not committed
to the repository. The evidence exists on the reviewer's machine for the duration of the review
window; the PR body references the artefact set by name and count.

#### Forbidden-content rules learned from S4

- **Hidden text in terminal-state overlays**: `PairedScreen` and similar surfaces that conditionally
  show/hide detail blocks must not expose operator identifiers, drawer totals, or branch KPIs in
  any hidden DOM subtree. A surface that passes visual inspection can still leak a string via
  `display:none` or `aria-hidden` — the forbidden-content audit must grep serialised DOM, not
  only the visible paint. No automated test; enforced by the contact-sheet grep audit on every
  PR that modifies a terminal-state surface.

#### Forbidden-content rules learned from S5

- **PIN dot-only markup (PR-1)**: PIN digits must never appear as text content in the DOM. The
  PinPad component represents each entered digit as a dot marker with `data-state="filled"` — no
  numeric character, no aria-label that reads a digit. Automated guard: `PinPad.dot-only-guard.test.tsx`
  (9 assertions).
- **TakeoverPrompt minimum-disclosure (FR-013)**: The takeover prompt surface must not render the
  pending terminal name, other operator's identity, other operator's role, a timestamp, or any CTA
  that implies the operator can learn the cause ("View details", "Why am I seeing this", "Show
  details"). Automated guard: `TakeoverPrompt.forbidden-strings.test.tsx` (10 assertions).
- **Cashier-Forbidden Information walling (FR-006/FR-031)**: Cashier-facing surfaces must not
  render shift totals, KPIs, drawer cash amounts, operator IDs, or management-only identifiers.
  Automated guard: `cashier-walling.test.tsx` (5 assertions).

Any amendment is a documented change to this contract; the change
takes effect for every PR opened after the amendment merges.

---

*This contract is the canonical merge gate for every subsequent UI
feature inheriting 007's visual recovery. Spec FR-030 / FR-031
reference it; NFR-014's 005 / 006 UI gate audit relies on it; the
auditor checklist in `visual-reference-adjudication.md` complements
it.*
