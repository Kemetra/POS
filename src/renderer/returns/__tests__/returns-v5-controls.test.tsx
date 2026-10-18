import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { OUTCOME_COPY, PAYOUT_COPY } from '../returns-messages.js';
import {
  fakeBridge,
  journal,
  lookUpSale,
  pickAndQuote,
  renderReturns,
  resetStores,
  submitReturn,
} from './returns-test-kit.js';

/**
 * RT-660 — the RT-15 Returns content on the shared V5 controls, as the
 * owner-approved G6R references draw it (visual-acceptance/G6-Returns,
 * RD-1…RD-10). Panels, buttons, fields, facts, numbers and notices are the
 * shared v5 ones; returns.css and its rt-* class set are retired. Behaviour is
 * pinned by the other returns suites and does not change here.
 */
afterEach(() => {
  cleanup();
  resetStores();
});

const DIR = resolve(__dirname, '..');

/**
 * Every element under `root` whose class list still names a legacy rt-* class.
 * The icon registry's own `rt-icon*` classes (RT-695) are not legacy.
 */
function legacyClassed(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('[class]'))
    .flatMap((el) => Array.from(el.classList))
    .filter((name) => name.startsWith('rt-') && !name.startsWith('rt-icon'));
}

function panelOf(headingName: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: headingName });
  const panel = heading.closest('section');
  expect(panel, `${headingName} sits in a section`).not.toBeNull();
  return panel as HTMLElement;
}

describe('returns.css and the rt-* class set are retired', () => {
  const sources = readdirSync(DIR)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => [f, readFileSync(resolve(DIR, f), 'utf8')] as const);

  it('returns.css no longer exists', () => {
    expect(existsSync(resolve(DIR, 'returns.css'))).toBe(false);
  });

  it.each(sources)('%s names no rt-* class and imports no returns.css', (_file, source) => {
    expect(source).not.toMatch(/['"`\s]rt-[a-z]/);
    expect(source).not.toMatch(/['/]returns\.css/);
  });

  it('no rendered step carries an rt-* class', async () => {
    const bridge = fakeBridge();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: [journal()] });
    const user = userEvent.setup();
    const { container } = renderReturns({ bridge });
    await screen.findAllByRole('row');
    expect(legacyClassed(container)).toEqual([]);
    await lookUpSale(user);
    expect(legacyClassed(container)).toEqual([]);
    await pickAndQuote(user);
    expect(legacyClassed(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'تأكيد الإرجاع' }));
    await screen.findByRole('heading', { name: PAYOUT_COPY.heading });
    expect(legacyClassed(container)).toEqual([]);
  });
});

