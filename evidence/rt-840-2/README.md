# RT-840 second attempt: packaged evidence (never merged)
Build: packaged POS main 5dc16c5a + TEMPORARY uncommitted focus-diagnostic overlay (bottom-left, not in any PR). rt9 lab, 1264x761, 100% DPI, keyboard Enter path.
- 11-t1.png: confirm button focused by Tab (ring visible).
- 13-completion-1264.png: after Enter, completion screen; overlay shows t+0/t+100 fv=true, 2px teal outline, hasFocus=true; at ~+470ms focusout and hasFocus=false (window lost OS activation), fv=false, outline none. No ring in the capture.
- 14-refocus.png: window brought back to front without a click; focusin on «بيع جديد», ring drawn again.
Cause: receipt os-print to the default (offline HP) printer starts HP "Printer Status" (shm4msm, 21:00:40 local; os_print:success 18:00:41Z) which takes the foreground.
