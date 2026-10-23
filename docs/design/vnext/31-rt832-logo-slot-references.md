# RT-832 — Tenant-logo slot references (RT-473 OD-7)

> **Work Mode: Docs (design references).** Jira **RT-832**; relates RT-472, RT-473, RT-475.
> **PROPOSED — awaiting owner sign-off.** Nothing here is approved. The owner's sign-off is what
> records OD-7 on RT-473 and on RT-832. No runtime code changes; the frames are the real screens on
> `main` with the slot drawn in flow.
>
> **Frames and table:** [`RT832-Logo-Slots-Spec.html`](visual-acceptance/RT832-Logo-slots/RT832-Logo-Slots-Spec.html)
> (PNG captures in [`captures/`](visual-acceptance/RT832-Logo-slots/captures/)).

## 1. Slot pixel boxes (for RT-473 S2)

One box per slot, **the same at 1024×768 and 1280×800**. The RT-473 S1 contract
(`tenant-branding.openapi.yaml`) has exactly one screen rendition per (slot, scale): 4 slots × 2
scales = 8, with no per-width entry. A width-dependent box would need a contract change.

| Slot (`slot`) | Box, CSS px | 1x px | 2x px | Square logo fits | 4:1 logo fits | `low_contrast` card outer (padding outside the box) |
|:--|:--|:--|:--|:--|:--|:--|
| Boot (`boot`) | 240×120 | 240×120 | 480×240 | 120×120 | 240×60 | 266×146 (12px + 1px border) |
| Pairing (`pairing`) | 200×80 | 200×80 | 400×160 | 80×80 | 200×50 | 226×106 (12px + 1px border) |
| Sign-in header (`sign_in`) | 128×32 | 128×32 | 256×64 | 32×32 | 128×32 | 138×38 (2px block, 4px inline + 1px border) |
| Lock (`lock`) | 200×80 | 200×80 | 400×160 | 80×80 | 200×50 | 226×106 (12px + 1px border) |

- **The box is the rendition bounds, including the uniform 8% clear space** that S2 normalization
  adds. Layout spacing outside the box is separate, so clear space is never applied twice. The band
  drawn in the frames (8% of the shorter side) is an approximation: S2 computes the exact band from
  the trimmed master.
- **Fit.** `contain` inside the box × scale, never above the master's native size, never cropped or
  stretched.
- **Masters.** Smallest accepted masters are 512×512 (square) and 256 px tall (horizontal, so at
  least 1024×256 at 4:1). Every 2x rendition fits within them: the largest 2x square fit is 240×240
  (boot, 2x box 480×240), under 512, and no 2x box is taller than 240, under 256.

## 2. Placement in RTL, spacing, states

| Slot | Placement | Spacing outside the box |
|:--|:--|:--|
| Boot | Centred; box, 24px gap and the loading status centred as one group | 24px to the status |
| Pairing | First child of the 440px card, above the leading icon, on the inline-start edge (RTL: right) | 16px (the card grid gap); card padding 32px (28px at 1024) |
| Sign-in header | Inline-start end of the context strip (RTL: right), at the gutter (24px at 1280, 16px at 1024); replaces the 26px mark and the «POS Pulse» wordmark (option A) | 14px to the separator (the existing strip gap); the strip stays 48px (44px at 1024) |
| Lock | First child of the 440px lock dialog, above the lock head, on the inline-start edge; the 56px lock glyph stays | 12px (the dialog grid gap); dialog padding 24px |

- **No logo.** The slot collapses: no placeholder, no reserved space, no powered-by line. Every
  screen is exactly today's screen, and the sign-in strip keeps the «POS Pulse» wordmark.
- **Powered-by (OD-12 decided: «Retail Tower»).** Shown only with a logo. 12px muted
  «بدعم من Retail Tower», the name isolated LTR. Boot: centred, 24px under the status. Pairing and
  lock: centred at the foot of the card or dialog. Sign-in: the inline-end end of the strip. The
  Arabic prefix is proposed copy.
- **`low_contrast` (FR-11).** White card: `#fff`, 1px border, 8px radius, padding outside the box
  (table). In the strip the padding is 2px / 4px so the strip does not grow.
- **Forced colours.** Images are not recoloured, so a logo's contrast on `Canvas` is unknowable. The
  frames propose that every logo sits on the white card with `forced-color-adjust: none` and a
  visible border. This extends the shipped un-force precedent (selected and current states) to a
  logo card, so it is an owner decision.
- **Long terminal label.** The label is admin free text with no length limit and the strip does not
  wrap, so with a logo and the powered-by line the context must truncate
  (`min-inline-size: 0; overflow: hidden; text-overflow: ellipsis`) while the logo, separator and
  powered-by line stay `flex: none`. The sign-in frames include a long-label capture at both widths.
- **Dark.** Not offered in the pilot (DESIGN.md, OD-4), so no dark slot is proposed. `low_contrast`
  is computed only against the light surface, so a logo's contrast in the dark register is
  unverified. The dark captures are reference only.

## 3. Receipt rendition: pending OD-8

Not sized. It needs the printer dpi and printable width from the printer self-test, which the owner
still owes. Formula only: `width_px ≤ floor(48 / 25.4 × dpi)`, `height_px ≤ floor(15 / 25.4 × dpi)`
(at most 48×15 mm). **PENDING OD-8.**

## 4. Owner decisions asked

1. The four boxes and their 1x/2x sizes (§1).
2. Sign-in placement, **A** (drawn: the logo replaces the mark and wordmark) or **B** (logo beside
   the wordmark with a separator; costs about 95px plus a 14px separator of the strip).
3. Forced colours: every logo on the un-forced white card.
4. The powered-by prefix «بدعم من» and its position per screen.
5. No logo means no powered-by line and no placeholder.

## 5. Method and evidence

Screens: the real `SignInRoute`, `PairingScreen` and `SessionLockGate` through
`#/dev/sign-in-proof` (`screen=sign-in | pairing | locked`) and the real `RouteLoading` for boot
(a throwaway page, not committed). `tools/capture_rt832.cjs` inserts the slot in flow, then fails if
anything leaves the viewport, the sign-in strip grows, or the sign-in controls leave the fold. It
writes `captures/slot-fit.json`. `tools/gen_spec.cjs` renders the HTML from `tools/slots.cjs`, the
single source for the numbers above. Sample logos are synthetic. These are dev-harness captures, not
packaged-build evidence.
