<!--
SYNC IMPACT REPORT
==================
Version change: 1.5.1 → 1.6.0
Bump rationale: MINOR — a Tech Stack substitution within an existing category (update feed
  host → provider-neutral origin; installer kind named) plus materially changed guidance in
  Additional Constraints (update-origin binding, TLS pinning scope, signature verification
  rule, update identity freeze). No Roman-numeral Core Principle or P1–P18 principle is
  added, removed or redefined.

  Why this update is needed:
  - Jira RT-234 (owner-confirmed 2026-10-09) decided the POS delivery/update architecture:
    signed per-user NSIS + electron-updater `generic` provider against a configurable,
    provider-neutral HTTPS origin; roll-forward only; staged lab → canary → cohort → GA.
    It is recorded in Orchestrator ADR-0006 and the POS design spec
    `docs/superpowers/specs/2026-10-09-rt-234-pos-delivery-update-design.md`.
  - The v1.5.1 text fixed the feed at `https://pos.smartdatapulse.tech/updates/`, named
    `stable` / `beta` channels, and REQUIRED TLS certificate pinning for the feed. Those
    conflict with RT-234 D8 (provider-neutral delivery). RT-319 makes this amendment a
    precondition for the updater implementation (RT-322), so the constitution and the
    ADR do not disagree.

  Modified sections:
  - Mission → platform surfaces table: `pos.smartdatapulse.tech` no longer carries the
    auto-update feed.
  - Additional Constraints → Platform Integration: the "Auto-update feed" row becomes
    "Update origin" (configured HTTPS origin, provider-neutral; channels `lab` / `canary` /
    `stable`). The TLS bullet keeps TLS mandatory for every outbound call and pinning
    RECOMMENDED for the API, and states that pinning is NOT required for the update origin.
  - Additional Constraints → Security: the code-signature bullet is made explicit (pinned
    publisher, RFC 3161 timestamp, sha512, fail closed and surfaced, no lower-version install).
  - Additional Constraints → Tech Stack: "Build & ship" names per-user NSIS and the
    `generic` provider against the configured origin; a new "Update identity" bullet freezes
    `appId`, `productName` and the package `name`.
  - All other sections → unchanged.

  Added sections: none. Removed sections: none.
  Modified principles: none.

  Templates requiring updates:
  - ✅ `.specify/templates/plan-template.md` — no changes required.
  - ✅ `.specify/templates/spec-template.md` — no changes required.
  - ✅ `.specify/templates/tasks-template.md` — no changes required.
  - ✅ `README.md` repository map — `.specify` row updated to constitution v1.6.0.
  - ✅ `CLAUDE.md` authoritative-documents table — version reference updated to v1.6.0
    (it previously still cited v1.3.0).

  Follow-up TODOs (open):
  - ⏳ UPDATER_IMPLEMENTATION — no updater or installer exists on `main` yet. The rules
    added here bind RT-321 (signed per-user NSIS + release workflow) and RT-322
    (UpdateService + SafePointGate); RT-320 adds the SchemaAheadGuard that ADR-0006
    rule 2 relies on. Verification: RT-324.
  - ⏳ FLEET_VERSION_CONTRACT — server-side minimum-supported version, fleet version
    reporting and the runtime compatibility signal are a gated Backend-Core contract
    (RT-323). Not constitution scope until that contract exists.

  Resolved TODOs (this revision):
  - ✅ The v1.1.x consequence-ledger item "Auto-update (`electron-updater`) … feed at
    `https://pos.smartdatapulse.tech/updates/`" is superseded by the provider-neutral
    origin rule. The ledger entry is retained below as history.

  Compatibility ledger:
  - No shipped code changes. `ELECTRON_UPDATE_FEED_URL` keeps its name as the
    configuration key for the update origin.
  - The update identity freeze matches the current `electron-builder.yml` and
    `package.json` exactly; nothing is renamed.
  - Prior feature plans pin earlier constitution versions and make no update-feed
    assertions that conflict with this revision.

History (prior revisions retained for reference):

Version change: 1.5.0 → 1.5.1
Bump rationale: PATCH — non-redefining clarification of an existing principle.
  Principle VIII ("Terminal Identity is Independent of User Identity (NON-NEGOTIABLE)")
  gains a single sub-clause under its existing "Human identity (Clerk OIDC)" bullet that
  formalises the distinction between a *custom user database* (which Principle VIII
  prohibits) and a *local terminal unlock factor* (which Principle VIII does not address
  by current wording). The sub-clause is additive: no existing sentence in Principle VIII
  is modified, no other principle is touched, no Roman-numeral or P1–P18 set entry is
  redefined, no Tech Stack or Hardware Matrix or Domain section changes.

  Why this update is needed:
  - Feature 004-operator-session adopts a hybrid identity model (plan AD-2): manager and
    admin authentication is fully Clerk/password-backed; cashier authentication is also
    anchored to a Clerk-backed identity, but the *unlock* of that identity at a paired
    terminal happens via a local 4–6 digit PIN (per spec FR-006). The local PIN is not an
    identity provider; it is a local-device unlock affordance over an already-Clerk-anchored
    identity. The 004 plan asserts this is not a "custom user database" within the meaning
    of Principle VIII — but the constitution does not yet make the distinction explicit.
  - The 004 planning artifacts gate downstream implementation work (Slices S3–S6, the
    `cashier_pin_records` migration, the Argon2id binding install, the cashier-PIN bridge
    surface) on Approval Gate §A1 — a constitutional clarification of Principle VIII.
    This amendment is the artifact that clears §A1 once merged.
  - Without this clause, future readers of Principle VIII could plausibly interpret the
    cashier PIN store as a Principle-VIII violation and reject the entire 004
    implementation slice. The clause closes that ambiguity at the constitution layer
    rather than relying on per-feature plan-level interpretation.

  Section additions / expansions:
  - **EXPANDED** Principle VIII → "Human identity (Clerk OIDC)" sub-bullet — adds a single
    clarification clause naming the conditions under which a *local terminal unlock
    factor* (e.g., a per-terminal hashed PIN keyed by the Clerk user ID) is **not** a
    custom user database. The clause defines six binding rules; a local unlock factor that
    violates any rule falls back into the "custom user databases are PROHIBITED" rule,
    which remains in force verbatim.

  Modified principles: none redefined.
  - Principle VIII — sub-bullet under "Human identity (Clerk OIDC)" extended with the
    local-unlock-factor clarification clause; existing "Clerk is the sole IdP for humans;
    custom user databases are PROHIBITED" sentence unchanged; existing Terminal-identity
    sub-bullet, audit-anchor sub-bullet, and Rationale unchanged.

  Modified sections:
  - Core Principles → Principle VIII — clause added; everything else verbatim.
  - All other sections (Mission, Principles I–VII and IX, Cross-Feature POS Principles
    P1–P18, Additional Constraints, Development Workflow & Quality Gates, Governance,
    Active-Feature Compatibility Note) → unchanged.

  Added sections: none (existing principle sub-bullet expanded).
  Removed sections: none.

  Templates requiring updates:
  - ✅ `.specify/templates/plan-template.md` — no changes required (Constitution Check
    table tracks principles by name; no principle was added or removed).
  - ✅ `.specify/templates/spec-template.md` — no changes required.
  - ✅ `.specify/templates/tasks-template.md` — no changes required.

  Follow-up TODOs (open):
  - ⏳ FOUR_FOUR_PLAN_CONSTITUTION_CHECK_UPDATE — after this amendment merges, update
    `specs/004-operator-session/plan.md` Constitution Check Principle VIII row from
    "PASS-with-clarification-gate" → "PASS" (no clarification gate remaining); update
    `specs/004-operator-session/coordination.md` §A1 row from "⏳ Resolution pending" →
    "✅ Cleared" with the merge SHA. Owner: 004 feature owner (Ahmed). Small follow-up;
    not part of this amendment PR.

  Resolved TODOs (this revision):
  - ✅ LOCAL_UNLOCK_FACTOR_CLARIFICATION — Principle VIII clarified to permit local
    terminal unlock factors that satisfy the six rules in the new sub-clause; closes
    Approval Gate §A1 from `specs/004-operator-session/plan.md` and
    `specs/004-operator-session/coordination.md` once this revision merges.

  Compatibility ledger:
  - Principle VIII's "Clerk is the sole IdP for humans; custom user databases are
    PROHIBITED" rule is preserved verbatim. Every cashier, manager, and admin remains a
    Clerk user. The clause clarifies what *isn't* covered by "custom user database" — it
    does not weaken the prohibition itself.
  - Forward compatibility: the clause is written generically ("local unlock factors"),
    not specifically PINs. Future features that introduce a biometric, smart-card, or
    hardware-token factor for local unlock can adopt the same six rules without further
    amendment, provided they too leave identity in Clerk.
  - Prior feature plans (001 v1.0+, 002 v1.2+, 003 v1.3.0, 004 v1.5.0) make no assertions
    that conflict with this clause. 003's plan pins v1.3.0 and is unaffected; 004's plan
    pins v1.5.0 and references this clarification as the §A1 gate.

