# RT-234 — POS Signed Auto-Update, Staged Rollout and Rollback — Design

| | |
|:--|:--|
| Jira | [RT-234](https://rahmaqanater.atlassian.net/browse/RT-234) (parent RT-7, W7 Pilot / Rollout) |
| Work Mode | **Planning** — no updater code, no feed deployment, no signing secrets |
| Baseline | `Kemetra/POS` `origin/main` @ `0e7cefe` (2026-10-09) |
| Status | Draft for owner review |
| Related | Device Registry & Device Lifecycle baseline (Confluence 23887876); Technology & Reference Radar v21; RT-138, RT-135, RT-164, RT-287 |

## 1. Purpose and success criteria

Define the production POS delivery/update contract before Retail Tower moves beyond a small,
manually managed pilot fleet. Success means every owner direction D1–D8 is turned into rules that
an implementation slice can build and a verification slice can prove, with no new cross-repo
contract invented inside this item.

This item does **not** become an RT-20 pilot blocker (D1) and stays behind the active pilot frontier.

## 2. Verified current state (`main` @ `0e7cefe`)

| Area | Fact | Consequence |
|:--|:--|:--|
| Packaging | `electron-builder.yml` builds only `win.target: dir`, unsigned. No NSIS, no `publish`. RT-164 fuses on (`onlyLoadAppFromAsar`, `enableEmbeddedAsarIntegrityValidation`). | An installer target and Authenticode signing are prerequisites for any updater. |
| Updater | No `electron-updater` dependency; no `autoUpdater` / `checkForUpdates` / `setFeedURL` / `latest.yml` anywhere in `src/`. | Greenfield. |
| Migrations | `src/main/db/migrate.ts` is forward-only. It applies files missing from `schema_migrations` and **silently ignores applied rows that have no file in the running build**. | An older binary started on a newer DB runs with no guard. This is the central D6 risk. |
| Local data | DB at `app.getPath('userData')/pos-pulse.db`; secrets via DPAPI `safeStorage` (per Windows user). Shifts persist in SQLite (`0007_shifts`, `0043_shift_cash_up`). | Install scope must preserve the user profile; an open shift survives a restart. |
| Version signal | `app.getVersion()` reaches only logs, Sentry `release`, and the renderer. POS sends **no** version to Backend-Core; Backend-Core advertises **no** contract version or minimum-supported version. | D5's runtime gate and D7's reporting need a new contract (gated, §9). |
| Constitution | v1.3.0 names the feed `https://pos.smartdatapulse.tech/updates/`, requires TLS **certificate pinning** for the update feed, channels `stable`/`beta`, and "the auto-updater MUST verify code signatures". | The fixed domain and pinning conflict with D8. An amendment is a **precondition** (§11), not assumed. |
| CI | `ci.yml` runs static (incl. `tests/contract/backend-core` conformance + codegen drift), tests, unsigned `package:dir`. No release workflow. | Release/signing workflow is new and must be separate from PR CI. |
| Pilot fleet | `docs/runbook/pilot-terminal-provisioning.md`: "Installer / auto-update — None", terminals run the unpacked `dir` build. | Pilot terminals need one manual migration into the first installed build. |

## 3. Decisions taken in this planning item

Owner-confirmed on 2026-10-09 (owner instruction: take the recommended option on every choice).

| ID | Decision |
|:--|:--|
| P-1 | **Updater technology:** `electron-builder` NSIS + `electron-updater`, pinned to a **stable** (non-alpha) release line. Policy is ours; we do not call `checkForUpdatesAndNotify()`. |
| P-2 | **Provider:** electron-updater `generic` provider against any HTTPS static origin (object storage + optional CDN). The origin URL is configuration, never code. GitHub Releases is not used (a private-repo token would sit on every terminal). |
| P-3 | **Rollback model: roll-forward only.** No terminal ever installs a lower version. Recovery = halt + ship a higher version. |
| P-4 | **Safe point:** install only when there is no open shift and no sale/tender/return in flight (§6). |
| P-5 | **Signing:** cloud-HSM Authenticode signing (Azure Artifact Signing or an equivalent CA cloud-HSM service). The key never leaves the HSM. CI signs through short-lived OIDC identity. |
| P-6 | **Install scope:** NSIS **per-user**, `oneClick`, no elevation. Keeps `userData`, the DB and DPAPI secrets under the cashier's Windows user and avoids a UAC prompt on every update. |
| P-7 | **Phasing:** Phase 1 = POS-side gates over a static signed feed with per-terminal channels. Phase 2 = Backend-Core-governed rollout, minimum-supported enforcement and fleet version reporting, delivered only through the gated contract in §9. |

Rejected alternatives: Backend-Core-governed rollout from day one (depends on the gated
heartbeat/telemetry contract); Velopack / MSIX / Intune (the stack is already electron-builder,
the evidence favours it, and none of them solves the transaction-safe install gate for us).

## 4. Architecture

```
Release CI (tag, protected env) ──sign via cloud HSM (OIDC)──▶ signed NSIS + latest*.yml
        │                                                          │
        └── publish to `lab` channel only ─────────────────────────▶ HTTPS static origin
                                                                   (provider-neutral)
POS main process                                                     │
  UpdateService (packaged-only, single init)  ◀── generic provider ──┘
    ├─ ChannelConfig       (lab | canary | stable, set at provisioning)
    ├─ download (background; differential with full-download fallback)
    ├─ verify  (sha512 from yml + Authenticode publisherName — fail closed)
    ├─ CompatGate          (release manifest vs. known Backend-Core window)
    └─ SafePointGate ──▶ quitAndInstall only when safe
  Migration runner
    └─ SchemaAheadGuard    (refuse start if DB is ahead of this build)
```

The updater lives in the main process only (constitution: main owns the auto-updater). The
renderer gets at most a read-only `update status` through the typed preload bridge. It never gets
an install trigger that bypasses `SafePointGate`.

Integration boundary: POS talks to the static origin for artifacts, and to Backend-Core only
through existing contracts until the §9 contract exists. POS never talks to ERPNext.

## 5. Signing and integrity boundary (D2)

1. **Key custody:** the signing key exists only inside the cloud HSM. No `.pfx`, no USB token,
   no key material on laptops, in the repo, in Jira or in Confluence.
2. **Who can sign:** only the release workflow, from a tag on `main`, in a protected GitHub
   environment with required reviewer approval, using a federated OIDC identity scoped to that
   environment. PR CI never signs.
3. **Timestamping is mandatory** (RFC 3161). Cloud-HSM certificates are short-lived; without a
   timestamp, a signed artifact fails verification shortly after signing.
4. **Updater verification is explicit, never defaulted:** `publisherName` is pinned to the stable
   certificate subject (the organisation name, not a rotating thumbprint). Verification failure,
   missing signature, sha512 mismatch or an inability to run verification means **do not install**.
   Upstream has historically skipped verification when `publisherName` was absent; we never rely
   on that default.
5. **Fail closed is visible:** a verification failure or "cannot verify" outcome is recorded as an
   update state (`verify_failed` / `verify_unavailable`), logged, and surfaced. It is never a
   silent stall. A locked-down terminal that cannot run the verification step must show up, not
   quietly stop updating.
6. **Release-time proof:** the release workflow verifies the signature of the produced installer
   and fails the release if verification does not pass.
7. **Defence in depth:** TLS is required for the origin. Authenticity comes from the Authenticode
   signature and sha512, not from the transport. Whether TLS pinning remains a MUST is a
   constitution decision (§11).

## 6. Safe-point install policy (D4)

**Predicate** `isSafeToInstall()` is true only when **all** of the following hold:

- no open shift / cash session exists in local SQLite;
- no sale, tender, payment attempt or return is in flight (cart empty, no non-terminal
  `payment_attempts` row);
- no receipt print job is in progress;
- the downloaded update is fully verified (§5) and passes `CompatGate` (§7).

**Triggers.** The same predicate is evaluated at both trigger points; there is no second code path:

1. on the shift-close event (after cash-up is committed);
2. on app start, before sign-in. Because shifts persist across restarts, an app start with a
   still-open shift is **not** a safe point.

**Rules.**

- Download may happen at any time in the background. It never blocks the cashier UI.
- `autoInstallOnAppQuit` is disabled. Quitting the app never installs implicitly; only the
  predicate does.
- The cashier sees a non-blocking "update ready, installs after shift close" indicator.
- A terminal whose shift is never closed stays `update_pending`. That is visible state, not
  silence. Compliance pressure on such terminals comes later through minimum-supported
  enforcement (§9), never through a forced mid-shift restart.
- Pending outbox rows (sales, returns, sync state) survive the install unchanged.

## 7. Compatibility gate and deployment order (D5)

**Deployment order (binding):** Backend-Core is deployed first, POS second. Backend-Core API
changes consumed by POS must be additive (expand) and must keep the previous released POS version
working (window ≥ N-1 POS minor) until that version is below the minimum supported.

**Phase 1 gate (release-time, testable now):**

- A POS release may be tagged only from a `main` commit whose `tests/contract/backend-core`
  conformance step and `codegen:verify` passed.
- The release records the Backend-Core `origin/main` SHA and the OpenAPI snapshot it was verified
  against, in the release notes or manifest metadata.
- A release that needs a Backend-Core change is not promoted past `lab` until that Backend-Core
  change is deployed to the environment the cohort uses.

**Phase 2 gate (runtime):** a POS-side `CompatGate` that refuses to install a release whose
declared Backend-Core window excludes the backend this terminal is paired to. This **requires**
Backend-Core to advertise a contract version, which does not exist today. It is delivered only
through the §9 contract and is not assumed by Phase 1.

## 8. Rollback, halt and SQLite migration safety (D6)

**Roll-forward only (P-3).**

1. `allowDowngrade` is `false`. **Ordering rule:** in at least some electron-updater versions,
   setting `autoUpdater.channel` also sets `allowDowngrade = true`. The implementation therefore
   sets the channel first, then forces `allowDowngrade = false`, and a unit test asserts the final
   state. This behaviour must be re-checked against the exact pinned version.
2. **SchemaAheadGuard (the real enforcement):** at startup, if `schema_migrations` contains any
   name that the running build has no migration file for, the app refuses to start (fail closed)
   with a clear operator-facing error and a log record. This holds no matter how an older binary
   reached the machine (updater, manual installer, copied folder).
3. **Shipped migrations are immutable:** a migration file that has shipped in any signed release
   is never edited, renamed, renumbered or deleted. A bad migration is corrected by a new
   migration in a higher version. The existing checksum column records the applied content.
4. **Pre-migration snapshot:** on the first start of a new version with pending migrations, the
   app writes a consistent DB snapshot (e.g. `VACUUM INTO`) under `userData/backups/`, retaining a
   bounded number of snapshots. Snapshots are for support-assisted recovery only. There is no
   automatic restore, because a restore would discard business facts captured after the snapshot.
5. **Business evidence is never deleted:** update, halt and recovery never clear the outbox,
   sales, returns, payment attempts, shifts or audit rows.

**Halt.** A halt reverts the affected channel's `latest*.yml` to the last known-good version.
- Terminals that have not updated stay on their current version.
- Terminals that have updated refuse the lower offer (rule 1) and stay on the bad version until a
  fix version is published.
- Promotion of the halted version to later stages stops.

**Recovery.** Publish a higher version (e.g. `1.4.1` carrying the `1.3.x` behaviour, plus every
migration that `1.4.0` shipped, plus any corrective migration). Promote it through the normal
stages, which may be shortened by owner decision for a hotfix.

**Identifying affected terminals.** Phase 1: the Sentry release (`app_version`) plus operator
inventory of the small fleet. Phase 2: the Device Registry fleet view (§9).

## 9. Fleet visibility and minimum-supported version (D7)

**Ownership is settled** by the Device Registry baseline (Confluence 23887876):
- the Backend-Core Device Registry owns the data;
- the Admin-Console Devices fleet view, filterable by version and update channel, is the operator
  surface;
- POS reports facts and never decides fleet truth.

**Delivery is gated.** POS sends no version today and the heartbeat/telemetry contract is gated.
A single bounded contract follow-up (Planning + Orchestrator ADR) defines, together:

- how POS reports installed version, channel/cohort and update state to Backend-Core
  (alongside or within the RT-138 `last_seen_at` signal);
- Backend-Core-held **latest / recommended / minimum-supported** versions, which are distinct
  concepts;
- the compliance-block behaviour for below-minimum software. This is **not** a trust revoke; the
  exact POS-facing behaviour is part of that contract;
- the runtime compatibility signal for §7 Phase 2;
- (optional, later) server-assigned cohort and halt directives, replacing static per-terminal
  channels.

Display rules from the baseline apply: unknown or unreported signals are shown as **Unknown**,
never Healthy, and version, connectivity, sync and update state stay separate dimensions.

**POS update states** (the vocabulary for logs, UI and the future contract):
`idle`, `checking`, `downloading`, `downloaded`, `verify_failed`, `verify_unavailable`,
`compat_blocked`, `update_pending` (waiting for a safe point), `installing`, `error`.

## 10. Channels, staged rollout and promotion (D3)

| Stage | Channel | Population | Exit criteria (all required) |
|:--|:--|:--|:--|
| 1 Lab | `lab` | rt9 lab + bench terminals | Verification drill (§12) green on the exact signed artifact |
| 2 Canary | `canary` | named pilot terminals (owner-chosen) | ≥ 1 full business day per canary terminal with ≥ 1 shift close and install; no new crash class in Sentry for the release; no rise in sync dead-letter or `stuck` outbox; zero `verify_*` failures |
| 3 Cohort | `stable` with `stagingPercentage` | bounded % of stable terminals | Same signals over a soak window the owner sets per release |
| 4 GA | `stable` at 100 % | all | — |

- Channel membership is a per-terminal setting written at provisioning (Phase 1) and is not
  user-editable at the cashier surface. With the `generic` provider a terminal reads only its own
  `${channel}.yml`, so the release process publishes every promoted `stable` release into the
  `canary` and `lab` channel files too; earlier-stage terminals never fall behind `stable`.
- Each promotion is a deliberate, recorded action (manual workflow with approval). Nothing
  promotes automatically.
- **A failed stage stops promotion.** Any exit criterion failing means halt (§8), not "continue
  and watch".
- `stagingPercentage` is random, not group-targeted. Named-group targeting is a Phase 2
  capability of the §9 contract.

## 11. Preconditions and constraints

1. **Constitution amendment (precondition for the updater slice):** replace the fixed feed domain
   with a provider-neutral, configurable HTTPS origin, and decide whether update-feed TLS
   certificate pinning stays a MUST or becomes optional defence in depth, given Authenticode
   verification. Until amended, the existing MUSTs stand.
2. **Update identity freeze:** `appId` (`tech.smartdatapulse.pos`) and `productName` (`POS Pulse`)
   are the update identity and the install location. They must be confirmed (or changed) **before**
   the first signed NSIS release; changing them afterwards breaks the update chain.
3. **Pilot migration:** pilot terminals on the unpacked `dir` build cannot auto-update into NSIS.
   The first installed build is a one-time manual, runbook-driven install per terminal. That
   procedure must keep `userData`, and must not cross Windows users, because DPAPI is per-user.
4. **Dependencies and CI changes** (NSIS target, `electron-updater`, release workflow) are
   explicitly out of scope here and belong to the implementation follow-ups that authorise them.

## 12. Verification contract (testable acceptance)

Unit / integration (in the implementation slices):

- `UpdateService` initialises once and only when `app.isPackaged`; dev startup never contacts
  the origin.
- After channel selection, `allowDowngrade === false` and `autoInstallOnAppQuit === false`.
- `isSafeToInstall()` is false for each of: open shift, non-empty cart, non-terminal payment
  attempt, in-flight return, in-flight print. It is true only when all are clear. The same
  function is used by both triggers.
- `SchemaAheadGuard` refuses start when `schema_migrations` contains an unknown name, and allows
  start when the DB is equal to or behind the build.
- The pre-migration snapshot is written before the first pending migration, and the bounded
  retention is enforced.

Lab drill (Verification slice, on the rt9 lab with real signed artifacts):

1. A signed update installs at shift close; it does **not** install with a shift open or mid-sale.
2. App start with an open shift does not install.
3. A tampered artifact (sha512 mismatch) is rejected; an unsigned artifact is rejected;
   `verify_failed` is visible.
4. An artifact older than the signing certificate's lifetime still verifies (timestamp works).
5. A locked-down terminal profile either verifies or reports `verify_unavailable`; it never
   installs unverified and never stalls silently.
6. Halt: reverting the channel to N-1 is refused by terminals on N; terminals on N-1 stay.
   Roll-forward to N+1 installs.
7. A manually installed older build on a newer DB refuses to start (`SchemaAheadGuard`).
8. Pending outbox rows before the update are present and still drain after it.
9. Differential update failure falls back to a full download.

## 13. Bounded follow-ups

| # | Work Mode | Repo | Scope | Depends on |
|:--|:--|:--|:--|:--|
| F1 | Docs | Orchestrator + POS constitution | ADR "POS delivery and update" recording §3–§10; constitution amendment for feed domain and TLS pinning (§11.1); update-identity freeze (§11.2) | — |
| F2 | Implementation | POS | `SchemaAheadGuard` + pre-migration snapshot (§8 rules 2–4). No updater, no dependency changes. | — |
| F3 | Implementation | POS | Per-user NSIS target + release workflow with cloud-HSM signing, timestamping, release-time signature verification, publish to `lab` only (§5). Includes signing-service onboarding. | F1 |
| F4 | Implementation | POS | `UpdateService`, `SafePointGate`, channel config, update-state vocabulary, read-only status bridge (§4, §6, §8.1, §10). | F1, F2, F3 |
| F5 | Planning | Backend-Core + Admin-Console (+ Orchestrator ADR) | Fleet version / update-state reporting, latest/recommended/minimum-supported, compliance block, runtime compat signal, optional cohort directives (§7 Phase 2, §9). Shares scope with the gated heartbeat contract; relates to RT-287. | F1 |
| F6 | Verification | POS (rt9 lab) | Lab drill §12 on real signed artifacts; pilot `dir` → NSIS migration runbook dry-run (§11.3). | F3, F4 |

## 14. Next safe action

**F1:** record the Orchestrator ADR and the constitution amendment. Every implementation slice
depends on it, and it changes no code.
