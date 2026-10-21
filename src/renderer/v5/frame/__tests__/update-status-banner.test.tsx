import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { UpdateStatusBridgeAPI } from '../../../../shared/bridge-api';
import type {
  UpdateStatusSnapshot,
  UpdateStatusState,
} from '../../../../shared/update-status/types';
import { UPDATE_COPY } from '../../../terminal-status/status-copy';
import { UpdateStatusBanner } from '../StatusBanners';

/**
 * RT-322 (S-B, design §6) — the one cashier update notice: shown only for a
 * ready update, polite, no action, absent for every other state.
 */

type WindowWithApi = { api?: { updateStatus?: UpdateStatusBridgeAPI } };

const snap = (state: UpdateStatusState): UpdateStatusSnapshot => ({ v: 1, state });

function install(initial: UpdateStatusSnapshot): { push: (s: UpdateStatusSnapshot) => void } {
  let listener: (s: UpdateStatusSnapshot) => void = () => undefined;
  (window as unknown as WindowWithApi).api = {
    updateStatus: {
      get: () => Promise.resolve(initial),
      onChanged: (cb) => {
        listener = cb;
        return () => undefined;
      },
    },
  };
  return {
    push: (s) => {
      act(() => {
        listener(s);
      });
    },
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as WindowWithApi).api;
});

describe('UpdateStatusBanner', () => {
  it.each(['downloaded', 'update_pending'] as const)(
    '%s: a polite status with the approved copy and no action',
    async (state) => {
      install(snap(state));
      render(<UpdateStatusBanner />);
      const banner = await screen.findByRole('status');
      expect(banner).toHaveTextContent(UPDATE_COPY.ready);
      expect(banner).toHaveAttribute('aria-live', 'polite');
      expect(banner).toHaveAttribute('data-tone', 'info');
      expect(screen.queryByRole('button')).toBeNull();
    },
  );

  it.each([
    'idle',
    'checking',
    'downloading',
    'verify_failed',
    'verify_unavailable',
    'error',
  ] as const)('%s: nothing is shown', async (state) => {
    install(snap(state));
    render(<UpdateStatusBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('appears and leaves with the pushed state', async () => {
    const { push } = install(snap('idle'));
    render(<UpdateStatusBanner />);
    expect(screen.queryByRole('status')).toBeNull();
    push(snap('downloaded'));
    expect(await screen.findByRole('status')).toHaveTextContent(UPDATE_COPY.ready);
    push(snap('installing'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders nothing when the preload has no updateStatus bridge', () => {
    render(<UpdateStatusBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
