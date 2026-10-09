# Maestro Operating System — POS-Pulse

> **Status:** DRAFT proposal — docs-only. Not yet ratified. Does not modify any
> existing workflow, gate, or process until accepted by the project owner.
> **Scope:** This directory contains the proposal. No source, test, package,
> migration, OpenAPI, CI, or `_reference/Data-Pulse/` files are touched by any
> document under `docs/maestro/`.

## What Maestro is

**Maestro is an overlay above Spec Kit, not a replacement.** Spec Kit
(`/speckit-specify`, `/speckit-clarify`, `/speckit-plan`, `/speckit-tasks`,
`/speckit-analyze`, `/speckit-implement`) remains the source-of-truth pipeline
for requirements, scope, acceptance criteria, and per-task ordering — exactly
as the Constitution P12 requires.

Maestro adds a **coordination layer** on top of that pipeline. It answers
operational questions that Spec Kit deliberately leaves open:

- Which tasks in the current `tasks.md` are **ready right now**, given the
  per-slice gate ledger in `coordination.md`?
- Which `[P]`-marked tasks are **actually parallel-safe** once you cross-check
  the file paths each task touches, vs. which need to be downgraded to
  sequential because they edit the same file?
- For the ready, parallel-safe set, **which can be delegated to subagents**,
  and which need a single human-supervised agent because they touch the same
  file, the bridge surface, a migration, or other sensitive boundaries?
- When a task fails (test, typecheck, lint, scope creep, forbidden-file touch,
  unexpected migration need), **where does the failure get routed**, and who
  decides whether to fix-in-place or stop and escalate?
- What does a **clean closeout look like** so the next person picking up the
  feature can read one file and know "where are we?"

Maestro does **not** invent new requirements, new task IDs, or new gates. It
reads what Spec Kit produced and orchestrates execution against it.

## What Maestro is NOT

- **Not a planning tool.** Planning happens in `/speckit-specify`,
  `/speckit-clarify`, `/speckit-plan`, and `/speckit-tasks`. Maestro reads the
  result; it does not author the spec.
- **Not a constitution-replacement.** The constitution
  (`.specify/memory/constitution.md`, currently v1.6.0) is the highest-priority
  document. Maestro principles MUST defer to Constitution principles I–IX and
  cross-feature P1–P18 in every conflict. Where Maestro and the constitution
  disagree, the constitution wins.
- **Not a CI rule.** Maestro guidance shapes how an agent (or a small team of
  agents) executes against an approved spec; it does not change the CI gates
  (typecheck, lint, vitest, package dry-run) defined in CLAUDE.md.
- **Not a new gate.** §A0 … §A5 remain the only gates. Maestro tracks them but
  does not add or subtract.
- **Not authority to start a feature.** A `coordination.md` row of "⛔ Held"
  remains held under Maestro. The point of Maestro is to ship cleanly inside
  whatever gate the current feature has opened — never around it.

## Source-of-truth order

When two documents disagree, the higher-listed wins:

1. **`.specify/memory/constitution.md`** — the constitution
   (currently v1.6.0). Highest priority. Principles I–IX are NON-NEGOTIABLE;
   P1–P18 are MUST/SHOULD with the Exception Procedure for waiver.
2. **`CLAUDE.md`** (project root) — locked technical decisions, hard rules
   always in force, the `useful commands` block.
3. **Active spec/plan/tasks/coordination** under
   `specs/<NNN>-<feature>/` — `spec.md` is the requirements
   source-of-truth (Constitution P12); `plan.md` carries architectural
   decisions; `tasks.md` is the executable list; `coordination.md` is the
   live gate ledger and phase status.
4. **`PRODUCT.md`** + **`DESIGN.md`** + **`.impeccable/design.json`** —
   product personality, design principles, and the design-token reference for
   any UI work. These do **not** authorise behaviour that the active
   spec/plan does not already permit (Constitution P12 forbids treating
   designs as requirements).
5. **GitHub PRs and issues** — operational state: what has merged, what is
   open, what is blocked on review. PR descriptions cite `tasks.md` task IDs
   (Constitution P13).

If a `tasks.md` row and a Figma frame disagree, the row wins. If `CLAUDE.md`
and a spec disagree on a stack decision, `CLAUDE.md` wins. If the constitution
and `CLAUDE.md` disagree, the constitution wins.

## File map of this proposal

