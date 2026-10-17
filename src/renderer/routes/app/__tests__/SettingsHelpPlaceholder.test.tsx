import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { SettingsHelpPlaceholder } from '../SettingsHelpPlaceholder';
import { useThemeStore, DEFAULT_THEME } from '../../../stores/theme-store';
import { expectNoAxeViolations } from '../../../test-utils/axe-config';

/**
 * RT-503 (VN-S10 S10-6, G-6 state 13) — Settings: an honest Arabic notice that
 * nothing can be changed on this terminal. No theme toggle (owner decision
 * D-10-3; the theme store stays), no «Coming soon» rows, no fake connection
 * row, no dev ?state= gallery.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useThemeStore.setState({ theme: DEFAULT_THEME });
});

function renderSettings(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <SettingsHelpPlaceholder />
    </MemoryRouter>,
  );
}

describe('SettingsHelpPlaceholder', () => {
  it('titles the page «الإعدادات» with the honest neutral notice', () => {
    renderSettings();
    expect(screen.getByRole('heading', { level: 1, name: 'الإعدادات' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'لا توجد إعدادات يمكن تغييرها على هذا الجهاز.',
    );
  });

  it('offers no control at all: no theme toggle, no density toggle, no disabled rows', () => {
    const { container } = renderSettings();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(container.querySelector('[data-theme-toggle]')).toBeNull();
    expect(container.querySelector('[data-testid^="settings-"]')).toBeNull();
  });

  it('shows no English copy (no «Coming soon», no connection simulation)', () => {
    const { container } = renderSettings();
    expect(container.textContent).not.toMatch(/[A-Za-z]/);
  });

  it('does not touch the theme store', () => {
    renderSettings();
    expect(useThemeStore.getState().theme).toBe(DEFAULT_THEME);
  });

  it('makes zero fetch calls on mount', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderSettings();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is axe-clean', async () => {
    const { container } = renderSettings();
    await expectNoAxeViolations(container);
  });
});
