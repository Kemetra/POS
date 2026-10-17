/**
 * RT-604 (VN-S6 S6-3) — the DEV-only status indicator harness: each capture
 * state reaches the REAL indicator through the in-memory `terminalStatus`
 * bridge (never by writing the store), inside the real frame.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { useTerminalStatusStore } from '../../terminal-status/terminal-status-store';
import {
  STATUS_PROOF_STATES,
  StatusIndicatorProof,
  readStatusProofState,
} from '../frame/dev/StatusIndicatorProof';
import { installViewport } from './__helpers__/viewport-bands';

beforeEach(() => {
  installViewport(1280);
});

afterEach(() => {
  cleanup();
  useOperatorSessionStore.getState().reset();
  useTerminalStatusStore.setState({ snapshot: null });
  delete (window as unknown as { api?: unknown }).api;
  window.location.hash = '';
});

const EXPECTED: Record<(typeof STATUS_PROOF_STATES)[number], [string, string | null]> = {
  Connected: ['متصل', null],
  Checking: ['جارٍ التحقق من الاتصال', null],
  Offline: ['غير متصل', null],
  Degraded: ['غير متصل', null],
  OfflinePending: ['غير متصل', '3 عمليات بانتظار الإرسال'],
  Sending: ['متصل', 'جارٍ إرسال 3 عملية…'],
  Paused: ['متصل', '2 عمليات بانتظار الإرسال'],
  Attention: ['متصل', 'تحتاج مراجعة'],
  PrinterFailed: ['متصل', null],
};

describe('StatusIndicatorProof', () => {
  it('reads the state from the hash, defaulting to Connected', () => {
    window.location.hash = '#/dev/status-proof?state=Paused';
    expect(readStatusProofState()).toBe('Paused');
    window.location.hash = '#/dev/status-proof?state=nope';
    expect(readStatusProofState()).toBe('Connected');
  });

  it.each(STATUS_PROOF_STATES)('%s renders through the bridge', async (state) => {
    window.location.hash = `#/dev/status-proof?state=${state}`;
    render(<StatusIndicatorProof />);
    const [connection, sync] = EXPECTED[state];
    const indicator = await screen.findByTestId('v5-status-indicator');
    await waitFor(() => {
      expect(indicator.querySelector('[data-row="connection"]')).toHaveTextContent(
        new RegExp(`^${connection}$`),
      );
    });
    const syncRow = indicator.querySelector('[data-row="sync"]');
    if (sync === null) expect(syncRow).toBeNull();
    else expect(syncRow).toHaveTextContent(sync);
    if (state === 'PrinterFailed') {
      await waitFor(() => {
        expect(indicator.querySelector('[data-row="printer"]')).toHaveTextContent('فشل آخر إيصال');
      });
    }
  });
});