Version change: 1.4.0 → 1.5.0
Bump rationale: MINOR — introduces a new section ("Cross-Feature POS Principles", P1–P18),
  expands the Governance section with four new subsections (Spec Compliance, ADRs &
  Constitutional Principles, Implementation PR Review — Constitution Check, Exception
  Procedure), and adds a time-boxed Active-Feature Compatibility Note for 003-pos-ui-shell.
  No existing principle is added to, removed from, or backward-incompatibly redefined in the
  Roman-numeral Core Principles set (I–IX); no Tech Stack lock changes; no Hardware Matrix
  changes; no Pharmacy Domain changes. The 18 cross-feature principles are stable POS-Pulse
  invariants that cut across features and are intentionally distinct from the stack-specific
  rules in I–IX.

  Why this update is needed:
  - The repository now has three features in flight or completed (001 ✅, 002 ✅, 003
    in-flight — planning merged, Slice 1 + US3 + US4 + US6 merged, Final polish /
    validation / handoff remaining), and several future POS domains (payments, fiscal
    integration, offline-sync
    write-path, operator/session/auth, receipt printing, auto-update wiring) are visible in
    the constitution's Tech Stack and Platform Integration sections but lack stable,
    cross-feature governance rules. Each domain has a tendency to creep into the feature
    that is currently in motion; the cross-feature principles below codify the invariants
    that prevent that drift.
  - The principle set in v1.4.0 is stack-flavoured (Electron sandboxing, TypeScript strict,
    Vitest coverage, etc.) and stays valid. The new principles operate at a different layer:
    *what the product owes its operators and customers*, regardless of stack. The two layers
    coexist; an implementation PR's Constitution Check must walk both.

  Section additions / expansions:
  - **NEW** "Cross-Feature POS Principles" section (P1–P18) — eighteen normative MUST /
    MUST NOT / SHOULD principles with rationale and enforcement guidance.
  - **EXPANDED** Governance section — four new subsections covering how new specs comply,
    how ADRs relate to constitutional principles, how implementation PR reviews check
    compliance, and how exceptions to the constitution are proposed and approved (separate
    from the existing Amendment Procedure).
  - **NEW** "Active Feature Compatibility Note — 003-pos-ui-shell" appendix — short,
    time-boxed marker that codifies what 003 may visually reserve, what it MUST NOT
    implement, and the visual-only status of the connection-state visuals introduced by
    P1–P18 / Principle I. The note sunsets when 003 ships and the feature index advances.

  Modified principles: none redefined. The existing nine Core Principles (I–IX) are
    unchanged in wording. The new P1–P18 set is additive and complementary, not a
    replacement.

  Modified sections:
  - Core Principles → unchanged.
  - **NEW** Cross-Feature POS Principles → P1–P18.
  - Additional Constraints → unchanged.
  - Development Workflow & Quality Gates → unchanged.
  - Governance → expanded with four new subsections (Spec Compliance, ADRs &
    Constitutional Principles, Implementation PR Review — Constitution Check, Exception
    Procedure). The existing Authority, Amendment Procedure, Versioning Policy, and
    Compliance Review subsections are unchanged in normative content.
  - **NEW** Active Feature Compatibility Note — 003-pos-ui-shell.

  Added sections: "Cross-Feature POS Principles", four Governance subsections, and the 003
    compatibility note (see above). No sections removed.

  Templates requiring updates:
  - ⚠ `.specify/templates/plan-template.md` — the Constitution Check table currently lists
    only the I–IX principles plus the Additional-Constraints rows. A follow-up PR SHOULD
    extend the table with the P1–P18 rows so each plan walks both sets explicitly. This is
    a template-only change and is NOT performed in this PR (which is constitution-only).
  - ✅ `.specify/templates/spec-template.md` — no template changes required; spec-level
    compliance is enforced by P12 and the new "Spec Compliance" governance subsection.
  - ✅ `.specify/templates/tasks-template.md` — no template changes required.

  Follow-up TODOs (open):
  - ⏳ TEMPLATE_PLAN_P1_P18 — extend `plan-template.md` Constitution Check table with the
    P1–P18 rows. Owner: next planning-artifact author or a small follow-up doc PR.

  Resolved TODOs (this revision):
  - ✅ CROSS_FEATURE_PRINCIPLES — eighteen cross-feature POS principles codified.
  - ✅ GOVERNANCE_EXCEPTION_PROCEDURE — separated from Amendment Procedure.
  - ✅ 003_COMPATIBILITY_NOTE — added as a sunsetting appendix.

  Intentional non-additions (principles considered but NOT added in this revision, with
    one-line rationale):
  - "No flaky tests" — already covered by Principle VI (Test-First, Coverage-Gated) plus
    the Development Workflow CI gates; a separate principle would be redundant.
  - "Reproducible builds" — the constitution's Tech Stack lock + lockfile commitments
    already imply this; a dedicated principle adds ceremony without enforcement.
  - "Rate limiting / abuse prevention" — a backend concern; POS-Pulse honours the
    backend's typed failure modes (RATE_LIMITED is in the pairing contract). No
    cross-feature principle added; specs that introduce new client-driven write paths
    should address rate-limit handling at the plan level under P5 (idempotency).
  - "Mandatory dark mode" / "Mandatory localisation parity" — accessibility and
    localisation are covered by P14 + the Localization Additional-Constraint section.
    Specific UX commitments belong in feature specs, not the constitution.

  Conflicts with existing planning artifacts:
  - 002-terminal-pairing — none. The 18 principles are consistent with 002's plan and
    tasks (operator accountability deferred to login feature; idempotency present in
    pairing-code semantics; redaction enforced).
  - 003-pos-ui-shell — none in spec, none in plan, none in `tasks.md`, and none in the
    MVP slices already merged to `main` (Slice 1 foundation, US3 placeholder states, US4
    connection states, US6 checkout reservation). The compatibility appendix codifies
    what 003 already commits to (UI-only, visual-only syncing state, no business logic,
    no IPC/main/preload/Sentry/CI changes). It does NOT widen 003's scope; it tightens
    the boundary 003 already drew. **003 planning does not require edits as a result
    of this amendment**; the only remaining 003 work is the Final polish / validation
    / handoff slice, which SHOULD be re-checked against P1–P18 before it is started.
    No re-plan is required unless that re-check finds a real violation.

  003-pos-ui-shell impact summary:
  - Compatibility note declares 003 a visual-shell feature; it MUST NOT implement
    sales/cart business logic, payments, receipts, fiscal integration, inventory mutation,
    offline-sync write paths, cashier login/session/auth, backend calls, IPC/preload/main
    changes, database migrations, OpenAPI changes, or Sentry changes.
  - Connection-state visuals (`syncing`, `offline`, `degraded`) introduced by 003 are
    visual-only unless a separate, already-approved source-of-truth backs them.
  - 003 MAY reserve visual space for future POS domains (cart, sales, checkout-payments,
    inventory, settings, dashboard) — exactly as its plan and spec already commit.
  - **No re-specification, no re-clarification, no re-planning is required by this
    amendment** for 003. `/speckit-tasks` for 003 has already completed and four
    implementation slices (Slice 1 foundation, US3 placeholder states, US4 connection
    states, US6 checkout reservation) are merged to `main`. The only remaining 003 work
    is Final polish / validation / handoff, which the team SHOULD re-check against the
    new P1–P18 rows before starting; a re-plan is required only if that re-check finds
    a real violation.

History (prior revisions retained for reference):

Version change: 1.3.0 → 1.4.0
Bump rationale: MINOR — three substitutions and two materially-expanded subsections that reflect
  decisions already locked in features 002-terminal-pairing and 003-pos-ui-shell, plus housekeeping
  on the templates ledger now that the three Spec Kit templates exist on disk. No principle is
  added, removed, or backward-incompatibly redefined.

  - Runtime baseline: Electron pin tightened from `33+` to `40+`. The repository has been on
    Electron 40 since feature 001 (`package.json` declares `electron ^40.9.3`; foundation
    `tasks.md` notes the 33→40 bump). Plans 002 and 003 already pin to v1.3.0 *and* call out
    Electron `^40.9` in their Technical Context. The constitution lagged the reality and the
    plans; this amendment closes that gap.
  - Renderer UI library policy: `Radix UI primitives` and `lucide-react icons` are removed from
    the Tech Stack and replaced by the **first-party UI primitives module** at
    `src/renderer/ui/` (primitives, tokens, states), which feature 003's research §4 locked in
    explicitly (rejecting shadcn/ui, Radix, MUI, Mantine, and Headless UI by name). Neither
    Radix nor lucide-react has ever been in `package.json`; the constitution's prior wording
    was aspirational. The substitution lands inside the existing "Renderer" Tech Stack
    category. (Resolved drift: UI_LIBRARY.)
  - Testing line expanded: the Vitest stack as-shipped includes `happy-dom`,
    `@testing-library/react` + `@testing-library/jest-dom` + `@testing-library/user-event`, and
    `axe-core` (consumed via a first-party `expectNoAxeViolations` Vitest helper, per 003
    research §5). The constitution previously named only Vitest and Playwright. The expansion
    is descriptive — it documents the test toolchain that is already running in CI.
  - Connection-state model: Principle I's "Offline" indicator is generalised to a four-state
    visual indicator — `online`, `degraded`, `offline`, `syncing` — locked by 003 spec
    Clarifications §3 and FR-7 / FR-16. `syncing` is reserved as a *visual-only* state today;
    real offline-sync behaviour remains the subject of a future feature. The non-blocking,
    non-modal property is unchanged.
  - Touch-target floor: a minimum of 44 × 44 CSS pixels is added to the Hardware section's
    operational rules, mirroring 003 NFR-5 / FR-19. The constitution previously left the
    touch-target floor unspecified.

Modified principles: none redefined.
  - Principle I ("Offline-First, NON-NEGOTIABLE") — connection-state indicator now names four
    visual states; offline-first guarantee unchanged.

Modified sections:
  - Core Principles → Principle I — connection-state indicator clause amended.
  - Additional Constraints → Hardware (MVP Matrix) → Operational rules — touch-target floor
    added.
  - Additional Constraints → Tech Stack → Runtime — Electron `33+` → `40+`.
  - Additional Constraints → Tech Stack → Renderer — Radix UI / lucide-react removed; first-party
    UI primitives module noted; Tailwind 4 clarified as CSS-first.
  - Additional Constraints → Tech Stack → new "UI primitives" line — names
    `src/renderer/ui/` as the canonical primitives module; external UI libraries require an
    amendment.
  - Additional Constraints → Tech Stack → Testing — `happy-dom`, `@testing-library/react`,
    and `axe-core` named alongside Vitest.

Added sections: none (existing sections expanded).
Removed sections: none.

Templates requiring updates:
  - ✅ `.specify/templates/plan-template.md` — scaffolded in repo; no amendment-driven changes
    needed (Constitution Check table tracks principles by name, none were added/removed).
  - ✅ `.specify/templates/spec-template.md` — scaffolded in repo; no changes needed.
  - ✅ `.specify/templates/tasks-template.md` — scaffolded in repo; no changes needed.

