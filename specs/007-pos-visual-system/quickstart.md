# Quickstart — POS Visual System Recovery

**Feature:** 007-pos-visual-system
**Plan:** [./plan.md](./plan.md)
**Spec:** [./spec.md](./spec.md)
**Audience:** Reviewers and implementers walking the 007 plan, the slice
gates, the design references, and the PR-attachment pattern.

---

## What 007 is and is not

**007 is** a renderer-only visual recovery of the POS Pulse pre-sales
surface (pairing, paired confirmation, sign-in surfaces, shell chrome,
placeholder routes). It is the visual layer that 005-sales-cart and
006-payments-tender inherit before their UI implementation slices begin.

**007 is not** a rewrite, a re-architecture, a route logic change, a
backend touchpoint, an OpenAPI change, an IPC change, or a SQLite
migration. Every primitive's public prop signature stays frozen.
Restyle, do not rewrite.

---

## Reading the plan

Read in this order:

1. [`spec.md`](./spec.md) — the product behaviour and acceptance rules
   (50 FRs + FR-048a + FR-051 + FR-052, 14 NFRs, 13 SCs).
2. [`plan.md`](./plan.md) — this directory's load-bearing artifact. The
   Visual Reference Adjudication, the seven slices (S0–S6), and the
   005 / 006 UI gate.
3. [`research.md`](./research.md) — Phase 0 evidence: the token
   alignment audit, the Inter Tight rejection, the Figma Make
   adjudication, the screenshot-tooling deferral, the per-slice
   exit-criteria template.
4. [`contracts/visual-reference-adjudication.md`](./contracts/visual-reference-adjudication.md)
   — the canonical priority ordering and adopt / adapt / reject lists.
5. [`contracts/screenshot-acceptance.md`](./contracts/screenshot-acceptance.md)
   — the per-surface viewport matrix, pixel-diff thresholds,
   forbidden-content rules, and reviewer sign-off protocol.

---

## Inspecting the design references (out-of-tree only)

The two reference packages live at:

- **Claude Design (primary):** `C:\Users\user\Downloads\POS-1-CLAUDE DESIGN.zip`
- **Figma Make (secondary):** `C:\Users\user\Downloads\POS-figam-2.zip`

Under Git Bash / WSL: `/mnt/c/Users/user/Downloads/<filename>.zip`.

**Extract only into the temporary out-of-tree directory:**

- Windows: `C:\Users\user\Downloads\pos-design-reference-temp\`
- Git Bash / WSL: `/mnt/c/Users/user/Downloads/pos-design-reference-temp/`

```bash
mkdir -p /c/Users/user/Downloads/pos-design-reference-temp/claude-design
mkdir -p /c/Users/user/Downloads/pos-design-reference-temp/figma-make
unzip -o "/c/Users/user/Downloads/POS-1-CLAUDE DESIGN.zip" \
  -d /c/Users/user/Downloads/pos-design-reference-temp/claude-design
unzip -o "/c/Users/user/Downloads/POS-figam-2.zip" \
  -d /c/Users/user/Downloads/pos-design-reference-temp/figma-make