| File | Purpose |
|:--|:--|
| [`README.md`](./README.md) | This file. What Maestro is, what it isn't, source-of-truth order. |
| [`workflow.md`](./workflow.md) | The standard 13-step Maestro workflow from repo verification to closeout. |
| [`agent-roles.md`](./agent-roles.md) | Nine agent roles and when NOT to use multiple agents. |
| [`task-marking.md`](./task-marking.md) | Maestro marks (`ready`, `blocked`, `parallel-safe`, etc.) and how they layer on top of `tasks.md` `[P]` markers. |
| [`graph-rules.md`](./graph-rules.md) | Dependency graph, parallel-safe graph, file-conflict graph — how to extract each, how to downgrade `[P]` on same-file risk. |
| [`error-routing.md`](./error-routing.md) | Decision tree for routing each failure class (test, lint, scope, forbidden file, conflict, a11y, surprise migration). |
| [`report-schema.md`](./report-schema.md) | Schema for the final closeout report (what changed, validation results, what's next). |
| [`goal-templates.md`](./goal-templates.md) | Five reusable `/goal` templates: preflight, implementation, validation/fix, PR review, closeout. |
| [`quick-prompts.md`](./quick-prompts.md) | Short copy-paste prompts for five common Maestro operations (preflight, execute, schedule group, closeout, PR review). |
| [`slice-schema.yaml`](./slice-schema.yaml) | Generic YAML schema for one Maestro execution slice. |
| [`templates/execution-map.yaml`](./templates/execution-map.yaml) | Per-spec execution map template: dependency graph, parallel-safe groups, findings, merged/blocked slice metadata. |
| [`templates/wave-status.md`](./templates/wave-status.md) | Human-readable per-spec/per-wave status template: merged, blocked, ready, groups, validation posture, next action. |
| [`templates/post-merge-closeout-prompt.md`](./templates/post-merge-closeout-prompt.md) | Reusable agent prompt for closing out a merged slice. |

## Spec Kit, in one paragraph (for new readers)

Spec Kit is the repo's planning pipeline. `/speckit-specify` produces
`spec.md` (functional + non-functional requirements, edge cases, user
stories). `/speckit-clarify` resolves `[NEEDS CLARIFICATION]` markers.
`/speckit-plan` produces `plan.md` (architectural decisions, technical
context) plus `research.md`, `data-model.md`, `contracts/`, and
`quickstart.md`. `/speckit-tasks` produces the executable `tasks.md` with
`T###` IDs, `[P]` parallel markers, and TDD test-task-before-impl-task
pairing per Constitution VI. `/speckit-analyze` is a cross-artifact
consistency check (suffix infill `T###a` is added rather than renumbering).
`/speckit-implement` is reserved for the executor; in practice it is the
slice-by-slice PR sequence each feature ships through.

Examples seen in this repo:

- **004-operator-session** — six slices (S0 visual direction → S6); five
  approval gates (§A1 constitutional clarification, §A2 backend OpenAPI,
  §A3 migrations, §A4 Argon2 binding, §A5 production readiness). S1–S5
  shipped; S6 holds on prior slices.
- **005-sales-cart** — six slices (S0 visual direction → S5 sign-off);
  five gates (§A0 upstream readiness, §A1 catalogue stub deferred, §A2
  migrations, §A3 audit categories, §A4 envelope contract, §A5 rollout).
  S1–S5 shipped 2026-05-17 … 2026-05-19; T100 functional sign-off
  recorded.
- **006-payments-tender** — DRAFT; §A0 functionally cleared (2026-05-19);
  §A1 visual direction signed off 2026-05-20; §A2/§A3/§A4 held; tasks
  authored, all rows BLOCKED until per-slice gates open. (Slice 1 of 006
  has now opened — payments tender selection + envelope ingest — and
  shipped under the post-§A1 boundary.)
- **007-pos-visual-system** — six slices (S0 → S6); S1+S2+S3 merged
  (gates the 005/006 UI work); S4–S6 in-flight.

## When to use Maestro vs. plain Spec Kit

Use Maestro when you're about to **execute** against an approved spec — that
is, when `coordination.md` shows the slice gates you need are open and you
have one or more `tasks.md` rows that are ready to start. Maestro's job is to
turn "the slice is open" into "task T020 starts now, T021/T022 run in
parallel, T031 waits on T020, and validation runs before the PR opens."

Use plain Spec Kit (no Maestro) when you're still in
specify/clarify/plan/tasks/analyse — those commands have their own
discipline and don't need a coordinator on top of them.

## Status of this proposal

**This is documentation only.** Adopting Maestro requires no code changes,
no constitution amendment, no `tasks.md` change. It is a description of a
practice the team can opt into, gradually, slice by slice. If the team
later wants to formalise it (e.g. require closeout reports per slice in
PR descriptions), that would be a separate `/speckit-specify` cycle for a
process feature, not a casual edit.

## Hybrid execution ledger templates

The `slice-schema.yaml`, `templates/execution-map.yaml`, `templates/wave-status.md`,
and `templates/post-merge-closeout-prompt.md` files are **optional per-spec
execution-state helpers**. `quick-prompts.md` provides copy-paste entry points for
the five most common Maestro operations.

Key constraints that always apply to these templates:

- **They do not replace Spec Kit, `tasks.md`, or `coordination.md`.** The constitution,
  `coordination.md`, and `tasks.md` remain the source-of-truth for gates, requirements,
  and the executable task list. The templates track execution-state metadata only.
- **They are templates, not active artefacts**, unless an approved process task copies
  them into a specific spec folder (e.g. `specs/006-payments-tender/maestro/`).
  Do not treat a template copy as authoritative until it is filled in for that run.
- **They help track parallel waves, findings, and closeout status** across a spec's
  slices — particularly useful when multiple slices are in-flight or when a finding
  pivots execution scope mid-wave.
- **They carry no authority to start a slice.** A `coordination.md` gate that is
  ⛔ Held remains held regardless of what any template file says.

Quick reference: `docs/maestro/quick-prompts.md` provides the five short prompts
most frequently needed when working with these templates.

## Suggested next step before any implementation

1. **Read in order:** `README.md` → `workflow.md` → `agent-roles.md` →
   `task-marking.md` → `graph-rules.md` → `error-routing.md` →
   `report-schema.md` → `goal-templates.md`.
2. **Try Maestro on one open slice** without changing how Spec Kit produces
   artefacts. The next candidate is 006 Slice 2 (cash payment), which has
   §A1 cleared and §A3/§A4 still held — i.e. plenty of preflight work but
   no implementation surface to touch yet, making it a low-risk dry run of
   the preflight / task-extraction / graph-extraction steps.
3. **Capture what worked and what didn't** in a short retrospective
   appended to this README, before formalising. Maestro is itself
   evidence-driven: if a marking or routing rule produces friction in
   practice, the proposal is to edit the doc, not the workflow.
