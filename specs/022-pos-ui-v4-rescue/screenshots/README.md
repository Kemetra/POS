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

> ✅ **VERIFIED PASS — 2026-09-19. No longer blocking.** Full evidence below.

T002 requires an actual Electron launch, with the result read from the **rotating main-process log
file** (see the root-cause note below — NOT from terminal stdout). Per quickstart §3 there are two
checks with **different** pass conditions:

- **(a) Operator bypass — REQUIRED.** The `operator.dev_bypass.active` warn line MUST appear.
  If absent, the session is not the fixture operator and no screenshot can be honestly
  attributed to a surface. **STOP.**
- **(b) Catalogue — EITHER** the `catalogue.dev_seed.active` warn line appears, **OR** verified
  evidence that the catalogue already holds usable products (a successful barcode/SKU lookup or
  search in the running app, or a direct row-count read of the dev DB). Record which check was
  used. An *empty* catalogue with no seed line is a **STOP**.

### ✅ T002 VERIFIED — 2026-09-19 20:17 (agent-run launch, PASS)

```
(a) operator.dev_bypass.active : [x] OBSERVED  -> PASS (no STOP)
(b) catalogue readiness        : [x] verified data (method: direct row-count read of the dev DB)
```

**(a) Operator bypass — the mandatory check — PASSED.** The warn line is present for this launch:

```json
{"level":"warn","time":"2026-09-19T17:17:02Z","event":"operator.dev_bypass.active",
 "packaged":false,"flag":"POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN","role":"manager",
 "msg":"DEV BYPASS: auto-signing-in with fixture manager session. Never enable in a packaged build."}
```

Followed by `read_down_driver:started`, `finalize_listener:started`, `sale_sync_engine:started`,
`app:ready`, and a live `cart.create.ok` — a healthy boot.

**(b) Catalogue — PASSED via the data branch, not the log branch.** No
`catalogue.dev_seed.active` line appeared, which is CORRECT and expected here:
`applyDevSeedCatalogueIfRequested` no-ops and returns `false` when the catalogue is already
populated. Verified directly instead (read-only, run through Electron's node because
`better-sqlite3` is built for Electron's ABI, not plain Node):

```
products         = 50
product_barcodes = 49
```

Usable catalogue data is present, so this is a pass — not the empty-catalogue STOP.

---

#### Why the three earlier attempts were inconclusive — root cause found

The earlier INCONCLUSIVE record blamed Windows stdout redirection. **That diagnosis was wrong.**

The real cause: **the main-process logger never writes to stdout at all.** It writes to a
daily-rotating FILE via `pino` plus a rolling stream (`src/main/logging/logger.ts:204-243`), under
`app.getPath('logs')`:

```
<AppData>/Roaming/pos-pulse/logs/main-.<YYYYMMDD>.1.log
```

Only the stderr FALLBACK path — used when the rolling stream fails to initialise — would ever reach
a terminal. So no amount of piping, `stdio` wrangling or `ELECTRON_ENABLE_LOGGING=1` was going to
surface those lines. They were in a file the whole time.

> **Lesson for whoever runs this next: read the log FILE, not the terminal.**
> The quickstart's phrasing ("the warn line MUST appear") reads as though it appears in the console;
> it appears in the rotating log. Checking the terminal alone yields a FALSE STOP — which is exactly
> what happened here until the logger was traced.

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


---

## Modified-test ledger (auditable, cumulative)

The standing constraint reads: *"Behavioural tests must pass unmodified. Only tests encoding an
owner-superseded **design decision** may change (T020–T022 only)."* Quickstart §7 scopes that to
"3 dark-default assertions in `theme-contract.test.ts`".

Implementation touched more test files than that literal reading allows. Each edit is defensible
on its own, but the set is wider than the spec granted, so it is tabled here rather than left for a
reviewer to discover in the diff.

| File | Slice / task | What changed | Why it encoded a superseded decision | Structural guarantee preserved |
|:--|:--|:--|:--|:--|
| `styles/__tests__/theme-contract.test.ts` | U0 / T020 | Default-register assertions dark → light | **Explicitly sanctioned** (spec A2, owner decision A) | Dark register exists; token-VALUE overrides only; no forked components; RTL systemic; persistence — all verbatim |
| `styles/__tests__/no-brand-font.test.ts` | U0 / T026 | `--font-family-sans` assertion no longer requires `'Inter Variable', Inter` | It pinned the exact unresolvable fonts T026 removes — the Arabic-fallback defect 022 exists to fix | Guard's real subject kept + strengthened: must lead with an Arabic-capable system face, must NOT contain Inter, must stay system-resolvable, no `@font-face` |
| `shell/regions/__tests__/ThemeToggle.test.tsx` | U0 / T021-T022 | Boot register dark → light; round-trip direction and at-rest label inverted | Assumed the superseded dark default as its fixture state | Unchanged in kind — still proves the button is wired to the store and a click repaints the root. No assertion removed or relaxed |
| `ui/operator/__tests__/ManagerAdminSignInForm.test.tsx` | U1 / T054 | `toHaveTextContent(/credentials not recognised/i)` → `toHaveTextContent(SIGN_IN_REFUSAL_COPY.invalid_input)` | Hardcoded the English literal the Arabic-first copy change replaces | Stronger than before: asserts the canonical copy SYMBOL, so it survives any future wording change. The security property is pinned by `data-category`, which is untouched |

| `ui/operator/__tests__/ManagerAdminSignInForm.test.tsx` | U1 / T054 | 22 `getByLabelText` label queries → `getByTestId`; submit assertion → "carries an Arabic label" | Queried by the English presentation copy T054 replaces | Same behaviours asserted via stable testids the inputs already carried. No markup added for tests; no assertion weakened |
| `routes/__tests__/sign-in-route.test.tsx` | U1 / T054 | 6 `getByLabelText` label queries → `getByTestId` | Same — coupled to superseded English labels | Identical flows, stable selectors |
| `ui/operator/__tests__/PinPad.dot-only-guard.test.tsx` | U1 / T054 | 3 literal `"N of 6 entered"` matches → count-based assertions | Pinned English wording of a live-region label now Arabic | **Strengthened**: now also asserts the label NEVER contains the PIN value — the security property the file exists to defend |

**Owner approval (explicit):** narrowly updating tests coupled to superseded English presentation
copy was authorised for T054. It did NOT authorise broader test rewrites or behaviour changes, and
none were made.

**T054 correction of record:** an earlier note in `tasks.md` claimed the T053 evidence files query
by the English labels. **They do not** — verified by grep; the only match in
`cashier-walling.test.tsx` is inside a comment. The real coupling was two files, both listed above.

**Not modified, and verified so (T053):** `__tests__/cashier-walling.test.tsx` and
`routes/__tests__/operator-route-guard.test.tsx` — 28 tests green, `git diff --name-only` empty.
That is the evidence U1's landing correction stayed a navigation change and never became an
access-control change.
