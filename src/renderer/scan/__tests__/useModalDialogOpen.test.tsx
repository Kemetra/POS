/**
 * RT-239 (M-S6, rule 7) — the visible scan status follows a modal dialog
 * without waiting on a scheduler macrotask.
 *
 * The scan guard itself reads `[aria-modal="true"]` synchronously when it
 * judges a burst (ScanGuardHost), so scanning is refused the moment a dialog
 * is in the document. The status line must not lag behind that: CI showed it
 * still reading «جاهز للمسح» more than a second after a dialog opened, while
 * the runner was loaded. The hook reads the document during render and
 * re-renders from the mutation observer's microtask, not from a queued state
 * update.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { useModalDialogOpen } from '../useModalDialogOpen';

function Probe(): JSX.Element {
  return <p data-testid="probe">{useModalDialogOpen() ? 'open' : 'closed'}</p>;
}

/** Microtasks only: no timer, no macrotask, no act flush. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-test-modal]').forEach((el) => {
    el.remove();
  });
});

describe('useModalDialogOpen', () => {
  it('reads a dialog already in the document on first render', () => {
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('data-test-modal', '');
    document.body.append(modal);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('open');
  });

  it('follows a dialog opened and closed outside React within microtasks', async () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('closed');

    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('data-test-modal', '');
    document.body.append(modal);
    await microtasks();
    expect(screen.getByTestId('probe')).toHaveTextContent('open');

    modal.remove();
    await microtasks();
    expect(screen.getByTestId('probe')).toHaveTextContent('closed');
  });

  it('follows aria-modal being set on an element already present', async () => {
    const panel = document.createElement('div');
    panel.setAttribute('data-test-modal', '');
    document.body.append(panel);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('closed');

    panel.setAttribute('aria-modal', 'true');
    await microtasks();
    expect(screen.getByTestId('probe')).toHaveTextContent('open');
  });

  it('stops observing after unmount', async () => {
    const { unmount } = render(<Probe />);
    unmount();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('data-test-modal', '');
    // No render after unmount: this must not throw or warn.
    await act(async () => {
      document.body.append(modal);
      await microtasks();
    });
    expect(screen.queryByTestId('probe')).toBeNull();
  });
});
