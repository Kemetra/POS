/**
 * RT-117 (RT-115 D4 / RT-116 §2.3) — genuine-input activity reporting.
 *
 * The renderer half of 004 T028b, never built until now (RT-112 RC-1): without
 * it main measured session AGE, not inactivity, and ended sessions mid-sale.
 *
 * Genuine input = trusted keyboard (barcode scanner wedges type as keyboard),
 * pointer, wheel and touch events on the app window. Script-dispatched
 * (untrusted) events, focus/visibility changes, timers and network activity
 * never count. Reports go over the existing notify-only
 * `operator._reportActivity`, throttled to at most one per 5 s. Main ignores
 * reports while the session is locked, so input never unlocks.
 */

export const GENUINE_INPUT_EVENTS: readonly string[] = [
  'keydown',
  'pointerdown',
  'pointermove',
  'wheel',
  'touchstart',
];

const THROTTLE_MS = 5_000;

export interface ActivityReporterOptions {
  now?: () => number;
  /** Test seam. Production checks `event.isTrusted` (real user input only). */
  isGenuine?: (event: Event) => boolean;
}

export function installActivityReporter(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  report: () => void,
  opts: ActivityReporterOptions = {},
): () => void {
  const now = opts.now ?? Date.now;
  const isGenuine = opts.isGenuine ?? ((event: Event) => event.isTrusted);
  let lastReportAt = Number.NEGATIVE_INFINITY;

  const onInput = (event: Event): void => {
    if (!isGenuine(event)) return;
    const t = now();
    if (t - lastReportAt < THROTTLE_MS) return;
    lastReportAt = t;
    try {
      report();
    } catch {
      // Reporting is best-effort; input handling must never break.
    }
  };

  const options: AddEventListenerOptions = { capture: true, passive: true };
  for (const type of GENUINE_INPUT_EVENTS) target.addEventListener(type, onInput, options);
  return () => {
    for (const type of GENUINE_INPUT_EVENTS) target.removeEventListener(type, onInput, options);
  };
}
