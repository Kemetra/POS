import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { AppRouter } from '../router';
import type { PairingBridgeAPI } from '../../shared/bridge-api';

/**
 * RT-241 (VNext W1-A, VN-S2) — a route that throws while rendering lands on the
 * Arabic ErrorScreen, never on react-router's default English error page.
 */
vi.mock('../routes/pairing/PairingRecoveryListener', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../routes/pairing/PairingRecoveryListener')>();
  return {
    ...original,
    PairingRoute: () => {
      throw new Error('render failure');
    },
  };
});

afterEach(cleanup);

describe('AppRouter route error boundary', () => {
  it('renders the ErrorScreen when a route throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bridge: PairingBridgeAPI = {
      getStatus: () => Promise.resolve({ kind: 'unpaired' }),
      submit: vi.fn(() => Promise.reject(new Error('unused'))),
    };

    render(<AppRouter pairing={bridge} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'تعذّر عرض هذه الشاشة.' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Unexpected Application Error/)).not.toBeInTheDocument();
  });
});
