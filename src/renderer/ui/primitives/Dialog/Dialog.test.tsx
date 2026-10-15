import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { Dialog } from './Dialog';

afterEach(cleanup);

describe('Dialog (T018)', () => {
  const variants = ['default', 'confirm', 'destructive'] as const;

  it.each(variants)('renders variant=%s when open', (variant) => {
    render(
      <Dialog open variant={variant} title="Test dialog" onOpenChange={() => {}}>
        Content
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Test dialog' })).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <Dialog open={false} title="Hidden dialog" onOpenChange={() => {}}>
        Content
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('has aria-modal="true"', () => {
    render(
      <Dialog open title="Modal dialog" onOpenChange={() => {}}>
        Content
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('calls onOpenChange(false) when ESC is pressed', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Dialog open title="ESC dialog" onOpenChange={onOpenChange}>
        Content
      </Dialog>,
    );
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange with primaryAction click', async () => {
    const onAction = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Dialog
        open
        title="Action dialog"
        onOpenChange={onOpenChange}
        primaryAction={{ label: 'Confirm', onClick: onAction }}
      >
        Content
      </Dialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('keeps the same title id across rerenders', () => {
    const { rerender } = render(
      <Dialog open title="Stable dialog" description="Details" onOpenChange={() => {}}>
        Content
      </Dialog>,
    );
    const before = screen.getByRole('dialog').getAttribute('aria-labelledby');
    rerender(
      <Dialog open title="Stable dialog" description="Details" onOpenChange={() => {}}>
        Content again
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe(before);
    expect(dialog).toHaveAccessibleName('Stable dialog');
    expect(dialog).toHaveAccessibleDescription('Details');
  });

  it('focuses the dialog on open', () => {
    render(
      <Dialog open title="Focus dialog" onOpenChange={() => {}}>
        Content
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    // Dialog should be focused or contain the focused element
    expect(dialog === document.activeElement || dialog.contains(document.activeElement)).toBe(true);
  });

  it('sets aria-describedby when description is provided', () => {
    render(
      <Dialog open title="Described dialog" description="Some description" onOpenChange={() => {}}>
        Content
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-describedby');
    expect(screen.getByText('Some description')).toBeInTheDocument();
  });

  it('calls secondaryAction.onClick when secondary button is clicked', async () => {
    const onSecondary = vi.fn();
    const user = userEvent.setup();
    render(
      <Dialog
        open
        title="Two-action dialog"
        onOpenChange={() => {}}
        secondaryAction={{ label: 'Cancel', onClick: onSecondary }}
      >
        Content
      </Dialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });
});
