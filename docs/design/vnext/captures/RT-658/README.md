# RT-658: shift family on the G-2 references (evidence)

**Compare:** open [`compare.html`](compare.html). It shows every capture beside its frozen reference from the G-2 pack ([`../../visual-acceptance/G2-Shift/`](../../visual-acceptance/G2-Shift/G2-Spec.html)), merged on `main` as owner-approved in #736 (`0725cfa`). You can filter it by width and mode.

- **Captures:** 20 states × 1024×768 and 1280×800 × light and forced colours, 80 PNGs in all. Each file is named `rt658-<State>-<W>x<H>[-forced].png`. The state names are the G-2 names:
  - 14 for the cashier's `/app/shift`;
  - 6 for the manager's `/app/shift/manager`.
- **Source:**
  - The captures render the real router, the real V5 frame and the real shift screens in the DEV-only harness `#/dev/shift-proof?state=<State>` (`src/renderer/v5/shift/dev/ShiftProof.tsx`). Vite drops the harness from production builds.
  - The harness installs an in-memory `window.api.shiftCashup` that keeps state the way main's answers do. An open makes the shift open, a pay-in adds to the totals, and a close ends the shift.
  - Interactive states are reached through the controls an operator would use: [`tools/capture-rt658.cjs`](tools/capture-rt658.cjs) types into the fields and presses the visible buttons.
- **What the captures prove:** layout and presentation only. Shift rules, cash-up logic, the shift IPC, main and Backend-Core are out of scope and unchanged.

## Automated checks ([`rt658-capture-log.json`](rt658-capture-log.json))

These checks ran on every capture:

| Check | Result |
|---|---|
| axe-core, whole document (light) | **0 violations** in all 40 light captures |
| Text under 12px in the screen or a dialog | none |
| Control under 44×44 in the screen or a dialog | none |
| Screen section scrolls (content taller than the frame) | none |
| Horizontal page overflow | none |
| A `<time>` set in the monospace face | none (dates are in Dubai) |
| The RT-17 `.v5-shift-titlebar` | absent |
| Page errors | none |

## Keyboard-only walk ([`rt658-walk-log.json`](rt658-walk-log.json))

The walk script is [`tools/walk-rt658.cjs`](tools/walk-rt658.cjs). Nothing is clicked after the page loads. It ran at 1024 and 1280. **8 / 8 pass:**

- **Open shift.** The Tab order is «إيداع نقدي», «سحب نقدي», the count, «تسجيل العدّ وإغلاق الوردية», then the nav. Every stop shows the focus ring. Enter on «إيداع نقدي» opens the dialog with focus on «المبلغ». Tab stays inside the dialog. Escape closes it and focus returns to «إيداع نقدي».
- **Close from the keyboard.** The script types the count, tabs to the commit and presses Enter. The manager approval opens on «إلغاء». Tab stays inside the dialog. Escape returns focus to the close commit.
- **No shift.** The float field is reachable. An invalid entry is announced, and the field is marked `aria-invalid`.
- **Manager page.** «تحديث» sits in the status card head. After it come the three PIN fields and «حفظ الرقم السري», in that order, all with the ring.

The walk found one keyboard defect, which already exists on main:

- **Symptom:** after Escape on the manager approval, focus fell to `<body>`.
- **Cause:** the close commit is disabled while the approval is open, which is pinned behaviour that stops a second send. Because of that, Chromium drops focus from it, so the dialog has nothing to return focus to.
- **Fix:** focus only. When the dialog goes away and the close card is still on screen, focus goes back to the commit (`useFocusBackAfterApproval` in `CloseShiftPanel.tsx`). The commit stays disabled while the approval is open.
- **Result:** the walk failed before the fix and passes after it. jsdom keeps focus on a disabled button, so the unit test is a regression guard only.

## Differences from the references (all expected)

- **Nav footer.** The status indicator in the nav footer is RT-604, which merged after G-2 was drawn. The references have no indicator.
- **Sample values.** The typed amounts differ slightly from the drawings. For example, the harness types `2450` where ParkedBlocked draws `2,450.00`. These are sample inputs, not layout.

## The shared `shift.css`

`src/renderer/v5/shift/shift.css` was shared with the void screen and the recovery page. When I merged `origin/main` at `3df05cf`, both had moved to their own stylesheets: RT-654 (#743) for void and RT-656 (#740) for recovery. I re-ran the grep for every rule against the merged tree. The recovery test even asserts that no `v5-shift` class remains on that page.

**Retired: 30 rules.** Nothing on main uses them any more:

- The RT-17 frame: `.v5-shift`, `-titlebar`, `-columns`, `-panel`, `-message`, `-outcome`, `-facts` and `-fact`.
- The old approval list: `-managers` and `-manager`.
- `-alert`, together with the `ShiftAlert` component, which has no importers left.
- The old manager page: `-manager-screen`, `-actions` and every `-mgr-*` rule.

**Kept, because something still uses them:**

| Rule | Still used by |
|---|---|
| `-hint`, `-money`, `-btn`, `-btn--primary` | the shift screens |
| `-fields`, `-input` | the lock screen (`LockScreen.tsx`, `lock-screen.css`) and `ReauthDialog` |
| `-banner`, `-notice` | the frame's `ShiftNotice` |

Everything else in the file is the new G-2 section.

## Rerun

1. From the repo root, start Vite with `npm run dev:vite`.
2. Then run:

```
node docs/design/vnext/captures/RT-658/tools/capture-rt658.cjs docs/design/vnext/captures/RT-658
node docs/design/vnext/captures/RT-658/tools/walk-rt658.cjs docs/design/vnext/captures/RT-658
node docs/design/vnext/captures/RT-658/tools/build-compare.cjs
```
