# RT-446 evidence — packaged Park v1 (spec 024), 2026-10-23

Evidence-only branch, never merged. Same build, lab and driver as RT-754 (POS `e33fca25`, packaged; see `RUN-NOTES.md`).
Captures per scenario: `captures/446-s<N>-*.png`. Data: `data/` (lab DB before/after, local POS reads, the S4/S5 catalogue change and its exact restore).

Results: S1 FAIL (RT-836), S2 PASS (limit 5 as spec 024 is written; the owner's no-default-limit decision is a separate Planning issue), S3 PASS (sign-out and restart), S4 PASS, S5 PASS, S6 PASS (UI), S7 refusal PASS / close-after-clear NOT VERIFIED, S8 PASS (UI), S9 NOT VERIFIED (RT-837).
