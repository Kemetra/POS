/**
 * T005 — Frozen forbidden allowlist for the source-scope guard.
 *
 * Originally authored for 003-pos-ui-shell, which had a strict no-touch
 * contract over the preload / IPC / bridge layers (those belonged to
 * 002 and were stable). 004-operator-session legitimately extends
 * those same layers (T014 extends `src/shared/bridge-api.ts` with the
 * `operator.*` namespace; T026–T028 add `src/main/ipc/operator.ts` and
 * `src/main/operator/*`; T032 wires the preload bridge), so the
 * 003-era prefixes for those layers are removed here. Any future
 * feature that wants to extend them MUST update this list with
 * justification.
 *
 * Permanently-forbidden paths (still off-limits to 004 S1 per the
 * user's hard constraints + the constitution):
 *
 *   - `src/main/pairing/`         — 002's territory; do not edit.
 *   - `src/main/secrets/`         — 001's safeStorage layer.
 *   - `src/shared/api-types.ts`   — generated; only `npm run codegen:api`
 *                                   may regenerate it (NOT in S1).
 *   - `scripts/codegen-api.ts`    — the codegen tool itself.
 *   - `scripts/openapi-snapshot.json` — pinned snapshot; S1 owner
 *                                   decision (b) keeps it untouched.
 *   - `.github/workflows/`        — CI config; S1 does not change CI.
 *
 * The list is a `readonly` const so it cannot be mutated at runtime.
 */
export const FORBIDDEN_PATH_PREFIXES = [
  'src/main/pairing/',
  'src/main/secrets/',
  'src/shared/api-types.ts',
  'scripts/codegen-api.ts',
  'scripts/openapi-snapshot.json',
  '.github/workflows/',
] as const satisfies readonly string[];

export type ForbiddenPathPrefix = (typeof FORBIDDEN_PATH_PREFIXES)[number];

/**
 * CI-maintenance branches (prefix `ci/`) are the sole exception to the
 * `.github/workflows/` block — their purpose IS CI config.  All other
 * forbidden prefixes remain blocked even on `ci/` branches.
 */
export const CI_MAINTENANCE_BRANCH_PREFIX = 'ci/' as const;
export const CI_MAINTENANCE_EXEMPT_PREFIXES = [
  '.github/workflows/',
] as const satisfies readonly ForbiddenPathPrefix[];

/**
 * `feat/002-dev-skip-pairing-fixture` is an explicitly approved 002
 * terminal-pairing dev fixture branch.  Its sole purpose is to add
 * `POS_PULSE_DEV_SKIP_PAIRING` dev-only support inside `src/main/pairing/`.
 *
 * `src/main/pairing/` remains forbidden for all other feature slices.
 * This exemption is NOT a general permission for future pairing changes —
 * any future branch touching `src/main/pairing/` must add its own
 * justified exemption here.
 */
export const PAIRING_DEV_FIXTURE_BRANCH_PREFIX = 'feat/002-dev-skip-pairing-fixture' as const;
export const PAIRING_DEV_FIXTURE_EXEMPT_PREFIXES = [
  'src/main/pairing/',
] as const satisfies readonly ForbiddenPathPrefix[];

/**
 * `feat/006-*` branches implement 006-payments-tender Slice 4 §A2 voucher
 * V-A contract pin (T200–T203) and may regenerate the two codegen artefacts.
 *
 * Authority: §A2 voucher contract sign-off recorded in
 * `specs/006-payments-tender/coordination.md` (Plan v1.0 — Slice 4 §A2
 * verification subsection). Upstream contract: Data-Pulse-2 PR #316,
 * merge commit 90261f2 (source commit aedb757).
 *
 * Exemption is narrow: only the two codegen artefacts. All other forbidden
 * prefixes (`src/main/pairing/`, `src/main/secrets/`, `scripts/codegen-api.ts`,
 * `.github/workflows/`) remain blocked on `feat/006-*` branches.
 */
export const FEAT_006_PAYMENTS_BRANCH_PREFIX = 'feat/006-' as const;
export const FEAT_006_PAYMENTS_EXEMPT_PREFIXES = [
  'src/shared/api-types.ts',
  'scripts/openapi-snapshot.json',
] as const satisfies readonly ForbiddenPathPrefix[];

