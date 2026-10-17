/**
 * RT-634 (OBS-5) — renderer errors → main → Sentry.
 *
 * The renderer runs no Sentry SDK. It forwards an uncaught error or an
 * unhandled rejection as `{ name, message, stack }` over the typed
 * `app:report-error` channel (sender-guarded like every other channel). Main
 * treats the payload as untrusted:
 *
 *   - non-string fields are ignored, the rest are capped;
 *   - an odd `name` becomes `Error` (it is also the only field logged locally);
 *   - at most `MAX_REPORTS_PER_WINDOW` reports per minute are logged locally
 *     or reach Sentry, so a render loop cannot fill the disk or flood the DSN
 *     quota (D2) and the offline queue;
 *   - with Sentry not initialised nothing is sent.
 *
 * The capture happens in MAIN, so the allowlist `beforeSend`, the release
 * stamp and the bounded offline transport apply unchanged. Fire-and-forget:
 * this never throws and never awaits the SDK.
 */

const MAX_NAME_LENGTH = 100;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_LENGTH = 8000;
const MAX_REPORTS_PER_WINDOW = 10;
const WINDOW_MS = 60_000;
// An identifier-like error class name (`TypeError`, `DOMException`, `Foo.Bar`).
const ERROR_NAME_PATTERN = /^[A-Za-z_$][\w$.]{0,99}$/;

export interface RendererErrorCaptureHint {
  mechanism: { type: 'renderer'; handled: false };
}

export interface RendererErrorReporterDeps {
  /** `Sentry.captureException` from `@sentry/electron/main`. */
  captureException: (error: Error, hint: RendererErrorCaptureHint) => unknown;
  /** True once main Sentry initialised. */
  isEnabled: () => boolean;
  logger: { warn(fields: Record<string, unknown>, msg: string): void };
  now?: () => number;
}

interface ValidReport {
  name: string;
  message: string;
  stack?: string;
}

function field(payload: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function isPlainBag(payload: unknown): payload is Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload);
}

function errorName(raw: string | undefined): string {
  return raw !== undefined && ERROR_NAME_PATTERN.test(raw) ? raw : 'Error';
}

function validate(payload: unknown): ValidReport | null {
  if (!isPlainBag(payload)) return null;
  const message = field(payload, 'message', MAX_MESSAGE_LENGTH);
  const stack = field(payload, 'stack', MAX_STACK_LENGTH);
  if (message === undefined && stack === undefined) return null;
  const name = errorName(field(payload, 'name', MAX_NAME_LENGTH));
  return { name, message: message ?? '', ...(stack !== undefined ? { stack } : {}) };
}

function toError(report: ValidReport): Error {
  const error = new Error(report.message);
  error.name = report.name;
  error.stack = report.stack ?? `${report.name}: ${report.message}`;
  return error;
}

export function createRendererErrorReporter(
  deps: RendererErrorReporterDeps,
): (payload: unknown) => void {
  const now = deps.now ?? (() => Date.now());
  let windowStart = Number.NEGATIVE_INFINITY;
  let sentInWindow = 0;
  let throttleWarned = false;

  const admit = (): boolean => {
    const at = now();
    if (at - windowStart > WINDOW_MS) {
      windowStart = at;
      sentInWindow = 0;
      throttleWarned = false;
    }
    if (sentInWindow < MAX_REPORTS_PER_WINDOW) {
      sentInWindow += 1;
      return true;
    }
    if (!throttleWarned) {
      throttleWarned = true;
      deps.logger.warn({ limit: MAX_REPORTS_PER_WINDOW }, 'sentry:renderer-report-throttled');
    }
    return false;
  };

  return (payload) => {
    try {
      const report = validate(payload);
      // The rate limit bounds the local log too: a render loop must not fill
      // the till's disk.
      if (report === null || !admit()) return;
      deps.logger.warn({ name: report.name }, 'renderer:uncaught-error');
      if (!deps.isEnabled()) return;
      deps.captureException(toError(report), { mechanism: { type: 'renderer', handled: false } });
    } catch {
      // Reporting is best-effort; it must never surface into the caller.
    }
  };
}
