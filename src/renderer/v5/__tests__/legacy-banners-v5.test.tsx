/**
 * RT-605 scope extension (owner, 2026-10-17) — the two legacy frame banners
 * move onto the V5 `Banner` in the `V5OperationalNotices` stack:
 *
 * - ShiftClosedBanner: a V5 info banner with Arabic copy (doc 15 M-W4,
 *   owner-approved 2026-10-17); show-once and dismiss unchanged.
 * - PrinterFailureBanner: a V5 warning banner with V5 buttons; copy, actions,
 *   reprint gating, aria-busy and the banner_state feed unchanged.
 *
 * The legacy `.shift-closed-banner`, `.printer-failure-banner` and `.v4-row`
 * rules leave tailwind.css. (`.btn` left too, in RT-652.)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptsBridgeAPI } from '../../../shared/bridge-api';
import { formatHumanDateTime } from '../../ui/format/human-format';
import { SHIFT_CLOSED_COPY, ShiftClosedBanner } from '../../ui/operator/ShiftClosedBanner';
import { PrinterFailureBanner } from '../../ui/receipts/PrinterFailureBanner';
import { expectNoAxeViolations } from '../../test-utils/axe-config';

afterEach(cleanup);

const CLOSED_AT = '2026-10-16T18:30:00.000Z';
const FAILURE = {
  sale_id: 'sale-1',
  failure_reason: 'printer_offline',
  has_successful_print: false,
};

function bridge(): ReceiptsBridgeAPI {
  return {
    retryPrint: vi.fn(() => new Promise(() => undefined)),
    manualOverride: vi.fn(() => new Promise(() => undefined)),
  } as unknown as ReceiptsBridgeAPI;
}

describe('ShiftClosedBanner — V5 info banner (M-W4)', () => {
  it('is a V5 info banner, announced politely', () => {
    render(<ShiftClosedBanner closedAt={CLOSED_AT} onDismiss={() => undefined} />);
    const banner = screen.getByTestId('shift-closed-banner');
    expect(banner).toHaveClass('v5-banner');
    expect(banner).toHaveAttribute('data-tone', 'info');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner.className).not.toContain('shift-closed-banner');
  });

  it('speaks Arabic, with the date from the absolute-date formatter in Western digits', () => {
    render(<ShiftClosedBanner closedAt={CLOSED_AT} onDismiss={() => undefined} />);
    const date = formatHumanDateTime(CLOSED_AT, { withYear: true, withTime: false }) as string;
    const banner = screen.getByTestId('shift-closed-banner');
    expect(banner).toHaveTextContent(
      `${SHIFT_CLOSED_COPY.before}${date}${SHIFT_CLOSED_COPY.after}`,
    );
    expect(banner.textContent).not.toMatch(/[A-Za-z]/);
    expect(banner.textContent).not.toMatch(/[٠-٩۰-۹]/);
  });

  it('isolates the date without forcing LTR (its month name is Arabic)', () => {
    render(<ShiftClosedBanner closedAt={CLOSED_AT} onDismiss={() => undefined} />);
    const date = screen.getByTestId('shift-closed-banner').querySelector('bdi');
    expect(date).not.toBeNull();
    expect(date).not.toHaveAttribute('dir', 'ltr');
  });

  it('keeps dismiss: an Arabic V5 banner action that calls onDismiss', () => {
    const onDismiss = vi.fn();
    render(<ShiftClosedBanner closedAt={CLOSED_AT} onDismiss={onDismiss} />);
    const banner = screen.getByTestId('shift-closed-banner');
    const dismiss = within(banner).getByRole('button', { name: SHIFT_CLOSED_COPY.dismiss });
    expect(dismiss).toBe(screen.getByTestId('shift-closed-banner-dismiss'));
    expect(dismiss.closest('.v5-banner__actions')).not.toBeNull();
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('is axe-clean', async () => {
    const { container } = render(
      <ShiftClosedBanner closedAt={CLOSED_AT} onDismiss={() => undefined} />,
    );
    await expectNoAxeViolations(container);
  });
});

describe('PrinterFailureBanner — V5 warning banner', () => {
  function renderBanner(hasPrint = false): HTMLElement {
    render(
      <PrinterFailureBanner
        printFailure={{ ...FAILURE, has_successful_print: hasPrint }}
        onReprint={() => undefined}
        _testReceiptsBridge={bridge()}
      />,
    );
    return screen.getByTestId('printer-failure-banner');
  }

  it('is a V5 warning banner with no legacy classes', () => {
    const banner = renderBanner();
    expect(banner).toHaveClass('v5-banner');
    expect(banner).toHaveAttribute('data-tone', 'warning');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveAttribute('aria-atomic', 'true');
    const classes = [banner, ...Array.from(banner.querySelectorAll('*'))].flatMap((el) =>
      Array.from(el.classList),
    );
    for (const legacy of ['v4-row', 'printer-failure-banner', 'btn']) {
      const hit = classes.filter(
        (c) => c === legacy || c.startsWith(`${legacy}--`) || c.startsWith(`${legacy}__`),
      );
      expect(hit).toEqual([]);
    }
  });

  it('keeps its own printer glyph, so it is never mistaken for the offline banner', () => {
    const banner = renderBanner();
    const tone = banner.querySelector('[data-icon="warning"]');
    const source = banner.querySelector('[data-icon="print"]');
    expect(source).not.toBeNull();
    // RT-695 (doc 25 §4.1): the printer sits beside the tone's own glyph, tone first.
    expect(tone).not.toBeNull();
    expect(tone?.compareDocumentPosition(source as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps the copy and the three actions as V5 banner buttons', () => {
    const banner = renderBanner();
    expect(banner).toHaveTextContent('فشل طباعة الإيصال · جرّب مرة أخرى أو حوّل للوضع اليدوي');
    const actions = banner.querySelector('.v5-banner__actions') as HTMLElement;
    expect(actions).not.toBeNull();
    expect(
      within(actions)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['إعادة المحاولة', 'نسخة', 'إيصال يدوي']);
  });

  it('keeps the reprint gating and aria-busy on the running action', () => {
    const banner = renderBanner(false);
    expect(within(banner).getByRole('button', { name: 'نسخة' })).toBeDisabled();
    const retry = within(banner).getByRole('button', { name: 'إعادة المحاولة' });
    fireEvent.click(retry);
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(within(banner).getByRole('button', { name: 'إيصال يدوي' })).toBeDisabled();
  });
});

describe('legacy banner CSS retired from tailwind.css', () => {
  const css = readFileSync(resolve(__dirname, '../../styles/tailwind.css'), 'utf8');

  it.each(['.shift-closed-banner', '.printer-failure-banner', '.v4-row'])('%s is gone', (rule) => {
    expect(css).not.toContain(rule);
  });

  it('RT-652: .btn is gone too (ReauthDialog moved to the V5 shift button)', () => {
    expect(css).not.toMatch(/\.btn\s*\{/);
  });
});

describe('doc 15 — M-W4 recorded as owner-approved', () => {
  const doc15 = readFileSync(
    resolve(__dirname, '../../../../docs/design/vnext/15-vnext-freeze-package.md'),
    'utf8',
  );

  it('carries the copy and dismiss label verbatim, marked approved', () => {
    const row = doc15.split('\n').find((line) => line.startsWith('| M-W4 |')) ?? '';
    expect(row).toContain(`«${SHIFT_CLOSED_COPY.before}‹date›${SHIFT_CLOSED_COPY.after}»`);
    expect(row).toContain(`«${SHIFT_CLOSED_COPY.dismiss}»`);
    expect(row).toContain('owner-approved 2026-10-17');
    expect(row).not.toContain('pending owner approval');
  });
});