/**
 * `feat/008-t094a-*` branches implement 008 T094a's POS-Pulse-side
 * pairing extension: six new `TerminalAssignmentRow` fields
 * (branch_name, branch_address, tenant_tax_registration_id,
 * printer_vendor_id, printer_product_id, printer_com_port) populated
 * from the post-PR #272 pinned `TerminalPairResponse`. Touches
 * `src/main/pairing/` store + service + dev fixture (002's territory)
 * because the contract pin from #272 cannot be consumed without
 * extending the row shape it's projected into.
 *
 * Authority: 008 plan §AD-12 + Slice 1 closeout-gap audit (POS-Pulse
 * PRs #267 / #268 / #271) + Slice 3 prep audit (PR #270) + the
 * contract pin landed in PR #272. Upstream contract: Data-Pulse-2
 * PR #388, merge commit 6c9dda2.
 *
 * Exemption is narrow: ONLY `src/main/pairing/`. All other forbidden
 * prefixes (`src/main/secrets/`, `src/shared/api-types.ts`,
 * `scripts/codegen-api.ts`, `scripts/openapi-snapshot.json`,
 * `.github/workflows/`) remain blocked on `feat/008-t094a-*`
 * branches. This exemption does NOT extend to other 008 work
 * (T094b/T094c/T028a etc. all touch their own non-forbidden
 * territory and need no exemption).
 */
export const FEAT_008_T094A_BRANCH_PREFIX = 'feat/008-t094a-' as const;
export const FEAT_008_T094A_EXEMPT_PREFIXES = [
  'src/main/pairing/',
] as const satisfies readonly ForbiddenPathPrefix[];

/**
 * `fix/pos-pairing-path` corrects the pairing client's request path from the
 * non-existent `/api/v1/terminals/pair` to the canonical contract path
 * `/api/pos/v1/terminals/pair` (matching the sibling `/api/pos/v1/sales` +
 * `/api/pos/v1/catalog/snapshot` clients). The old path 404s against the
 * deployed DP-2 backend, whose `posPairTerminal` consume endpoint shipped at
 * `/api/pos/v1/terminals/pair` (Data-Pulse-2 PR #541). The fix necessarily
 * touches `src/main/pairing/` (network.ts + its test).
 *
 * Exemption is narrow: ONLY `src/main/pairing/`. All other forbidden prefixes
 * (`src/main/secrets/`, `src/shared/api-types.ts` — the #349 api-types re-pin is
 * a SEPARATE task and is intentionally NOT touched here, `scripts/codegen-api.ts`,
 * `scripts/openapi-snapshot.json`, `.github/workflows/`) remain blocked on this
 * branch.
 */
export const FIX_POS_PAIRING_PATH_BRANCH_PREFIX = 'fix/pos-pairing-path' as const;
export const FIX_POS_PAIRING_PATH_EXEMPT_PREFIXES = [
  'src/main/pairing/',
] as const satisfies readonly ForbiddenPathPrefix[];

/**
 * `fix/380-*` is the P0 #380 fix for F-007 (the payment/sales/cart session
 * adapters stamped `terminal_id = session.branch_id`, collapsing every terminal
 * at a branch into one payment scope so one stuck attempt bricked them all). The
 * fix adds a synchronous `getCurrentTerminalId()` accessor to `PairingStore`
 * (`src/main/pairing/store.ts` + its service mock) so the adapters can source the
 * REAL terminal_id. The pairing module is the authoritative home of the
 * terminal_id, so the accessor must live there.
 *
 * Authority: issue #380 (P0, area:004-operator-session). Exemption is narrow:
 * ONLY `src/main/pairing/`. All other forbidden prefixes (`src/main/secrets/`,
 * `src/shared/api-types.ts`, `scripts/codegen-api.ts`,
 * `scripts/openapi-snapshot.json`, `.github/workflows/`) remain blocked.
 */
export const FIX_380_F007_BRANCH_PREFIX = 'fix/380' as const;
export const FIX_380_F007_EXEMPT_PREFIXES = [
  'src/main/pairing/',
] as const satisfies readonly ForbiddenPathPrefix[];

/**
 * `feat/349-*` is the #349 re-pin: replace the stale pharmacy-era catalogue
 * surface in the pinned OpenAPI snapshot with the DEPLOYED read-down contract
 * (`/api/pos/v1/catalog/snapshot` + `/deltas`, from DP-2
 * `packages/contracts/openapi/catalog/read-down.yaml`), then regenerate the
 * types. Its sole purpose is to update the two codegen artefacts — exactly the
 * `feat/006-` precedent.
 *
 * Authority: issue #349 (D-DEPLOY cleared 2026-06-15 — DP-2 main deployed to
 * the configured backend environment; `/api/pos/v1/catalog/snapshot` + `/deltas` serve 401, stale
 * `/catalog/products` → 404). Design:
 * `docs/superpowers/specs/2026-06-15-349-repin-readdown-contract-design.md`.
 *
 * Exemption is narrow: ONLY the two codegen artefacts. All other forbidden
 * prefixes (`src/main/pairing/`, `src/main/secrets/`, `scripts/codegen-api.ts`,
 * `.github/workflows/`) remain blocked on `feat/349-*` branches.
 */
export const FEAT_349_REPIN_BRANCH_PREFIX = 'feat/349-' as const;
export const FEAT_349_REPIN_EXEMPT_PREFIXES = [
  'src/shared/api-types.ts',
  'scripts/openapi-snapshot.json',
] as const satisfies readonly ForbiddenPathPrefix[];

