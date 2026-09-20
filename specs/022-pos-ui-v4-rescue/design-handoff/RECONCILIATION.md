# Design-handoff reconciliation — 022 POS UI v4.0

**Vendored:** 2026-09-20 · **Status:** supplementary visual authority · **Feature:** `022-pos-ui-v4-rescue`

This directory holds the owner-approved Claude Design handoff bundle for POS UI v4.0. It is
**richer packaging of the design 022 already adopted** — not a new design, and not a new feature.

> **Read this file before using anything in this directory.** The bundle is authored for a Saudi
> pharmacy and contains capabilities POS-Pulse does not have. Section B lists them.

---

## A. Authority split

| Domain | Authority |
|:--|:--|
| **Product behaviour, capabilities, contracts** | Current POS-Pulse implementation + [`../spec.md`](../spec.md) |
| **Visual appearance** | Approved Claude Design mockup (this directory) + [`../visual-references/`](../visual-references/) |

**When they conflict, functional truth wins and the visual treatment adapts.** The mockup never
authorises behaviour. If a screen in this bundle shows something the product cannot do, the
implementation renders the _supported_ reality in the mockup's visual language — it does not grow a
capability to match a picture, and it does not invent a behaviour to fill a layout.

This mirrors the rule 022 already carries for the reference images
([`../spec.md`](../spec.md) §Visual-Reference Authority → _Non-Capability Inventory_):
**"The images are the visual direction, never the feature list."** That rule extends unchanged to
every artifact here, including the HTML mockups and `tokens.css`.

---

## B. Explicit non-capabilities

Present in the bundle, **NOT authorised** by it. None of these may be implemented under 022:

| Not authorised | Where it appears in the bundle |
|:--|:--|
| **Saudi fiscal / ZATCA** — QR block, TLV payload, tax-number line | Sale-complete receipt |
| **15% VAT behaviour** — the VAT row, VAT-refunded rows | Checkout, sale-complete, returns |
| **Saudi Riyal as the money unit** | Every screen |
| **mada card network** — Saudi-only scheme | Checkout tender grid |
| **Unsupported tenders** — credit card, insurance company, digital wallet (Apple Pay / STC Pay), gift voucher | Checkout tender grid (6 tiles) |
| **Returns** implementation | Screen 05 |
| **Shift close / Z-report** implementation | Screen 06 |
| Loyalty points, registered-customer records, prescription (Rx) workflow | Cart info row, checkout |

**On VAT specifically:** POS-Pulse is an **Egyptian** product. Egyptian VAT is deferred —
`total_tax_minor` is hardcoded `0` and receipts carry no tax line (008 §A5 rollout caveat).
`specs/012-vat-fiscal-receipt` owns that work and has not shipped. The mockup's tax rows are
therefore **not a requirement, not a preview, and not a TODO** for 022.

**On tenders:** the supported set is exactly three, pinned in source
(`src/shared/payments/types.ts` → `TENDER_TYPES`):

```
cash · external_card_terminal · internal_voucher
```

The mockup's 3×2 grid of six tiles **does not transfer as geometry** — with three tenders the grid
reshapes. Its typography, spacing, tile proportions, selected-state treatment and hierarchy do.

**On Returns / Shift Close:** vendored in [`forward-references/`](./forward-references/) as visual
reference for `specs/014-returns-refunds-voids` and `specs/015-shift-cash-management` **only**.
Neither is in 022 scope. Vendoring a picture is not scheduling the feature.

---

## C. Accessibility / token rule

**Handoff values are design evidence, not permission to regress WCAG.**

`tokens.css` here is the designer's palette, recorded verbatim for provenance. It is **not** a
drop-in replacement for the repo's tokens. Verified diff against `src/renderer/styles/tailwind.css`:

- **Shared:** `#0F766E` (brand primary) and `#FFFFFF`. The brand primary **agrees** — that is the
  substantive alignment.
- **Divergent:** ~35 further hexes. The handoff uses the stock Tailwind ramp (`#EF4444` red-500,
  `#F59E0B` amber-500, `#3B82F6` blue-500).

The repo's semantic colours were chosen by **measured contrast**, with the rejected values recorded
inline at `src/renderer/styles/tailwind.css`:

```css
--color-success: #15774d; /* #1f8a5b failed AA as a fill (white-on-it 4.33:1); #15774d is 5.56:1 */
--color-warning: #a35a00; /* orange — warnings only (5.22:1 AA) */
--color-danger: #b3261e; /* red — destructive/error only (6.54:1 AA) */
```

