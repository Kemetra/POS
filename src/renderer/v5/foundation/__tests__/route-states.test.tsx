import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';

import type { RendererLogger } from '../../../logging/logger';
import { ErrorScreen } from '../ErrorScreen';
import { RouteLoading } from '../RouteLoading';

afterEach(cleanup);

/**
 * RT-241 (VNext W1-A, VN-S2) — the two route-level states the 06 inventory
 * names: `RouteLoading` (never blank) and `ErrorScreen` (route error boundary,
 * What → Safety → Action → Evidence).
 */
describe('RouteLoading', () => {
  it('is never blank: an Arabic status line inside the loading landmark', () => {
    render(<RouteLoading />);
    const main = screen.getByTestId('route-loading');
    expect(main.tagName).toBe('MAIN');
    expect(main).toHaveAttribute('aria-busy', 'true');
    expect(main).toHaveAttribute('dir', 'rtl');
    expect(main).toHaveAttribute('lang', 'ar');
    expect(screen.getByRole('status')).toHaveTextContent('جارٍ التحميل…');
  });
});

type LogFn = (msg: string, fields?: Record<string, unknown>) => void;

function fakeLogger(): RendererLogger & { error: ReturnType<typeof vi.fn<LogFn>> } {
  return {
    trace: vi.fn<LogFn>(),
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
    fatal: vi.fn<LogFn>(),
  };
}

function Boom(): never {
  throw new TypeError('secret-ish internal detail 4111111111111111');
}

function renderBrokenRoute(logger: RendererLogger, onReload: () => void): void {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Boom />,
        errorElement: <ErrorScreen logger={logger} onReload={onReload} />,
      },
    ],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

describe('ErrorScreen (route error boundary)', () => {
  // React logs the caught render error; keep the run output readable.
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  afterEach(() => {
    consoleError.mockClear();
  });

  it('says what happened, what is safe and what to do, in Arabic', () => {
    renderBrokenRoute(fakeLogger(), vi.fn());
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('dir', 'rtl');
    expect(main).toHaveAttribute('lang', 'ar');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('تعذّر عرض هذه الشاشة.');
    expect(screen.getByText('ما حُفظ على هذا الجهاز لم يتأثر.')).toBeInTheDocument();
    expect(
      screen.getByText('أعد تحميل الشاشة. إذا تكرر الخطأ فأبلغ المدير برقم المرجع.'),
    ).toBeInTheDocument();
  });

  it('never shows the raw error text', () => {
    renderBrokenRoute(fakeLogger(), vi.fn());
    expect(document.body.textContent).not.toContain('secret-ish');
    expect(document.body.textContent).not.toContain('4111');
  });

  it('shows a support reference and logs the error under the same reference, without its message', () => {
    const logger = fakeLogger();
    renderBrokenRoute(logger, vi.fn());

    const ref = screen.getByTestId('error-screen-ref');
    expect(ref.tagName).toBe('BDI');
    expect(ref).toHaveAttribute('dir', 'ltr');
    expect(ref.textContent).toMatch(/^[0-9A-F]{8}$/);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, fields] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe('renderer route error');
    expect(fields).toEqual({ ref: ref.textContent, error_name: 'TypeError' });
  });

  it('the reload action reloads, and it is the focused control', async () => {
    const onReload = vi.fn();
    renderBrokenRoute(fakeLogger(), onReload);
    const button = screen.getByRole('button', { name: 'إعادة تحميل' });
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('an unmatched path is logged as a route status, still in Arabic with no router default page', () => {
    const logger = fakeLogger();
    const router = createMemoryRouter(
      [{ path: '/', element: <p>home</p>, errorElement: <ErrorScreen logger={logger} /> }],
      { initialEntries: ['/nowhere'] },
    );
    render(<RouterProvider router={router} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('تعذّر عرض هذه الشاشة.');
    expect(screen.queryByText(/404 Not Found/)).not.toBeInTheDocument();
    const [, fields] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields['error_name']).toBe('route_404');
  });
});