Follow-up TODOs (open): (none).

Resolved TODOs (this revision):
  - ✅ UI_LIBRARY — Radix / lucide-react removed; first-party `src/renderer/ui/` primitives
    module is the canonical UI surface.
  - ✅ ELECTRON_PIN — pinned to `40+` to match `package.json` and feature plans.
  - ✅ TEMPLATES_SCAFFOLDED — three Spec Kit templates exist; ledger updated.

Consequence ledger (drift NOT closed by this revision, deliberately):

  - Auth (Clerk OIDC) — Principle VIII names Clerk as the IdP. `@clerk/*` is not yet a
    `package.json` dependency; the foundation slice (001) and the pairing slice (002) ship the
    *terminal* identity half of the hybrid model only. Clerk integration is planned for a later
    feature; the constitutional rule stands and will be honoured when human-auth lands.
  - Auto-update (`electron-updater`) — Tech Stack and Platform Integration name the auto-update
    feed at `https://pos.smartdatapulse.tech/updates/`. `electron-updater` is not yet a
    dependency; auto-update wiring is deferred to a packaging-and-distribution feature.
  - Direct-path printing (`node-thermal-printer` or equivalent) — Tech Stack names a printer
    adapter; no printer library is installed yet because no feature has needed receipt
    printing. Hardware caveat: the constitution still requires receipt-template engines to emit
    both an ESC/POS byte stream and a printable HTML/canvas fallback when the receipt-printing
    feature lands.

  These three are *future-state* commitments that the constitution forecasts. They are NOT
  drift in the sense of "constitution diverges from the reality the team has agreed to build";
  they are deliberate not-yet-built capabilities. Listing them here keeps the ledger honest and
  makes the next plan's Constitution Check easier to write.

History (prior revisions retained for reference):

Version change: 1.2.1 → 1.3.0
Bump rationale: MINOR — two stack substitutions within categories already named in §Tech Stack.
  No principle is redefined; both substitutions land inside rules that already exist.

  - Testing tool: Jest is removed. Vitest is now the single test runner for both renderer and
    main-process code; Playwright remains optional for E2E. Reason: Vitest covers main-process
    modules via the same toolchain that already covers the renderer, eliminating a redundant
    test-runner installation, configuration, and CI lane. Substitution lands in feature
    001-foundation as the inaugural usage. (Resolved TODO: TEST_RUNNER.)
  - Secret storage: `electron-store` is replaced by Electron's built-in `safeStorage`. On
    Windows, `safeStorage` is backed by DPAPI keyed to the current Windows user account;
    encrypted blobs cannot be decrypted on a different machine or under a different Windows
    account, which is at least as strong as the prior "electron-store + hardware-derived key"
    recipe and removes a third-party dependency plus all custom key-derivation code from the
    audit surface. Production builds MUST refuse to start if
    `safeStorage.isEncryptionAvailable()` returns false. (Resolved TODO: SECRET_STORE.)

Modified principles: none redefined.
  - Principle VI ("Test-First, Coverage-Gated") — testing-tool list updated; rules unchanged.
  - Principle VIII ("Terminal Identity") — secret-storage mechanism updated; rules unchanged.

Modified sections:
  - Core Principles → Principle VI — `Jest (electron main)` removed; Vitest covers both
    processes.
  - Core Principles → Principle VIII — pairing/storage clause now names `safeStorage` instead
    of `electron-store`; the "credential not portable across machines" property is preserved
    (and tightened — DPAPI also fails on a different Windows user account on the same machine).
  - Additional Constraints → Platform Integration → Storage and revocation — same substitution;
    added explicit production-startup guard against
    `safeStorage.isEncryptionAvailable() === false`.
  - Additional Constraints → Security — same substitution; explicit cross-platform note (DPAPI
    on Windows, Keychain on macOS, libsecret on Linux).
  - Additional Constraints → Tech Stack → Testing — Jest removed.
  - Additional Constraints → Tech Stack → new "Secret storage" line — names `safeStorage` as
    the canonical secret store; third-party stores not permitted.
  - Development Workflow → Pre-Push Checklist — `npm run test:electron` removed; `npm test`
    (Vitest) is the single test command for both processes.
  - Development Workflow → CI Gates — Jest removed from the required-tests bullet.

Added sections: none.
Removed sections: none.

Templates requiring updates:
  - ⚠ pending  .specify/templates/plan-template.md       (not yet scaffolded)
  - ⚠ pending  .specify/templates/spec-template.md       (not yet scaffolded)
  - ⚠ pending  .specify/templates/tasks-template.md      (not yet scaffolded)

Follow-up TODOs (open): (none).

Resolved TODOs (this revision):
  - ✅ TEST_RUNNER — Vitest-only; `npm run test:electron` retired.
  - ✅ SECRET_STORE — Electron `safeStorage` adopted; `electron-store` removed.

History (prior revisions retained for reference):

Version change: 1.2.0 → 1.2.1
Bump rationale: PATCH — non-semantic clarifications. Two wording fixes, no principle added,
  removed, or redefined.

  - Principle II ("Financial Precision") wording corrected: the prior text prohibited *all*
    JavaScript `number` arithmetic on currency values, which conflated "no floats" with "no
    `number`." The intent — and the practice every implementation in the repo follows — is
    "no floating-point arithmetic." Restated: integer minor units represented as JS `number`
    under a `Number.isSafeInteger` guard are the canonical representation. (Resolved /speckit-
    analyze finding C2 against feature 001-foundation.)
  - Tech Stack: generated API types path corrected from `src/api/types.ts` to
    `src/shared/api-types.ts`, matching the project layout decided in the Foundation plan
    (the shared module sits next to other shared utilities; the prior `src/api/` path was
    a stale draft note). (Resolved /speckit-analyze finding C1.)

Version change: 1.1.0 → 1.2.0
Bump rationale: MINOR — materially expanded two existing sections (Hardware, Platform Integration →
  Auth/Pairing), introduced the new organizational concept of "branch" as a token scope, and pinned
  the MVP hardware matrix. No principle added, removed, or backward-incompatibly redefined.

  - HARDWARE matrix locked for MVP: Windows desktop/laptop only; keyboard-wedge barcode scanners;
    receipt printing via local print adapter (ESC/POS preferred where available); cash drawer
    optional via printer kick command. Mobile/tablet, label printers, scales, customer displays,
    and direct card-terminal integrations are explicitly OUT of scope for MVP.
  - PAIRING flow expanded: device token is scoped to **tenant + branch + terminal**; the POS
    pairing screen accepts a manual code OR a QR scan generated by the platform admin app.
  - "Branch" is now a first-class organizational concept (between tenant and terminal); reflected
    in Domain and Platform Integration.

Modified principles: none (Principle IV "Hardware Failures Are Loud" wording unchanged; the
  hardware-matrix subsection beneath it absorbs the MVP scope).

Modified sections:
  - Additional Constraints → Hardware — replaces stub with the MVP hardware matrix and out-of-scope
    list.
  - Additional Constraints → Platform Integration → Auth — pairing UX (code or QR), token scope
    (tenant + branch + terminal), and POS-side pairing screen specified.
  - Additional Constraints → Domain → adds "branch" as a canonical organizational unit.
  - Additional Constraints → Tech Stack → printer adapter language updated to match MVP scope.
  - Follow-up TODOs — both HARDWARE_MATRIX and PAIRING_UX resolved.

Added sections: none (existing sections expanded).
Removed sections: none.

Templates requiring updates:
  - ⚠ pending  .specify/templates/plan-template.md       (not yet scaffolded — create on first /speckit-plan)
  - ⚠ pending  .specify/templates/spec-template.md       (not yet scaffolded — create on first /speckit-specify)
  - ⚠ pending  .specify/templates/tasks-template.md      (not yet scaffolded — create on first /speckit-tasks)
  - ⚠ pending  .specify/templates/constitution-template.md (this file is the source; template can be derived later)

Follow-up TODOs (open):
  - (none) — all initial-bootstrap TODOs are resolved as of this revision.

Resolved TODOs (this revision):
  - ✅ HARDWARE_MATRIX — MVP scope locked. See Additional Constraints → Hardware.
  - ✅ PAIRING_UX — POS-side pairing screen + token scoping spec. See Platform Integration → Auth.
  - ✅ STACK_FREEZE — Tech Stack subsection re-titled "Frozen for MVP"; further changes require an
    amendment.

Resolved TODOs (prior revisions):
  - ✅ BACKEND_CONTRACT (v1.0.1) — pinned to https://api.smartdatapulse.tech.
  - ✅ AUTH_SCHEME (v1.1.0) — Hybrid: Clerk for human auth + per-terminal device token.
  - ✅ DOMAIN_CONFIRM (v1.1.0) — Pharmacy POS confirmed.

Reference posture:
  - `_reference/Data-Pulse/pos-desktop/` is REFERENCE ONLY, gitignored, and MUST NOT be copy-pasted.
    Pharmacy-specific behaviors (drug families, expiry tracking, regulated-substance flags) MAY be
    studied there to ensure parity, but implementations are re-derived here against current
    requirements.
-->

# POS-Pulse Constitution

## Mission

POS-Pulse is a desktop Point-of-Sale terminal for Windows, packaged as an Electron application. It runs
on cashier workstations, captures sales transactions in real time, drives connected hardware (thermal
receipt printer, barcode scanner, cash drawer), and synchronizes with the SmartDataPulse platform
backend when the network is available. It MUST keep selling when the network is down.

POS-Pulse is the **POS surface of the SmartDataPulse platform** (`smartdatapulse.tech`). It is one
client of the platform, not the platform itself:

| Surface                          | Role                                                  |
|:---------------------------------|:------------------------------------------------------|
| `pos.smartdatapulse.tech`        | Product landing, installer download                   |
| `api.smartdatapulse.tech`        | Backend REST API consumed by this app                 |
| `app.smartdatapulse.tech` (sep.) | Web analytics dashboard (separate repo)               |

