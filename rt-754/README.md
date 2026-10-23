# RT-754 evidence — packaged keyboard-only Sale → Checkout, focus-not-obscured, forced colors (2026-10-23)

Evidence-only branch, never merged. Build: POS `origin/main` `e33fca25`, unsigned `win-unpacked` (hashes in `pos-build-hashes.txt`).
Lab: rt9 (`rt9-api:79537b34`, :13000), Descope operators, fresh profile `D:\rt9combo-userdata`.
Driver: `tools/pos.ps1` / `tools/posq.ps1` (Win32 SendInput keys + PrintWindow captures, no CDP, no mouse). Scans are simulated keyboard-wedge bursts, not a real scanner.
Full chronological log: `RUN-NOTES.md`.

| Run | Window (client) | Captures |
| --- | --- | --- |
| 1280×800, 100 % | 1280×800 | `captures/754-1280-*` (Sale Tab stops `m4.png`, Undo `m10`/`754-1280-v*`, Checkout `m16`, cash `m17`, completion `p24`/`p25`) |
| 1024×768, 100 % | 1024×768 | `captures/754-1024-*` (13-line cart, 60 Tab stops `m1024-0..2`, card path `754-1024-card*`/`cd*`) |
| forced colors | 1280×800, `--force-high-contrast` | `captures/754-fc-*`, `mfc1..4` |
| 125 % (emulated) | 1280×800 physical = 1024×640 CSS, `--force-device-scale-factor=1.25` | `captures/754-125-*`, `m125s/k/p/c` |

Findings: F-A (completion «بيع جديد» focused with no visible indicator), O-1 (Undo chip 8 s vs 7 Shift+Tabs), O-2 (one dropped simulated scan, not reproduced). Details in RUN-NOTES.md.
