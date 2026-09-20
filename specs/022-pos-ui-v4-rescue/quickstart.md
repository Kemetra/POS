# Quickstart — POS UI v4.0 Rescue (developer path)

**Feature ID:** 022-pos-ui-v4-rescue
**Plan:** [./plan.md](./plan.md)

How to launch the terminal, reach each cashier surface **honestly**, and capture the screenshot
evidence every visual slice requires.

---

## 1. Launch

```bash
npm install          # first run only
npm run dev          # vite (5173) + electron, concurrently
```

`npm run dev` bundles the preload, compiles the main process, waits for Vite, then launches
Electron. A stale server on 5173 fails loudly rather than launching against the wrong renderer.

---

## 2. Reaching gated surfaces — the verified dev path

Four cashier-journey flags are **fail-closed** (`false` by default), so a default build shows
placeholders rather than the till. Reaching them for visual work uses existing dev env vars.

```bash
# pairing + operator session + catalogue fixtures
export POS_PULSE_DEV_SKIP_PAIRING=1
export POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN=1
export POS_PULSE_DEV_SEED_CATALOGUE=1

# ⛔ ACTIVELY UNSET — do not merely omit. It conflicts with the seed above
#    (see the note below), and a shell that ran an earlier version of this
#    block still has it exported, where commenting out a line changes
#    nothing. Only set it for the fixture-SKU-only path in the table below.
unset POS_PULSE_DEV_ITEM_RESOLVER

# cashier-journey feature flags
export POS_PULSE_FEATURE_CART=1
export POS_PULSE_FEATURE_PAYMENTS=1
export POS_PULSE_FEATURE_SALE_FINALIZATION=1
export POS_PULSE_FEATURE_PRODUCT_SEARCH=1

npm run dev
```

