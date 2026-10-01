# VNext visual references (RT-104) — APPROVED (Direction B)

These are **design references**, not screenshots of the app and not implementation proof. Every
image carries a «مرجع تصميم VNext — ليس لقطة من التطبيق» tag. They render the design language
([../04-design-language.md](../04-design-language.md)) with the **shipped token values** from
`src/renderer/styles/tailwind.css`.

The owner approved the package on 2026-10-01 with **Direction B** (OD-7). The Sale and Checkout
references are therefore `VN-B1-*` and `VN-B2-*`. `VN-R1`/`VN-R2` remain as the Direction A
comparison, and the other `VN-R*` captures remain the state references.

> **Keyboard hints in every capture are conditional.** No reference keycap (F2, F3, F4, F8, F9,
> Enter) is a bound shortcut today. They illustrate RT-24's *proposed* key map, which is still
> unconfirmed (RT-24 §C.5, carried forward in [../README.md](../README.md#carried-forward--still-open)).
> Approval of these captures covers layout, hierarchy and states, not the key assignments.
> Implementations show a hint only for a key that is actually bound, after VN-S5 confirms the map
> ([`docs/DESIGN.md`](../../../DESIGN.md), Keyboard hints). The captures are kept as approved
> rather than re-rendered without hints.

- Source: [`src/build.cjs`](src/build.cjs) (generator), [`src/vnext-kit.css`](src/vnext-kit.css) (reference kit — **not** production CSS), generated HTML in `src/html/`.
- Regenerate: `node docs/design/vnext/references/src/build.cjs <path-to>/playwright/index.mjs` (uses the pre-installed Chromium; no repo dependency added).
- Fonts: production uses Windows **Dubai** + Consolas/Cascadia for numerals. The render sandbox has no Dubai, so references substitute **IBM Plex Sans Arabic / IBM Plex Mono** (loaded from Google Fonts at render time). Letterforms differ; layout, hierarchy, sizes and colours are the reference.
- Data is illustrative: product names, prices, the sale number `S-0412-000187`, the support reference and operator names are invented for layout only. The sale-number format is **not** a contract.
- Capture check: every capture was rendered at exact viewport size; the build asserts no horizontal overflow and no clipped panel (`console.table` in the build output, all `false` on 2026-09-30).

| ID | File | Width | State | RT-24 / RT-25 anchor | Status of underlying behaviour on `main@28890fa` |
|---|---|---|---|---|---|
| VN-R1 | `VN-R1-sale-1280.png` | 1280 | Sale, active cart, scan-owner **ready**, last scan acknowledged inline | RT-25 §3–§5; S08–S17 | Live (V5). Suspend (F4) and F-key hints are **target**, not bound. |
| VN-R1 | `VN-R1-sale-1024.png` | 1024 | Sale, typed search with keyboard-active result, scan-owner **paused** | RT-25 §6 | Live (V5) except scan-owner indicator and hints |
| VN-R2 | `VN-R2-checkout-cash-1280.png` | 1280 | Checkout cash, received ≥ due, change shown, amount due pinned | RT-25 §12, §14, §15; S22–S23 | Checkout is legacy 006 in V5 frame — **to be recomposed** (VN-S4). Back is **RT-26 target**. |
| VN-R2 | `VN-R2-checkout-cash-shortfall-1024.png` | 1024 | Checkout cash, shortfall, confirm disabled with reason, summary collapsed to strip | RT-25 §15 | as above |
| VN-R3 | `VN-R3-card-unknown-recovery-1280.png` | 1280 | External card result **UNKNOWN** — no re-charge, record terminal result, back refused | RT-25 §16, §18; S27 | No dedicated recovery surface today |
| VN-R4 | `VN-R4-card-terminal-entry-1024.png` | 1024 | External card: waiting for terminal result; optional 0–6 reference | RT-25 §16 | Live as legacy `ExternalCardTerminalEntry` |
| VN-R5 | `VN-R5-complete-print-failed-1280.png` | 1280 | Sale complete; receipt print failed; sync pending (info, not success) | RT-25 §19–§20; S29–S31 | Completion is v4; **no sale number/receipt yet** (blocked, X-4) |
| VN-R6 | `VN-R6-manager-approval-1280.png` | 1280 | Manager approval sheet for a line discount (manager-only, bound to cart) | RT-25 §8; RT-28 | No discount-entry or in-sale approval UI today |
| VN-R7 | `VN-R7-offline-selling-1024.png` | 1024 | Offline selling banner + sync backlog indicator | RT-25 §23; S36–S38 | Connection hard-coded online; sync status unmounted (X-2) |
| VN-R8 | `VN-R8-lock-live-tender-1280.png` | 1280 | Inactivity lock over a live cash tender — nothing lost | RT-25 §25 | Lock behaviour per RT-24; not verified on `main` |
| VN-R9 | `VN-R9-storage-blocked-1280.png` | 1280 | `STORAGE_BLOCKED` — stop collecting money | RT-25 §24; S39–S40 | No error boundary / blocking screen today |
| VN-R10 | `VN-R10-suspended-resume-conflict-1280.png` | 1280 | Suspended sales list + resume conflict + price-change notice | RT-25 §10–§11; S18–S21; RT-27 correction 3 | **Not implemented** (no park bridge) |
| VN-R11 | `VN-R11-shift-required-1280.png` | 1280 | Shift required / opening float (boundary) | RT-25 §2; S07 | No shift UI (D-003, RT-17) |
| VN-R12 | `VN-R12-returns-entry-gated-1280.png` | 1280 | Returns entry, not yet available for pilot (manager view) | RT-25 §22 | Manager/admin-only placeholder route (`shell-routes.ts`); cashier return flow RT-15 not built |
| — | `VN-R1-sale-1280-forced-colors.png`, `VN-R2-checkout-cash-1280-forced-colors.png` | 1280 | Windows contrast theme emulation (`forced-colors: active`) | 04 §15 | No forced-colors support in `src/renderer` today |

### Layout direction comparison (OD-7, [../10-direction-comparison.md](../10-direction-comparison.md))

| ID | File | Width | State |
|---|---|---|---|
| VN-B1 | `VN-B1-sale-1280.png` | 1280 | Direction B Sale: command bar, cart-first, money column |
| VN-B1 | `VN-B1-sale-search-1024.png` | 1024 | Direction B Sale: search dropdown over the cart, scan paused |
| VN-B2 | `VN-B2-checkout-cash-1280.png` | 1280 | Direction B Checkout, slim nav |
| VN-B2 | `VN-B2-checkout-cash-shortfall-1024.png` | 1024 | Direction B Checkout shortfall |
| CMP | `CMP-A-long-cart-{1024,1280}.png`, `CMP-B-long-cart-{1024,1280}.png` | both | 10-line cart capacity test (A vs B) |

Open [`index.html`](index.html) for the gallery and [`compare.html`](compare.html) for A vs B side by side.