Backend services, dbt warehouse, BI dashboards, and the marketing/analytics web app live in **other
repos** and are out of scope here. POS-Pulse targets the **pharmacy** vertical: items are medicines
and pharmacy SKUs, inventory carries expiry and batch metadata, returns and shifts follow pharmacy
audit norms, and offline sync is mandatory. The previous-generation app (`Data-Pulse/pos-desktop/`,
vendored at `_reference/Data-Pulse/`) informs design decisions but is not a basis for code reuse:
POS-Pulse is rebuilt from first principles with clean boundaries, while preserving the operational
concepts the legacy app proved necessary.

## Core Principles

### I. Offline-First (NON-NEGOTIABLE)

The POS MUST be able to ring up a sale, print a receipt, and open the drawer with zero network
connectivity. Concretely:

- All transactional reads and writes hit a **local SQLite store first**. Sync to the backend is a
  background concern, not a request-path concern.
- Pending transactions, refunds, and inventory adjustments queue locally with idempotency keys and
  reconcile when connectivity returns.
- The UI MUST show a clear, non-modal connection-state indicator. The indicator surfaces four
  visual states — `online`, `degraded`, `offline`, `syncing` — and MUST NOT block the cashier.
  (`syncing` is reserved today as a visual-only state; the offline-sync behaviour behind it
  lands in a future feature, but the visual contract is fixed so future work remains additive.)
- A failed network call is NEVER a reason to lose, drop, or refuse a sale.

**Rationale:** A POS that stops selling because Wi-Fi blinked is a product failure, not a network
failure. The cashier loses money and the customer leaves.

### II. Financial Precision — No Floats for Money

All monetary values (prices, taxes, discounts, totals, change due, tender amounts) MUST be represented
as integer minor units (e.g., piastres for EGP, cents for USD) in storage and computation.
**Floating-point arithmetic on currency values is PROHIBITED.** The canonical in-process
representation is a JavaScript `number` holding an integer minor-unit value, validated at construction
by `Number.isSafeInteger`; `BigInt` is permitted but not required at this scale. Conversion to a
display string happens only at the formatting boundary.

- The local SQLite schema MUST use `INTEGER` for all money columns.
- A single shared `Money` module MUST own arithmetic (add/sub/mul-by-quantity/distribute-rounding).
- The `Money` constructor MUST reject non-integer, non-safe-integer, and non-finite inputs.
- Tax and discount rounding rules MUST be specified per receipt line, not per total, to match
  pharmacy/retail audit expectations.

**Rationale:** Float drift in a POS is a cash-drawer discrepancy. Cash-drawer discrepancies are
investigated by humans, and they erode trust faster than any feature delights it. Disallowing
*float* arithmetic is the rule that protects against drift; disallowing *all* `number` arithmetic
would force `BigInt` for amounts that fit comfortably in the safe-integer range and add JSON,
ergonomic, and interop costs without a corresponding correctness gain.

### III. Electron Process-Boundary Discipline (NON-NEGOTIABLE)

The Electron architecture MUST follow the modern security model:

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` on every `BrowserWindow`.
- The renderer NEVER imports Node modules directly; all OS / hardware / SQLite access is exposed by a
  **typed preload bridge** (`contextBridge.exposeInMainWorld`) with a narrow, audited surface.
- IPC channels MUST be enumerable, named, and documented; ad-hoc `ipcRenderer.send('whatever', ...)`
  calls outside the bridge are PROHIBITED.
- The main process owns: SQLite, printer/scanner/drawer drivers, file system, auto-updater, Sentry main.
- The renderer owns: UI, state (Zustand/TanStack Query), input handling.

**Rationale:** Electron security incidents almost always trace back to renderer-side Node access. Locking
the boundary on day one is a one-time cost; retrofitting it after a feature ships is not.

### IV. Hardware Failures Are Loud, Never Silent

Connected hardware (thermal printer, barcode scanner, cash drawer, customer display) is the most common
source of operational issues in a POS. Therefore:

- Every hardware operation MUST have a timeout and a typed error result.
- A failed receipt print MUST surface a retry/reprint affordance and MUST NOT auto-dismiss.
- A failed drawer-open command MUST be logged with device id, attempt timestamp, and last successful
  open — and MUST page the cashier to manual override.
- A "degraded mode" (e.g., printer offline) is permitted, but the UI MUST display a persistent banner
  until the device recovers. Silent degradation is PROHIBITED.

**Rationale:** Cashiers blame the software when hardware fails silently. Loud, structured failures keep
trust calibrated to reality.

### V. Type Safety End-to-End

- TypeScript `strict: true` for both renderer and main process tsconfigs.
- Backend API types MUST be generated via `openapi-typescript` (or equivalent) from the backend's OpenAPI
  spec — never hand-typed.
- The IPC preload bridge MUST be typed; both ends share the same interface declaration.
- `any` requires a `// eslint-disable-next-line` line with a justification comment. PRs introducing
  unjustified `any` are blocked.

**Rationale:** A POS has many integration seams (backend, hardware, IPC, SQLite). Each seam is a place
for runtime surprises; the type system is the cheapest way to find them at compile time.

### VI. Test-First, Coverage-Gated

For every new feature or bug fix:

1. Write a failing test (Vitest for both renderer and main process / business logic; Playwright
   for end-to-end flows where applicable).
2. Implement the minimum code that makes it pass.
3. Refactor with the test as the safety net.

Coverage on new code MUST be ≥ 80%. CI MUST gate merges on a coverage floor that ratchets upward only.
The `Money` module, the offline queue, and the receipt-rendering module MUST sit above 95%.

**Rationale:** The cost of a regression in a POS is measured in real money on a real receipt. Tests are
the only durable correctness signal.

### VII. Observability — Local Logs + Remote Crash Reports

- Application logs use `pino` with rotation (`pino-roll`) to a known on-disk location. Log records are
  structured JSON with `terminal_id`, `cashier_id`, `tx_id`, and `request_id` where applicable.
- Crashes and unhandled errors report to Sentry (electron + react). PII (customer name, card data,
  national ID) MUST be scrubbed before transmission.
- Every transaction MUST carry a stable client-generated UUID (`tx_id`) from the moment the cart opens
  through receipt print and backend sync. This ID is the audit anchor.

**Rationale:** When a customer disputes a receipt or a manager investigates a discrepancy, the answer
must be on disk locally and recoverable in seconds.

### VIII. Terminal Identity is Independent of User Identity (NON-NEGOTIABLE)

POS-Pulse uses a **hybrid authentication model**: every backend request carries two identities, and
both MUST be validated server-side.

- **Human identity (Clerk OIDC).** Cashiers, supervisors, and admins log in to a session via Clerk.
  Their identity drives roles, permissions, and audit attribution on transactions. Clerk is the sole
  IdP for humans; custom user databases are PROHIBITED.
  - **Local terminal unlock factors** (e.g., a per-terminal hashed PIN keyed by the Clerk user ID,
    used to unlock a Clerk-backed cashier identity already provisioned on a paired terminal) are
    **not** custom user databases within the meaning of this principle, **provided all six rules
    below hold**:
    1. **Clerk remains the sole human identity provider.** Every cashier, manager, and admin
       remains a Clerk user. The canonical record of "who is this person?" lives in Clerk. Local
       unlock factors do not compete with Clerk for identity.
    2. **The PIN (or equivalent local factor) is used only as a local terminal/session unlock
       factor.** It proves "the person currently in front of this paired terminal may unlock the
       already-known cashier identity for an operator session." It does not adjudicate identity
       in any other context.
    3. **The PIN MUST NOT mint backend identity tokens.** Backend session tokens for any operator
       (cashier, manager, admin) derive from the existing Clerk JWT pipeline. A successful local
       PIN unlock alone does not produce a backend-recognised credential.
    4. **The PIN MUST NOT be accepted by any backend API as an authentication credential.** Backend
       endpoints MUST NOT receive a PIN field, header, or query parameter; backend endpoints MUST
       NOT log any field that could carry a PIN; backend endpoints MUST NOT maintain a server-side
       PIN store.
    5. **The local unlock-factor store MUST NOT become a custom user database or source of truth
       for human identity.** It may contain only terminal-scoped hashed unlock material, lockout
       state, stable Clerk user references, and minimal audit/support metadata such as
       `created_at`, `updated_at`, and `created_by_operator_id`. It MUST NOT contain identity
       profile attributes such as email, phone, legal name, role source-of-truth, tenant
       membership source-of-truth, or backend authentication tokens.
    6. **Operator audit identity remains Clerk-backed and stable.** Audit-event records (per the
       auditability principle, P4 / P10) reference the Clerk user ID for the acting operator,
       never the local unlock-factor record id. The audit trail's identity anchor is independent
       of whichever local unlock factor produced the session.

    A local unlock factor that violates any of rules 1–6 falls back into the "custom user
    database" category and is PROHIBITED.

    **Operational note (informational, not normative):** the canonical storage mechanism for a
    local unlock factor is Electron's existing `safeStorage` (already named for the device token),
    with the same cross-platform scoping (DPAPI on Windows / Keychain on macOS / libsecret on
    Linux). New local-factor implementations should reuse this mechanism rather than introducing a
    parallel secret store.
- **Terminal identity (per-device token).** Every physical POS terminal MUST hold its own opaque
  device token, provisioned exactly once via an admin-authenticated pairing flow. The token is the
  machine's identity; it is sent on every request alongside the user JWT.
  - Pairing: an authenticated admin (Clerk session, `admin` role) initiates pairing from the platform
    admin app. The terminal exchanges a short-lived enrollment code for a long-lived device token,
    which is stored encrypted-at-rest via Electron's built-in `safeStorage` (DPAPI on Windows, scoped
    to the current Windows user account; Keychain on macOS; libsecret on Linux).
  - Rotation / revocation: device tokens are revocable from the admin app; the terminal MUST handle
    `401 device_revoked` by clearing local credentials and entering a "needs re-pairing" mode without
    losing offline-queued transactions.
