/**
 * RT-498 (VN-S10 S10-1) — the v5 screen section that replaces the legacy
 * `Workspace` once a screen sits inside the v5 frame. The frame owns the one
 * <main>, so a screen is a labelled region: its own <h1>, never a landmark of
 * its own.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { expectNoAxeViolations } from '../../../test-utils/axe-config';
import { ScreenSection } from '../ScreenSection';

afterEach(cleanup);

describe('ScreenSection', () => {
  it('is a region named by its own <h1>, holding the screen content', () => {
    render(
      <ScreenSection title="المرتجعات">
        <p>المحتوى</p>
      </ScreenSection>,
    );
    const region = screen.getByRole('region', { name: 'المرتجعات' });
    expect(
      within(region).getByRole('heading', { level: 1, name: 'المرتجعات' }),
    ).toBeInTheDocument();
    expect(within(region).getByText('المحتوى')).toBeInTheDocument();
  });

  it('adds no landmark of its own: no main, banner or navigation', () => {
    render(
      <ScreenSection title="Audit">
        <p>body</p>
      </ScreenSection>,
    );
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('gives each instance its own heading id', () => {
    render(
      <>
        <ScreenSection title="A">
          <p>a</p>
        </ScreenSection>
        <ScreenSection title="B">
          <p>b</p>
        </ScreenSection>
      </>,
    );
    const [a, b] = screen.getAllByRole('heading', { level: 1 });
    expect(a?.id).not.toBe('');
    expect(a?.id).not.toBe(b?.id);
  });

  it('carries a stable test id and is axe-clean', async () => {
    const { container } = render(
      <main>
        <ScreenSection title="الإعدادات">
          <p>body</p>
        </ScreenSection>
      </main>,
    );
    expect(screen.getByTestId('v5-screen-section')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
