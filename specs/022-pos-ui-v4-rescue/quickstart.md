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
export POS_PULSE_DEV_ITEM_RESOLVER=1

# cashier-journey feature flags
export POS_PULSE_FEATURE_CART=1
export POS_PULSE_FEATURE_PAYMENTS=1
export POS_PULSE_FEATURE_SALE_FINALIZATION=1
export POS_PULSE_FEATURE_PRODUCT_SEARCH=1

npm run dev
```

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

Launching is not evidence the bypass worked. Confirm the warn lines in the main-process log
**before** trusting what is on screen:

```
operator.dev_bypass.active     — "DEV BYPASS: auto-signing-in with fixture manager session…"
catalogue.dev_seed.active      — "DEV SEED: inserting fixture catalogue rows…"
```

If they are absent, the surface on screen is **not** the one you think you reached.

*Why this step exists:* during the 022 audit, Electron launched cleanly and stayed running, but
neither line ever appeared — so no screenshot could be honestly attributed to a surface. That is the
exact failure this check prevents.

Note: `applyDevSeedCatalogueIfRequested` also no-ops when the catalogue is **already populated**, so
absence of the seed line is not automatically a failure — confirm which case applies.

---

## 4. Surface map

| Surface | Route | Reached by | Notes |
|:--|:--|:--|:--|
| Pairing | `/pairing` | unset `POS_PULSE_DEV_SKIP_PAIRING` | |
| Sign-in | `/sign-in` | unset `POS_PULSE_DEV_SKIP_OPERATOR_SIGNIN` | roster + PIN pad |
| Landing | `/app` | after sign-in | **today:** dashboard for all roles; **after U1:** cashier → `/app/cart` |
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
