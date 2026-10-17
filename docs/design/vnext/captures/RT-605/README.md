# RT-605 (VN-S6 S6-4): notices-stack banners evidence

**Compare:** open [`compare.html`](compare.html). It shows each capture next to its frozen reference where one exists, with filters for width, mode and nav (labelled panel or slim rail).

* **Scope:** the S6-4 status banners (M-O1, M-O3), plus the owner's scope extension of 2026-10-17 (RT-605 Jira comment): the forced-shift-close banner and the printer-failure banner move onto the V5 `Banner` in the same stack.
* **Captures:** 9 states × 2 navs (labelled panel on `/app/dashboard`, slim rail on `/app/cart`, the active sale) × 1024×768 and 1280×800 × light and forced colours = 72 PNGs (`rt605-<State>-<nav>-<W>x<H>[-forced].png`).
* **Source:** the real frame, the real `V5OperationalNotices` stack and the real `StatusIndicator`, in the DEV-only harness `#/dev/status-proof?state=<State>&path=<route>` (`src/renderer/v5/frame/dev/StatusIndicatorProof.tsx`, the RT-604 harness with two more states). `closed=shift` (new in `OneFrameProof`) signs in through the real store path with a forced-close notice. The harness installs an in-memory `window.api.terminalStatus` that answers one fixed snapshot. The banners read the same store the indicator fills through the bridge subscription; nothing writes the store directly. Vite drops the harness from production builds.
* **What the captures prove:** layout and presentation only. The packaged bench (real API stop, cable pull, a real dead letter) is S6-V (RT-607).

| State | Harness query | Snapshot | Stack (top to bottom) |
|---|---|---|---|
| Offline | `state=Offline` | offline, nothing pending | M-O1 (warning) |
| Degraded | `state=Degraded` | `degraded` | M-O1 (warning), D-6-2 |
| AttentionDeadLetter | `state=Attention` | online, 2 dead letters, 1 pending | M-O3 (danger) «تعذّر إرسال 2 عمليات. راجع المدير.» |
| Attention24h | `state=Attention24h` | online, 2 pending, oldest 26 h old, no dead letter | M-O3 (danger), n = 2 (D-6-5) |
| OfflineAttention | `state=OfflineAttention` | offline, 1 dead letter, 2 pending (20 min old) | M-O3 (n = 1), then M-O1 |
| OfflineAttentionPrinter | `state=OfflineAttention&banner=printer` | as above, plus the last print failed | M-O3, M-O1, then the printer-failure banner |
| ShiftClosed | `state=Connected&closed=shift` | online; previous shift force-closed while away | shift-closed banner (info), M-W4 + «إخفاء» |
| PrinterFailed | `state=PrinterFailed` | online; last print failed | printer-failure banner (warning) |
| FullStack | `state=OfflineAttention&banner=printer&closed=shift` | everything at once | M-O3, shift closed, M-O1, printer failure (§4.3 order) |

### The two restyled banners (owner scope extension)

* **Shift closed** (`ui/operator/ShiftClosedBanner.tsx`): was English («Your previous shift was closed on … while you were away.» / «Dismiss») on the legacy `.shift-closed-banner`. Now a V5 **info** `Banner` with the drafted Arabic copy **M-W4** «أُغلقت ورديتك السابقة في ‹date› أثناء غيابك.» and the action «إخفاء», recorded in doc 15 §5, **owner-approved (2026-10-17)**. The date is the existing absolute-date formatter (Arabic month, Western digits), bidi-isolated. Show-once and dismiss are unchanged (the session store still owns both).
* **Printer failure** (`ui/receipts/PrinterFailureBanner.tsx`): was `v4-row` with 007 `.btn` buttons and a coloured side stripe. Now a V5 **warning** `Banner` with V5 banner buttons and its own printer glyph (new `printer` V5 icon), so it is never confused with the offline banner's triangle. Copy, the three actions, reprint gating, `aria-busy` (spinner now `.v5-banner__spinner`) and the 1 s `banner_state` feed are unchanged.
* **CSS retired** from `styles/tailwind.css`: `.shift-closed-banner*`, `.printer-failure-banner*` (with its keyframes), `.v4-row` / `.v4-row--between`, and the `banner-slide-in` keyframes that only the shift-closed banner used. Nothing else referenced them. `.btn` stays (ReauthDialog still uses it).

### Status banner copy

Copy is verbatim from doc 15 §M-O: M-O1 «غير متصل — البيع محفوظ على هذا الجهاز وسيُرسَل عند عودة الاتصال.» and M-O3 «تعذّر إرسال ‹n› عمليات. راجع المدير.» (D-6-11). The count is an isolated LTR run with Western digits. Neither banner lists online-only actions (D-6-9), and neither has a dismiss control: each leaves when its state is over.

## Automated checks ([`rt605-capture-log.json`](rt605-capture-log.json))

These ran on every capture, through [`tools/capture-rt605.cjs`](tools/capture-rt605.cjs). Each case waits (retrying) for its expected banner stack, and the tool exits non-zero if any capture shows a different stack, a legacy class, an axe violation or a page error:

| Check | Result |
|---|---|
| axe-core, whole document (light) | **0 violations** in all 36 light captures |
| Stack order (DOM) | attention → shift closed → offline → printer in every capture that has them (doc 24 §4.3) |
| Legacy classes (`.shift-closed-banner`, `.printer-failure-banner`, `.v4-row`, `.btn` in the printer banner) | none, in all 72 |
| «غير متصل —» shown once | exactly 1 element in every offline capture, and no 007 `StatusBanner` (`.status-banner`) anywhere |
| Banner text under 12px | none |
| Horizontal page overflow | none |
| `<main>` still visible | ≥ 534 px of 768 with all four banners at 1024 (604 px with three, 674 px with two) |
| Page errors | none |

