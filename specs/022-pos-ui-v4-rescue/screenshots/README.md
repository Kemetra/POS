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

---

## ✅ T028 VERIFIED — Arabic typography on target hardware (2026-09-19, PASS)

**Verified by the owner** on target Windows hardware, against the running v4.0 build — the same
launch that cleared T002 above.

**Result:** Arabic renders **cleanly** through the configured stack:

```
--font-family-sans: 'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif;
```

### What this closes

T026 replaced a stack that led with `'Inter Variable', Inter` — faces that resolve to **nothing**
in this app (no package, no `@font-face`, no bundled file), so Arabic fell through to uncontrolled
OS fallback. That was the original defect. It is now both fixed and confirmed on the hardware the
terminal actually ships to, still with **no package, no `@font-face` and no bundled file** — so the
`no-brand-font` guard stays green.

### The approval gate is NOT triggered

[`research.md` §1](../research.md) makes the webfont question strictly conditional:

> *"No approval is required for the system-stack approach. An approval gate is triggered **only if**
> U0's on-target-hardware verification shows the system stack cannot meet FR-10/FR-11 quality — at
> which point bundling a webfont becomes an owner decision, raised before any package is added."*

The stack met the bar, so:

- bundling a webfont (Noto Kufi Arabic / Cairo / Tajawal) remains **rejected**;
- **no owner decision is owed**, and none should be raised;
- no dependency, `@font-face` rule or font file enters the build.

Had it failed, the task's instruction was explicit — **STOP and escalate**, never fix it in-slice.
It passed, so U0's typography work is complete as shipped.

### ⚠️ The dev bypass signs in as MANAGER, not cashier

`DEV_OPERATOR_FIXTURE_SESSION_INPUT` is hardcoded `role: 'manager'`
(`src/main/operator/dev-skip-operator-signin.ts`) and there is no role-override env var. The
bypass therefore **cannot** evidence any cashier-specific behaviour — including FR-44's cashier
landing (U1) and every cashier-role gated state.

A genuine cashier session needs a provisioned cashier PIN row for the dev
tenant/branch/terminal, signed in through the PIN pad (local-only, no backend). **A manager
screenshot is not an acceptable substitute for a cashier-role acceptance capture.**

---

## T002 — per-capture gate evidence, 2026-09-22

> **T002 itself stays COMPLETED** (historical, verified 2026-09-19). This section records today's
> readings only, because the gate is **per-capture**: each capture launch must re-observe it.

**(b) Catalogue — PASS, unchanged.** Direct read-only row count of the dev DB
(`%APPDATA%/pos-pulse/pos-pulse.db`), run through Electron's node because `better-sqlite3` is built
for Electron's ABI:

```
products         = 50
product_barcodes = 49
```

Same usable dataset as the 09-19 and 09-20 verifications.

> **Resolution gotcha for whoever runs this next.** A probe script placed in a temp/scratchpad
> directory fails with `Cannot find module 'better-sqlite3'` — `require` resolves from the
> **script's own directory** upward, and there is no `node_modules` above `AppData\Local\Temp`.
> Running from the repo cwd does NOT help (cwd is irrelevant to file-based `require` resolution).
> Pass the repo path in and `path.join` it, or keep the probe inside the repo tree.

**(a) Operator bypass — NOT SATISFIED by today's launches.** The two runs recorded in
`logs/main-.20260922.1.log` (08:38:54Z and 08:40:12Z) show a healthy boot —
`db:opened` → `db:migrations-applied (36)` → `read_down_driver:started` → `app:ready` — but
**no `operator.dev_bypass.active` and no `pairing.dev_bypass.active`**, only
`operator.clerk.missing_publishable_key`. These were plain `npm run dev` launches **without the
documented dev env vars**, so the session is not the fixture operator.

**Consequence: no screenshot may be attributed to a surface from these launches.** This is the
documented STOP, and it is an environment fact, not a defect. **Any future capture requires a fresh
launch with the documented env block and a newly observed `operator.dev_bypass.active` line** read
from the rotating log file (not the terminal — see the root-cause note above).

