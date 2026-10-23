/**
 * RT-840 (RT-754 F-A): move focus and ask for the visible ring.
 *
 * Chromium's `:focus-visible` heuristic does not match a programmatic
 * `focus()` that follows a pointer interaction, so «بيع جديد» (and any control
 * focused after a mouse-confirmed step) held focus with no ring drawn. Passing
 * `focusVisible: true` makes the V5 focus-ring token (`--v5-focus-ring`, with
 * its forced-colors override) apply. Focus placement is the caller's.
 *
 * `FocusOptions.focusVisible` is not in the TS 5.6 DOM lib yet; the shipped
 * Electron's Chromium supports it, and an older engine ignores the key.
 */
export function focusVisibly(element: HTMLElement | null | undefined): void {
  element?.focus({ focusVisible: true } as FocusOptions);
}
