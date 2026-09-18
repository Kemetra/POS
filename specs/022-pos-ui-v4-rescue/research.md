# Phase 0 Research — POS UI v4.0 Rescue

**Feature ID:** 022-pos-ui-v4-rescue
**Plan:** [./plan.md](./plan.md)
**Created:** 2026-09-18

Four non-trivial decisions, each resolved against source or platform evidence.

---

## 1. Arabic typography — how to satisfy FR-10 without a dependency

**Question.** FR-10 requires Arabic operator text to render through an *intentionally selected*
typeface rather than undeclared OS fallback. Can that be met without adding a font package, a
bundled file, or an `@font-face` — all of which would require separate owner approval?

### Evidence

| Finding | Source |
|:--|:--|
| No font files bundled | `find src public -name "*.woff*" -o -name "*.ttf" -o -name "*.otf"` → empty |
| No `@font-face` anywhere in renderer styles | `grep "@font-face" src/renderer/styles/tailwind.css` → none |
| No font package in dependencies | `package.json` → only `node-thermal-printer` matches /font|inter/ |
| Declared stack names a face that does not exist | `--font-family-sans: 'Inter Variable', Inter, 'Segoe UI', system-ui, -apple-system, sans-serif` (`tailwind.css`) |
| Target platform | Windows 10/11 x64 desktop/laptop, touchscreen-first (constitution "Hardware (MVP Matrix)") |
| Arabic-capable faces shipped with Windows 10/11 | Dubai (4 weights), Segoe UI, Majalla, Tahoma, Arial — verified present in `C:\Windows\Fonts` |

### Diagnosis

The real defect is **not** "no Arabic font available". It is that `'Inter Variable'` and `Inter`
**resolve to nothing** — neither is installed nor bundled — so every glyph, Latin and Arabic alike,
falls through to `'Segoe UI'`. Arabic is therefore rendered by whatever the OS happens to select,
with no declared intent and no guarantee of consistency across terminals.

### Decision

**Declare an ordered system font stack.** Naming an explicit, ordered list of faces that are known
to ship with the target OS *is* an intentional selection — it satisfies FR-10 without any new
dependency.

Direction (exact list finalised in U0, on-hardware):

```
--font-family-sans: 'Dubai', 'Segoe UI', Tahoma, Arial, system-ui, sans-serif;
```

Rationale: **Dubai** is an Arabic-first face designed for UI, ships with Windows 10/11, and covers
Latin coherently, so mixed Arabic/Latin strings hold one visual voice. Segoe UI and Tahoma are
ordered fallbacks; both are Arabic-capable and universally present on the target SKU.

Money and identifiers keep the existing `--font-family-mono` with tabular numerals (FR-12).

### Alternatives considered

| Option | Verdict |
|:--|:--|
| Bundle a webfont (Noto Kufi Arabic, Cairo, Tajawal) | **Rejected for now** — adds a file/dependency ⇒ requires separate approval; also a first-paint cost on a POS boot path. Recorded as the escalation path if §Gate fails |
| Keep `Inter` and add an Arabic face after it | **Rejected** — `Inter` still resolves to nothing; the stack would stay misleading |
| `system-ui` alone | **Rejected** — not an *intentional* selection; reproduces today's defect |

### Gate (explicit, and the only typography approval condition)

**No approval is required for the system-stack approach.** An approval gate is triggered **only if**
U0's on-target-hardware verification shows the system stack cannot meet FR-10/FR-11 quality — at
which point bundling a webfont becomes an owner decision, raised before any package is added.

**Verification owed at U0:** render Arabic UI copy, mixed Arabic/Latin, dense cart rows and large
totals on Windows 10/11 target hardware. This plan does **not** assert that result from a
development machine.

---

## 2. Light-first default — switch points and blast radius

**Question.** How much has to change for light to become the default, given v3.5 baked dark in?

### Evidence

`:root` (`tailwind.css:3-133`) is **already the complete light base**; `:root[data-theme='dark']`
(135-250) is an override register of custom properties only. So light is not built — it exists and
is simply not the default.

### Decision

Flip three points; change no component.

