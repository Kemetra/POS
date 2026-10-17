# RT-604 (VN-S6 S6-3): status indicator evidence

**Compare:** open [`compare.html`](compare.html). It shows each capture next to its frozen reference where one exists, with filters for width, mode and nav (labelled panel or slim rail).

* **Captures:** 9 states × 2 navs (labelled panel on `/app/dashboard`, slim rail on `/app/cart`) × 1024×768 and 1280×800 × light and forced colours = 72 PNGs (`rt604-<State>-<nav>-<W>x<H>[-forced].png`).
* **Source:** the real frame and the real `StatusIndicator`, rendered in the DEV-only harness `#/dev/status-proof?state=<State>&path=<route>` (`src/renderer/v5/frame/dev/StatusIndicatorProof.tsx`). The harness installs an in-memory `window.api.terminalStatus` that answers one fixed snapshot. The indicator reads it through the same bridge subscription as production; nothing writes the status store directly. Vite drops the harness from production builds.
* **What the captures prove:** layout and presentation only. The packaged bench (real API stop, cable pull) is S6-V.

| State | Snapshot | Indicator |
|---|---|---|
| Connected | online, nothing pending | «متصل» (U6, M-O4). Sync idle: no sync row |
| Checking | `checking` | «جارٍ التحقق من الاتصال» (U7, D-6-2) |
| Offline | offline, nothing pending | «غير متصل» (U3) |
| Degraded | `degraded` | «غير متصل» (U3, D-6-2) |
| OfflinePending | offline, 3 pending | «غير متصل» + «3 عمليات بانتظار الإرسال» (M-O2) |
| Sending | online, 3 pending | «متصل» + «جارٍ إرسال 3 عملية…» (U4, S16) |
| Paused | online, 2 pending, `paused` | «متصل» + «2 عمليات بانتظار الإرسال» (U5, M-O2, D-6-6) |
| Attention | online, 2 dead letters | «متصل» + «تحتاج مراجعة» (U2) |
| PrinterFailed | online, last print failed | «متصل» + «فشل آخر إيصال» (D-6-7). The existing printer banner also shows |

## Automated checks ([`rt604-capture-log.json`](rt604-capture-log.json))

These ran on every capture, through [`tools/capture-rt604.cjs`](tools/capture-rt604.cjs):

| Check | Result |
|---|---|
| axe-core, whole document (light) | **0 violations** in all 36 light captures |
| Indicator inside the nav column and on screen, without scrolling | yes, in all 72 |
| Indicator text under 12px | none |
| Horizontal page overflow | none |
| Page errors | none |

## Keyboard-only walk ([`rt604-walk-log.json`](rt604-walk-log.json))

[`tools/walk-rt604.cjs`](tools/walk-rt604.cjs), no mouse after load, for Offline, Sending, Attention and PrinterFailed, in the panel and the slim rail. **8 / 8 pass:**

* The indicator adds no control, so it has no tab stop. Tab goes from the last nav link to «تسجيل الخروج», as before.
* Every row's text stays in the accessibility tree, in the slim rail too (glyphs only on screen).
* Only the connection row is a polite live region (`role="status"`), so a connection change is announced and a count change is not (doc 24 §4.2).

## Frozen references

* **Offline, Degraded, OfflinePending** are paired with **I3-Offline** (1024 and 1280) and, at 1024, **VN-R7** offline selling.
* **Sending** is paired with **I3-Syncing** (1024 and 1280).
* The I3 references are the doc 15 B3 iteration 3 HTML (frozen, "pending RT-113"). The PNGs in [`references/`](references/) are rasterised from that HTML by [`tools/render-references.cjs`](tools/render-references.cjs); the HTML itself is not changed.
* **No frozen reference exists** in doc 24 or the RT-104 package for Connected, Checking, Paused, Attention or PrinterFailed in the indicator. Those captures stand alone.
* **The references differ from the implementation on purpose.** They draw the pre-V5 top bar with status chips and older copy («بانتظار المزامنة», «مزامنة», «وضع عدم الاتصال»). The implementation follows doc 24 §4.1 / §4.2 (the approved plan) and DESIGN.md §Navigation (the indicator lives in the V5 nav footer), with the frozen M-O / S16 copy from doc 15. The offline and sync banners shown in the references are S6-4 (RT-605), not this slice.

## Interpretations the owner should confirm

1. **Sync idle shows no sync row.** Doc 24 §4.1 lists no sync copy when nothing is pending (U6 names only the connection row, U3 shows sync "if pending > 0"). A row such as "all sent" would be new copy, so none is shown.
2. **`checking` with pending sales shows M-O2 «‹n› عمليات بانتظار الإرسال».** Doc 24 does not cover this case. S16 «جارٍ إرسال» would claim sending without evidence of a connection, so the calm, true M-O2 is used, as for offline and paused.
3. **The 24 h attention line (D-6-5)** is checked whenever a snapshot arrives, plus one timer set for the moment the oldest pending sale turns 24 h old. That timer fires once; it is not a poll.
4. **Sales held from a previous pairing** (`heldPreviousPairing`) are not shown. D-6-4 counts this terminal's sales, and the §4.1 table uses `pending` only.
5. **Counts follow the frozen copy verbatim**, so the grammar does not change with the number: «1 عمليات بانتظار الإرسال», «جارٍ إرسال 3 عملية…». Plural forms would be new copy for doc 15.
6. **U1 (not paired or revoked)** has no row. The indicator lives only in the V5 frame, which the router mounts only for a paired, signed-in terminal; RT-215 recovery replaces the frame on revocation.
7. **The printer row reads the existing `banner_state` feed** through the existing `useBannerState` hook, which polls that feed every second, as the printer and drawer banners each already do. No new IPC read was added.
8. **The legacy 007 connection banner** stays mounted until S6-5 (RT-606). It is not visible in these captures because the legacy store is still `online`.
