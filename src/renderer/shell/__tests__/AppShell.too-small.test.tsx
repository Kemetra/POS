import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppShell } from '../AppShell';
import {
  installViewport,
  resizeTo,
  settleTier,
} from '../../v5/__tests__/__helpers__/viewport-bands';

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

const WIDTH_HEADING = /^الشاشة أصغر من 1024×768\s?\.$/;
const HEIGHT_HEADING = 'ارتفاع الشاشة أقل من الحد المدعوم.';
const WIDTH_ACTION = 'كبّر النافذة أو استخدم شاشة أكبر.';
const HEIGHT_ACTION = /^كبّر النافذة، أو اضبط مقياس العرض في Windows على 100% أو 125%\s?\.$/;

/** The notice body's whole text: the digits are <bdi> runs, which getByText does not join. */
function noticeBody(): HTMLElement | null {
  return document.querySelector('.screen-too-small__body');
}

function renderTooSmall() {
  return render(
    <MemoryRouter initialEntries={['/app/dashboard']}>
      <Routes>
        <Route path="/app/*" element={<AppShell />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * T047 — AppShell at <1024px: shows ScreenTooSmall; no nav in DOM.
 */
describe('AppShell too-small (T047)', () => {
  it('renders ScreenTooSmall heading at <1024px', () => {
    installViewport(1023);
    renderTooSmall();
    expect(screen.getByRole('heading', { level: 1, name: WIDTH_HEADING })).toBeInTheDocument();
  });

  it('renders the M-F2 Arabic guidance', () => {
    installViewport(1023);
    renderTooSmall();
    expect(screen.getByText(WIDTH_ACTION)).toBeInTheDocument();
  });

  it('no <nav> in DOM at <1024px', () => {
    installViewport(1023);
    const { container } = renderTooSmall();
    expect(container.querySelector('nav')).not.toBeInTheDocument();
  });

  it('no off-screen or aria-hidden nav at <1024px', () => {
    installViewport(1023);
    const { container } = renderTooSmall();
    expect(container.querySelector('[aria-hidden="true"] nav')).not.toBeInTheDocument();
    expect(container.querySelector('nav[aria-hidden]')).not.toBeInTheDocument();
  });
});

/**
 * RT-313 (RT-312 D1/D5) — the legacy shell applies the 600px height floor too,
 * with the right M-F2 variant.
 */
describe('AppShell height floor (RT-313)', () => {
  it('599px high: the height notice; no nav and no MainContent', () => {
    installViewport(1280, 599);
    const { container } = renderTooSmall();
    expect(screen.getByRole('heading', { level: 1, name: HEIGHT_HEADING })).toBeInTheDocument();
    expect(noticeBody()).toHaveTextContent(HEIGHT_ACTION);
    expect(container.querySelector('nav')).not.toBeInTheDocument();
    expect(container.querySelector('.app-shell__content')).not.toBeInTheDocument();
  });

  it('600px high: the shell, its nav and MainContent', () => {
    installViewport(1280, 600);
    const { container } = renderTooSmall();
    expect(screen.queryByRole('heading', { name: HEIGHT_HEADING })).not.toBeInTheDocument();
    expect(container.querySelector('nav')).toBeInTheDocument();
    expect(container.querySelector('.app-shell__content')).toBeInTheDocument();
  });

  it('under both floors: the size heading with the height action', () => {
    installViewport(1023, 599);
    renderTooSmall();
    expect(screen.getByRole('heading', { level: 1, name: WIDTH_HEADING })).toBeInTheDocument();
    expect(noticeBody()).toHaveTextContent(HEIGHT_ACTION);
    expect(screen.queryByText(WIDTH_ACTION)).not.toBeInTheDocument();
  });

  it('on return focus lands on MainContent, never on <body>', async () => {
    installViewport(1280, 800);
    const { container } = renderTooSmall();
    resizeTo(1280, 599);
    await settleTier();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));

    resizeTo(1280, 800);
    await settleTier();
    const content = container.querySelector('.app-shell__content');
    expect(content).toBeInTheDocument();
    expect(document.activeElement).toBe(content);
    // Focusable by script, never a Tab stop.
    expect(content).toHaveAttribute('tabindex', '-1');
  });
});
