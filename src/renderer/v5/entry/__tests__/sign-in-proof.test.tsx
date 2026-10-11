import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { SignInProof, readSignInProofParams } from '../dev/SignInProof';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';

/**
 * RT-244 W1-D — the DEV-only sign-in harness renders the real SignInRoute in
 * every G-1 roster state, so the captures come from the shipped component.
 */

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useOperatorSessionStore.getState().reset();
});

describe('SignInProof — the real sign-in screen against an in-memory bridge', () => {
  it('reads its params from the hash, with safe defaults', () => {
    window.location.hash = '#/dev/sign-in-proof?roster=long&signin=rate_limited';
    expect(readSignInProofParams()).toEqual({ roster: 'long', signin: 'rate_limited' });
    window.location.hash = '#/dev/sign-in-proof?signin=role_mismatch';
    expect(readSignInProofParams()).toEqual({ roster: 'typical', signin: 'invalid_input' });
  });

  it('renders the long roster with the terminal label', async () => {
    window.location.hash = '#/dev/sign-in-proof?roster=long';
    render(<SignInProof />);
    await waitFor(() => expect(screen.getByTestId('roster-item-17')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId('entry-terminal-label')).toHaveTextContent('POS-03'),
    );
  });

  it('renders the offline roster state', async () => {
    window.location.hash = '#/dev/sign-in-proof?roster=offline';
    render(<SignInProof />);
    await waitFor(() =>
      expect(screen.getByTestId('roster-state')).toHaveAttribute('data-state', 'offline'),
    );
  });
});
