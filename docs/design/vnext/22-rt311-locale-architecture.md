# 22 — RT-311: POS Arabic/English locale architecture and staged i18n rollout (PROPOSED)

> **Status: PROPOSED — owner review pending.** Nothing here is approved, implemented or shipped.
>
> - **Jira:** **RT-311** (Work Mode: **Planning**). Parent W2 (RT-2); cross-cutting RT-106. Related:
>   RT-266 (Admin-Console locale plan, Done), RT-241 (W1-A, Done), RT-242 / RT-243 / RT-244 /
>   RT-257 (In Review), RT-258 / RT-259 (Done), RT-261, RT-262, RT-279, RT-252.
> - **Authority used:** Constitution v1.7.0 (`.specify/memory/constitution.md`), Confluence
>   [UX-12](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/24477697) (incl. "POS
>   Two-Locale Product Target — 2026-10-08"),
>   [UX-11](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/23166988), `docs/DESIGN.md`,
>   `15-vnext-freeze-package.md` §5 (copy rules, M-F1…M-F3).
> - **Read limits:** the UX-11 and UX-12 rule sections came back as headings only through the
>   Confluence API. Their stress-test, gap and two-locale sections were read in full. The rule
>   bodies must be re-checked in the Confluence UI when L0 is written.
> - **Baseline:** `Kemetra/POS origin/main@837b0866`. The code inventory was taken at `9689500`;
>   the only commit between the two (#665) changes docs and specs, not `src/`.
> - **Not authorized by this document:** any source, config, package, lockfile, CI, migration or
>   Jira change; a locale selector; English copy; a receipt or catalog-contract change.
> - **RT-241 / PR #579:** RT-241 is Done and #579 is merged (`f63c77d`). This plan does not reopen
>   it. The "do not expand #579" exclusion in RT-311 is therefore already satisfied.

---

## 0. Summary

POS is Arabic-only today, and is close to locale-neutral **structurally**. It has almost no
physical-direction CSS, the bidi isolation of numbers is good, and plural and formatter helpers
already exist. It is **not** locale-neutral in **content**. Copy is spread across ~14 per-surface
copy modules and inline JSX, `dir="rtl"` / `lang="ar"` is re-declared on 29 leaves (including the
Dialog portal), main-process dialogs build Arabic text directly, and some English strings remain
in Arabic mode.

The recommended architecture adds **no dependency**. It is a small typed message catalog on top
of `Intl`, which generalises what RT-257 and RT-258 already built:

1. Main owns the locale. It is a **terminal-level** preference stored in main, and **main
   enforces** whether a switch is allowed.
2. The root `lang` / `dir` follows the locale. Leaves never re-declare direction; they only
   isolate machine data (`<bdi>` / `dir="ltr"`).
3. Arabic is the source catalog. The English catalog is type-checked for key parity, and a
   missing translation falls back to the approved Arabic. A raw key or backend English is never
   shown.
4. The UI locale changes **only** UI chrome. It does not change receipt language, product names,
   digits (Western in both), money format (`1,250.00 EGP` in both), the Store business timezone,
   or the OS keyboard layout.

The rollout runs in eight slices, **L0–L7**. The first four are Arabic-only refactors with zero
visible change. English becomes selectable only at the end, behind owner-approved copy and a
packaged two-locale verification. **An ADR plus a constitution amendment (L0) is required before
any locale-switch code (L5).**

---

## 1. Inventory (RT-311 deliverable 1)

Read-only. Counts come from a grep/regex sweep and are **heuristic**: they include some comments
and strings. Production numbers exclude dev and proof harnesses.

### 1.1 Document direction and language

| Finding | Where | Consequence for English LTR |
| --- | --- | --- |
| Root is static `<html lang="ar" dir="rtl" data-theme="light">` | `src/renderer/index.html:16` | It must become locale-driven. CSP `script-src 'self'` forbids an inline pre-paint script, so the attribute must be set from `main.tsx` before `createRoot` (the same pattern as `initTheme`). |
| `dir="rtl"` re-declared on **29** leaf elements; `lang="ar"` in 7 files (11 occurrences) | e.g. `v5/sale/SaleCart.tsx` (8), `routes/app/DashboardView.tsx`, `routes/sign-in.tsx:222`, `ui/operator/ReauthDialog.tsx:30`, `ForcedCloseSurface.tsx:280`, `ScreenTooSmall.tsx:69`, `ScanGuardHost.tsx:99`, 5 spans in `PrinterFailureBanner.tsx` | These would stay RTL and Arabic-tagged inside an English page. They also contradict DESIGN.md §RTL ("components never re-declare RTL"). |
| **Dialog portal hard-codes direction**: `<div className="v5-dialog-backdrop" dir="rtl" lang="ar">` | `src/renderer/v5/foundation/Dialog.tsx:219` (portal to `document.body` or a host) | Every modal would stay RTL in English. It has to be derived from the locale, not inherited by accident. `CheckoutActionBar.tsx:44` portals into an in-tree slot and inherits correctly. |
| `dir="ltr"` on **76** sites (keypads, PIN, money, IDs, inputs) | e.g. `CashKeypad.tsx`, `PinPad.tsx`, `PaymentLedger.tsx` | Correct in both locales. Keep them. |
| `<bdi>` / `unicode-bidi: isolate` / `.rt-num` on ~73 sites | e.g. `returns/*.tsx` | Correct in both locales. Keep them. |

### 1.2 Physical-direction CSS

Only **4** physical declarations exist in `.css`, and there are **0** physical Tailwind utilities
or inline physical style props in `.tsx`:

- `styles/tailwind.css:1340-1343`: `[dir='rtl'] .dialog-panel { left: 50%; right: auto }`. This
  is a direction-scoped override, so it needs an LTR twin or a logical rewrite.
- `v5/cashiers/cashiers.css:311` and `v5/entry/entry.css:533`: `text-align: left` on LTR inputs.
  This is intentional, because the inputs are `[dir='ltr']`.

There are 285 logical CSS declarations. **No blanket RTL refactor is needed.** Direction-implying
icons have not been audited yet (L2 owns that audit).

### 1.3 Copy location (production; heuristic counts)

There are about **640** Arabic copy literals in production code (~760 including ~120 in
dev/proof/demo files such as `dev/*Proof.tsx`, `demo-sale.ts`, `dashboard-demo-data.ts` and
`dev-seed-catalogue.ts`).

- **Copy modules (already one place per surface):** `v5/shift/shift-copy.ts` (~100),
  `returns/returns-messages.ts` (~87), `v5/recovery/recovery-copy.ts` (~49),
  `v5/cashiers/cashiers-copy.ts` (~30), `v5/entry/entry-copy.ts` (~25),
  `ui/operator/messages.ts` (~19; the `RefusalCategory → copy` map), `routes/pairing/messages.ts`
  (~14), `scan/scan-messages.ts` (~11), `ui/payments/payment-read-copy.ts`,
  `connection/connection-state.ts`.
- **Inline JSX copy (no module):** `v5/sale/LiveSaleCart.tsx` (~24),
  `ui/payments/PaymentSurface.tsx` (~20), `v5/sale/SaleCart.tsx` (~18),
  `ui/sales-sync/SaleSyncStatus.tsx` (~16), `LiveProductRail.tsx`, `session/LockScreen.tsx`,
  `ProductRail.tsx`, `LiveCartParts.tsx`, `TenderPicker.tsx`, `ui/operator/PinPad.tsx`,
  `LiveSearchResults.tsx`, `CompletionPanel.tsx`, `PrinterFailureBanner.tsx`, and others.
- **Shared:** `shared/operator/role.ts:35-37` (role labels «كاشير» / «مدير» / «مسؤول النظام»),
  `shared/formatters/time-formatters.ts` (relative time).

### 1.4 English residue in Arabic mode (a UX-12 "one locale at a time" defect today)

- **Cashier-reachable:**
  - aria-labels: "Dismiss notification" (`Toast.tsx:37`, `ShiftClosedBanner.tsx:26`),
    "Connection status" (`StatusBanner.tsx:11`), "Loading" (`Button.tsx:19`), "Primary"
    (`NavRail.tsx:45`);
  - the English takeover sentences on sign-in, `ui/operator/TakeoverPrompt.tsx:112-157` ("You
    are already signed in on another POS terminal in this branch." — also the banned "branch"
    term, UX-12 «المتجر»);
  - `OperatorSlot.tsx` title.
- **Manager or legacy:**
  - `ui/states/LoadingState.tsx` step text (used only by the legacy placeholder routes);
  - `ForcedCloseSurface.tsx` and `FindSaleReceipt.tsx`;
  - `ThemeToggle.tsx`;
  - legacy routes `DashboardPlaceholder`, `DashboardSkeleton`, `DashboardView`,
    `SettingsSkeleton`, `SettingsHelpPlaceholder`, `InventoryPlaceholder`, `SalesWorkspace`,
    `AuditPlaceholder`, `checkout/CheckoutPlaceholder`;
  - `CatalogueDiagnostics`;
  - `ReceiptPreview.tsx` title.
- The brand "POS Pulse" (`TopBar.tsx:52`, `SaleScreen.tsx:11`) is a product name, not copy (D-L9).

### 1.5 Main-process and printed copy

- **Pre-renderer error dialogs** build Arabic in main:
  - `src/main/app/feature-flags.ts:105-108`;
  - `src/main/app/schema-ahead-refusal.ts:22-25`.

  A renderer-only preference such as the theme's `localStorage` cannot reach these, so the locale
  must live in main.
- **Receipts:**
  - `src/main/receipts/template-engine.ts` hard-codes **bilingual** labels («نقدًا — Cash»,
    «شكرًا لتعاملكم معنا — Thank you», «Change due — الباقي»), with one `display_name` per line
    and deliberately **no `Intl`** (byte-stability, FR-016).
  - `src/main/returns/returns-slip.ts` does the same («نسخة — COPY», «طريقة الصرف: نقدًا — Cash»).
  - Constitution §Localization / hardware requires receipt templates to be "version-controlled
    assets (not hardcoded strings)". This is an **existing gap**. It is recorded here and left out
    of scope.

### 1.6 Formatting

- **`renderer/ui/format/human-format.ts`** (RT-257, In Review):
  - a module constant `LOCALE = 'ar-EG-u-nu-latn'`;
  - money is built by integer arithmetic into `1,250.00 EGP` and is locale-independent;
  - dates use the terminal zone (Store timezone is RT-279).
- **`shared/formatters/arabic-plural.ts`** (RT-258): `Intl.PluralRules('ar')` plus full-sentence
  templates. This is the model for the generalised plural helper.
- **Other `Intl` callers:**
  - `v5/cashiers/cashiers-model.ts:55` uses `Intl.DateTimeFormat('en-GB')` for lock time. This is
    a second formatter, to be folded in L1.
  - `main/cart/park/park-rules.ts:27` uses `'en-CA'` for a **machine** day key. This is correct
    and not UI, so leave it.
- **Input:** RT-259 normalises Arabic-Indic and Persian digits in money, quantity and count
  inputs. `main/catalogue/normalize.ts` folds Arabic letters and digits for search.

### 1.7 Error-to-copy mapping

The bridge returns codes (`RefusalCategory`, payment states), and the renderer maps each code to
one approved Arabic string (`SIGN_IN_REFUSAL_COPY`). This already matches UX-12 "machine codes
drive copy". Keep it: catalogs extend the mapping and must not replace it.

### 1.8 Product names (server-provided)

- `products.name_ar := row.name` and **`name_en := null` always** in read-down data (D-NAME,
  GAP-3: `main/catalogue/read-down/map-sellable-row.ts:23,163-168`). Backend-Core sends one
  language-neutral `name`. Only the dev seed (`dev-seed-catalogue.ts`) sets `name_en`.
- The writer already folds both names: `name_fold = normalize(name_ar + ' ' + (name_en ?? ''))`
  (`read-down-writer.ts:145`), and `search.ts` matches `name_fold` / `alias_fold`. English names
  become searchable as soon as the contract delivers them.
- `LiveSearchResults.tsx:147` already renders `display_name_en` as a secondary line when present,
  which never happens with read-down data today.
- The cart freezes `display_name` (`ResolvedSeam`) at add time (005 FR-011/013). The sale and
  the receipt carry that single name (008 AD-6).

**Consequence:** per-locale product names are a **Backend-Core catalog contract change**
(cross-repo). POS cannot plan them alone (§6.1).

### 1.9 Keyboard and scanner

- `renderer/scan/scan-guard.ts:167-201` builds scan runs from `event.key`. A HID-wedge scanner
  types through the **OS keyboard layout**, so alphanumeric barcodes scanned under an Arabic
  layout may arrive as Arabic letters. This does not depend on the UI locale, but a bilingual
  rollout makes the mixed-layout bench case more likely (§5.4).
- Shortcuts: the F-key map is still open (D-K1 / RT-252).

### 1.10 Preferences and tests

- The theme persists in renderer `localStorage` (`stores/theme-store.ts`). There is no main-side
  settings store for UI preferences.
- **205** test files contain Arabic text (most of them assert approved copy). There is no catalog-parity or "no raw key" test, and
  no English test.

### 1.11 Governing-document conflicts (must be resolved before switch code)

| Source | Says | Conflicts with |
| --- | --- | --- |
| Constitution v1.7.0 §Localization | "The UI **MAY** use Arabic-Indic numerals" | UX-12 / DESIGN.md OD-3: **Western digits everywhere** |
| Constitution §Localization | "**Cairo** is the canonical Arabic typeface; Fraunces / JetBrains Mono" | DESIGN.md: `'Dubai', 'Segoe UI', Tahoma…` (shipped); RT-262 A/B |
| Constitution §Localization | No English UI locale | UX-12 "POS Two-Locale Product Target" |
| `15-vnext-freeze-package.md` §5 rule 1 | "Arabic only on cashier and manager surfaces … no English fallbacks" | UX-12 two-locale target. Read it as "one locale at a time" once L0 amends it; until then it still binds every slice. |
| DESIGN.md §RTL | "components never re-declare RTL" | 29 leaf `dir="rtl"` (§1.1) |
| Constitution hardware | receipt templates are version-controlled assets | hard-coded bilingual receipt labels (§1.5) |

---

## 2. Library choice (deliverable 2)

All approaches satisfy offline use (bundled catalogs) and CSP `script-src 'self'`, because none
of them needs `eval` once messages are precompiled or plain functions. Package data comes from
`npm view`, read-only, on 2026-10-15. Nothing was installed.

| Option | What it gives | Cost and risk here | Verdict |
| --- | --- | --- | --- |
| **A. In-house typed catalog on `Intl`** (extend `arabic-plural.ts` + `human-format.ts`) | Compile-time key parity (`satisfies`), plain TS functions for plurals and params, zero runtime, works in main **and** renderer, matches the existing per-surface copy modules | ~150 lines to own; no translator file format (TS is the format); ICU plural *selectors* are hand-written per message | **Recommended** |
| B. FormatJS / `react-intl` 12.1.4 (BSD-3; pulls `@formatjs/intl`, `intl-messageformat`, the ICU parser) | ICU MessageFormat, React provider, TMS-friendly JSON | New dependency tree (not authorized); string IDs lose type safety unless extra codegen; runtime parse unless precompiled with an extra CLI | Revisit trigger only |
| C. `i18next` 26.4.5 + `react-i18next` 17.0.16 (MIT) | Mature, plugins, namespaces | Largest surface; its JSON v4 plural suffixes duplicate what `Intl.PluralRules` already does; React-coupled (main dialogs need a second setup) | Not recommended |
| D. Lingui `@lingui/core` 6.9.1 (MIT; Babel macro plugin) | Compile-time ICU, small runtime, PO extraction | Adds a Babel macro step to a Vite 8 build (build-config change); message IDs from source text clash with "Arabic is source + approved copy" | Best **external** option if the revisit trigger fires |
| E. `Intl.MessageFormat` (TC39 proposal) | Native ICU | Not shipped in Electron 40 / Node 24 | Not available |

**Decision D-L1 (recommended): A.** Revisit, through an ADR, only if any trigger fires: an
external translator or TMS needs a file exchange, a third locale is approved, or the message count
outgrows hand-written plural selectors. If a trigger fires, prefer D, then B.

---

## 3. Locale contract and catalog strategy (deliverable 2)

### 3.1 Types (shared; no DOM, so safe in main and renderer)

```ts
// src/shared/i18n/locale.ts  (L1)
export type UiLocale = 'ar-EG' | 'en-GB';          // the exact English region is owner decision D-L2
export interface LocaleMeta {
  readonly lang: 'ar' | 'en';                       // → <html lang>
  readonly dir: 'rtl' | 'ltr';                      // → <html dir>
  readonly intlTag: 'ar-EG-u-nu-latn' | 'en-GB';    // → every Intl.* call (Western digits in both)
}
export const LOCALE_META: Readonly<Record<UiLocale, LocaleMeta>>;
export const DEFAULT_UI_LOCALE: UiLocale = 'ar-EG';
```

### 3.2 Catalog shape

- **One catalog per surface** (`src/shared/i18n/catalogs/<surface>.ts`, or next to the surface
  when only the renderer uses it). Each mirrors today's copy-module boundaries, so migration is a
  move, not a rewrite.
- **Arabic is the source.** English is typed against it:

  ```ts
  export const ar = { … } as const;
  export const en = { … } satisfies CatalogOf<typeof ar>;
  ```

  A missing English key is a **compile error**.
- **A message** is either a string or a pure function of typed params that returns a full
  sentence. **Never concatenate number + noun or sentence fragments.**
- **Plurals** use a generalised helper, `plural(locale, n, forms)`. Its forms are typed per
  locale: `ar` takes zero / one / two / few / many / other (as `pluralAr` does today); `en` takes
  one / other. `{n}` is formatted with `LOCALE_META[locale].intlTag`, so digits are Western.
- **Params are formatted before injection** with `human-format` (money, dates, counts). Catalogs
  never format.
- **Bidi:**
  - In React, machine data (money, barcode, SKU, sale or receipt number, terminal id, PIN) is
    isolated at the **component** level (`<bdi className="rt-num">`, or `dir="ltr"` for inputs and
    keypads) and is never embedded in the message string.
  - For plain-text sinks (aria-label, `title`, main-process dialogs), use an `isolate(text)`
    helper that wraps the run in U+2068 FSI … U+2069 PDI.
  - Server-provided product names use `dir="auto"` inside `<bdi>`.
- **Lookup:**
  - `t(locale, catalog, key, params?)` is pure (used by main and tests);
  - `useT(catalog)` reads the renderer locale store.

### 3.3 Safe fallback

1. English missing at runtime (cannot happen when typed, but guarded): render the **approved
   Arabic** message and record a dev-only log. Never render the key.
2. Unknown machine code from the bridge or backend: render the **state-specific generic** message
   for its category (as `SIGN_IN_REFUSAL_COPY` does). Never render backend English or an
   arbitrary `message` field.
3. A payment UNKNOWN state keeps its dedicated copy in both locales: «نتيجة الدفع غير مؤكدة» plus
   the duplicate-charge warning, with recovery-only actions. It never falls back to a generic
   "failed" message.

### 3.4 Glossary and naming authority (avoid two business-truth copies)

- **Authority:** UX-12 §Terminology on Confluence stays the one source. POS gets a
  `src/shared/i18n/glossary.ts` pinning the Arabic terms (المؤسسة / المتجر / الصنف / الوردية /
  الكاشير / المدير / الإيصال …) and their **owner-approved** English equivalents (D-L7).
- A glossary test fails when a catalog uses a banned variant, for example «الفرع» for Store.
- Admin-Console (RT-266 plan, `docs/design/arabic-first-rtl-migration-plan.md`) keeps its own
  catalog and points at the same UX-12 table. **No shared runtime or package** (UX-12). Any change
  to the shared table is made on Confluence first and then reflected in both repos.
- Catalogs hold **copy only**. Business state (cart, payment, sync, print proof) comes from codes
  and read models. A catalog never decides that something succeeded.

### 3.5 Semantic `lang` / `dir`

- The root `<html>` gets `lang` / `dir` from `LOCALE_META[locale]`, set in `main.tsx` before
  `createRoot` and again on every switch. `index.html` keeps the static `ar` / `rtl` as the
  first-paint default.
- Leaves **never** declare `dir="rtl"` or `lang="ar"`. A leaf declares `dir="ltr"` / `<bdi>` only
  for isolated machine runs, and `lang` only for an embedded run in the *other* language (for
  example an Arabic product name inside English UI: `<bdi lang="ar" dir="auto">`).
- Portals: `Dialog` derives `dir` / `lang` from the locale context instead of hard-coding them
  (§1.1), because a host outside `#root` must not depend on accidental inheritance.

---

## 4. Selection, persistence and switching (deliverable 3)

| Question | Recommendation | Why |
| --- | --- | --- |
| Scope (D-L3) | **Terminal-level** UI locale for v1. No per-operator preference. | Shared terminals hand over between operators. A per-operator flip at sign-in makes the PIN or roster screen change language under the next cashier. YAGNI until a store asks for it. |
| Who changes it (D-L4) | **Manager or admin only**, from a manager settings surface. The cashier sees no selector. | Avoids an accidental switch mid-shift. Role is enforced in main, like other manager actions. |
| Where it is stored (D-L5) | **Main process**, in a terminal-local setting (a `userData` JSON or a SQLite settings row; the choice is made in L5). Read synchronously at start-up. | Main builds pre-renderer dialogs (§1.5). The setting must survive renderer reloads and be readable before React. SQLite would need §A2, and the new channel needs §A4. |
| First run | `ar-EG`. Pairing, sign-in and Ready stay Arabic until a manager changes the setting. | The pilot is Arabic-first and nothing is configured before pairing. |
| Offline | Purely local. No backend read or write, and no sync. | The selector must work offline. A tenant or Store default from Admin is a later option (D-L6). |
| Switch guard (D-L8) | **Main refuses** a switch unless: the cart has no lines; no payment attempt is in a non-terminal state (started / pending / UNKNOWN); no recovery is open; no shift-close or cash-up is in progress. Refusal uses an existing category (`state_invalid` or `payment_in_progress`). The renderer hides or disables the control, but main is the authority, as with RT-245 `cart.undoLast`. | Financial and scanner safety: no relabelling of a live tender, no focus jump during a sale, and UNKNOWN copy is never re-rendered mid-recovery. Parked carts are allowed; their lines keep their frozen names. |
| How it applies | In-place re-render: update the locale store, set `<html lang/dir>`, move focus to the page heading, and make one polite announcement in the new language. **No reload.** The scan guard is untouched. | A reload would drop renderer-only state and focus. Cart and payment truth live in main anyway. |
| Audit | A local, non-financial audit event `terminal.ui_locale_changed` (actor, from, to). Its exact shape belongs to L5 (D-L10). | A configuration change on a shared terminal should be attributable. |
| What a switch never changes | Receipt or printed language, product and cart-line names, digits, money format, Store timezone, OS keyboard layout, permissions, error codes, idempotency. | UX-12 §Architecture and rollout guardrails. |

---

## 5. Layout, keyboard and accessibility acceptance (deliverable 4)

### 5.1 Viewport authority

Constitution v1.7.0 **Display** row (RT-312 D15) is unchanged by this plan:

- ≥ 1024×768 is the full reference;
- 600–767 high is a compact band, supported only after pilot-hardware verification;
- width < 1024 or height < 600 is **blocked** with the `ScreenTooSmall` notice. All three M-F2
  variants (width, height, both; RT-313) and the M-F3 compact-band notice (RT-412) need approved
  English twins in L6;
- 150 % Windows scale is **not supported** for the pilot;
- no auto-zoom.

**The sub-1024 fallback is not changed.**

### 5.2 Two-locale capture matrix (L7, and per-slice for touched surfaces)

- **Locales:** `ar-EG` RTL, and the English locale LTR.
- **Viewports:** 1024×768, 1280×800, and the pilot standard (≈1920×1009 at 100 %; ≈1536×793 at
  125 % with the menu bar removed).
- **Themes:** light, and Windows forced-colors (high contrast).
- **Motion:** reduced-motion on and off. Must be invariant (UX-06, RT-260).

At every point: no horizontal overflow, no clipped text, no hidden essential state, focus visible
and not obscured by pinned money or action regions, targets ≥ 44×44, amount due and commit never
scrolled away (RT-243 rule) in **both** directions, and axe clean.

### 5.3 Direction rules

- Keypads and PIN pads stay **LTR in both locales** (1-2-3 top row).
- Direction-implying icons mirror; search, scan, print, lock, clock and check never mirror
  (DESIGN.md).
- Reading order is importance order. In LTR, money and commit move to the inline end (right) by
  logical properties alone. Verify, do not assume.
- Mixed runs: an English label beside an Arabic product name (`dir="auto"`), and Western-digit
  money and IDs inside RTL or LTR sentences.

### 5.4 Keyboard layouts (ar-EG and en-GB / en-US OS input)

- POS **never** changes the OS input language. The UI locale and the keyboard layout are
  independent.
- Numeric inputs normalise Arabic-Indic and Persian digits in both locales (RT-259). PIN and code
  inputs remain LTR and ASCII.
- Product search accepts Arabic and Latin input through the existing fold (`normalize.ts`).
  English **names** are folded already, but read-down delivers none until §6.1 lands. Aliases
  and SKUs are searchable today.
- Shortcuts, once D-K1 is decided, must bind on `event.code` or F-keys, never on layout-dependent
  `event.key` letters.
- **Scanner bench (Verification, joins RT-252):** scan numeric (EAN-13) and alphanumeric
  (Code-128 with letters) barcodes with the OS layout set to Arabic (101) and to English. Record
  what `event.key` delivers. If letters arrive as Arabic, the first failing boundary is the
  `scan-guard` run builder. Fixing it is a separate Implementation issue, not part of the locale
  rollout.

### 5.5 Assistive technology

Narrator must switch voice by `lang` (root and embedded runs). Accessible names (aria-label,
`title`) come from the catalog in the active locale, so there is no English aria-label in Arabic
mode and no Arabic aria-label in English mode.

---

## 6. UI language vs catalog names vs receipts (deliverable 5)

### 6.1 Server-provided product names

- **v1 (both locales):** show the single server `name` as **data**. In English UI it stays as
  sent (usually Arabic), wrapped in `<bdi lang="ar" dir="auto">` where it is known to be Arabic
  and `dir="auto"` otherwise. The UI locale never translates or transliterates a product name.
- The cart-line `display_name` stays **frozen at add time** (005 FR-011/013, 008 AD-6). A locale
  switch never rewrites a cart, sale or receipt line.
- **Per-locale names are a separate decision.** They require a Backend-Core catalog contract that
  splits the name per locale (and probably a Connector mapping and an Admin edit surface). This is
  a **cross-repo contract**. Per CLAUDE.md §9, POS stops here. A separate **Planning** issue in
  Backend-Core is needed (R1 in §7.3). POS would then populate `name_en`, fold it for search, and
  choose a display rule. None of that is in this rollout.

### 6.2 Printed and fiscal receipts

- The receipt language is **independent of the UI locale**. A UI switch never changes printed
  output, legal or tax content, numbering, or the template engine's byte-stability (no `Intl` in
  `template-engine.ts`).
- Today's receipts are bilingual and hard-coded (§1.5). Whether receipts become per-Store
  configured templates, and in which language, is a **receipt/fiscal contract decision** (Store or
  tenant configuration owned by Backend-Core, ERP/fiscal implications). It is a separate Planning
  issue (R2), outside RT-311.
- Receipts keep Western digits (constitution) and integer-minor money.

### 6.3 Invariants that do not depend on the locale

- **Money:** `1,250.00 EGP` in both locales, grouped, two decimals, `EGP` after the number in an
  LTR-isolated run, minus U+2212. Arithmetic stays integer minor units.
- **Digits:** Western 0–9 in all system-generated output in both locales (`nu-latn` for Arabic).
- **Time:** the Store business timezone (RT-279) in both locales, 24-hour clock. Audit and
  evidence timestamps stay explicit UTC. `en-GB` gives day-month order. The decision is D-L2.
- **Terminology:** coordinated with Admin RT-266 through UX-12 (§3.4). No shared runtime.

### 6.4 Fonts

- Both locales use one `--font-family-sans` stack: `'Dubai', 'Segoe UI', Tahoma, Arial,
  system-ui, sans-serif` (`styles/tailwind.css:110`). There is no per-locale font switch.
- There is no `@font-face`, font package or bundled file (`tailwind.css:105-109`), so Dubai is a
  **Windows system-font dependency**. L7 verifies that it is present on the pilot image. If it is
  missing, the fallback is Segoe UI.
- In English, Latin glyphs come from Dubai first, not Segoe UI. Whether that is acceptable is a
  typography question for RT-262 (and the constitution's "Cairo" line, §1.11), not for this
  rollout. An English-specific font would be a new decision (D-L11), routed to RT-262.
- The mono stack for IDs and evidence is unchanged. Money typography stays as shipped (UX-03,
  RT-262).
- The receipt printer codepage (CP864 vs Windows-1256, flagged in `template-engine.ts`) belongs to
  R2, not to UI fonts.

---

## 7. Staged rollout (deliverable 6)

### 7.1 Global constraints (every slice)

- No new package or lockfile change unless the slice's Jira item explicitly authorizes it (D-L1
  needs none).
- Every Arabic-only slice (L1–L4) produces **zero visible change**. Its evidence is
  before-and-after captures at 1024×768 and 1280×800, light and forced-colors, plus green
  typecheck, lint and `test --coverage`.
- Safety-critical copy (UNKNOWN payment, refusals, re-auth, drawer notice, print-proof verbs)
  stays asserted as **literal approved Arabic** in tests, never read back from the catalog.
- Main stays authoritative for cart, payment, auth and the switch guard. The renderer never
  decides eligibility.
- Each slice re-verifies `origin/main` and cites `08-rt24-invariants.md` where it touches the
  cashier flow.

### 7.2 Slices

| ID | Work Mode | Scope | Depends on | Gate / DoR |
| --- | --- | --- | --- | --- |
| **L0** | Planning / Docs | (a) **Orchestrator ADR** "POS UI locale contract" covering §3–§4 and §6: locale set, terminal-level scope, main-owned preference, switch guard, separation from receipts and catalog names, glossary authority. (b) **Constitution amendment** to §Localization: Western digits in UI, two UI locales one at a time, a single catalog + formatter layer; the font line deferred to RT-262 / RT-261. (c) Amend `15-vnext-freeze-package.md` §5 rule 1 to "one locale at a time". (d) Owner decisions D-L1…D-L11. | RT-311 approval | Owner approves ADR + amendment. **Required before L5.** L1–L4 may start once D-L1 is approved, because they are Arabic-only. |
| **L1** | Implementation | Locale core: `src/shared/i18n/{locale,catalog,plural,isolate}.ts`; `plural()` generalises `pluralAr` (which stays as a wrapper); `human-format.ts` takes a `locale` param, defaulting to `ar-EG`; fold `cashiers-model.ts` `LOCK_TIME` into it; a renderer locale store fixed to `ar-EG`. | D-L1; **RT-257 merged** | Unit tests for plural (ar 0, 1, 2, 3, 10, 11, 100, 101; en 0, 1, 2) and for formatters in both tags; existing formatter tests unchanged. |
| **L2** | Implementation | Structural direction: root `lang/dir` from the store (still `ar-EG`); remove the 29 leaf `dir="rtl"` and the leaf `lang="ar"`; `Dialog` derives from the locale; LTR twin or logical rewrite for `tailwind.css:1340`; direction-icon audit; a lint guard against `dir="rtl"` in `src/renderer/**` (`no-restricted-syntax` in the existing ESLint, only if the slice authorizes the config edit). | L1; **RT-242/243/244 merged** | Pixel-parity captures in Arabic; Dialog tests (trap, Esc, focus return, portal direction) stay green. |
| **L3** | Implementation (split L3a / L3b / L3c by surface group) | Move copy into catalogs, Arabic only: (a) entry, sign-in, pairing, lock, Ready, ScreenTooSmall, scan; (b) sale, checkout, completion, recovery, sync status, receipts UI, banners; (c) shift, cashiers, returns, manager surfaces. **Translate the English residue in §1.4 into approved Arabic**, including aria-labels. Legacy placeholder routes (Dashboard / Settings / Inventory / Sales / Audit / CatalogueDiagnostics) are either catalogued or removed from cashier reach. That choice is owner decision D-L9. | L2 | No Arabic copy outside catalogs in production `src/renderer` (sweep test); literal-Arabic safety tests unchanged. |
| **L4** | Implementation | Main-process copy: pre-renderer dialogs (`feature-flags.ts`, `schema-ahead-refusal.ts`) read from a main-side catalog using `t()`; `role.ts` labels move to a catalog keyed by role code. | L1 | Dialog text unchanged in Arabic; tests pass. |
| **L5** | Implementation | Locale preference: the main-side store (D-L5), a bridge channel `settings.uiLocale.get/set` (preload + `bridge-api.ts`), role gate, the **main switch guard** (§4), the audit event, a manager settings control. Only `ar-EG` is selectable (English hidden behind a build or feature flag until L7). | **L0 approved**, L3, L4 | **§A4** bridge-security review; **§A2** if SQLite; guard tests (lines present / payment started / pending / UNKNOWN / recovery open → refused; idle → allowed); switch does not touch the cart or payment. |
| **L6** | Implementation + owner copy approval | English catalog for **every** catalog reachable on the terminal (one locale at a time means no partially English terminal), built from owner-approved English copy and glossary (D-L7). `ScreenTooSmall` M-F2, UNKNOWN, refusals and re-auth are approved string by string. | L5; D-L2, D-L7 | Type parity compiles; English-mode "no Arabic outside allowed isolates" sweep (§8); the English plural tests. |
| **L7** | Verification | Packaged two-locale matrix (§5.2) on pilot hardware; switch-guard runtime checks with a live cart and pending, UNKNOWN or recovery states; scanner bench under both OS layouts (§5.4); Narrator spot check. Enable the English selector only after owner acceptance. | L6 | Evidence posted to Jira; Lab and Bench Runbook updated. |

**Minimal English path:** L0 → L1 → L2 → L3 → L4 → L5 → L6 → L7. It is deliberately minimal and
excludes per-operator preference, English product names, English receipts, a pseudo-locale tool,
Admin-driven defaults and a third locale. L3a, L3b and L3c can run in parallel once L2 lands,
because they own different files. L4 can run in parallel with L2 and L3.

### 7.3 Related issues outside this rollout (create separately, after owner OK)

- **R1 — Backend-Core Planning:** per-locale catalog names (name split in the sellable-catalog
  contract, Connector mapping, Admin edit). It unblocks English product names in POS (§6.1).
- **R2 — Planning (Backend-Core + POS):** receipt language and templates as configured assets per
  Store, plus fiscal/legal review. It also closes the constitution "templates as assets" gap
  (§1.5).
- **R3 — Admin-Console:** RT-266 plan Q6 (English locale) is aligned to the same glossary
  (§3.4). No new POS work.
- **Scanner keyboard-layout fix** only if the L7 bench fails (§5.4).

---

## 8. Test strategy

| Layer | Test | Proves |
| --- | --- | --- |
| Type | `en satisfies CatalogOf<typeof ar>` in every catalog | No missing English key ships |
| Unit | `plural()` per locale and category; `human-format` per tag (grouping, negatives, zero, large values, isolation marks, midnight in Store timezone once RT-279 lands); `isolate()` | Grammar and digit rules |
| Unit | Literal approved-Arabic assertions for safety copy (UNKNOWN, refusals, re-auth, print-proof verbs, drawer notice); later, literal approved English for the same | The catalog did not drift from approved copy (a catalog-equals-catalog test proves nothing) |
| Unit | `t()` fallback: a missing English key returns Arabic and never the key; an unknown code returns the category generic | Safe fallback |
| Unit (main) | Switch guard matrix (§4) and role gate | Financial safety; main authority |
| Sweep | **Arabic mode:** no production `src/renderer` Arabic literal outside catalogs (after L3), and no Latin-letter text nodes outside allowed isolates. **English mode:** render each route and harness and fail on any Arabic character outside allowed isolates (product names, `lang="ar"` runs) | Hard-coded strings are caught in either direction |
| jsdom a11y | axe in both locales (pattern `ui/primitives/__tests__/axe-smoke.test.tsx`); root `lang`/`dir`; the Dialog portal carries the active locale's direction | Semantics and a11y |
| Visual | Captures per §5.2 (Arabic parity for L1–L4; both locales for L6 and L7) | Layout direction |
| Packaged | L7 matrix, scanner bench, Narrator | Runtime truth |

---

## 9. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Copy migration (L3) collides with in-review W1-B, W1-C and W1-D PRs touching the same files | Rework or conflicts | L2 and L3 wait for RT-242/243/244 to merge; L1 waits for RT-257 |
| A switch during a live tender relabels money or recovery copy | Financial misunderstanding | Main-enforced guard (§4), L7 runtime check |
| English UI shows Arabic product names | Mixed-language look | Accepted for v1 and stated in the ADR; R1 for real fix |
| Receipts assumed to follow the UI locale | Fiscal/legal error | ADR states independence; R2 owns receipts |
| Hard-coded leaf `dir="rtl"` reintroduced by new work | English layout broken | L2 lint guard; sibling-session note; DESIGN.md rule |
| Scanner under Arabic OS layout | Wrong or rejected alphanumeric scans | §5.4 bench; separate fix if it fails |
| English text expansion and Arabic line height at 1024 | Clipping or overflow | §5.2 matrix per touched surface |
| Constitution says Cairo and Arabic-Indic digits | Contradictory authority for implementers | L0 amendment before L5 |
| Catalog test that reads its own catalog | False confidence | Literal-copy rule for safety strings (§8) |

---

## 10. Owner decisions needed

| ID | Decision | Recommendation |
| --- | --- | --- |
| D-L1 | i18n mechanism | In-house typed catalog on `Intl`, no dependency (§2) |
| D-L2 | Exact English locale | `en-GB` (day-month dates, 24-hour available, `nu` already Western). The alternative `en-US` brings a month-first date order that is unusual in Egypt. |
| D-L3 | Preference scope | Terminal-level; no per-operator setting in v1 |
| D-L4 | Who may switch | Manager or admin only; the cashier has no selector |
| D-L5 | Where it is stored | Main-process terminal-local setting (L5 picks JSON vs SQLite and names its gates) |
| D-L6 | Tenant or Store default from Admin | Not in v1 (later, needs a Backend-Core contract) |
| D-L7 | English copy and glossary authority | Owner approves the English UX-12 equivalents and every safety string; Admin RT-266 reuses the table |
| D-L8 | Switch guard states | As in §4 (empty cart, no non-terminal payment, no recovery or shift-close) |
| D-L9 | Legacy English routes and brand | Remove from cashier reach or catalogue them in L3; the "POS Pulse" brand stays untranslated |
| D-L10 | Audit of a locale change | Local non-financial audit event (shape in L5) |
| D-L11 | English typeface | None in this rollout: keep the single Dubai stack (§6.4); route any change to RT-262 |

---

## 11. Review focus (failure modes no single slice owns by default)

1. **The Dialog portal in English** still renders RTL because it bypasses root inheritance. L2
   owns the test: render a Dialog with the English locale and expect `dir="ltr"`, `lang="en"`.
2. **A switch while UNKNOWN recovery is open** re-renders the recovery copy or drops the
   duplicate-charge warning. L5 owns the test: guard refuses; recovery state unchanged.
3. **Machine runs reorder in LTR**, for example a sale number beside Arabic text in English mode.
   L6 owns a bidi snapshot of mixed runs with `<bdi>`.
4. **Main dialogs before the renderer** stay Arabic after a switch to English. L4 and L5 own a
   test where main's `t()` reads the persisted locale at start-up.
5. **An aria-label left in the old locale** after a switch. L6's English sweep includes accessible
   names, not only text nodes.

---

## 12. Mapping to RT-311 deliverables

| RT-311 deliverable | Section |
| --- | --- |
| 1. Inventory (hard-coded Arabic, RTL assumptions, portals, labels, error mapping, formatters, tests) | §1 |
| 2. Locale contracts, catalog strategy, plurals, `lang`/`dir`, bidi, fallback, glossary, no duplicated truth | §2, §3 |
| 3. Selection, persistence, first run, offline, role scope, switching during cart / payment | §4 |
| 4. Layout, keyboard, a11y, reduced-motion, forced-colors, Windows scaling; sub-1024 unchanged | §5 |
| 5. UI language vs catalog names vs receipts; timezone, digits, money; RT-266 coordination; fonts | §6 |
| 6. Slices with dependencies, DoR, AC, minimal English path; whether an ADR is required | §7 (ADR: **yes**, L0) |