> ### ⛔ `DEV_SEED_CATALOGUE` and `DEV_ITEM_RESOLVER` conflict — pick one
>
> They are **mutually exclusive resolvers, not layers.** `createCartBridgeHandlers` selects the
> five-SKU **fixture** resolver whenever the build is unpackaged *and*
> `POS_PULSE_DEV_ITEM_RESOLVER` is truthy; otherwise it uses 009's **catalogue-backed** resolver
> (`wire-cart-handlers.ts:68-77`).
>
> The catalogue confirm action submits the seeded `product_id`
> (`CatalogueAddController.tsx:94-97`) — `dev-p-001`… — but the fixture map knows only
> `SKU-PARA-500`, `SKU-IBUP-400`, `SKU-AMOX-250`, `SKU-VITA-C`, `SKU-OMEP-20`
> (`resolve-item-ref.ts:23-31`). Set both and **every catalogue add is refused `unknown_item`**, so
> no cart can be populated through the 009 search → confirm path.
>
> | Goal | `DEV_SEED_CATALOGUE` | `DEV_ITEM_RESOLVER` |
> |:--|:--:|:--:|
> | Add a **real catalogue** product via search/scan (any capture needing a non-empty cart) | `1` | **unset** |
> | Exercise 005's fixture SKU path alone, no catalogue | unset | `1` |
>
> *(Caught by Codex review on PR #449 — an earlier draft of the #448 capture instructions set both.)*

### Why this is safe (verified in source)

Every dev bypass hard-returns `false` when the app is packaged — a **compiled-in guard**, not a
convention:

```ts
if (deps.isPackaged) return false;                       // dev-skip-operator-signin.ts:75
if (!isTruthy(deps.env['POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN'])) return false;
```

Same shape in `dev-seed-catalogue.ts` and the cart item-resolver. **Production feature-flag defaults
are never modified** — these are per-process env vars for a dev build only.

> ⚠️ **Never commit an env change, and never edit source to make a surface appear.** If a surface
> cannot be reached honestly, that is a finding to report — not something to work around.

---

## 3. Verify the bypass actually engaged — do not skip

Launching is not evidence the bypass worked. Two separate checks, with **different pass conditions**.

### (a) Operator bypass — the log line is REQUIRED

```
operator.dev_bypass.active     — "DEV BYPASS: auto-signing-in with fixture manager session…"
```

If this line is absent, the session is **not** the fixture operator and the surface on screen is not
the one you think you reached. **STOP.**

*Why this step exists:* during the 022 audit, Electron launched cleanly and stayed running, but this
line never appeared — so no screenshot could be honestly attributed. That is the exact failure this
check prevents.

### (b) Catalogue — EITHER the log line OR verified data

```
catalogue.dev_seed.active      — "DEV SEED: inserting fixture catalogue rows…"
```

**Do not treat the absence of this line as a failure.** `applyDevSeedCatalogueIfRequested` **no-ops
and returns `false` when the catalogue is already populated** (`dev-seed-catalogue.ts` —
`if (alreadyPopulated(deps.db)) return false`), so on any re-run against an existing dev DB it will
legitimately never appear.

Pass condition is **either**:

- the seed line appears (fixtures inserted this launch); **or**
- you verify the catalogue **already holds usable products** — a barcode/SKU lookup or a search
  returning results in the running app, or a direct row-count read of the dev DB.

Record which check you used. What matters is that usable catalogue data is **present**, not that it
was inserted on this particular launch. An **empty** catalogue with no seed line is a STOP.

---

## 4. Surface map

| Surface | Route | Reached by | Notes |
|:--|:--|:--|:--|
| Pairing | `/pairing` | unset `POS_PULSE_DEV_SKIP_PAIRING` | |
| Sign-in | `/sign-in` | unset `POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN` | roster + PIN pad |
| Landing | `/app` | after sign-in | **today:** dashboard for all roles; **after U1:** cashier → `/app/cart` |

> ⚠️ **The dev bypass signs you in as a MANAGER, not a cashier.**
> `DEV_OPERATOR_FIXTURE_SESSION_INPUT` is hardcoded `role: 'manager'`
> (`src/main/operator/dev-skip-operator-signin.ts:40-47`) and there is no role-override env var. So
> the bypass **cannot** evidence any cashier-specific behaviour — including FR-44's cashier landing
> and every cashier-role gated state.
>
> To reach a genuine **cashier** session: leave `POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN` unset, provision
> a cashier PIN row for the dev tenant/branch/terminal, and sign in through the PIN pad. That path is
> **local-only** — no backend needed (`sign-in-handler.ts:362`, `backend_session_id: ''`).
>
> A manager screenshot is **not** an acceptable substitute for a cashier-role acceptance capture.
| Sale workspace | `/app/cart` | nav or landing | needs `CART` + `PRODUCT_SEARCH` |
| Checkout / tender | `/app/checkout` | "continue to payment" from a non-empty cart | needs `PAYMENTS` |
| Sale success | `/app/checkout` (settled) | settle a payment | needs `SALE_FINALIZATION` for a receipt |
| Dev state variants | `?state=loading\|empty\|error` | dev-only URL param | `useDevToggles`, tree-shaken from prod |
| Connection states | `?conn=online\|degraded\|offline\|syncing` | dev-only URL param | |

---

## 5. Capture screenshots

**Before** (where the surface pre-exists) → implement → **after**.

```
specs/022-pos-ui-v4-rescue/screenshots/<slice>-<surface>-<before|after>.png
```

Examples: `u4a-sale-success-before.png`, `u0-sale-workspace-after.png`.

| Rule | Requirement |
|:--|:--|
| Format | PNG, lossless, no scaling |
| Size | ≤ ~400 KB each; prune superseded captures |
| Content | Dev fixture data only |
| Redaction | **No secrets, tokens, pairing codes or real PII in frame** (constitution P7/P17) |
| Claim | The slice PR names which `visual-references/` image it was compared against |

Capture with the OS tool (`Win + Shift + S`) or Electron DevTools device-frame capture. **No
Playwright/Puppeteer** — adding one is out of scope for this feature.

---

## 6. Gates before calling a slice done

```bash
# targeted first — fast feedback
npx vitest run src/renderer/<area>

# then the wider gates
npm run typecheck
npm run lint
npm test                 # baseline: 468 files / 5538 passed / 3 skipped
npm run build:renderer   # slices touching CSS/tokens
```

A slice is **not** complete on source review alone. It needs: after-screenshot + reference
comparison + green gates + the slice's a11y/keyboard checks.

---

## 7. Working rules for this feature

1. **Tokens are the only place colour changes.** Need a literal? You found a missing token — add it
   in U0, not locally.
2. **Reference images never create features.** Check the spec's Non-Capability Inventory before
   treating anything in an image as a requirement.
3. **Behavioural tests pass unmodified.** Only tests encoding an owner-superseded *design decision*
   may be updated (currently: 3 dark-default assertions in `theme-contract.test.ts`).
4. **Renderer-only.** No `src/main/`, `src/preload/`, `src/shared/bridge-api.ts`, or `migrations/`
   (constitution P8).