### T0C2 cashier capture — BLOCKED, now with measured evidence

```
cashier_pin_records = 0 rows
```

(Table and its indexes exist — `cashier_pin_records`, `idx_cashier_pin_records_clerk` — from
migration `0036`'s rebuild. They are simply empty.)

Combined with the hardcoded `role: 'manager'` dev bypass, **a genuine cashier session is currently
unreachable by any means** — this is not merely "awaiting a manual snip". T0C2 cannot be captured
until a cashier PIN row exists.

> **OWNER RULING 2026-09-22 — do NOT unblock this from inside 022.** No direct `INSERT` of a PIN
> row, no dev fixture, and no change to `src/main/**`, `src/preload/**`, IPC or `migrations/**`.
> **POS-019 already owns the secure `provisionCashierPin` write path**; building a usable
> provisioning UI/path is **outside 022's renderer-only scope**. T0C2 stays blocked and honest.

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

### u2 — Sale workspace (cart-dominant layout)

> ⏸️ **DEFERRED 2026-09-20 → [#448](https://github.com/Kemetra/POS/issues/448).**
> U2 merged via PR #447 (`2b4b8be`) **without** its capture, so **FR-15 is visually unverified**
> and this slice is not visually accepted. See spec §Screenshot Acceptance → Outstanding captures.

| Capture | Status |
|:--|:--|
| `u2-sale-workspace-before.png` | ⏸️ deferred → #448 |
| `u2-sale-workspace-after.png` | ⏸️ deferred → #448 |
| `u2-sale-workspace-lone-cart-after.png` | ⏸️ deferred → #448 (P1 fix — never rendered) |
| ~~`u2-sale-workspace-narrow-after.png`~~ | ❌ **IMPOSSIBLE — dropped.** See [#450](https://github.com/Kemetra/POS/issues/450) |

**Reference image:** `visual-references/03-sale-workspace.png`.

**Before-capture:** a real one IS available — U2's merge-base is `e7390f9`. Record
`no before-capture available` only if that turns out to be unbuildable; it is not the first slice.

#### ✅ T002 gates verified on 2026-09-20 — historical record, NOT a standing pass

> ⚠️ **Re-verify both gates on every capture launch.** This result certifies only the `dbe14d4`
> launch below. #448 needs **new** launches — at least one from a *different revision* (`e7390f9`
> for the before-capture) — and the dev DB can be reset or repopulated in between. Quickstart §3
> requires observing `operator.dev_bypass.active` and confirming current catalogue data precisely
> because an absent bypass or a reset database invalidates the surface: evidence could otherwise be
> attributed to the wrong session or captured against unusable data. Keep this record for
> reference; do not treat it as clearance for a later launch.

What passed on that launch:

```
(a) operator.dev_bypass.active : [x] OBSERVED (role=manager) -> PASS (no STOP)
(b) catalogue readiness        : [x] verified data (direct row-count read of the dev DB)
                                     products = 50 · product_barcodes = 49
```

Launched on `main` @ `dbe14d4` with `POS_PULSE_DEV_SKIP_PAIRING`,
`POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN`, `POS_PULSE_FEATURE_CART`,
`POS_PULSE_FEATURE_PRODUCT_SEARCH` all `=1`. Boot was healthy:
`pairing.dev_bypass.active` → `operator.dev_bypass.active` → `cart.create.ok`.

#### ⛔ `POS_PULSE_DEV_ITEM_RESOLVER` MUST be **unset** for a catalogue-seeded capture

The two resolvers are mutually exclusive, not layered. `createCartBridgeHandlers` picks the
**five-SKU fixture** resolver whenever the build is unpackaged *and* `POS_PULSE_DEV_ITEM_RESOLVER`
is truthy, otherwise 009's catalogue-backed production resolver
(`wire-cart-handlers.ts:68-77`).

The confirm action submits the **catalogue** `product_id` (`CatalogueAddController.tsx:94-97`) —
seeded rows are `dev-p-001`… — but the fixture map knows only `SKU-PARA-500`, `SKU-IBUP-400`,
`SKU-AMOX-250`, `SKU-VITA-C`, `SKU-OMEP-20` (`resolve-item-ref.ts:23-31`). With the flag set, every
searched product is refused `unknown_item` and **the non-empty cart the capture requires cannot be
reached**.

The launch block for #448 — copy verbatim; every name is read only in its full `POS_PULSE_*` form
(`dev-skip-pairing.ts`, `dev-skip-operator-signin.ts`, `main/index.ts`, `dev-seed-catalogue.ts`), so
an abbreviation silently does nothing and leaves the app pairing-gated with an empty catalogue:

```bash
export POS_PULSE_DEV_SKIP_PAIRING=1
export POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN=1
export POS_PULSE_FEATURE_CART=1
export POS_PULSE_FEATURE_PRODUCT_SEARCH=1
export POS_PULSE_DEV_SEED_CATALOGUE=1

# ACTIVELY unset — omitting is not enough if an earlier launch exported it
# in this shell (a commented-out export clears nothing).
unset POS_PULSE_DEV_ITEM_RESOLVER

npm run dev
```

**Verified 2026-09-20 by executing this block** in a shell that already had
`POS_PULSE_DEV_ITEM_RESOLVER=1` exported (the returning-executor case): the `unset` cleared it,
`pairing.dev_bypass.active` + `operator.dev_bypass.active` both fired, and the catalogue-backed
resolver was selected. 0 of the 50 seeded `product_id`s overlap the five fixture SKUs — which is
exactly why the flag must stay unset.

(The alternative — fixture resolver on, catalogue seed off, adding a fixture SKU — does not exercise
the 009 search → confirm → cart path the capture is meant to show.)

##### Captures #2 and #3 need a DIFFERENT launch

The block above serves captures **#1** and **#4** only. `CartWorkspace` passes
`showCatalogue={productSearchFlag}`, so with `POS_PULSE_FEATURE_PRODUCT_SEARCH=1` the catalogue is
always rendered and the lone-cart state is unreachable.

- **#2 lone cart** — relaunch with product search **off**:

  ```bash
  export POS_PULSE_DEV_SKIP_PAIRING=1
  export POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN=1
  export POS_PULSE_FEATURE_CART=1
  unset POS_PULSE_FEATURE_PRODUCT_SEARCH   # <- the point of this capture
  unset POS_PULSE_DEV_ITEM_RESOLVER
  npm run dev
  ```

  ⚠️ **Known limitation — this capture will show an EMPTY lone cart.** With search off there is no
  in-app way to add a catalogue line, and **you cannot carry one over from the block above**:
  each launch creates a *new* cart rather than resuming the previous one (verified 2026-09-20 —
  consecutive launches produced distinct `cart_id`s, both `state=empty`).

  That is acceptable for this capture's **purpose**, which is the P1 fix — showing the lone cart
  fills the workspace instead of collapsing into a 380px rail beside dead space. Dominance of an
  empty region is still visible. It is **not** FR-15 evidence; capture #1 carries that.

  Do **not** hand-edit the DB to fake a populated lone cart. A manufactured artifact is worse than
  an honestly empty one (spec §Screenshot Acceptance requires the surface be *reached honestly*).

- **#3 narrow terminal — ❌ DROPPED, cannot be captured.** `useViewportTier` treats anything under
  **1024px** as `too-small` (`useViewportTier.ts:6`) and `AppShell` then renders `ScreenTooSmall`
  **instead of** its `<Outlet />` (`AppShell.tsx:63-74` vs `:121`). `/app/cart` is a child of that
  outlet (`router.tsx:167-183`), so below 1024px `.sale-layout` does not render at all and the shot
  cannot contain it. `@media (max-width: 1023px)` and the supported tier `>= 1024px` are exactly
  complementary — **the rule is unreachable, so there is no window width that shows both.**

  No workaround is legitimate: DevTools device emulation drives `matchMedia` identically, and
  raising the tier floor to force the view would be *editing code to manufacture the view*, which
  §Screenshot Acceptance requirement 2 forbids. Tracked as a code question in
  [#450](https://github.com/Kemetra/POS/issues/450) (4 such `max-width: 1023px` blocks exist; the
  fix is delete-the-dead-rules or lower the tier floor, an owner call). **#448 is 3 captures, not 4.**

#### ⚠️ An empty cart cannot evidence FR-15 — new constraint, applies to future slices too

Verified against the live dev DB during this launch: the boot cart is `state: "empty"` with **0
lines**, and **no dev fixture seeds cart lines** — `POS_PULSE_DEV_SEED_CATALOGUE` populates the
*catalogue* only (`dev-seed-catalogue.ts`). FR-15 is about line items and the running total
dominating, so the capture requires a product **searched and confirm-added by hand** first. A
launch-and-shoot of the empty workspace would not evidence the requirement.

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

| `ui/payments/__tests__/tender-surface-recompose.test.tsx` | U3 / Phase C (`94e4864`, `abc8751`) | (a) 3 × `.amount-due-card` **presence** assertions retargeted to **absence** in `CashEntry`, `ExternalCardTerminalEntry`, `VoucherEntry`; (b) 1 voucher-refusal literal `This voucher cannot be used right now.` → `تعذّر استخدام هذه القسيمة حالياً.` | (a) The file required each *entry* component to render its own amount-due card — the v3.5 recompose requirement. FR-16 + the v4 handoff make `PaymentSurface` the **sole** owner of the amount due; a per-entry copy put the same value on screen twice at two sizes, defeating the hierarchy the slice exists to create. (b) Same class as the already-authorised T054 English-copy updates — the literal pinned English wording now Arabic in source (`VoucherEntry.tsx:51`). | (a) **Strengthened, and verified present:** the local "is present" check is replaced by a GLOBAL "exactly one amount-due presentation" count in `single-amount-due.test.tsx` (`:154-155` assert `.amount-due-card` length 0 surface-wide; `:151` asserts the single `payment-surface-amount-due`; `:171-192` re-assert per-entry absence). No assertion dropped — each is retargeted in place with a comment at the original site. (b) The security property is untouched: the test still asserts the structured reason (`voucher_not_found`) NEVER reaches the DOM. |

> ⚠️ **OWNER RULING 2026-09-22 — T074 REMAINS UNCHECKED. Recorded as a spec-reality mismatch.**
>
> This fifth row carries **no explicit owner authorization**, unlike the four above it: the standing
> constraint grants test changes for superseded design decisions **"T020–T022 only"**, and this file
> was modified under **T070/T076 (Phase C)** citing FR-16 and the design handoff — not an owner
> decision on record.
>
> **T074's literal requirement is that the payment/FSM tests pass "unmodified". PR #455 modified a
> payment test, so T074 is NOT satisfied as written.** It is therefore left **unchecked**, and was
> explicitly *not* marked pass-with-exception — a literal requirement either holds or it does not,
> and grading it on a curve would silently redefine the bar for every later reader.
>
> **Disposition: carry into the next `/speckit-analyze` as a spec-reality mismatch**, where the
> reconciliation is either (a) ratify the Phase C retarget under an amended grant, or (b) record a
> scoped exception, or (c) restore the original assertions. That is a spec-amendment decision, not
> a closeout one, and it is deliberately NOT resolved here. Task wording, IDs, labels and the
> standing constraints are left untouched by this closeout.
>
> **The evidence stands on its own** (gathered 2026-09-22, independent of the disposition):
> the suite is green at **487 files / 5688 passed / 3 skipped / 0 failed**; the money/FSM/guard
> files T074 names are genuinely **untouched** (`parse-currency-to-minor.test.ts`,
> `PaymentSurface.money-safety-guards.test.tsx`, `CashEntry.no-overapply.test.tsx`,
> `CashEntry.currency-input.test.tsx`, `PaymentSurface.settled-receipt.test.tsx`); four of the five
> changed files are **new additions** mandated by T070/T071/T075/T076, not modifications; and the
> single modified file is the one tabled in the row above. A green suite cannot answer "unmodified"
> — that is a git claim, verified here by
> `git diff 94e4864^..HEAD -- src/renderer/ui/payments/__tests__/**`.

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
