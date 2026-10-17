# RT-646: count-aware sync counts — capture evidence

The copy is in doc 15 §5.1 and is **owner-approved (2026-10-17)**.

* **Captures:** 3 messages × counts 1, 2, 3 and 11 × 1024×768 and 1280×800, light, in the labelled nav panel (`/app/dashboard`). That makes 24 PNGs, named `rt646-<Message>-n<count>-<W>x<H>.png`.
* **Source:** the RT-604 / RT-605 DEV-only harness `#/dev/status-proof?state=<State>&count=<n>` (`src/renderer/v5/frame/dev/StatusIndicatorProof.tsx`). RT-646 adds only the `count` override. The real frame, the real `StatusIndicator` and the real notices stack read one fixed snapshot through the in-memory `window.api.terminalStatus` bridge. Vite drops the harness from production builds.
* **Tool:** [`tools/capture-rt646.cjs`](tools/capture-rt646.cjs). It checks every capture and exits non-zero on a text mismatch, an axe violation, a page error or horizontal overflow. The log is in [`rt646-capture-log.json`](rt646-capture-log.json).
* **What the captures prove:** layout and presentation only.

| Message | Harness state | 1 | 2 | 3 | 11 |
|---|---|---|---|---|---|
| M-O2 (indicator sync row; M-O1 shows too, offline) | `OfflinePending` | «عملية واحدة بانتظار الإرسال» | «عمليتان بانتظار الإرسال» | «3 عمليات بانتظار الإرسال» | «11 عملية بانتظار الإرسال» |
| S16 (indicator sync row) | `Sending` | «جارٍ إرسال عملية واحدة…» | «جارٍ إرسال عمليتين…» | «جارٍ إرسال 3 عمليات…» | «جارٍ إرسال 11 عملية…» |
| M-O3 (sync-attention banner; dead letters = n) | `Attention` | «تعذّر إرسال عملية واحدة. راجع المدير.» | «تعذّر إرسال عمليتين. راجع المدير.» | «تعذّر إرسال 3 عمليات. راجع المدير.» | «تعذّر إرسال 11 عملية. راجع المدير.» |

## Automated checks

| Check | Result |
|---|---|
| Rendered text equals the doc 15 §5.1 form for the count | 24 / 24 |
| Count run: none at 1 and 2 (words); `dir="ltr"` run with the Western-digit count at 3 and 11 | 24 / 24 |
| axe-core, whole document | **0 violations** in all 24 |
| Horizontal page overflow, page errors | none |

## Not covered

* Forced colours and the slim rail are not re-captured. The change is text only, and RT-604 / RT-605 already cover both modes. The slim rail shows glyphs, not the text.