```

**Do NOT** extract into the repo. **Do NOT** commit, stage, copy, or
reference any path inside the repo for these packages.

### What to read in Claude Design

| File | What it tells you |
|:--|:--|
| `claude-design/handoff/README.md` | Hard rules (PIN dot-only, takeover minimum disclosure, closed-set refusal copy, no secrets, cashier walling, no emoji) |
| `claude-design/handoff/01-design-tokens.md` | Token table (color, type, spacing, radius, elevation, density, focus, motion, breakpoints) |
| `claude-design/handoff/02-components.md` | Per-component visual guidance |
| `claude-design/handoff/03-screens.md` | 12-screen contact sheet — viewport, hierarchy, layout, states |
| `claude-design/handoff/04-security-and-visibility.md` | Constitutional rules (PIN, JWT, device token, refusal copy, takeover, role visibility) |
| `claude-design/handoff/05-implementation-translation.md` | Translation order, token deltas, primitive restyle map, layout primitives, acceptance criteria |
| `claude-design/ContactSheet.html` | Printable visual reference (open in browser) |
| `claude-design/Prototype.html` | Live interactive prototype (open in browser) |
| `claude-design/Deck.html` | Visual system deck |

### What to read in Figma Make

| File | Verdict |
|:--|:--|
| `figma-make/POS-figam-2/DESIGN_HANDOFF_README.md` | Adapt — structure only |
| `figma-make/POS-figam-2/DELIVERABLES.md` | Adapt — structure only |
| `figma-make/POS-figam-2/PROTOTYPE_README.md` | Adapt — structure only |
| `figma-make/POS-figam-2/IMPLEMENTATION_NOTES.md` | **Reject in entirety** — backend / DB / PIN-validation / routing guidance contradicts the spec |
| `figma-make/POS-figam-2/default_shadcn_theme.css` | **Reject in entirety** — shadcn defaults contradict CD's navy palette and ship a `.dark` block |
| `figma-make/POS-figam-2/src.zip` | **Reject — never extract** — generated React |
| Any `.tsx` / `.css` / `.html` / `.js` | **Reject** — generated source |

The visual-reference-adjudication contract names every reject by name.

---

## Reading the slice gates

The plan defines seven slices: S0, S1, S2, S3, S4, S5, S6. Each slice has
four sections (five for S1–S3):

1. **Goal.**
2. **Diff scope.** The exact paths the implementing PR may modify.
3. **Definition of done.** A concrete checklist.
4. **Screenshot-acceptance gate.** What contact sheet the PR attaches.
5. (S1–S3 only) **Approval criteria for the 005 / 006 UI gate.** What
   the reviewer ticks against the PR's evidence.

**The 005 / 006 UI gate audit:**

```
S1 approved (token additivity verified + semantic palette covered + parity test passes)
+ S2 approved (every primitive 005 / 006 will consume restyled + public prop signatures unchanged + touch-target + axe)
+ S3 approved (shell chrome restyled + Workspace primitive available + role-indicator slot in final position + 4 connection-states render distinctly)
= 005 / 006 UI implementation slices unblocked.
```

S0 sets up the gate. S4 / S5 are independent surfaces; they do NOT
contribute to the gate. S6 closes 007 by promoting the
screenshot-acceptance contract into an enforced merge gate.

Non-UI 005 / 006 work (planning, specification, contract design,
data-model work, money-math wiring, audit-attribution wiring) is
**explicitly NOT held** by this gate.

---

## What an implementing PR attaches

Every 007 implementation slice's PR (S0 baseline, S1 token deltas, S2
primitives polish, S3 shell, S4 pairing surfaces, S5 operator surfaces,
S6 contract finalisation) attaches:

- **A contact sheet** of the surfaces the slice touches, at 1280 × 800
  + 1024 × 768 viewports, at Windows display scaling 100 % (and 125 / 150 %
  if the slice changes any layout that responds to scaling; 150 % only as
  spec NFR-012 allows).
- **Reviewer sign-off** recorded in the PR description.
- **Per-PR forbidden-content discipline:**
  - No PII, no Clerk JWT, no `device_token`, no PIN value, no PIN hash,
    no credentials, no raw cardholder data in any screenshot.
  - For TakeoverPrompt screenshots: zero occurrences of the FR-013
    forbidden-string set in the modal subtree (terminal-A label,
    prior-session timestamp, other-operator name / role, "View
    details" / "Why am I seeing this" / "Show details").
  - For cashier-reachable surface screenshots: zero items from the
    Cashier-Forbidden Information catalogue (004 FR-015).
  - No emoji in any screenshot label, contact-sheet caption, or PR
    description.
- **No binary design file committed to the repo.** Screenshots
  attached to the PR description are stored in the PR's attachment
  surface (GitHub uploads), NOT in `specs/` or any other repo path.

---

## Local validation before pushing a 007 implementation PR

```bash
# Type check + lint + test
npm run typecheck
npm run lint
npm test -- --coverage

# Package dry-run (Windows-only check)
npm run package:dir
```

Each of these MUST pass on `windows-latest` CI before the PR is
mergeable. The static no-touch source-scope guard from 003 (forbidden
allowlist) MUST be a no-op for every 007 slice.

---

## Verifying the 005 / 006 gate

A reviewer auditing whether 005 / 006 UI implementation may begin walks
this checklist:

- [ ] **S1 approved.** Token additivity verified by `git diff` of
      `src/renderer/styles/tailwind.css` and `src/renderer/ui/tokens/*`
      shows zero rename / repurpose / removal of an existing 003 token.
      Semantic palette covers FR-005. `tokens.test.ts` parity test
      passes.
- [ ] **S2 approved.** Every primitive 005 / 006 will consume
      (`Button`, `Card`, `Input`, `Dialog`, `StatusBanner`, `Badge`,
      `Table`, plus state primitives) is restyled to CD. Every
      primitive's public prop signature is unchanged. Touch-target
      invariant + axe baseline pass.
- [ ] **S3 approved.** Shell chrome (`AppShell`, `TopBar`, `NavRail`,
      `IdentityStrip`, `ConnectionIndicator`, `OperatorSlot`)
      restyled. `<Workspace>` layout primitive available. Role-indicator
      slot in final position. Four connection-states render distinctly
      without colour-only signal.

If all three are ticked, **005 / 006 UI implementation is unblocked**.
The reviewer notes the unblock decision in the relevant 005 / 006
implementing PR's description, citing the three 007 slice PRs.

---

## What's next

After this plan PR merges:

1. `/speckit-tasks` produces the per-slice work breakdown (S0 first;
   S1–S6 follow per the plan's slice numbering).
2. S0 lands as a standalone reviewer-baseline PR (baseline screenshot
   contact sheet captured out-of-tree; reviewer signs off the
   visual-reference-adjudication contract and the
   screenshot-acceptance contract in a final form).
3. S1 lands the token deltas. PR attaches a contact sheet comparing
   every existing route to the S0 baseline; reviewer ticks the 005 / 006
   gate criterion for S1.
4. S2 lands the primitives polish. PR attaches a per-primitive contact
   sheet; reviewer ticks the gate criterion for S2.
5. S3 lands the shell + layout primitives. PR attaches a shell contact
   sheet; reviewer ticks the gate criterion for S3. **At this point
   005 / 006 UI implementation is unblocked.**
6. S4 + S5 land in either order (independent surfaces) — pairing /
   paired surfaces; operator sign-in surfaces.
7. S6 closes 007 by promoting the screenshot-acceptance contract into
   an enforced merge gate for every subsequent UI feature.

---

*This quickstart is the reviewer's entry point. The authoritative content
lives in [`plan.md`](./plan.md), [`research.md`](./research.md), and the
two contracts under [`contracts/`](./contracts/).*
