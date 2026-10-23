# RT-840 second attempt: packaged evidence (never merged)
Build: packaged POS main 5dc16c5a + TEMPORARY uncommitted focus-diagnostic overlay (bottom-left, not in any PR). rt9 lab, 1264x761, 100% DPI, keyboard Enter path.
- 11-t1.png: confirm button focused by Tab (ring visible).
- 13-completion-1264.png: after Enter, completion screen; overlay shows t+0/t+100 fv=true, 2px teal outline, hasFocus=true; at ~+470ms focusout and hasFocus=false (window lost OS activation), fv=false, outline none. No ring in the capture.
- 14-refocus.png: window brought back to front without a click; focusin on «بيع جديد», ring drawn again.
Cause: receipt os-print to the default (offline HP) printer starts HP "Printer Status" (shm4msm, 21:00:40 local; os_print:success 18:00:41Z) which takes the foreground.

## Re-run with BIXOLON SRP-B300 as default printer (owner-approved)
Clean packaged build of main 5dc16c5a (no overlay), rt9 lab, keyboard Enter path (Tab to confirm, Enter applies, Enter completes). No "Printer Status" window opened. bixolon/:
- t1264-* (client 1264x761, 100%), t1024-* (1024x700), t125-* (--force-device-scale-factor=1.25, 1584x962 px), thc-* (--force-high-contrast).
- *-b-confirm-focused: the confirm button focused; *-d-completion: «بيع جديد» shows the ring in all four.
Printer default restored to the HP afterwards.
