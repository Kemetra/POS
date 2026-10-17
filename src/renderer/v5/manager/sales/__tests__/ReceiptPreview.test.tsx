/* eslint-disable @typescript-eslint/unbound-method --
 * vi.fn-typed mock properties on the bridge spy trigger this rule on every
 * `expect(bridge.preview)` assertion. Same posture as the payments bridge tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ReceiptsBridgeAPI, ReceiptsPreviewResponse } from '../../../../../shared/bridge-api';
import { expectNoAxeViolations } from '../../../../test-utils/axe-config';
import { ReceiptPreview } from '../ReceiptPreview';
import { SALES_COPY as C } from '../sales-copy';

/**
 * RT-659 — the receipt preview as a V5 Dialog (G-6 addendum, G6P-Receipt-Preview,
 * owner option A, 2026-10-17): «إغلاق» only, the sale number under the title,
 * the engine's slip in a focusable scroll region. No zoom, no duplicate ✕, no
 * «طباعة»: reprint stays on the result row.
 *
 * Ports every still-valid case of the 008 preview tests (fetch, loading,
 * refusal / rejection / no bridge, close, Esc, unmount guards, axe, the
 * window.api fallback) and pins the V5 Dialog behaviour.
 */

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
});

const NUMBER = 'TERM-01-2026-10-15-000042';
const SLIP = '<div class="receipt" dir="rtl"><div class="band">Sale # ' + NUMBER + '</div></div>';

function ok(html = SLIP): ReceiptsPreviewResponse {
  return {
    kind: 'ok',
    preview: { html, width_chars: 42, bilingual_locale: 'ar-EG-RTL-with-latin-en' },
  };
}

function bridge(
  answer: () => Promise<ReceiptsPreviewResponse> = () => Promise.resolve(ok()),
): ReceiptsBridgeAPI {
  return { preview: vi.fn(answer) } as unknown as ReceiptsBridgeAPI;
}

const pending = (): Promise<ReceiptsPreviewResponse> => new Promise(() => {});

/** `null` renders with no injected bridge (production falls back to window.api). */
function open(b: ReceiptsBridgeAPI | null = bridge(), onClose = vi.fn()) {
  const view = render(
    <ReceiptPreview
      saleId="sale-1"
      saleNumber={NUMBER}
      onClose={onClose}
      {...(b !== null ? { _testBridge: b } : {})}
    />,
  );
  return { ...view, onClose };
}

