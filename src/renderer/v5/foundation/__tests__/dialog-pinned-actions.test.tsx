import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ReauthDialog } from '../../../ui/operator/ReauthDialog';
import { REAUTH_COPY } from '../../../ui/operator/messages';
import { expectNoAxeViolations } from '../../../test-utils/axe-config';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { ConfirmDialog } from '../ConfirmDialog';
import { DialogHost } from '../Dialog';

/**
 * RT-313 (RT-312 B2) — dialog.css pins the action row of a dialog taller than
 * the viewport by structure: the panel's last <div>, or the last <div> of a
 * form that ends the panel. These tests hold the real dialogs to that shape, so
 * the pinned row IS the action row, and walk it by keyboard. happy-dom does not
 * lay out; the scrolling itself is proved in Chromium (RT-313 evidence).
 */

/** The element dialog.css pins, found with the same selectors. */
function pinnedRow(panel: HTMLElement): HTMLElement | null {
  return panel.querySelector<HTMLElement>(
    ':scope > div:last-child, :scope > form:last-child > div:last-child',
  );
}

const LONG_BODY = Array.from(
  { length: 40 },
  (_, i) => `سطر ${String(i + 1)} من نص طويل لا يتسع له ارتفاع الشاشة.`,
).join(' ');

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
});

describe('ConfirmDialog with a body taller than the viewport', () => {
  function renderLong(): void {
    render(
      <DialogHost>
        <ConfirmDialog
          label="تأكيد طويل"
          title="تأكيد طويل"
          body={LONG_BODY}
          cancelLabel="رجوع"
          confirmLabel="تأكيد"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </DialogHost>,
    );
  }

  it('its action row is the pinned row, holding both actions', () => {
    renderLong();
    const panel = screen.getByRole('dialog', { name: 'تأكيد طويل' });
    const row = pinnedRow(panel);
    expect(row).not.toBeNull();
    const actions = within(row as HTMLElement).getAllByRole('button');
    expect(actions.map((b) => b.textContent)).toEqual(['رجوع', 'تأكيد']);
  });

  it('keyboard walk: both actions are reached and Tab stays inside', async () => {
    renderLong();
    const user = userEvent.setup();
    const cancel = screen.getByRole('button', { name: 'رجوع' });
    const confirm = screen.getByRole('button', { name: 'تأكيد' });
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('no axe violations', async () => {
    renderLong();
    await expectNoAxeViolations(document.body);
  });
});

describe('ReauthDialog (actions inside a form that ends the panel)', () => {
  function renderReauth(): void {
    useOperatorSessionStore.getState().beginSignIn();
    useOperatorSessionStore.getState().resolveSignedIn({
      id: 's1',
      operator_id: 'op-1',
      display_name: 'د. سارة',
      role: 'manager',
      tenant_id: 't1',
      branch_id: 'b1',
      started_at: '2026-10-11T08:00:00.000Z',
    });
    render(
      <ReauthDialog
        operator={{ reauthenticate: vi.fn() }}
        onReauthenticated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
  }

  it('its action row is the pinned row, holding cancel and submit', () => {
    renderReauth();
    const panel = screen.getByRole('dialog', { name: REAUTH_COPY.title });
    const row = pinnedRow(panel);
    expect(row).not.toBeNull();
    const inRow = within(row as HTMLElement);
    expect(inRow.getByRole('button', { name: REAUTH_COPY.submit })).toBeInTheDocument();
    expect(inRow.getAllByRole('button')).toHaveLength(2);
  });

  it('keyboard walk: from the identifier, Tab reaches submit and wraps inside', async () => {
    renderReauth();
    const user = userEvent.setup();
    const submit = screen.getByRole('button', { name: REAUTH_COPY.submit });
    const start = document.activeElement;
    const panel = screen.getByRole('dialog', { name: REAUTH_COPY.title });
    const seen: Element[] = [];
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      if (document.activeElement !== null) seen.push(document.activeElement);
      expect(panel.contains(document.activeElement)).toBe(true);
    }
    expect(seen).toContain(submit);
    expect(seen).toContain(start);
  });

  it('no axe violations', async () => {
    renderReauth();
    await expectNoAxeViolations(document.body);
  });
});
