import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { LockScreen } from '../LockScreen';
import type { LockStateView } from '../../../shared/bridge-api';

afterEach(cleanup);

/**
 * RT-593 (VN-S8 lock) — the lock screen on the V5 vocabulary.
 *
 * Owner decision L3 / doc 15 §2.1 (RT-593 comment, 2026-10-17): the lock
 * surface shows NOTHING of the sale — no lines, no count, no amounts. Main
 * still provides `summary`; the screen no longer renders it.
 */

const LOCKED: LockStateView = {
  state: 'locked',
  locked_at: '2026-10-01T10:10:00.000Z',
  role: 'cashier',
  display_name: 'Cashier One',
  summary: { line_count: 3, total_minor: 5275, tender_applied_minor: 1000, has_live_tender: true },
};

function renderLock(view: LockStateView = LOCKED, onSwitchOperator?: () => void) {
  return render(
    <LockScreen
      view={view}
      unlock={vi.fn(() => Promise.resolve({ kind: 'unlocked' as const }))}
      onUnlocked={vi.fn()}
      {...(onSwitchOperator !== undefined ? { onSwitchOperator } : {})}
    />,
  );
}

describe('RT-593 lock hides the sale (L3)', () => {
  it.each(['cashier', 'manager'] as const)(
    'renders no line, count, amount or paid-so-far for a %s lock',
    (role) => {
      renderLock({ ...LOCKED, role });
      const text = document.body.textContent;
      // line_count 3, total 52.75, tender applied 10.00 — none may appear in any form.
      expect(text).not.toMatch(/52[.,٫]75|5275|10[.,٫]00|1000/);
      expect(text).not.toContain('مدفوع حتى الآن');
      expect(text).not.toContain('عدد الأصناف');
      expect(text).not.toContain('الإجمالي');
      expect(document.querySelector('dl, .session-lock__summary')).toBeNull();
      expect(document.body.textContent).not.toMatch(/\d{2,}\.\d{2}/);
    },
  );

  it('renders the same with and without a preserved sale', () => {
    // The Dialog portals into its DialogHost inside the lock root, so the root's markup is the whole screen.
    const markup = (): string =>
      (document.querySelector('.session-lock')?.innerHTML ?? '').replace(/_r_[0-9a-z]+_/g, '_id_');
    const withSale = renderLock();
    const a = markup();
    expect(a).not.toBe('');
    withSale.unmount();
    renderLock({ ...LOCKED, summary: null });
    expect(markup()).toBe(a);
  });

  it('never reads the summary or the money formatter in the source', () => {
    const src = readFileSync(resolve(__dirname, '../LockScreen.tsx'), 'utf-8');
    expect(src).not.toMatch(/\.summary\b/);
    expect(src).not.toMatch(/formatCheckoutMoney/);
  });
});

describe('RT-593 lock is V5, not 007', () => {
  it('does not import the 007 primitives', () => {
    const src = readFileSync(resolve(__dirname, '../LockScreen.tsx'), 'utf-8');
    expect(src).not.toMatch(/ui\/primitives/);
  });

  it('renders through the one V5 Dialog with the M-L1 copy', () => {
    renderLock();
    const dialog = screen.getByRole('dialog', { name: 'الطرفية مقفلة' });
    expect(dialog).toHaveClass('v5-dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.closest('.v5-dialog-backdrop')).not.toBeNull();
    // M-L1 «الطرفية مقفلة. أدخل الرقم السري للمتابعة.» — title, then prompt.
    expect(screen.getByRole('heading', { name: 'الطرفية مقفلة' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('أدخل الرقم السري للمتابعة.');
    expect(dialog).toHaveAccessibleDescription('أدخل الرقم السري للمتابعة.');
    expect(document.querySelector('.dialog-panel, .dialog-overlay')).toBeNull();
  });

  it.each(['manager', 'admin'] as const)('shows M-L1b to a %s, not the PIN prompt', (role) => {
    renderLock({ ...LOCKED, role });
    // M-L1b «الطرفية مقفلة. أدخل بيانات الدخول للمتابعة.» — same title, role-specific prompt.
    const dialog = screen.getByRole('dialog', { name: 'الطرفية مقفلة' });
    expect(dialog).toHaveAccessibleDescription('أدخل بيانات الدخول للمتابعة.');
    expect(dialog).not.toHaveTextContent('أدخل الرقم السري للمتابعة.');
  });

  it('uses V5 button vocabulary and keeps the switch-operator button', () => {
    renderLock(LOCKED, vi.fn());
    const unlock = screen.getByRole('button', { name: 'فتح القفل' });
    expect(unlock).toHaveClass('v5-live-btn', 'v5-live-btn--primary');
    expect(unlock).toHaveAttribute('type', 'submit');
    const sw = screen.getByRole('button', { name: 'دخول موظف آخر' });
    expect(sw).toHaveClass('v5-live-btn');
    expect(sw).toHaveAttribute('type', 'button');
  });

  it('focuses the first field on open and Esc clears the entry but keeps the lock', async () => {
    renderLock();
    const pin = screen.getByLabelText('رمز PIN');
    expect(pin).toHaveFocus();
    await userEvent.type(pin, '12');
    await userEvent.keyboard('{Escape}');
    expect(pin).toHaveValue('');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
