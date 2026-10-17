# RT-652: re-auth-required notice off the 007 `.btn`

Before and after captures of the re-auth-required notice on the stuck-shifts page, at 1280×800 in light mode. They are kept for the record. The change is effectively non-visual: one button moves to the V5 vocabulary.

* **Source:** the DEV-only one-frame harness at `#/dev/one-frame-proof?path=/app/manager/stuck-shifts&list=reauth`. RT-652 adds `list=reauth`, so `listStuckShifts` answers a `reauth_required` refusal.
* **Tool:** [`tools/capture-rt652.cjs`](tools/capture-rt652.cjs). It writes [`rt652-capture-log.json`](rt652-capture-log.json).

| | Button classes | Box | axe |
|---|---|---|---|
| [before](rt652-reauth-notice-before-1280x800.png) | `btn btn--primary btn--md` (007) | 115×44 | 0 violations |
| [after](rt652-reauth-notice-after-1280x800.png) | `v5-shift-btn v5-shift-btn--primary` (V5) | 119×44 | 0 violations |

The copy, the single action and the 44px target are unchanged.