- **No user-only auth.** The backend MUST reject any request that lacks a valid device token, even
  if the user JWT is valid. Conversely, an unattended terminal (paired but no user logged in) MAY
  perform background sync but MUST NOT ring up sales.
- **Audit anchor.** Every transaction record persists *both* `terminal_id` and `cashier_user_id`.
  Reconciling either independently MUST be possible.

**Rationale:** Pharmacy POS regulators and operators ask "which terminal" at least as often as "which
cashier." Conflating the two — or relying on user login alone — produces audit gaps and lets a
compromised user credential talk to the backend from any device. The pairing model also enables fleet
operations (revoke a stolen terminal, reassign a terminal between branches) without touching user
accounts.

### IX. Reference, Not Inheritance

`_reference/Data-Pulse/pos-desktop/` is gitignored, read-only context. Code, schemas, IPC channel names,
and configurations MUST NOT be copy-pasted into POS-Pulse. Patterns may be studied; implementations MUST
be re-derived against current requirements. Any deliberate carry-over MUST be called out in the PR
description with a justification.

**Rationale:** The reference embodies decisions made under different constraints. Re-typing forces
re-thinking; copy-paste imports decisions silently.

## Cross-Feature POS Principles

The eighteen principles below are stable, cross-feature invariants for POS-Pulse. They operate at
a different layer than the Roman-numeral Core Principles (I–IX): I–IX pin the *stack* (Electron
sandboxing, TypeScript strict, Vitest coverage, etc.); P1–P18 pin *what the product owes its
operators and customers* regardless of stack. Every plan's Constitution Check MUST walk both sets.
A VIOLATION on either set blocks `/speckit-tasks`; a WAIVED entry is permitted on P1–P18 (under
the Exception Procedure below) but PROHIBITED on any NON-NEGOTIABLE Roman-numeral principle.

### P1. Financial Correctness First

**Normative.** Financial correctness and auditability MUST take priority over speed, visual
polish, and convenience. When a design or implementation choice trades correctness or auditability
for any of those values, the choice MUST be rejected.

**Rationale.** A POS that miscounts is a POS that loses cashier trust and customer trust
simultaneously, and the loss is permanent. Polish recovers; trust recovers slowly, if at all.

**Enforcement.** Plans MUST cite this principle when their failure modes touch money. PR review
MUST refuse approval on a money-touching surface that has open correctness or audit gaps. When in
doubt, slow the feature down — don't ship the gap.

### P2. No Fake Success States

**Normative.** POS-Pulse MUST NOT imply that a financial, payment, receipt, inventory, sync, or
terminal operation succeeded unless the system state truthfully supports that claim. Optimistic UI
MUST NOT cross the boundary into "this transaction is now committed" on the cashier's screen.

**Rationale.** A green checkmark that lies is worse than a red error: the cashier handed over the
goods, the customer left, and the dispute lands tomorrow with no recovery path.