describe('the steps are shared v5 panels, fields and buttons (G6R)', () => {
  it('lookup: a manager panel, a code input and one filled commit', () => {
    renderReturns();
    const panel = panelOf('البحث عن بيع');
    expect(panel).toHaveClass('v5-manager-panel');
    expect(screen.getByRole('heading', { name: 'البحث عن بيع' }).parentElement).toHaveClass(
      'v5-manager-panel__head',
    );
    const input = screen.getByLabelText('رقم البيع');
    expect(input).toHaveClass('v5-manager-input', 'v5-manager-input--code');
    expect(within(panel).getByRole('button', { name: 'بحث' })).toHaveClass(
      'v5-manager-btn',
      'v5-manager-btn--primary',
    );
  });

  it('a refusal is the shared danger notice with its glyph', async () => {
    const bridge = fakeBridge();
    bridge.lookup.mockResolvedValueOnce({ kind: 'refused', reason: 'sale_not_found' });
    const user = userEvent.setup();
    renderReturns({ bridge });
    await user.type(screen.getByLabelText('رقم البيع'), 'X-1{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('v5-notice');
    expect(alert).toHaveAttribute('data-tone', 'danger');
    expect(alert.querySelector('.v5-tone-icon svg')).not.toBeNull();
  });

  it('line selection: steppers, a fully returned pill, a quiet "search again" and the filled quote', async () => {
    const user = userEvent.setup();
    renderReturns();
    await lookUpSale(user);
    const panel = panelOf('اختر الأصناف المرتجعة');
    expect(panel).toHaveClass('v5-manager-panel');
    const increase = screen.getByRole('button', { name: 'زيادة بانادول 500 مجم' });
    expect(increase.closest('.v5-returns-stepper')).not.toBeNull();
    const done = within(panel).getByText('أُرجع بالكامل');
    expect(done).toHaveClass('v5-returns-state');
    expect(done.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'بحث عن بيع آخر' })).toHaveClass(
      'v5-manager-btn',
      'v5-manager-btn--ghost',
    );
    expect(screen.getByRole('button', { name: 'احسب مبلغ الاسترداد' })).toHaveClass(
      'v5-manager-btn--primary',
    );
  });

  it('quote: a table, the refund total as the largest tabular figure, one filled commit', async () => {
    const user = userEvent.setup();
    renderReturns();
    await lookUpSale(user);
    await pickAndQuote(user);
    const panel = panelOf('ملخص الاسترداد');
    expect(within(panel).getByRole('table')).toHaveClass('v5-returns-table');
    const total = panel.querySelector('.v5-returns-total__amount');
    expect(total).toHaveTextContent('24.99 EGP');
    expect(total).toHaveClass('v5-manager-num');
    expect(screen.getByRole('button', { name: 'تأكيد الإرجاع' })).toHaveClass(
      'v5-manager-btn--primary',
    );
    expect(screen.getByRole('button', { name: 'تعديل الكميات' })).not.toHaveClass(
      'v5-manager-btn--primary',
    );
  });

  it('outcome: a success notice, shared facts, and the payout beside them', async () => {
    const user = userEvent.setup();
    renderReturns();
    await submitReturn(user);
    await screen.findByRole('heading', { name: PAYOUT_COPY.heading });
    const announced = await screen.findByText(OUTCOME_COPY.confirmed);
    const notice = announced.closest('.v5-notice');
    expect(notice).toHaveAttribute('data-tone', 'success');
    expect(notice?.tagName).toBe('OUTPUT');
    expect(notice).not.toHaveAttribute('role');
    const panel = panelOf('نتيجة المرتجع');
    expect(panel.querySelector('dl')).toHaveClass('v5-manager-facts');
    expect(panel.querySelector('.v5-returns-outcome .v5-returns-payout')).not.toBeNull();
    const ready = screen.getByText(PAYOUT_COPY.ready).closest('.v5-notice');
    expect(ready).toHaveAttribute('data-tone', 'neutral');
    expect(ready).toHaveAttribute('aria-live', 'polite');
  });
});

describe('the journal (G6R history)', () => {
  it('each state is a pill with its own glyph and word; actions are shared buttons', async () => {
    const bridge = fakeBridge();
    bridge.list.mockResolvedValue({
      kind: 'ok',
      returns: [
        journal({ returnId: 'a', state: 'pending', returnRef: null }),
        journal({ returnId: 'b', state: 'confirmed' }),
        journal({ returnId: 'c', state: 'paid_out' }),
        journal({ returnId: 'd', state: 'refused', refusalReason: 'over_return' }),
        journal({ returnId: 'e', state: 'unknown', returnRef: null }),
      ],
    });
    renderReturns({ bridge });
    const rows = (await screen.findAllByRole('row')).slice(1);
    const pills = rows.map((row) => row.querySelector('.v5-returns-state'));
    expect(pills.map((p) => p?.getAttribute('data-state'))).toEqual([
      'pending',
      'confirmed',
      'paid_out',
      'refused',
      'unknown',
    ]);
    const glyphs = pills.map((p) => p?.querySelector('svg path')?.getAttribute('d'));
    expect(new Set(glyphs).size).toBe(5);
    expect(within(rows[1] as HTMLElement).getByRole('button')).toHaveClass('v5-manager-btn');
  });

  it('the table scrolls inside the journal panel, which fills the screen (RD-3)', async () => {
    const bridge = fakeBridge();
    bridge.list.mockResolvedValue({ kind: 'ok', returns: [journal()] });
    renderReturns({ bridge });
    const table = await screen.findByRole('table');
    expect(table.parentElement).toHaveClass('v5-returns-table-scroll');
    expect(panelOf('سجل المرتجعات على هذا الجهاز')).toHaveClass('v5-returns-journal');
  });

  it('an empty journal is a neutral notice', async () => {
    renderReturns();
    const empty = await screen.findByText(OUTCOME_COPY.historyEmpty);
    expect(empty.closest('.v5-notice')).toHaveAttribute('data-tone', 'neutral');
  });
});

describe('the fail-closed gate', () => {
  it('is the G-6 honest page: one neutral status notice', () => {
    renderReturns({ flag: false });
    const notice = screen.getByRole('status');
    expect(notice).toHaveClass('v5-notice');
    expect(notice).toHaveTextContent('المرتجعات غير مفعّلة على هذا الجهاز.');
    expect(notice.closest('.v5-honest-state')).not.toBeNull();
  });
});
