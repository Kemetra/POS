# RT-670: void attention banner link sized to the 44×44 target

Before and after captures of the frame's void attention banner (`SaleVoidNotice`, `.v5-void-banner`) at 1024×768 and 1280×800 in light mode. The banner's «عرض» link (`v5-live-btn v5-live-btn--primary`) had no size rule, so it rendered about 23px tall. RT-670 adds one scoped rule in `src/renderer/v5/void/void.css` (`.v5-void-banner .v5-live-btn`): `display: inline-flex`, centred, `min-block-size: var(--v5-target, 44px)`, `min-inline-size: 44px`. The copy, the link target (`/app/void`) and every other banner are unchanged.

* **Source:** the DEV-only void harness at `#/dev/void-proof?state=RefServer&from=dashboard`. RT-670 adds `from=dashboard`: the router starts on the manager dashboard, where the banner shows (it is hidden on the void screen itself). `state=RefServer` supplies one refused void that needs attention.
* **Tool:** [`tools/capture-rt670.cjs`](tools/capture-rt670.cjs). It writes [`rt670-capture-log.json`](rt670-capture-log.json).

| Capture | Link box (w×h) | Link display | Banner box (w×h) | axe |
|---|---|---|---|---|
| [before 1024×768](rt670-void-banner-before-1024x768.png) | 67×23 | block | 868×48 | 0 violations |
| [after 1024×768](rt670-void-banner-after-1024x768.png) | 67×44 | flex | 868×69 | 0 violations |
| [before 1280×800](rt670-void-banner-before-1280x800.png) | 67×23 | block | 1048×48 | 0 violations |
| [after 1280×800](rt670-void-banner-after-1280x800.png) | 67×44 | flex | 1048×69 | 0 violations |

The banner keeps its layout: the message on the reading side, the link on the other, the same padding and border. It grows by 21px in height only because the link now meets the 44px target. The link was already wider than 44px, so its width is unchanged.

The RT-652 touch-target guard (`src/renderer/v5/__tests__/touch-target-guard.test.ts`) no longer lists any known offender, and passes.
