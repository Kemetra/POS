# RT-695 (IC-2): POS icon consumers on the semantic registry — before / after

Each PNG is one **before / after pair side by side**: left is `main` at `673a8f9` (the old `V5Icon`
set), right is the IC-2 branch (Fluent Regular glyphs from `src/renderer/icons/`). Every surface is
captured at 1024×768 and 1280×800, in light mode and in forced colours (`forced-colors: active`).

- **Source:** the DEV-only harnesses (`#/dev/*-proof`) on `npm run dev:vite`, rendered with
  Playwright and the preinstalled Chromium.
- **Tools:** [`tools/capture-ic2.cjs`](tools/capture-ic2.cjs) (run once per branch) and
  [`tools/pair-ic2.cjs`](tools/pair-ic2.cjs) (lays the pairs out). The log is
  [`ic2-capture-log.json`](ic2-capture-log.json).
- **axe:** 0 violations on all 80 captures (40 before, 40 after).
  No page errors.
- **Glyph column:** `svg.v5-icon` before → `svg.rt-icon` + `svg.v5-brand-cross` after, at 1280 light.
  The count rises by one only where IC-2 adds a glyph on purpose: the cash keypad's `⌫` text
  becomes a glyph, and the printer banner gains its tone glyph.

| Surface | Harness | Pairs | Glyphs | What to look at |
|---|---|---|---|---|
| Nav panel + manager home | `#/dev/one-frame-proof?path=/app/dashboard&shift=on` | [1024](ic2-nav-panel-manager-home-1024x768.png) · [1024 forced](ic2-nav-panel-manager-home-1024x768-forced.png) · [1280](ic2-nav-panel-manager-home-1280x800.png) · [1280 forced](ic2-nav-panel-manager-home-1280x800-forced.png) | 13 → 12 + 1 brand | Labelled panel (no glyphs, unchanged); brand cross; manager home tiles `people`, `held`, `stuckShift`, `shift`; status rows. |
| Nav rail + Sale | `#/dev/one-frame-proof?path=/app/cart` | [1024](ic2-nav-rail-sale-1024x768.png) · [1024 forced](ic2-nav-rail-sale-1024x768-forced.png) · [1280](ic2-nav-rail-sale-1280x800.png) · [1280 forced](ic2-nav-rail-sale-1280x800-forced.png) | 13 → 12 + 1 brand | Slim rail with the current entry (`cart`) **Filled** (D-263-8); scan, search, forward glyphs on the live Sale. |
| Checkout tenders | `#/dev/checkout-proof?preset=none` | [1024](ic2-checkout-tenders-1024x768.png) · [1024 forced](ic2-checkout-tenders-1024x768-forced.png) · [1280](ic2-checkout-tenders-1280x800.png) · [1280 forced](ic2-checkout-tenders-1280x800-forced.png) | 7 → 6 + 1 brand | Tender tiles `cash`, `card`, `voucher`; `lock` on the order summary; info banner. |
| Checkout tenders, cash selected | `#/dev/checkout-proof?preset=none` + click «نقدي» | [1024](ic2-checkout-tenders-cash-selected-1024x768.png) · [1024 forced](ic2-checkout-tenders-cash-selected-1024x768-forced.png) · [1280](ic2-checkout-tenders-cash-selected-1280x800.png) · [1280 forced](ic2-checkout-tenders-cash-selected-1280x800-forced.png) | 9 → 9 + 1 brand | Selected tile `confirm` mark; cash keypad `⌫` text → `backspace` glyph. |
| Banner — printer (warning) | `#/dev/status-proof?state=PrinterFailed&path=/app/dashboard` | [1024](ic2-banner-printer-1024x768.png) · [1024 forced](ic2-banner-printer-1024x768-forced.png) · [1280](ic2-banner-printer-1280x800.png) · [1280 forced](ic2-banner-printer-1280x800-forced.png) | 14 → 14 + 1 brand | Printer banner now shows the tone glyph △ **beside** the `print` glyph (doc 25 §4.1). |
| Banner tones — full stack | `#/dev/status-proof?state=OfflineAttention&banner=printer&closed=shift&path=/app/dashboard` | [1024](ic2-banner-stack-1024x768.png) · [1024 forced](ic2-banner-stack-1024x768-forced.png) · [1280](ic2-banner-stack-1280x800.png) · [1280 forced](ic2-banner-stack-1280x800-forced.png) | 18 → 18 + 1 brand | danger ✕○, info ⓘ, warning △ (offline), warning △ + print. |
| Entry — sign-in | `#/dev/sign-in-proof?screen=sign-in` | [1024](ic2-entry-sign-in-1024x768.png) · [1024 forced](ic2-entry-sign-in-1024x768-forced.png) · [1280](ic2-entry-sign-in-1280x800.png) · [1280 forced](ic2-entry-sign-in-1280x800-forced.png) | 3 → 2 + 1 brand | PIN-pad `backspace`, `key` on «دخول المدير», brand cross in the strip. |
| Entry — ready | `#/dev/sign-in-proof?screen=ready` | [1024](ic2-entry-ready-1024x768.png) · [1024 forced](ic2-entry-ready-1024x768-forced.png) · [1280](ic2-entry-ready-1280x800.png) · [1280 forced](ic2-entry-ready-1280x800-forced.png) | 2 → 1 + 1 brand | `terminal` card glyph. |
| Entry — pairing | `#/dev/sign-in-proof?screen=pairing` | [1024](ic2-entry-pairing-1024x768.png) · [1024 forced](ic2-entry-pairing-1024x768-forced.png) · [1280](ic2-entry-pairing-1280x800.png) · [1280 forced](ic2-entry-pairing-1280x800-forced.png) | 2 → 1 + 1 brand | `pair` card glyph. |
| Entry — locked | `#/dev/sign-in-proof?screen=locked` | [1024](ic2-entry-locked-1024x768.png) · [1024 forced](ic2-entry-locked-1024x768-forced.png) · [1280](ic2-entry-locked-1280x800.png) · [1280 forced](ic2-entry-locked-1280x800-forced.png) | 4 → 3 + 1 brand | `lock` glyph (28 px → `lg` 24 grid). |

## Decisions the owner signs off from these captures

| ID | Question | Where to look |
|---|---|---|
| **D-263-1** | Visual fit: Fluent System Icons Regular as the one glyph family, against the VNext pharmacy-teal language. | Every pair. Notable shape changes: `back` is an arrow, not a chevron (entry screens); `return` is Arrow Hook Up Left, mirrored in RTL (rail); `stuckShift` is Clock Pause (manager home); the printer banner now shows △ + printer side by side. |
| **D-263-5** | Stroke weight: Fluent's line is about 1.0px at 16/20 against today's 1.46px, 1.5px at 24. | Nav rail, tender tiles, status rows (16), keypads and the Sale forward arrow (24). |
| **D-263-8** | Filled glyph only on the selected slim-rail entry. | `nav-rail-sale` (the «نقطة البيع» cart glyph is Filled) and the checkout pairs (same rail). The labelled panel shows no glyphs, as before. |

All three stay **open until the owner signs off**; IC-2 does not merge before that.

## Not in these captures

- The DEV-only `#/dev/sale-proof` text glyphs (`−` `＋` `←` `⌕` `✚`) moved to `remove`, `add`,
  `forward`, `search` and the brand cross. That page is not shipped, so it is not captured here.
- The scan notice (`!` → `status.warning`) is a 2-second transient; its unit test covers it.
- Legacy `ui/payments/VoucherEntry` `✓` is unchanged: that panel mounts only behind the
  `voucherTender` flag, which is off for the pilot (RT-10 D2), so it is not a live surface.