**Enforcement.** Every "success" affordance MUST be backed by a server-confirmed result, a
durable local persist, or both (per the operation's idempotency strategy — see P5). Acceptance
criteria for success states MUST name the underlying check that makes the success truthful.

### P3. No Silent Data Loss

**Normative.** Critical POS operations (sales, refunds, voids, inventory adjustments, shift
events, audit records) MUST either be durably recorded or fail visibly. A failed operation MUST
NOT vanish silently after crash, restart, network failure, or retry.

**Rationale.** Silent loss converts a software bug into a cash-drawer mystery. The operator
blames the cashier; the cashier blames the software; the manager has no answer; the audit fails.

**Enforcement.** The local outbox + idempotency-key pattern (P5) is the canonical satisfaction.
Tests MUST exercise the crash, restart, network-failure, and retry paths for any new critical
operation. A feature plan that introduces a critical operation without naming its durability path
fails its Constitution Check.

### P4. Auditability and Non-Destructive Financial Correction

**Normative.** Financial corrections MUST be represented as explicit, auditable events (voids,
refunds, reversals, adjustments). Mutating or deleting a prior financial record MUST NOT be used
as a correction mechanism.

**Rationale.** The auditor's question is "what changed and when?" Only an append-only event log
answers it. Hidden mutations destroy the trail that makes audits possible.

**Enforcement.** Schemas MUST favour append-only event tables over mutable rows for money-bearing
state. Any feature introducing an `UPDATE` or `DELETE` on a money-bearing row MUST justify the
choice in its plan and demonstrate the audit trail is preserved by another mechanism.

### P5. Idempotency for Retried Operations

**Normative.** Any operation that can be retried, replayed, synced, or submitted after failure
MUST define its idempotency strategy in the plan **before** implementation begins. The
idempotency key MUST be a client-generated UUID established at the moment of intent (e.g.,
`tx_id` for a sale, `pairing_attempt_id` for a pairing submission), not assigned by the server.

**Rationale.** Without idempotency, the offline queue creates duplicate sales the moment the
network blinks twice. The duplicate is indistinguishable from a legitimate retry without a key.

**Enforcement.** `/speckit-plan` artifacts MUST include an "Idempotency" subsection for any
retryable operation. Tests MUST exercise the duplicate-submit path. The bridge surface for any
retryable operation MUST accept the client UUID as an explicit parameter.

### P6. No Raw Cardholder Data by Default

**Normative.** Raw cardholder data (PAN, full track data, CVV, expiry tuple with PAN) MUST NOT
enter renderer UI, application logs, the local SQLite database, support bundles, diagnostics,
Sentry events, or general application state. Only authorisation tokens and last-four MAY be
persisted, and only inside the payment-feature scope.

**Rationale.** PCI-DSS scope is determined by where card data flows. Letting it flow into
POS-Pulse multiplies the audit surface tenfold and creates regulatory exposure that the project
has explicitly chosen to avoid by delegating capture to a certified payment terminal.

**Enforcement.** Card capture MUST be delegated to a PCI-DSS certified payment terminal (per
Additional Constraints → Security). PRs that touch a payment surface MUST add a redaction test
covering the bridge, the logs, and the Sentry scrubber. Future scope changes (e.g., adding a
software-card-input flow) require an explicit constitutional amendment, not an exception.

### P7. Secrets Never Reach Renderer or Logs

**Normative.** `device_token`, pairing codes, payment secrets, fiscal secrets, client secrets,
preshared keys, and equivalent credentials MUST NOT be exposed to the renderer process or appear
in any log line, Sentry event, support bundle, or diagnostic output. The renderer MAY display
user-facing identifiers (`terminal_label`, `branch_name`, the masked last-four of a token) but
never the underlying secret.

**Rationale.** A secret that reaches the renderer is a secret that reaches the DOM, the
screenshot tool, the support bundle, and eventually a Slack thread or a screen-share recording.

**Enforcement.** A cross-process redaction test MUST exist (002 ships the canonical version);
new secret-handling features extend it, not replace it. Bridge-surface review MUST refuse new
APIs that return raw secrets to the renderer. Pino redaction paths and Sentry scrubbers MUST be
updated whenever a new secret type is introduced.

### P8. Electron Security Boundary

**Normative.** Changes to IPC channel surface, the preload bridge (`src/preload/`,
`src/shared/bridge-api.ts`), the main-process boundary (`src/main/`), the SecretStore API, the
migration runner, or the OpenAPI codegen pipeline MUST be introduced only by features that
explicitly own them, and MUST receive explicit security review. They MUST NOT be smuggled into
UI-only features as incidental work.

**Rationale.** The Electron threat model lives at the bridge. Each new bridge call is a security
review. Quietly expanding the surface during UI work is the documented pattern by which
Electron apps get owned.

**Enforcement.** PRs touching `src/preload/`, `src/main/`, `src/shared/bridge-api.ts`, or
`migrations/` MUST cite the feature that owns the change. UI-only feature plans MUST list these
paths in their out-of-scope section. PR review MUST refuse approval on incidental bridge or
main-process changes.

### P9. Truthful Offline / Degraded / Sync States

**Normative.** Offline, degraded, syncing, pending, failed, and local-only states MUST be
truthful. UI MUST NOT imply capabilities (e.g., "synced", "queued for sync", "will be sent when
online") that are not implemented in the code that drives the state. Visual-only states (states
introduced for layout consistency before the underlying capability ships) MUST be labelled as
visual-only in the originating spec and in any consuming feature's plan, until the
capability lands.

**Rationale.** Visual states create operator expectations. False expectations turn into
customer-facing claims that the product cannot keep, which silently erode trust and create
disputes the support team cannot resolve.

**Enforcement.** The audit point on every connection-state visual is: *"what does this state
promise, and what code makes the promise true?"* Plans MUST answer it for every state they
introduce or consume. The 003-pos-ui-shell `syncing` state is the canonical example of a
visual-only state pending real implementation (see Active Feature Compatibility Note).

### P10. Operator Accountability for Sensitive Actions

**Normative.** Sensitive POS actions — refunds, voids, discounts beyond a threshold, price
overrides, cash-drawer kicks outside a sale, receipt reprints, payment reversals, shift
reconciliation entries — MUST be attributable to an authenticated operator and an open shift
before they execute in production. The audit record MUST persist the operator identity, the
shift identity, the action category, and the originating terminal.

**Rationale.** "Who did that?" is the most common forensic question in retail. Without operator
attribution, the answer is "the terminal", which is not actionable.

**Enforcement.** Acceptance criteria for any sensitive-action feature MUST include
operator-attribution. The Domain section's Sales / Returns / Shifts entities already carry the
schema fields; new sensitive-action features extend the catalogue rather than redefining it.
Until cashier login/session lands, sensitive actions MAY be gated behind a "supervisor override
required" flow that captures the supervisor's identity at action-time.

### P11. Supportability Without Secret Leakage

**Normative.** Diagnostics, crash reporting, log streams, and support bundles MUST be useful
enough to troubleshoot a production issue, AND MUST be minimal and redacted by design. Adding a
verbose log site MUST be paired with explicit redaction for every field that could carry a
secret or PII.

**Rationale.** "Just log everything" is how the next breach happens. "Log nothing" is how the
next outage becomes undebuggable. The path between is deliberate.

**Enforcement.** A redaction list MUST live alongside the logger configuration. Every new log
site MUST be checked against it. Sentry scrubbing rules MUST be reviewed and updated whenever a
new event type is introduced. Support-bundle export tooling MUST run the same redaction pipeline
as the on-disk log writer.

### P12. Spec Kit Artifacts Are Source of Truth

**Normative.** Spec Kit artifacts (`spec.md`, `plan.md`, `tasks.md`, `contracts/`,
`data-model.md`, `research.md`, `quickstart.md`) ARE the source of truth for requirements, scope,
and acceptance criteria. Prototypes, Figma designs, Figma Make exports, Figma MCP outputs,
screenshots, and visual explorations MUST NOT be treated as requirements unless they are
reflected back into Spec Kit artifacts via `/speckit-specify`, `/speckit-clarify`, or
`/speckit-plan`.

**Rationale.** Designs drift the moment they leave the design file. The Spec Kit pipeline is
the only path that produces an auditable trail from intent to acceptance, with versioning, with
constitutional alignment, and with the analyse pass.

**Enforcement.** PR review MUST cite `tasks.md` task IDs, not Figma frames or design URLs.
Ambiguities discovered during planning MUST be resolved via `/speckit-clarify`, not via "the
designer said". Visual-only states (P9) MUST be reflected in the spec, not just the design.

### P13. Small, Scoped Implementation PRs

**Normative.** Each implementation PR MUST implement only the explicitly assigned task IDs from
`tasks.md`, MUST NOT improvise scope, MUST stage only named files (no `git add -A` or `git add
.`), and MUST stop after opening the PR. Out-of-scope changes discovered mid-implementation MUST
be filed as follow-up tasks, not folded into the current PR.

**Rationale.** Small PRs review well, revert cleanly, and build a stable history. Scope
improvisation is the documented pattern by which features ship half-baked adjacent
functionality.

**Enforcement.** PR descriptions MUST list the task IDs covered. Reviewers MUST refuse PRs that
extend beyond the listed IDs. Hooks and process docs SHOULD codify the "stage only named files"
rule.

### P14. Accessibility and Cashier Ergonomics

**Normative.** POS UI MUST support keyboard operation on every cashier-critical path (no
mouse-only flows on sales, refunds, voids, or shift actions), touch-friendly targets at the
≥ 44 × 44 CSS-pixel floor (see Hardware Matrix), readable states (icon + text or icon + colour,
never colour alone), accessibility-rule cleanliness on default state variants (axe-clean smoke
checks per the testing toolchain), and Windows desktop ergonomics (focus rings, focus restore,
keyboard-wedge focus management) from the moment a feature ships.

**Rationale.** The cashier uses this product for an eight-hour shift. Tiny buttons, mouse-only
flows, and colour-only states cost minutes per transaction and create accessibility violations
the team will pay to fix later under deadline.

**Enforcement.** Renderer features MUST include keyboard-path tests. Each placeholder pane and
each interactive primitive MUST run an axe-rule smoke test. The 44 × 44 floor is enforced by
the existing invariant test in `src/renderer/ui/`.

### P15. Production Readiness Gates

**Normative.** Features that affect real store operations (sales, payments, receipts, inventory
mutation, offline sync write-paths, fiscal integration, auto-update wiring, cashier login)
MUST define their test plan, rollback strategy, support runbook entry, failure-mode catalogue,
and operational readiness expectations BEFORE production rollout. A feature that lacks any of
these MUST NOT be enabled for paying customers.

**Rationale.** Production readiness review is the last cheap chance to find the failure mode
before a real cash drawer slams shut at 8 pm. UI-only and infrastructure-only features have
lower readiness bars; production-affecting features do not.

**Enforcement.** `/speckit-plan` artifacts for production-affecting features MUST include a
"Production Readiness" subsection. The merge gate for a production-rollout PR MUST require
its presence. UI-only features (e.g., 003-pos-ui-shell) are explicitly out of this gate.

### P16. Feature Scope Discipline

**Normative.** Future POS domains — payments, sales/cart business logic, inventory mutation,
offline-sync write-paths, fiscal integration, auto-update wiring, receipt printing,
operator/session/cashier authentication — MUST be implemented only by the features that
explicitly own them. Other features MUST NOT bring those domains in incidentally, even when
they reserve visual space for them.

**Rationale.** Scope creep is how a UI shell ships with a half-working payment integration the
team had no plan to support. The reservation of *visual space* (slots, placeholders, named
regions) is permitted; the implementation of *behaviour* is not.

**Enforcement.** Plans MUST list out-of-scope domains explicitly. PR review MUST refuse changes
that touch out-of-scope domains. The 003-pos-ui-shell plan's "Hard Non-Implementation
Boundaries" subsection is the canonical example; future feature plans SHOULD adopt the same
shape.

### P17. Privacy and Tenant Isolation

**Normative.** Tenant, branch, terminal, operator, customer, transaction, and support-bundle
data MUST NOT cross tenant boundaries. Multi-tenant safety MUST be preserved by design — at the
database layer (`tenant_id` on every domain row, queries scoped by it), at the API layer (token
claims rejected on tenant drift, per Principle VIII), and at the support-bundle layer (export
filtered by tenant before it leaves the device).

**Rationale.** A multi-tenant leak is a regulatory event. The cost is not "user complaints"; it
is "regulatory fine + customer churn + lost design partner".

**Enforcement.** Schema reviews MUST check for `tenant_id` presence on every new domain table.
API contracts MUST require tenant claims. Support-bundle export tooling MUST be tenant-aware.
Cross-tenant queries (e.g., support tooling that aggregates) MUST be a separately reviewed
feature with explicit operator authorisation.

### P18. Local Durability Before Offline Promises

**Normative.** POS-Pulse MUST NOT promise offline financial capability — in marketing copy, in
UI, or in any customer commitment — until the local durability, replay safety, conflict
handling, and recovery behaviours that back that promise are explicitly designed, implemented,
and tested. Visual-only offline states (per P9) MUST NOT be cited as evidence that the offline
capability is delivered.

**Rationale.** "Sells offline" is a high-trust promise. Breaking it costs real money in a real
cash drawer, and the breakage is visible to customers, not just to the operator.

**Enforcement.** Marketing-copy claims about offline behaviour MUST cite the spec/plan that
delivers the behaviour. Until the relevant feature ships, the UI MUST surface offline state as
"offline — selling locally, queueing for later" only when the queue is real and durable, not
visual-only. Connecting this to P9: a visual-only `offline` state MUST be labelled as such in
the originating spec.

## Additional Constraints

### Platform Integration

POS-Pulse is bound to the SmartDataPulse platform on the explicit endpoints below. These are the
only remote hosts the production app contacts (in addition to Sentry's ingest URL):

| Purpose            | URL (production)                                    | Notes                                              |
|:-------------------|:----------------------------------------------------|:---------------------------------------------------|
| Backend API        | `https://api.smartdatapulse.tech`                   | All transactional, sync, and config calls          |
| OpenAPI spec       | `https://api.smartdatapulse.tech/openapi.json`      | Source of truth for `openapi-typescript` codegen   |
| Update origin      | Configured HTTPS origin (`ELECTRON_UPDATE_FEED_URL`) | Provider-neutral static origin; `electron-updater` `generic` provider; channels `lab` / `canary` / `stable` (ADR-0006) |
| Landing / download | `https://pos.smartdatapulse.tech`                   | Installer download, release notes (separate repo)  |

Constraints on this binding:

- The base URL MUST be configurable via build-time env (`VITE_API_BASE_URL`,
  `ELECTRON_UPDATE_FEED_URL`) for staging and dev environments. Hardcoded production hostnames in
  source code outside the env layer are PROHIBITED.
- TLS MUST be enforced for every outbound call; certificate pinning is RECOMMENDED for the API.
  Pinning is NOT required for the update origin: update authenticity comes from the signature
  and sha512 verification required under Security, and pinning a CDN or object-storage
  certificate would stop fleet updates on routine certificate rotation.
- Network egress from the renderer is blocked at the CSP layer; only the main process opens
  connections to the hosts above.
- A single typed API client (generated from the OpenAPI spec) is the only path to the backend; ad-hoc
  `fetch` against `api.smartdatapulse.tech` is PROHIBITED.

**Auth (hybrid — see Principle VIII for the rule, this subsection for the wire format).**

Every backend request from POS-Pulse MUST carry both headers:

| Header              | Source                          | Lifetime                          |
|:--------------------|:--------------------------------|:----------------------------------|
| `Authorization`     | Clerk-issued JWT for the user   | Short (refreshed by Clerk SDK)    |
| `X-Terminal-Token`  | Device token from pairing flow  | Long; rotated/revoked from admin  |

**Token scope.** The device token is bound to a `(tenant_id, branch_id, terminal_id)` tuple. The
backend MUST embed all three in the token claims and reject any request whose runtime context drifts
from them. Re-assigning a terminal to another branch requires re-pairing — silent rebinding is
PROHIBITED.

**Pairing flow.**

- **Admin side** (lives in the platform admin/dashboard app, separate repo): an authenticated admin
  selects `tenant + branch + terminal slot`, generates a short-lived pairing code, and displays it
  alongside a QR encoding of the same code.
- **POS side** (this repo): on first launch (or after `device_revoked`), the app shows a minimal
  pairing screen with two affordances — **enter pairing code manually** or **scan QR** (the
  keyboard-wedge barcode scanner is the canonical QR input on POS hardware; the screen accepts
  both).
- The terminal calls `POST /api/v1/terminals/pair` with the pairing code; the response carries the
  long-lived device token plus the bound `(tenant_id, branch_id, terminal_id)`.
- This is the only backend call where `X-Terminal-Token` is absent.

**Endpoint contract (POS-side requirements).** The contract is owned by the backend repo, but the POS
client MUST expect:

| Aspect                    | Requirement                                                                              |
|:--------------------------|:-----------------------------------------------------------------------------------------|
| Request body              | `{ pairing_code: string }`                                                               |
| Successful response       | `{ device_token, tenant_id, branch_id, terminal_id, terminal_label, expires_at? }`       |
| Pairing-code lifetime     | Short (≤ 15 minutes recommended); reuse rejected                                         |
| Failure modes (typed)     | `INVALID_CODE`, `EXPIRED_CODE`, `ALREADY_PAIRED`, `BRANCH_MISMATCH`, `RATE_LIMITED`      |
| Idempotency               | Successful pair is one-shot per code; the terminal MUST NOT retry a consumed code        |

**Storage and revocation.**

- The device token is stored encrypted-at-rest via Electron's `safeStorage`. On Windows this is
  backed by DPAPI keyed to the current Windows user account; encrypted blobs cannot be decrypted
  on a different machine or under a different Windows account, so copying the user-data directory
  does NOT carry the credential. Production builds MUST refuse to start if
  `safeStorage.isEncryptionAvailable()` returns false (a misconfigured workstation must fail
  loudly rather than silently fall back to plaintext).
- Background sync MAY proceed with terminal-only auth (no logged-in cashier); sales MAY NOT.
- A `401 device_revoked` response MUST clear the device token, retain the offline transaction queue,
  and surface a "Needs re-pairing — contact admin" state without losing pending data.

### Security

- The renderer MUST NOT have direct file-system, network, or child-process access. All such access goes
  through the typed preload bridge.
- Backend authentication tokens (and any other persisted secret) MUST be stored encrypted-at-rest
  via Electron's `safeStorage` — DPAPI on Windows, Keychain on macOS, libsecret on Linux — never
  plaintext. Production builds MUST refuse to start if `safeStorage.isEncryptionAvailable()` returns
  false.
- The auto-updater MUST verify the Authenticode signature (publisher pinned to the stable
  certificate subject; RFC 3161 timestamped) and the channel-file sha512 before applying an
  update, and MUST fail closed: an unsigned, mismatched or unverifiable update is never
  installed, and the failure is surfaced, not silent. The auto-updater MUST NOT install a
  version lower than the one running (roll-forward only, ADR-0006).
- No card data (PAN, CVV) ever touches POS-Pulse storage or logs. Card capture is delegated to a PCI-DSS
  certified payment terminal; only authorization tokens / last-4 may be persisted.
- Content Security Policy (CSP) MUST disallow `unsafe-eval` and inline scripts in production builds.

### Hardware (MVP Matrix)

The MVP ships with a deliberately narrow hardware surface. Anything not listed below as **In scope**
is **Out of scope** until a future amendment.

**In scope (MVP):**

| Category            | Support                                                                                |
|:--------------------|:----------------------------------------------------------------------------------------|
| Workstation         | Windows 10/11 desktop or laptop, x64. The single primary build target.                 |
| Barcode scanner     | **Keyboard-wedge** (HID) only. Scanners present as keyboards; no SDK integration.      |
| Receipt printer     | Local print adapter (system printer queue). **ESC/POS direct path preferred** when the connected printer supports it; otherwise fall back to the OS print path. |
| Cash drawer         | **Optional**, opened via the receipt printer's kick command (DK1/DK2 ESC/POS pulse).   |

**Out of scope (MVP) — explicitly NOT supported until a future amendment:**

- Android, iPad, iPhone, or any non-Windows POS form factor.
- Label printers and scales.
- Customer-facing displays (CFD / pole displays).
- Direct integration with card terminals (PIN pads, mPOS readers). Card capture stays on a separate
  PCI-DSS certified device per the Security subsection.
- Native scanner SDKs (Honeywell, Zebra DataWedge as native bridge, etc.) — wedge mode only.

**Operational rules:**

- The supported hardware list MUST be reproduced in `docs/hardware-matrix.md` with concrete tested
  models, transports, driver versions, and known caveats. Adding a model requires updating that doc
  and adding an integration test.
- Barcode scanner input is treated as keyboard input by default; the focus-management strategy MUST
  prevent stray scans from polluting unrelated fields. The pairing screen and the cart screen are
  the two contexts where wedge input is accepted by design.
- Every interactive element in the renderer MUST meet a minimum touch-target size of
  **44 × 44 CSS pixels**. Cashier hardware is touchscreen-first; the floor is enforced by an
  invariant test in `src/renderer/ui/`.
- Receipt templates are version-controlled assets (not hardcoded strings). The template engine MUST
  emit both an ESC/POS byte stream and a printable HTML/canvas fallback so the same template renders
  on both the direct and OS-print paths.
- A failed cash-drawer kick MUST surface a manual-override path per Principle IV; it MUST NOT block
  the receipt print.

### Localization

- Arabic-first UI: RTL layout MUST be the default for Arabic locale; Latin numerals MUST be used in
  receipts (audit/legal compatibility), but the UI MAY use Arabic-Indic numerals where appropriate.
- The Cairo font is the canonical Arabic typeface; Fraunces and JetBrains Mono are the Latin / mono
  pairs.
- Currency, date, and time formatting MUST flow through a single `formatters` module — never inlined.

### Domain — Pharmacy POS

POS-Pulse is a pharmacy POS. The following concepts are **canonical** in this codebase: any feature that
touches them MUST integrate with the existing module rather than redefine its own variant. Names are
indicative — the actual modules will be defined in `/speckit-plan` artifacts — but the concepts are
fixed.

| Concept              | Pharmacy specifics that MUST be respected                                              |
|:---------------------|:----------------------------------------------------------------------------------------|
| **Tenant**           | Top-level customer account (one pharmacy chain or independent operator). All data is tenant-scoped at the backend. |
| **Branch**           | Physical location belonging to a tenant (one shop). Stock, shifts, and reports are branch-scoped; a terminal belongs to exactly one branch. |
| **Terminal**         | A specific Windows workstation running POS-Pulse. Identity is established by the device token (Principle VIII), not by user login. |
| **Products / Medicines** | SKU + barcode (EAN/GTIN); generic + brand name; dosage form; pack size; controlled-substance flag; prescription-required flag |
| **Inventory**        | Per-batch tracking with **expiry date** and **batch/lot number**, scoped to a branch; FEFO (First-Expired-First-Out) is the default issue policy |
| **Barcode**          | Primary input modality at checkout; lookup MUST be O(1) against the local SQLite index; unknown barcode flows to a "manual entry / add product" path, never to a hard error |
| **Sales**            | One sale → multiple lines, each line linked to a specific batch; tax computed per line per Principle II; receipt prints synchronously before the cart closes |
| **Returns**          | Exchange or refund against an existing receipt; partial returns supported; returned stock is NOT silently re-added to inventory — disposition (resalable / quarantine / destroy) is explicit |
| **Shifts**           | Cashier opens a shift with a starting cash float; closes with a count and reconciliation; X-report (mid-shift) and Z-report (close) MUST print; a shift binds the cashier-user to the terminal for its duration |
| **Offline Sync**     | Per Principle I: every sale, return, inventory adjustment, and shift event has a client-generated UUID and queues to a durable outbox; sync is idempotent and order-preserving per terminal |

Cross-cutting:

- **Pricing rules** (member discounts, insurance copay, promotional pricing) are computed locally
  against rules cached from the backend; recomputation server-side at sync time MUST agree to the
  cent — divergence is a reconciliation bug, not a feature.
- **Regulated substances**: any item flagged as controlled MUST require a supervisor (Clerk role)
  override at sale time; the override is recorded on the transaction.
- **Receipts** include the pharmacy's tax registration ID, the cashier's display name, the branch
  identifier, the terminal ID, and per-line batch/expiry where regulation requires it. Layout is a
  versioned template, not inlined strings.

**Rationale:** Pharmacy POS has structural concepts that other retail verticals lack (expiry, batch,
controlled substances, insurance copay). Encoding them as canonical domain concepts in the
constitution prevents the very common drift where each new feature reinvents its own shape for
"product" or "inventory line."

### Tech Stack (Frozen for MVP)

The stack below is locked for the MVP. Changes require an amendment (MINOR bump for a substitution
within a category, MAJOR bump if it shifts a Core Principle's enforcement).

- Runtime: Electron 40+, Node 20+, Windows 10/11 x64 primary target.
- Renderer: React 19, TypeScript 5.6+, Vite 8, Tailwind 4 (CSS-first theming via `@theme`).
- UI primitives: first-party module at `src/renderer/ui/` (`primitives/`, `tokens/`, `states/`).
  External UI libraries (Radix, shadcn/ui, MUI, Mantine, Headless UI, lucide-react, …) are NOT
  in the MVP stack; adding one requires an amendment with the rationale recorded against the
  rejection logged in feature 003 research §4.
- State: Zustand for UI state; TanStack Query (or SWR) for server state.
- Local DB: better-sqlite3 (synchronous, embedded, fastest for POS workload).
- Secret storage: Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
  No third-party secret store; production refuses to start without it.
- Routing: react-router-dom 7.
- Observability: pino + pino-roll (logs), Sentry (crashes).
- Testing: Vitest (renderer + main + business logic) with `happy-dom` as the DOM env,
  `@testing-library/react` (+ `jest-dom`, `user-event`) for renderer assertions, and `axe-core`
  consumed via a first-party `expectNoAxeViolations` helper for accessibility-rule smoke
  checks. Playwright remains an optional addition for end-to-end flows.
- Printing: receipt template engine emitting both an ESC/POS byte stream and a printable
  HTML/canvas fallback (`node-thermal-printer` or equivalent for the direct path; the OS print queue
  for the fallback). The choice is per-printer, not per-feature.
- Hardware: barcode scanners as keyboard-wedge HID input only (no native SDK).
- Build & ship: Vite for renderer, `tsc` for main, electron-builder for Windows installers
  (per-user NSIS), electron-updater (`generic` provider) against the configured update origin
  for auto-update (ADR-0006).
- Update identity (frozen): `appId` `tech.smartdatapulse.pos`, `productName` `POS Pulse`, and
  the package `name` `pos-pulse`. Together they determine the installer identity, install
  directory, executable name and the `userData` path that holds the local database and
  DPAPI-protected secrets. Changing any of them breaks the update chain and orphans terminal
  data, so it requires an amendment and a data-migration plan.
- API typings: `openapi-typescript` reading from `https://api.smartdatapulse.tech/openapi.json`,
  generated into `src/shared/api-types.ts` and committed to the repo.

## Development Workflow & Quality Gates

### Branching & Commits

- Feature work happens on a descriptive branch off `main`.
- Commits follow conventional-commit prefixes: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`,
  `perf`, `ci`.
- Direct commits to `main` are PROHIBITED except for repo bootstrap.

### Pre-Push (Local) Checklist

Before pushing any branch, the following MUST pass:

- `npm run typecheck` (all tsconfigs).
- `npm run lint` (ESLint + Prettier).
- `npm test` (Vitest — covers both renderer and main).

### CI Gates (Merge to `main`)

Merge to `main` requires:

1. All automated tests passing (Vitest + Playwright where present).
2. Coverage gate satisfied (≥ 80% on new code; ≥ 95% on `Money` / offline-queue / receipt modules).
3. At least one human approval on the PR.
4. No open CRITICAL or HIGH findings from security-review or code-review agents.
5. Linked spec / plan / tasks artifacts present for any non-trivial feature.
6. Installer builds successfully on the CI runner (`electron-builder --win --dir`).

### Spec Kit Workflow

Non-trivial work MUST flow through the Spec Kit pipeline:

```
/speckit-specify   → spec.md
/speckit-clarify   → resolve ambiguities
/speckit-plan      → plan.md
/speckit-tasks     → tasks.md
/speckit-analyze   → cross-artifact validation
/speckit-implement → execute tasks
```

Trivial fixes (typos, dependency bumps, log-message tweaks) MAY skip the pipeline.

## Governance

### Authority

This constitution is the highest-priority document in the repository. When it conflicts with any other
document (READMEs, ADRs, comments, agent instructions), this document wins until it is amended.

### Spec Compliance — How New Specs Comply

Every new feature spec produced by `/speckit-specify` MUST:

1. Cite the constitution version it was authored against in `spec.md` front-matter (see
   002-terminal-pairing and 003-pos-ui-shell for the canonical layout).
2. Pass through `/speckit-clarify` before planning if any open `[NEEDS CLARIFICATION]` items
   touch a constitutional principle (Roman-numeral I–IX or P1–P18).
3. Be analysed by `/speckit-analyze` after `/speckit-tasks`. The analyse pass MUST include a
   Constitution Check pass that walks both principle sets.
4. State, in the Out of Scope section, every domain it does NOT touch — particularly the
   future POS domains named in P16 (payments, inventory mutation, offline-sync write-paths,
   fiscal integration, auto-updates, receipt printing, operator/session/auth).

A spec that omits the constitution-version pin is incomplete and MUST be revised before
`/speckit-plan` runs. A spec that violates a NON-NEGOTIABLE principle is rejected — there is no
WAIVED state for NON-NEGOTIABLE rules at the spec layer.

### ADRs and Constitutional Principles

Architectural Decision Records (ADRs — whether kept lightweight in `research.md` sections or as
standalone `docs/adrs/*.md` files) document material design choices that are not bound to a
single feature. Their relationship to the constitution is one-way:

- An ADR MUST cite the constitutional principle(s) it upholds, applies, or rebalances.
- An ADR MUST NOT contradict a constitutional principle. An ADR that materially departs from a
  principle is not an ADR — it is an Amendment proposal in disguise, and MUST be filed as a
  constitution amendment via the Amendment Procedure below.
- An ADR MAY refine *how* a principle is satisfied for a particular subsystem (e.g., "this
  feature satisfies P5's idempotency requirement by using a server-issued sequence number").
  This is interpretation, not departure.

When an ADR and a feature plan both touch the same principle, the plan's Constitution Check
table MUST cite the ADR.

### Implementation PR Review — Constitution Check

Every implementation PR description MUST include a "Constitution Check" line that names the
principles the PR most directly touches (typically two to five). Reviewers MUST:

1. Verify each cited principle is honoured by the diff under review.
2. Scan the unmentioned principles for incidental violations — particularly P6 (raw cardholder
   data), P7 (secrets in renderer/logs), P8 (Electron security boundary), P13 (scope
   discipline), and P17 (tenant isolation), which are the highest-risk categories for silent
   drift.
3. Refuse approval on any open VIOLATION; require a follow-up PR or an explicit Exception
   (below) for any open WAIVED entry.
4. Confirm the PR stages only the files named in the originating tasks (P13).

The Constitution Check is the reviewer's responsibility; the PR author's responsibility is to
make it easy to perform — by listing principles touched, citing the corresponding `tasks.md`
task IDs, and flagging anything intentionally close to a principle boundary.

### Amendment Procedure

1. Open a PR titled `docs: amend constitution to vX.Y.Z (<summary>)`.
2. The PR MUST include the updated `Sync Impact Report` (HTML comment at top of this file),
   covering: version-change line, bump rationale, modified principles (if any), modified
   sections, added/removed sections, templates requiring updates, follow-up TODOs (open),
   resolved TODOs (this revision), and any conflicts with existing planning artifacts.
3. The PR MUST update or flag every dependent template/document affected by the amendment.
4. At least one maintainer (currently the repo owner) MUST approve.
5. Merge bumps the version per the rules below and updates `Last Amended`.

### Exception Procedure (Time-Boxed Waiver)

An *exception* is a time-boxed, scope-limited deviation from a constitutional principle that
is too small to justify a full amendment. Exceptions are recorded as `WAIVED` rows in the
originating plan's Constitution Check table.

A WAIVED row MUST cite, on a single line each:

- the principle being waived (Roman numeral or P-number);
- the precise scope of the waiver (which file, which feature, which sub-feature);
- the expiry condition (a follow-up task ID, a feature ID that closes the waiver, or a date
  no more than 90 days from waiver-issue);
- the reviewer who approved the waiver.

Hard rules:

- Exceptions MUST NOT be used to bypass NON-NEGOTIABLE principles (Principle I, III, VIII).
  Deviations from those require a full amendment, not an exception.
- Exceptions MUST NOT be open-ended. A waiver without an expiry condition is invalid.
- Exceptions accumulate — when the count of open waivers exceeds five repository-wide, the
  constitution Compliance Review (below) moves up the schedule to within two weeks.

### Versioning Policy (Semantic)

- **MAJOR** — backward-incompatible change to a principle, removal of a principle, or
  redefinition of governance.
- **MINOR** — new principle, new section, or materially expanded guidance.
- **PATCH** — clarifications, wording, typo fixes, non-semantic refinements.

### Compliance Review

- Every PR review checklist includes a "Constitution Check" line. The reviewer MUST cite which
  principles were considered (both Roman-numeral I–IX and P1–P18 are in scope).
- The constitution is reviewed in full at least once per quarter; the review is logged as an
  ADR. The quarterly review MUST inspect: open waivers (Exception Procedure), follow-up TODOs
  in the Sync Impact Report, alignment between the principle set and the active feature
  index, and any drift between the Tech Stack lock and `package.json`.

## Active Feature Compatibility Note — 003-pos-ui-shell

This appendix is a *time-boxed compatibility marker*. It restates what 003 already commits to in
its `spec.md` and `plan.md` and aligns 003's scope with the principle set above. It does NOT
widen 003's scope. It sunsets when 003 ships and the active-feature index advances.

**003 MAY:**

- Reserve named visual slots, placeholder regions, and route shells for future POS domains
  (sales, cart, checkout-payments, inventory, settings, dashboard) — exactly as the existing
  003 spec/plan permit. Slot reservation is *layout capacity*, not behaviour (P16).
- Introduce visual-only connection-state visuals (`online`, `degraded`, `offline`,
  `syncing`). These are visual-only unless and until a separate, already-approved
  source-of-truth backs them (P9, P18).
- Land the four-state connection-state model and the 44 × 44 CSS-px touch-target floor
  established in v1.4.0 of this constitution.

**003 MUST NOT:**

- Implement sales / cart business logic, payments, receipts, fiscal integration, inventory
  mutation, offline-sync write-paths, cashier login / session / auth, or backend calls (P16).
- Modify IPC channel surface, the preload bridge, the main-process boundary, the SecretStore
  API, database migrations, OpenAPI schemas, or Sentry configuration (P8). The
  bridge-typing test and renderer-isolation test in `src/tests/` are the canonical guards.
- Promise capabilities through visual states that the underlying code does not deliver (P2,
  P9). The `syncing` visual is a placeholder; no real sync logic backs it in 003.
- Widen 003 scope beyond what its merged `spec.md`, `plan.md`, and `tasks.md` already
  authorise. As of this amendment, 003 has completed `/speckit-specify`,
  `/speckit-clarify`, `/speckit-plan`, and `/speckit-tasks`; the planning PR is merged;
  and four implementation slices (Slice 1 foundation, US3 placeholder states, US4
  connection states, US6 checkout reservation) are merged to `main`. The only
  remaining 003 work is the Final polish / validation / handoff slice. Before that
  slice begins, the responsible author MUST re-check it against P1–P18 (and the rest
  of this constitution); a planning revision is required only if the re-check finds a
  real violation. New scope items not already in 003's `tasks.md` MUST go through a
  separate spec, not be smuggled into the polish slice.

**003 source-of-truth:** the `spec.md`, `plan.md`, and `tasks.md` under
`specs/003-pos-ui-shell/` are the source of truth (P12). Any Figma frame, Figma Make export,
Figma MCP output, screenshot, or visual exploration referenced during 003 work MUST be
reflected back into those artifacts before it counts as a requirement.

This appendix is removed (or superseded by an equivalent appendix for the next active
feature) when 003 closes.

---

**Version:** 1.6.0
**Ratified:** 2026-05-01
**Last Amended:** 2026-10-09