**Where the repo token intentionally differs from the handoff on accessibility grounds, the repo
token is authoritative and stays.** Adopting a stock Tailwind value to match the mockup more
literally would reintroduce a contrast failure the repo already measured and rejected.

**Mechanically enforced.** `src/renderer/styles/__tests__/token-guard.test.ts` (022 T025/T025a)
blocks raw colour/spacing/radius/type/shadow literals in renderer inline styles across all five
FR-8 value families, with a **closed** exception list. Its own instruction:

> _"A needed literal means a MISSING TOKEN. The fix is to add the token in U0, not to add a local
> value and not to widen the exception list."_

So a value from this bundle may enter **only** as a token definition in `tailwind.css`. It may never
be pasted into a component. CI rejects the alternative.

---

## D. Reference mapping — the handoff README mapping is WRONG

The five reference PNGs in the bundle are **pixel-identical** to 022's existing
[`../visual-references/`](../visual-references/) — verified: 0 differing pixels, all 1448×1086 RGB.

**But the handoff filenames are shuffled.** Verified two ways: pixel-identity across all five, and
by **opening all five** 022 images and confirming each one's content matches its own filename.

| 022 filename (**authoritative**) | Actual content         | Pixel-identical handoff file | Handoff name correct? |
| :------------------------------- | :--------------------- | :--------------------------- | :-------------------- |
| `01-visual-system.png`           | Design-system sheet    | `02-cart-cashier.png`        | ❌ wrong screen       |
| `02-sign-in.png`                 | Sign-in / shift start  | `03-payment.png`             | ❌ wrong screen       |
| `03-sale-workspace.png`          | Sale workspace / cart  | `05-design-system-sheet.png` | ❌ wrong screen       |
| `04-checkout-tender.png`         | Checkout / tender      | `01-login-shift-start.png`   | ❌ wrong screen       |
| `05-sale-success.png`            | Sale success / receipt | `04-sale-complete.png`       | ✅ right screen, different ordinal |

**So 4 of the 5 handoff filenames name the wrong screen.** The fifth (`04-sale-complete.png`)
describes its content correctly and differs only in ordinal — it is listed for completeness, not as
an error.

**022 filenames are correct and MUST NOT be renamed to match the handoff README.** Spot-confirmed in
both directions: `022/02-sign-in.png` renders the sign-in screen, while the handoff's
`01-login-shift-start.png` renders the **checkout** screen.

The handoff README _Element → mockup mapping_ table therefore points at the wrong files.
[`HANDOFF-README.md`](./HANDOFF-README.md) is vendored **verbatim**, so that error is preserved in
it on purpose — this table is the correction. When the README names a reference file, resolve it
through this table.

This also resolves an apparent contradiction: the README says _"height varies 989–1106"_. That
describes the **HTML mockup screens**, not these PNGs, which are uniformly 1448×1086.

**The five original PNGs are deliberately NOT duplicated here.** They already exist,
pixel-identical, under `../visual-references/`. Duplicating ~6.5 MB of identical bytes would create
a second "authority" that can silently drift from the first.

---

## E. Responsive rule

**The current 1024px viewport-floor policy is unchanged by this task.**

The handoff README states _"Below ~1280px nothing was designed"_ and suggests raising it as a design
question. **That is a note about the design canvas, not a runtime requirement, and it does not
authorise any change to viewport behaviour.**

The shipped policy stands: `useViewportTier` treats anything under **1024px** as `too-small`
(`src/renderer/shell/viewport/useViewportTier.ts`), and `AppShell` renders `ScreenTooSmall` instead
of its `<Outlet />` below that. This was examined in
[#450](https://github.com/Kemetra/POS/issues/450) and documented in commit `dcc8083` specifically to
record why the narrow-terminal media rules must not be deleted.

Do **not** reinterpret the handoff note as permission to change the tier floor, the media rules, or
`ScreenTooSmall`. Any change there is a separate, owner-approved decision.

---

## Wordmark — bundle-only, NOT authorised in the product

`Retail Tower POS` appears throughout the bundle (login hero, header, receipt). It is the
designer's wordmark, and **`Retail Tower POS` is its approved English form** (owner decision,
2026-09-20) — so when reading the bundle, do not treat the wordmark as an error to be corrected.
Any Arabic transliteration of it (e.g. the welcome line) is **placeholder only** and is not
approved copy.