## Keyboard-only walk ([`rt605-walk-log.json`](rt605-walk-log.json))

[`tools/walk-rt605.cjs`](tools/walk-rt605.cjs), no mouse after load, one full Tab cycle (sign-out reached twice; the tool exits non-zero on any failure), for Offline, AttentionDeadLetter, OfflineAttention, OfflineAttentionPrinter, ShiftClosed and FullStack, in the panel and the slim rail. **12 / 12 pass:**

* M-O1 and M-O3 add no control, so Tab never stops inside them.
* The shift-closed banner's «إخفاء» is reachable.
* With the printer banner, its «إعادة المحاولة» and «إيصال يدوي» stay reachable («نسخة» is disabled until a first print succeeded, as before). On the sale screen they come after Tab wraps, because the screen focuses its scan field on load; that order is unchanged by this slice.
* Both banners sit in the «إشعارات التشغيل» landmark with their text exposed. M-O1 is `role="status"` / polite; M-O3 is `role="alert"` / assertive (the V5 `Banner` danger rule).

The jsdom suite (`src/renderer/v5/__tests__/status-banners.test.tsx`) also runs axe on the notices strip with both banners in the panel and the slim rail: 0 violations.

## Frozen references

* **Offline, Degraded, OfflineAttention, OfflineAttentionPrinter** are paired with **I3-Offline** (1024 and 1280) and, at 1024, **VN-R7** offline selling. The I3 PNGs are the ones RT-604 rasterised from the doc 15 B3 iteration 3 HTML (`../RT-604/references/`); VN-R7 is the RT-104 reference (`../../references/`). Both are linked, not copied.
* **PrinterFailed** is paired with **I3-Receipt** (1024 and 1280, rasterised into [`references/`](references/) by [`tools/render-references.cjs`](tools/render-references.cjs)) and, at 1280, **VN-R5** print failed. Both show the receipt failure on the **completion surface** with M-C3 copy, not the frame banner; the frame banner keeps its existing copy, as the scope extension requires.
* **No frozen reference exists for M-O3** (sync attention), **for the shift-closed banner**, or **for the full stack**, in doc 15, doc 24, the RT-104 references or the B3 visual-acceptance HTML. Those captures stand alone.
* **The references differ from the implementation on purpose.** I3-Offline draws the pre-V5 top bar with an «غير متصل» chip and a sub-bar, not a banner. VN-R7 draws a banner with different copy («تعمل دون اتصال · المبيعات تُحفظ على هذا الجهاز وتُرسل تلقائيًا عند عودة الاتصال. الكاتالوج من …») and a «الطابعة جاهزة» row, which D-6-7 rejects. The implementation follows doc 24 §4.3 and uses the frozen doc 15 M-O1 copy verbatim.

## Interpretations the owner should confirm

1. **M-O3 and M-O1 show together.** Doc 24 §4.1 says the first matching rule wins "for the banner", but §4.3 lists sync attention and offline as separate entries of one stack, and this slice was asked for an offline + attention capture. So each banner shows whenever its own condition holds, in the §4.3 order.
2. **M-O3's ‹n›** is the dead-letter count, plus every pending sale once the oldest pending sale is older than 24 h (they wait behind it). With only dead letters it is the dead-letter count; with only the 24 h line it is the pending count. Doc 15 and doc 24 do not define ‹n› for the 24 h case. Sales held from a previous pairing are not counted (D-6-4, as in RT-604).
3. **No snapshot yet shows no banner.** Before the first bridge answer the state is unknown, so neither M-O1 nor M-O3 is shown (doc 24 §2.4: never a guess).
4. **One subscription.** The banners read the store that the nav's `StatusIndicator` connects. Both live in the same V5 frame, so the frame has exactly one `get` and one push subscription (a test checks this). The 24 h timer reuses the indicator's one-shot deadline hook, moved to `terminal-status/use-attention-deadline.ts` so both cross the line together.
5. **M-W4 copy (new, owner-approved 2026-10-17):** «أُغلقت ورديتك السابقة في ‹date› أثناء غيابك.» and the dismiss label «إخفاء». Recorded in doc 15 §5 and tested against it.
6. **The printer banner gets its own glyph** (a printer with a warning mark, the shape the legacy banner used) instead of the warning triangle, so it reads apart from M-O1 when both show. Its three buttons are the quiet V5 banner buttons; «إعادة المحاولة» is no longer filled primary.
7. **Counts follow the frozen copy verbatim**, so «تعذّر إرسال 1 عمليات» does not change with the number. The count-aware forms are RT-646.
8. **The 007 connection banner no longer renders in the frame.** `V5Frame` stops mounting the 007 `StatusBanner`, so offline is never shown twice. The 007 component, the legacy connection store and the `?conn=` toggle still exist (the toggle now only sets the unused legacy store); deleting them is S6-5 (RT-606).

## Re-running

With `npm run dev:vite` running, from the repo root. The tools default to the cloud session's Chromium and `playwright-core`; elsewhere set `CHROMIUM_PATH` (and `PLAYWRIGHT_CORE`) to a local install. The repo declares no Playwright dependency, and adding one is out of scope (CLAUDE.md §10).

```bash
node docs/design/vnext/captures/RT-605/tools/capture-rt605.cjs docs/design/vnext/captures/RT-605
node docs/design/vnext/captures/RT-605/tools/walk-rt605.cjs docs/design/vnext/captures/RT-605/rt605-walk-log.json
node docs/design/vnext/captures/RT-605/tools/render-references.cjs
node docs/design/vnext/captures/RT-605/tools/build-compare.cjs
```