/**
 * `claude/rt-215-*` implements Jira RT-215 (RT-138 P-1): the durable
 * device-revoked state and the pairing-recovery flow. A confirmed device 401
 * must be recorded on the pairing row (`terminal_assignment.device_revoked_at`,
 * migration 0042), reported by `PairingStore.getStatus()` as
 * `invalid / device_revoked`, cleared by a re-pair, and must stop the device
 * token from being read for sending. The pairing module is the single owner of
 * that state, so the change necessarily touches `src/main/pairing/` (store +
 * the device-401 detector + the sendable-token reader, and their tests).
 *
 * Authority: owner approval, Jira RT-215 comment 10875 (2026-10-05), decision
 * (4) — "a narrow, owner-approved exemption in `source-scope-guard.const.ts`
 * for the `claude/rt-215-` branch prefix, covering `src/main/pairing/` only".
 *
 * Exemption is narrow: ONLY `src/main/pairing/`, ONLY on `claude/rt-215-*`.
 * All other forbidden prefixes (`src/main/secrets/`, `src/shared/api-types.ts`,
 * `scripts/codegen-api.ts`, `scripts/openapi-snapshot.json`,
 * `.github/workflows/`) remain blocked on these branches. Narrowness is
 * asserted by `source-scope-guard-rt215.test.ts`.
 */
export const RT_215_DEVICE_REVOKED_BRANCH_PREFIX = 'claude/rt-215-' as const;
export const RT_215_DEVICE_REVOKED_EXEMPT_PREFIXES = [
  'src/main/pairing/',
] as const satisfies readonly ForbiddenPathPrefix[];

/**
 * `claude/rt-228-*` implements Jira RT-228: Backend-Core returns terminal-pairing
 * errors in the canonical envelope `{ "error": { "code", "message" } }`
 * (`pos-terminal-pairing.openapi.yaml` `components.schemas.Error`), but POS's
 * `mapFailure` switched on a flat top-level `body.code`, so every pairing error
 * (INVALID_CODE, EXPIRED_CODE, ALREADY_PAIRED, BRANCH_MISMATCH, RATE_LIMITED)
 * collapsed to `unknown_error`. The pairing module owns that mapping
 * (`src/main/pairing/failure-mapping.ts` + the `PairFailureBody` type in
 * `network.ts`), so the fix necessarily touches `src/main/pairing/`.
 *
 * Authority: owner approval, Jira RT-228 (2026-10-05) — "a narrow source-scope
 * exemption for the `claude/rt-228-` branch prefix, covering `src/main/pairing/`
 * only", following the RT-215 pattern.
 *
 * Exemption is narrow: ONLY `src/main/pairing/`, ONLY on `claude/rt-228-*`.
 * All other forbidden prefixes (`src/main/secrets/`, `src/shared/api-types.ts`,
 * `scripts/codegen-api.ts`, `scripts/openapi-snapshot.json`,
 * `.github/workflows/`) remain blocked on these branches. Narrowness is
 * asserted by `source-scope-guard-rt228.test.ts`.
 */
export const RT_228_PAIRING_ERROR_ENVELOPE_BRANCH_PREFIX = 'claude/rt-228-' as const;
export const RT_228_PAIRING_ERROR_ENVELOPE_EXEMPT_PREFIXES = [
  'src/main/pairing/',
] as const satisfies readonly ForbiddenPathPrefix[];

/**
 * `claude/rt-306-*` implements Jira RT-306 (RT-215 10901-(a), owner decision
 * 10906): the sealed device token is bound to the pairing row it was issued
 * for, so a crash between the token write and the row write during a re-pair
 * fails closed (`invalid/inconsistent`, never sent) instead of sending the new
 * token under the old terminal's identity. The binding lives in the pairing
 * store and its token readers (`src/main/pairing/store.ts`, `device-token.ts`,
 * `token-binding.ts`), so the fix necessarily touches `src/main/pairing/`.
 *
 * Authority: owner approval, 2026-10-08 (recorded on Jira RT-306): "a narrow
 * source-scope exemption for the `claude/rt-306-` branch prefix, covering
 * `src/main/pairing/` only", following the RT-215 / RT-228 pattern.
 *
 * Exemption is narrow: ONLY `src/main/pairing/`, ONLY on `claude/rt-306-*`.
 * All other forbidden prefixes (`src/main/secrets/`, `src/shared/api-types.ts`,
 * `scripts/codegen-api.ts`, `scripts/openapi-snapshot.json`,
 * `.github/workflows/`) remain blocked on these branches. Narrowness is
 * asserted by `source-scope-guard-rt306.test.ts`.
 */
export const RT_306_PAIRING_TOKEN_BINDING_BRANCH_PREFIX = 'claude/rt-306-' as const;
export const RT_306_PAIRING_TOKEN_BINDING_EXEMPT_PREFIXES = [
  'src/main/pairing/',
] as const satisfies readonly ForbiddenPathPrefix[];