| # | File | Current | Target |
|:--:|:--|:--|:--|
| 1 | `src/renderer/index.html:14` | `<html lang="ar" dir="rtl" data-theme="dark">` | light default (keep `lang`/`dir`; keep the static attribute for flash-free boot — the shipped meta CSP is `script-src 'self'`, so an inline pre-paint script is not an option) |
| 2 | `src/renderer/stores/theme-store.ts` | `export const DEFAULT_THEME: Theme = 'dark'` | `'light'` |
| 3 | `src/renderer/styles/__tests__/theme-contract.test.ts` | 3 hardcoded `'dark'` default assertions | invert to light |

`src/renderer/stores/__tests__/theme-store.test.ts` asserts predominantly through the
`DEFAULT_THEME` **symbol**, so it follows automatically; only genuinely hardcoded cases need review.

**Preserved deliberately:** the theme-contract guards that (a) a dark register exists, (b) it
contains custom-property overrides **only** — no forked dark components, and (c) RTL/`lang="ar"` is
systemic. These encode structure, not the superseded default, and must survive.

---

## 3. Dark-register disposition — a decision that must be made, not defaulted

**Question.** Once light is the default, do the ~6 core dark tokens adopt v4.0 (pharmacy teal
adapted for dark surfaces), or stay v3.5 Vault Dark?

**Finding.** The dark register currently encodes v3.5's navy/blue-cyan identity. Leaving it
untouched means the product ships **two different visual identities** depending on a toggle.

**Recommendation: retune (option a).** Bring the dark register's `--color-primary*`, `--color-accent`
and semantic-state values into the v4.0 family so dark is a *rendering* of v4.0 rather than a
surviving v3.5. Scope stays token-values-only (~6 tokens); the theme-contract structural guards are
unaffected.

**Alternative (option b): freeze Vault Dark.** Cheaper, and defensible if dark is treated as
legacy-support-only. Must then be stated as a known, accepted divergence rather than an oversight.

**Owner call, recorded at U0.** The plan names it so it cannot fall out implicitly.

---

## 4. U4a wiring feasibility — can the receipt be surfaced without touching the bridge?

**Question.** U4a mounts the existing `ReceiptPreview` on the completion path. `ReceiptPreview`
requires a `saleId`. `PaymentSurface` tracks a sale *number*. If no sale **id** is reachable, U4a
would need a new bridge field — a **P8 violation**, which would block the recommended slice order.

### Evidence

| Finding | Source |
|:--|:--|
| `ReceiptPreview` prop | `saleId: string` → calls `receipts.preview({ sale_id, idempotency_key })` itself (`ReceiptPreview.tsx:25-64`) |
| `PaymentSurface` already polls recent sales | `sales.subscribe({ topic: 'recent' })` on entering `settled` (`PaymentSurface.tsx:158-214`) |
| That response's shape | `RecentSaleSummary { sale_id: string; sale_number: string; finalized_at: string }` (`src/shared/sales/types.ts:165-169`) |
| What the component keeps today | `settledSaleNumber` only — **`sale_id` is received and discarded** |

### Decision

**U4a is unblocked, and requires no bridge change.** The needed `sale_id` is already delivered by an
existing channel and merely dropped on the floor. U4a retains it and passes it to `ReceiptPreview`.

Two clarifications for reviewers:

1. `ReceiptPreview` calling `receipts.preview` makes U4a a **new consumer of an existing IPC
   channel** — not an expansion of the bridge surface. P8 governs *surface changes*; adding a
   consumer is not one.
2. This confirms the plan's headline ordering (U4a first) is safe: the slice is renderer-only,
   palette-independent, and free of bridge work.

### Honest-degradation requirement (P2)

Two paths must remain truthful and are specified as U4a acceptance:

| Condition | Required behaviour |
|:--|:--|
| `saleFinalization` flag off (the fail-closed default) | 008's finalize listener short-circuits ⇒ **no receipt exists**. Say so honestly; never render a placeholder receipt |
| `sale_id` / `sale_number` null (poll failed, bridge absent, unmounted) | Today the block is simply omitted — preserve that. **No fabricated sale number**, no invented completion detail |

---

## Summary of decisions

| # | Decision | Dependency added? |
|:--:|:--|:--:|
| 1 | Arabic via declared **system font stack** (`Dubai` → `Segoe UI` → Tahoma → Arial) | **No** |
| 2 | Light default via **3 switch points**; structural theme guards preserved | **No** |
| 3 | Dark register **retuned to v4.0** (recommended; owner call at U0) | **No** |
| 4 | U4a surfaces the receipt via the **already-delivered `sale_id`** | **No** — P8 clear |
