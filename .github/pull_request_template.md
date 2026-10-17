<!--
T072 — Pull request template.

This is the body shape every PR should fill in. Mirrors the structure
used in PRs #6–#10. Sections are not optional unless explicitly marked.
Delete this comment block when filling in a real PR.
-->

## Summary

<!-- 1–2 sentences. What changed and why. -->

## Completed tasks

<!-- Bullet list with task IDs from specs/<feature>/tasks.md, e.g. T070, T071. -->

- [ ] **T0XX** description — `path/to/file`

## Changed files

**New:**

- `path/to/new/file` — one-line purpose

**Modified:**

- `path/to/modified/file` — one-line purpose

## Checks run

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm run codegen:verify` — exit 0
- `npm test -- --coverage` — N/N pass; coverage report
- `npm run package:dir` — note local result, or "deferred to CI" with rationale

## Manual smoke

<!--
Recipe a reviewer can copy-paste. Mark explicitly whether the smoke was
PERFORMED in this session or DOCUMENTED for reviewer follow-up. Examples
of the latter posture: T041 (DB), T049 (SecretStore), T063 (logging),
T069 (Sentry).
-->

## Constitution check

<!--
Cite the relevant principles from `.specify/memory/constitution.md` and
explain in one line each how this PR upholds them.
-->

- **<Principle>** — <one-line justification>

## CodeRabbit review

<!--
CodeRabbit's plan allows about one review per hour and `.coderabbit.yaml` turns off
incremental review (RT-590), so pushes do not re-trigger it. Add the label
`skip-coderabbit` to opt a trivial PR out. For a High-tier PR, post the single
comment "@coderabbitai review" (as a PR comment, not in this description) on the
final head.
-->

- [ ] **High-tier PR (RT-582 tiers):** one manual CodeRabbit review requested on the final head, after the last push.

## Active spec

Refs [specs/001-foundation/spec.md](../specs/001-foundation/spec.md). Update this link when feature 002 lands.

## Not in this PR

<!--
Explicit list of out-of-scope items relevant to the change. Forces
reviewers to confirm scope boundaries.
-->
