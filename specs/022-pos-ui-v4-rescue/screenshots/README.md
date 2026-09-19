# Screenshot evidence — 022 POS UI v4.0 Rescue

Visual evidence for each 022 slice. A slice is **not** complete on source review alone
(tasks.md §Standing constraints).

---

## Naming convention

```
<slice>-<surface>-<before|after>.png
```

Examples: `u4a-sale-success-before.png`, `u0-sale-workspace-after.png`.

| Rule | Requirement |
|:--|:--|
| Format | PNG, lossless, no scaling |
| Size | ≤ ~400 KB each; prune superseded captures |
| Content | Dev fixture data only |
| Redaction | **No secrets, tokens, pairing codes or real PII in frame** (constitution P7/P17) |
| Claim | The slice PR names which `visual-references/` image it was compared against |

Capture with the OS tool (`Win + Shift + S`) or Electron DevTools device-frame capture.
**No Playwright/Puppeteer** — adding one is out of scope for this feature (quickstart §5).

---

## T003 — baseline full-suite result

Captured on `main` before `feat/022-us4a-sale-success-honesty` diverged.

```
npm test
Test Files  468 passed (468)
     Tests  5538 passed | 3 skipped (5541)
```

This **matches the expected baseline** recorded in tasks.md T003 exactly
(468 files / 5538 passed / 3 skipped / 0 failed). It is the regression reference for every
later slice.

### Post-US4a suite result

```
Test Files  469 passed (469)
     Tests  5553 passed | 3 skipped (5556)
```

Delta is exactly this slice's additions: **+1 file, +15 tests**. All six pre-existing tests that
touch the settled surface pass **unmodified** (see `u4a` note below).

---

## T002 — dev launch verification

> ⏳ **NOT YET RUN — blocking for every screenshot task, not for source work.**

T002 requires a human-observed Electron launch. Per quickstart §3 there are two checks with
**different** pass conditions:

- **(a) Operator bypass — REQUIRED.** The `operator.dev_bypass.active` warn line MUST appear.
  If absent, the session is not the fixture operator and no screenshot can be honestly
  attributed to a surface. **STOP.**
- **(b) Catalogue — EITHER** the `catalogue.dev_seed.active` warn line appears, **OR** verified
  evidence that the catalogue already holds usable products (a successful barcode/SKU lookup or
  search in the running app, or a direct row-count read of the dev DB). Record which check was
  used. An *empty* catalogue with no seed line is a **STOP**.

Record the result here when run:

```
(a) operator.dev_bypass.active : [ ] observed   [ ] ABSENT → STOP
(b) catalogue readiness        : [ ] seed line  [ ] verified data (method: ______ )
```

### ⚠️ The dev bypass signs in as MANAGER, not cashier

`DEV_OPERATOR_FIXTURE_SESSION_INPUT` is hardcoded `role: 'manager'`
(`src/main/operator/dev-skip-operator-signin.ts`) and there is no role-override env var. The
bypass therefore **cannot** evidence any cashier-specific behaviour — including FR-44's cashier
landing (U1) and every cashier-role gated state.

A genuine cashier session needs a provisioned cashier PIN row for the dev
tenant/branch/terminal, signed in through the PIN pad (local-only, no backend). **A manager
screenshot is not an acceptable substitute for a cashier-role acceptance capture.**

---

## Slice captures

### u4a — Sale-success honesty

| Capture | Status |
|:--|:--|
| `u4a-sale-success-before.png` | ⏳ pending T002 |
| `u4a-sale-success-after.png` | ⏳ pending T002 |

**Before-capture note:** if a pre-divergence build is no longer available, record
`no before-capture available (first slice)` here rather than reconstructing one. An honest
absence is acceptable; a manufactured artifact is not.

**Reference image:** `visual-references/05-sale-success.png`.

> **The after-capture for this slice is pre-v4.0 palette** (US4a runs before U0's token work, and
> is constrained to existing semantic tokens). It is **superseded by T083** after U0 lands.
