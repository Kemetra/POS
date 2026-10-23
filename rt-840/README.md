# RT-840 evidence (not for merge)
Dev harness `#/dev/checkout-proof?preset=exact`, Playwright Chromium, 1280x800 and 1024x768, light and forcedColors=active.
before/ = main 1eac12f9; after/ = PR branch. `click` = pointer confirm, `enter` = keyboard confirm.
Result (`:focus-visible` on «بيع جديد»): before click = false (outline none), before enter = true, after = true in all 8 captures
(light ring rgb(15,118,110) 2px; forced-colors Highlight 2px). tools/el.cjs: shipped Electron 44 (Chromium 152.0.7977.130):
after a mouse click plain focus() = false, focus({focusVisible:true}) = true.