> ⚠️ **This does NOT authorise the wordmark in the product.**
> [`../spec.md`](../spec.md) §Non-Capability Inventory classifies
> *"'Retail Tower POS' branding, marketing hero imagery, taglines"* as **not POS-Pulse identity —
> marketing chrome is prohibited in the working terminal**. That spec is **rank 3** and outranks
> this document (**rank 4b**) per [`../plan.md`](../plan.md) and §A above, so the prohibition
> stands: **no slice may rebrand the header, receipt or any working surface from this bundle.**

The owner decision settles **how to read the bundle**, not what the terminal ships. If the terminal
is ever intended to carry this wordmark, that is an amendment to `spec.md`'s Non-Capability
Inventory and a separate owner decision — **this handoff does not grant it.**

---

## Contents

| Path | What it is | Verbatim? |
| :--- | :--------- | :-------- |
| [`HANDOFF-README.md`](./HANDOFF-README.md) | Designer 31 KB written spec — per-screen values, component/props table, state model | yes (incl. its mapping error — see §D) |
| [`tokens.css`](./tokens.css) | Designer machine-readable token list | yes — **provenance only**, see §C |
| [`design-files/Retail Tower POS v4.dc.html`](./design-files/) | **Approved** mockup — the precise source for values. ⚠️ **does not render** (missing `support.js`; see below) | yes |
| [`design-files/Retail Tower POS v1 (reference-faithful).dc.html`](./design-files/) | First-pass recreation, kept for comparison. ⚠️ same missing runtime | yes |
| [`forward-references/returns-014.png`](./forward-references/) | Returns screen → `specs/014` **only** | cropped capture |
| [`forward-references/shift-close-015.png`](./forward-references/) | Shift close / Z-report → `specs/015` **only** | cropped capture |

**Notes on the two forward-reference captures:** both are 909×525 — captured in a preview pane
narrower than the 1448px canvas, so the right edge is cropped — and both show the prototype floating
screen-switcher pill. That pill is a prototype affordance and **must not be implemented**. Read them
for structure only; the HTML mockup is the accurate source.

### ⚠️ The `.dc.html` mockups do NOT render as committed

Both files open with `<script src="./support.js"></script>`, and **`support.js` was never shipped
in the designer's bundle** — it is absent from that bundle and from this repository (verified).
Without it the custom `<x-dc>` / `<sc-if>` elements, the `{…}` interpolation and the
`type="text/x-dc"` state script are never evaluated, so the page does not render, and the screen
switcher and interactions do not work.

[`HANDOFF-README.md:15`](./HANDOFF-README.md) says *"Open them by double-clicking; they run in any
browser with no build step."* **That is not true of the bundle as delivered** — the same
verbatim-vendoring rule as §D applies, so the claim is preserved in that file and corrected here.

**Read them as source text, not as a running prototype** — which is what the designer's own README
also instructs: *"Read it for **values** (hex codes, pixel measurements, copy), not for
architecture."*
That use is unaffected: every value in `HANDOFF-README.md` was taken from these files, and they
remain the most precise record of hex codes, measurements, grid tracks and Arabic copy.

**[`../visual-references/*.png`](../visual-references/) are the rendered visual authority.** They
are what the approved design actually looks like, and they render fine.

The missing runtime is an **open question for the designer** — vendoring it, or an export that is
self-contained, would make the mockups browsable. Neither is attempted here: this directory's value
rests on the files being byte-identical to the designer's bundle (see §Line endings), and rewriting
them to render would forfeit that.

Their Google-Fonts `<link>` is moot for the same reason. Either way it would not be a requirement —
022 T026/T028 settled the shipped font stack (system stack, verified on target hardware; no
webfont, no `@font-face`).

`tokens.css` is **unaffected** — it is plain CSS with no runtime dependency and is readable as-is.

**Prettier:** this directory is covered by the existing `specs/` and `*.md` entries in
`.prettierignore`, so these files are never reformatted. That is deliberate and matches the repo's
stated rationale for `docs/design/` — reformatting a design reference corrupts the design source.

**Line endings:** the repo runs `core.autocrlf=true` on Windows, which would materialise CRLF in a
checkout and make the verbatim claim above true only on some platforms. `.gitattributes` therefore
pins `eol=lf` on this directory's `.html` / `.css` / `.md` files, following the narrow precedent
already set there for the codegen-sensitive artifacts. Every vendored file's committed blob was
verified md5-identical to the designer's source, PNGs included.
