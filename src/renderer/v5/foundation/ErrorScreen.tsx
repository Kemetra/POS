import { useEffect, useRef, useState, type JSX } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { createRendererLogger, type RendererLogger } from '../../logging/logger';
import './route-states.css';

interface ErrorScreenProps {
  /** Injected for tests; production uses the renderer → main log bridge. */
  logger?: RendererLogger;
  /** Injected for tests; production reloads the renderer. */
  onReload?: () => void;
}

const defaultLogger = createRendererLogger();

/* v8 ignore next 3 -- jsdom/happy-dom cannot reload; tests inject onReload */
function reloadRenderer(): void {
  window.location.reload();
}

/** Eight hex characters: short enough to read aloud to a manager. */
function newSupportRef(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

/** A loggable kind for the error: never its message, which may carry internals. */
function errorName(error: unknown): string {
  if (isRouteErrorResponse(error)) return `route_${String(error.status)}`;
  return error instanceof Error ? error.name : typeof error;
}

/**
 * RT-241 (VNext W1-A, VN-S2) — the route error boundary (06 `ErrorScreen`):
 * What happened → What is safe → What to do → Evidence.
 *
 * It claims only what is true of a renderer render error: drawing a screen
 * cannot change what main has stored. It never shows the raw error text (it
 * may carry internals), only a support reference, and logs the error name
 * under that same reference. Its one action reloads the renderer; no new
 * recovery behaviour is invented here.
 */
export function ErrorScreen({
  logger = defaultLogger,
  onReload = reloadRenderer,
}: ErrorScreenProps): JSX.Element {
  const error = useRouteError();
  const [ref] = useState(newSupportRef);
  const actionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    logger.error('renderer route error', { ref, error_name: errorName(error) });
  }, [logger, ref, error]);

  useEffect(() => {
    actionRef.current?.focus();
  }, []);

  return (
    <main className="v5-route-state" aria-labelledby="v5-error-screen-title" dir="rtl" lang="ar">
      <section className="v5-route-state__panel">
        <h1 id="v5-error-screen-title" className="v5-route-state__title">
          تعذّر عرض هذه الشاشة.
        </h1>
        <p>ما حُفظ على هذا الجهاز لم يتأثر.</p>
        <p>أعد تحميل الشاشة. إذا تكرر الخطأ فأبلغ المدير برقم المرجع.</p>
        <p className="v5-route-state__meta">
          رقم المرجع:{' '}
          <bdi dir="ltr" data-testid="error-screen-ref">
            {ref}
          </bdi>
        </p>
        <button ref={actionRef} type="button" className="v5-route-state__action" onClick={onReload}>
          إعادة تحميل
        </button>
      </section>
    </main>
  );
}