describe('RT-659 — the V5 Dialog', () => {
  it('is one modal dialog named «معاينة الإيصال», described by the sale number', async () => {
    open();
    const dialog = await screen.findByRole('dialog', { name: C.preview });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: C.preview })).toBeVisible();
    expect(dialog).toHaveAccessibleDescription(NUMBER);
    // The sale number is an isolated LTR code.
    expect(within(dialog).getByText(NUMBER, { selector: 'bdi' })).toHaveAttribute('dir', 'ltr');
  });

  it('has «إغلاق» as its only control: no zoom, no ✕, no «طباعة»', async () => {
    open();
    const dialog = await screen.findByRole('dialog');
    await screen.findByRole('region', { name: C.previewSlip });
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([C.previewClose]);
    expect(screen.queryByRole('button', { name: 'زر التكبير' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'طباعة' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إغلاق المعاينة' })).not.toBeInTheDocument();
  });

  it('focuses «إغلاق» on open (the safe control)', async () => {
    open();
    const close = await screen.findByRole('button', { name: C.previewClose });
    expect(close).toHaveFocus();
  });

  it('closes on «إغلاق»', async () => {
    const { onClose } = open();
    await userEvent.click(await screen.findByRole('button', { name: C.previewClose }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Esc and ignores other keys', async () => {
    const { onClose } = open();
    await screen.findByRole('button', { name: C.previewClose });
    await userEvent.keyboard('a');
    await userEvent.keyboard('{ArrowDown}');
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog: the slip region, then «إغلاق»', async () => {
    open();
    const close = await screen.findByRole('button', { name: C.previewClose });
    const slip = await screen.findByRole('region', { name: C.previewSlip });
    expect(slip).toHaveAttribute('tabindex', '0');
    await userEvent.tab();
    expect(slip).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(slip).toHaveFocus();
  });

  it('returns focus to the control that opened it', async () => {
    function Host() {
      const [shown, setShown] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setShown(true);
            }}
          >
            {C.preview}
          </button>
          {shown && (
            <ReceiptPreview
              saleId="sale-1"
              saleNumber={NUMBER}
              onClose={() => {
                setShown(false);
              }}
              _testBridge={bridge()}
            />
          )}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: C.preview });
    await userEvent.click(opener);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});

describe('RT-659 — the slip, loading and failure', () => {
  it('fetches receipts.preview and shows the engine slip in the «الإيصال» region', async () => {
    const b = bridge();
    open(b);
    const slip = await screen.findByRole('region', { name: C.previewSlip });
    expect(slip).toHaveTextContent(`Sale # ${NUMBER}`);
    expect(b.preview).toHaveBeenCalledWith({
      sale_id: 'sale-1',
      idempotency_key: 'preview-sale-1',
    });
  });

  it('never puts the sale id in an accessible name', async () => {
    open();
    await screen.findByRole('region', { name: C.previewSlip });
    const labelled = Array.from(document.querySelectorAll('[aria-label]'));
    expect(labelled.map((el) => el.getAttribute('aria-label')).join(' ')).not.toContain('sale-1');
  });

  it('shows «جارٍ التحضير» while the preview loads, with no slip region', () => {
    open(bridge(pending));
    expect(screen.getByRole('status')).toHaveTextContent(C.previewLoading);
    expect(screen.queryByRole('region', { name: C.previewSlip })).not.toBeInTheDocument();
  });

  it.each([
    ['refused', () => Promise.resolve({ kind: 'refused', reason: 'sale_not_found' } as const)],
    ['rejected', () => Promise.reject(new Error('ipc down'))],
  ])('shows «تعذّرت معاينة الإيصال» when the bridge %s', async (_label, answer) => {
    open(bridge(answer));
    expect(await screen.findByText(C.previewFailed)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: C.previewSlip })).not.toBeInTheDocument();
    // Still closable: «إغلاق» is the only control.
    expect(screen.getByRole('button', { name: C.previewClose })).toBeEnabled();
  });

  it('fails honestly with no bridge, or a window.api without receipts', async () => {
    open(null);
    expect(await screen.findByText(C.previewFailed)).toBeInTheDocument();
    cleanup();
    (window as unknown as { api: Record<string, unknown> }).api = { something: 1 };
    open(null);
    expect(await screen.findByText(C.previewFailed)).toBeInTheDocument();
  });

  it('reads window.api.receipts when no bridge is injected', async () => {
    (window as unknown as { api: { receipts: ReceiptsBridgeAPI } }).api = { receipts: bridge() };
    open(null);
    expect(await screen.findByRole('region', { name: C.previewSlip })).toHaveTextContent(NUMBER);
  });

  it('swallows an answer or a rejection that arrives after unmount', async () => {
    let resolveFn: (r: ReceiptsPreviewResponse) => void = () => {};
    let rejectFn: (e: unknown) => void = () => {};
    const late = bridge(
      () =>
        new Promise((res) => {
          resolveFn = res;
        }),
    );
    open(late).unmount();
    resolveFn(ok());
    const failing = bridge(
      () =>
        new Promise((_res, rej) => {
          rejectFn = rej;
        }),
    );
    open(failing).unmount();
    rejectFn(new Error('late'));
    await Promise.resolve();
    expect(late.preview).toHaveBeenCalled();
    expect(failing.preview).toHaveBeenCalled();
  });

  it.each([
    ['ready', () => Promise.resolve(ok())],
    ['loading', pending],
    ['failed', () => Promise.resolve({ kind: 'refused', reason: 'sale_not_found' } as const)],
  ])('is axe-clean when %s', async (state, answer) => {
    open(bridge(answer));
    if (state === 'ready') await screen.findByRole('region', { name: C.previewSlip });
    if (state === 'failed') await screen.findByText(C.previewFailed);
    await expectNoAxeViolations(document.body);
  });
});

describe('RT-659 — no inline styles, no dead controls', () => {
  const source = readFileSync(resolve(__dirname, '../ReceiptPreview.tsx'), 'utf8');

  it('the component carries no style={} and no disabled control', () => {
    expect(source).not.toMatch(/style=\{/);
    expect(source).not.toMatch(/CSSProperties/);
    expect(source).not.toMatch(/\bdisabled\b/);
  });

  it('the 008 preview and its zoom tokens are gone', () => {
    const tokens = readFileSync(resolve(__dirname, '../../../../styles/tailwind.css'), 'utf8');
    expect(tokens).not.toMatch(/--font-size-slip/);
    expect(() =>
      readFileSync(resolve(__dirname, '../../../../ui/receipts/ReceiptPreview.tsx'), 'utf8'),
    ).toThrow();
  });
});
