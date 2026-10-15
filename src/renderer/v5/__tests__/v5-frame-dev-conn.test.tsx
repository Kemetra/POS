/**
 * RT-498 (VN-S10 S10-1, owner decision D-10-7) — the `?conn=` dev toggle moves
 * from the legacy AppShell into the v5 frame. In a dev build the frame reads
 * it once on mount and drives the one connection store, so the connection
 * banner can be exercised until a real signal exists (VN-S6). Vitest runs as a
 * dev build (`import.meta.env.DEV` is true), as the AppShell test did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import { V5Frame } from '../frame/V5Frame';
import {
  CONNECTION_BANNER_MESSAGES,
  useConnectionStateStore,
} from '../../connection/connection-state';
import { installViewport } from './__helpers__/viewport-bands';

const ORIGINAL_URL = window.location.href;

function renderFrame(): void {
  render(
    <MemoryRouter initialEntries={['/app/dashboard']}>
      <V5Frame>
        <section aria-labelledby="t">
          <h1 id="t">لوحة المتابعة</h1>
        </section>
      </V5Frame>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installViewport(1280);
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', ORIGINAL_URL);
  useConnectionStateStore.getState().setState('online');
  vi.unstubAllGlobals();
});

describe('V5Frame — ?conn= dev toggle (D-10-7)', () => {
  it('?conn=offline shows the offline connection banner', async () => {
    window.history.replaceState(null, '', '/?conn=offline');
    renderFrame();
    expect(await screen.findByText(CONNECTION_BANNER_MESSAGES.offline)).toBeInTheDocument();
  });

  it('?conn=syncing shows the syncing banner', async () => {
    window.history.replaceState(null, '', '/?conn=syncing');
    renderFrame();
    expect(await screen.findByText(CONNECTION_BANNER_MESSAGES.syncing)).toBeInTheDocument();
  });

  it('no ?conn= leaves the state online: no banner', async () => {
    window.history.replaceState(null, '', '/');
    renderFrame();
    await waitFor(() => {
      expect(useConnectionStateStore.getState().state).toBe('online');
    });
    for (const message of Object.values(CONNECTION_BANNER_MESSAGES)) {
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    }
  });

  it('an unknown ?conn= value falls back to online', async () => {
    window.history.replaceState(null, '', '/?conn=bogus');
    renderFrame();
    await waitFor(() => {
      expect(useConnectionStateStore.getState().state).toBe('online');
    });
  });
});
