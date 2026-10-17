import type { RendererErrorReport } from '../../shared/renderer-error-report';

/**
 * RT-634 (OBS-5) — renderer crash reporting without a renderer Sentry SDK.
 *
 * Listens for uncaught errors and unhandled rejections and forwards
 * `{ name, message, stack }` over the typed bridge (`window.api.reportError`).
 * Main validates, rate-limits, scrubs (OBS-1 allowlist) and sends — or does
 * nothing when Sentry is not configured. The DSN never reaches the renderer.
 *
 * A non-Error rejection reason is never serialised: it could be any object,
 * including a sale. Reporting is fire-and-forget and never throws into the
 * page.
 */

type Send = (report: RendererErrorReport) => Promise<void>;

function fromError(error: Error): RendererErrorReport {
  return error.stack !== undefined
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: error.name, message: error.message };
}

function fromErrorEvent(event: Event): RendererErrorReport {
  const { error, message } = event as Event & { error?: unknown; message?: unknown };
  if (error instanceof Error) return fromError(error);
  return { name: 'Error', message: typeof message === 'string' ? message : 'uncaught error' };
}

function fromRejection(event: Event): RendererErrorReport {
  const { reason } = event as Event & { reason?: unknown };
  if (reason instanceof Error) return fromError(reason);
  return { name: 'UnhandledRejection', message: 'non-error rejection' };
}

function forward(send: Send, report: RendererErrorReport): void {
  try {
    void send(report).catch(() => undefined);
  } catch {
    // Bridge missing or broken: reporting is best-effort.
  }
}

/** Install the listeners on `target` (the window). Returns an uninstaller. */
export function installErrorReporter(target: EventTarget, send: Send): () => void {
  const onError = (event: Event): void => {
    forward(send, fromErrorEvent(event));
  };
  const onRejection = (event: Event): void => {
    forward(send, fromRejection(event));
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
