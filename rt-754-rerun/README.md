# RT-754 AC4 re-check evidence: focus ring on «بيع جديد» on completion (rt9 lab, 2026-10-23)

Evidence-only branch, never merged. Build: POS `origin/main` `5dc16c5a` (includes RT-840 #816 `4d60cf9f`), packaged `win-unpacked` (hashes in `pos-build-hashes.txt`).

- `captures/754r-1280-*`, `754r-1024-*`, `754r-125-*`: `*-completion*-arrival.png` were taken on arrival before any key; `*-shifttab.png` after Tab then Shift+Tab (the ring appears only then).
- `RUN-NOTES.md`: the combined-run log. `tools/`: launcher and SendInput/PrintWindow driver.
