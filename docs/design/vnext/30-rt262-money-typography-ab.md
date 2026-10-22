# RT-262 — Money typography and font-challenger A/B (UX-03)

> **Work Mode: Planning.** Jira **RT-262** (related RT-106, RT-242, RT-243). Docs and a prototype
> page only: no production token, font, CSS, dependency, `package.json` or lockfile change. **No
> font file is added to the repository.** Nothing here is decided: the owner picks the font and
> the money treatment. No slice may migrate money typography before the owner accepts a result
> (RT-262 scope).
>
> **Baseline.** `Kemetra/POS` `origin/main` = `e387fcad` (RT-803, #805). Measured 2026-10-22 on the
> lab workstation (Windows 11, Microsoft Edge headless, Dubai 1.10 from `C:\Windows\Fonts`,
> IBM Plex Sans Arabic 1.101 from Google Fonts, Cascadia Code present).
>
> **Authorities read.** Confluence RETAIL UX-03 (page 22839299); POS [`docs/DESIGN.md`](../../DESIGN.md)
> §2 typography (shipped vs target money treatment, rows 265-266, 402-405); docs
> [04](04-design-language.md), [15](15-vnext-freeze-package.md) of this package. Where they
> conflict, the owner decision of 2026-10-07 stands: **UX-03 wins; shipped mono money stays until
> this A/B proves the sans treatment better.**
>
> **Companion prototype:** [30-rt262-money-typography-ab.html](30-rt262-money-typography-ab.html).
> Screenshots: [`captures/RT-262/`](captures/RT-262/) (24 frames plus one specimen sheet).

## 0. Summary

- **Variants** (only the font family changes; layout, size, weight and colour are identical):

  | Id  | UI font                | Money / quantity font               |
  | --- | ---------------------- | ----------------------------------- |
  | A   | Dubai                  | Monospace stack (**shipped today**) |
  | B   | Dubai                  | Dubai, tabular figures              |
  | C   | IBM Plex Sans Arabic   | Monospace stack                     |
  | D   | IBM Plex Sans Arabic   | IBM Plex Sans Arabic, tabular       |

- **Finding 1 — "tabular sans" costs nothing for either font.** Western digits 0-9 have one
  fixed advance in both faces (Dubai 540/1000 em, Plex 600/1000 em; verified from the `hmtx`
  table and in the browser). Neither font has a `tnum` or `lnum` feature, and none is needed:
  the default digits are already tabular and lining. `font-variant-numeric: tabular-nums` is a
  harmless no-op kept for intent. Decimal points stack in every variant (specimen §2).
- **Finding 2 — the sans treatment is denser.** The shipped mono stack is wider than either sans.
  In the Sale frame at 1024 the unit-price column wraps `1,087.70 EGP` onto two lines in A and C
  and fits on one line in B and D (`captures/RT-262/sale-1024-a.png` against `-b.png`). The
  prototype column widths are fixed, so this shows the pressure, not a production measurement.
- **Finding 3 — the shipped mono stack is not one font.** It is
  `ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace`. On this workstation it
  resolves to Cascadia Code (digit advance 0.586 em). Another terminal falls through to Consolas
  (0.55 em) or the generic monospace. Variant A therefore looks different per machine; B and D do
  not, because their figures come from the same face as the Arabic.
- **Finding 4 — Plex is not on the machine; Dubai is.** Choosing Plex means bundling it (§3).
  That reverses the OD-2 decision (bundled-font option declined) and touches the `no-brand-font`
  guard. This ticket does not do that.
- **Not found at this stage:** a clear readability gain for Plex over Dubai that UX-03 requires
  before a font change. The two are close in weight and Arabic shaping at the sizes tested; Plex
  has a larger x-height (0.516 em against 0.438 em), so the Latin looks bigger at the same size.
  That is a taste and density call for the owner, not a defect in either face.

## 1. Method

1. One structural mock for each of **Sale**, **Checkout** and **Completion**, built from the shipped
   `docs/DESIGN.md` values (amount-hero 44px, amount-total 30px, money-row 14px/600; 36px and 24px
   at 1024). Arabic RTL, money / quantity / SKU runs LTR-isolated with `<bdi>`, Western digits,
   `1,250.00 EGP` formatting.
2. Four variants (A-D) rendered at **1024×680** and **1280×720**: 3 screens × 2 widths × 4
   variants = 24 frames. Reproduce any frame with
   `30-rt262-money-typography-ab.html#screen=sale|checkout|done&w=1024|1280&v=a|b|c|d`.
3. Data is Arabic product names with Latin strengths and SKUs, and values chosen to expose the
   confusable pairs: `17.00`, `71.10`, `108.80`, `187.70`, `780.00`, `1,087.70`, `88,888.88`.
4. Font metrics read from the font files with `fontTools` (scratch directory, not committed) and
   confirmed in the browser with canvas `measureText` (specimen §4 of the page).

**Limits.** This is a prototype of structure, not the production renderer: real component CSS,
real catalogue strings and the packaged Electron text stack (Chromium on Windows with
DirectWrite) were not exercised. Frames were rendered in headless Edge. It does not prove
behaviour on the cashier workstation printer or at the target display scaling. A packaged-build
check is recommended before any migration slice.

## 2. Measurements

| Measure                         | Dubai (400 / 700)        | IBM Plex Sans Arabic (400 / 700) | Mono stack (A, C)        |
| ------------------------------- | ------------------------ | -------------------------------- | ------------------------ |
| Digit advance, 0-9              | 540, all equal           | 600, all equal                   | 586 (Cascadia), all equal |
| Width of `1,780.70` at 44px bold | 161 px (narrowest)       | 186 px (+16% on Dubai)           | 206 px (+28% on Dubai)   |
| `tnum` / `lnum` features        | none (default tabular)   | none (default tabular)           | n/a                      |
| x-height / cap height (em)      | 0.438 / 0.648            | 0.516 / 0.698                    | font-dependent           |
| Real weights                    | 300, 400, 500, 700       | 400, 500, 600, 700               | 400, 700                 |

Widths are the summed advance widths from each font's `hmtx` table (Dubai Bold, Plex Bold, Cascadia at 0.586 em per character), not rendered pixels.
Dubai has no 600; Windows maps the DESIGN.md `600` weight to Bold. Plex has a true 600.

**Glyph confusion (1/7, 0/8, 6/9).** At the 44px hero size all four variants separate 1 from 7,
0 from 8 and 6 from 9 clearly. The mono stack adds a dotted zero (Cascadia), which is the only
variant that disambiguates 0 from O by shape. At 14px row size the four are distinguishable in
the captured frames, but this was a visual check on a clean display only. A low-contrast or worn-display test was
not run; treat 14px confusion as unproven either way.

**Arabic / Latin mix.** In all four variants the Arabic run, the Latin strength and the isolated
SKU and money runs keep reading order, with no digit shaping to Arabic-Indic. Plex's taller
Latin gives a slightly larger Latin-to-Arabic size contrast; Dubai's Latin sits closer to its
Arabic x-height. Neither shows broken mixed runs once the money is wrapped in `<bdi dir="ltr">`.

## 3. Licensing and bundle size

| Item            | Dubai                                                                                  | IBM Plex Sans Arabic                                         |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Licence         | Microsoft-supplied font (name ID 13): usable in content as permitted by the Windows licence and the font's own embedding restrictions. **Not** an open licence | **SIL Open Font License 1.1** (name table licence URL `scripts.sil.org/OFL`; copyright 2019 IBM Corp.) |
| Redistribution  | Not bundleable without a separate licence from the rights holder (Dubai Executive Council / Monotype). Today it is **not** bundled: it relies on the Windows install | Free to bundle and embed; the OFL notice must travel with it |
| Ships with OS   | Yes, Windows 10/11 (the reason it was kept for the pilot)                              | No. Bundling or a network fetch is the only way                |
| Size (per weight) | 177 KB TTF, 57 KB woff2                                                              | 214 KB TTF, 66 KB woff2 (400); 68 KB woff2 (700)             |
| Four weights    | About 230 KB woff2 if it could be bundled                                              | About 265 KB woff2                                           |

Plex adds roughly 130 KB (woff2, two weights) to 265 KB (four weights) of renderer payload and
needs an OFL notice entry next to the font, as RT-263 did for Fluent icons. The prototype page
loads Plex from Google Fonts only to render the comparison; that fetch is not a production path
(an offline POS cannot rely on it). The `no-brand-font` guard and OD-2 currently forbid a bundled
face.

**Rules for any adoption.** The app must never load a font from a CDN: the POS is offline-first and
Constitution egress rules forbid it. Any adopted font is vendored under its licence (Plex: OFL 1.1,
with the notice kept beside the file) through a bounded Jira slice. The prototype page needs
network access to render the Plex variants (Dubai comes from the local Windows install). This PR
records the comparison only; it does not decide the font or the money style.

## 4. Per-variant reading

- **A (current).** Strongest "ledger" look and a dotted zero. Widest; wraps the price column at
  1024. Looks different on a machine without Cascadia Code. Mixes two type voices in one row (a
  proportional Arabic label beside a mono value).
- **B (Dubai + tabular sans).** Same face as the Arabic, so a row reads as one voice. Narrowest (161 px against 206 px for A).
  Digits align as well as A in the specimens. **No new font file, licence or bundle.** The only
  change is the money family token (it still needs a bounded token slice).
- **C (Plex + mono).** Needs the Plex bundle and keeps the mono width cost. Gains nothing the
  other options do not already offer.
- **D (Plex + tabular sans).** One voice and consistent across machines. 16% wider than Dubai
  figures (still 10% narrower than the mono), with a larger Latin presence and a true 600. Requires the bundle, the OFL notice and an owner reversal of OD-2.

## 5. Recommendation for the owner (not applied)

Presented for decision; nothing is migrated.

1. **Money treatment: prefer B over A**, if the owner accepts the visual change. It satisfies the
   UX-03 target (sans with tabular lining numerals; mono for IDs and evidence), costs no
   dependency, no font file and no licence work, removes the machine-dependent mono fallback, and
   buys horizontal room in the 1024 cart. The measured trade-off is the loss of the
   dotted zero; if the owner wants the zero cue, A stays valid.
2. **UI font: keep Dubai**, which is UX-03's incumbent position, unless the owner prefers Plex's
   look. The evidence does not show a clear readability gain that UX-03 requires, and Plex adds a
   bundle, an OFL notice and an OD-2 reversal. If the owner wants Plex anyway, D is the coherent
   pairing; C is not.
3. Any adoption needs its own bounded Jira slice (token change plus a packaged-build check at 1024
   and 1280, then the owner's visual sign-off). Until then DESIGN.md rows 265-266 stand.

## 6. What this does not decide

- The font, the money family and the dotted-zero trade-off (all owner decisions).
- Whether to reverse OD-2 and bundle a face. This ticket does not add a font file or dependency.
- Behaviour in the packaged app, on the printer, and at 14px for worn or low-contrast displays
  (recommended before a migration slice).

## 7. Acceptance mapping (RT-262)

| RT-262 requirement                                                          | Evidence                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Same-screen renders of Sale, Checkout, Completion at 1024 / 1280            | 24 frames, `captures/RT-262/{sale,checkout,done}-{1024,1280}-{a..d}.png` |
| Current Dubai + mono vs Dubai + tabular sans vs Plex variants               | Variants A, B, C, D                                                  |
| Digit alignment in columns                                                  | §0 finding 1, specimen §2 (`overview-specimens.png`)                 |
| Glyph confusion (1/7, 0/8)                                                  | §2 and specimen §1                                                   |
| Arabic / Latin mix                                                          | §2 and specimen §3                                                   |
| Licensing and bundle size                                                   | §3                                                                   |
| Recommendation for the owner; no slice migrates before acceptance           | §5-§6                                                                |
| No implementation authorised                                                | Docs and prototype only; no production, font or dependency change   |
