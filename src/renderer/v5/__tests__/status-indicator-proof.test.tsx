/**
 * RT-604 (VN-S6 S6-3) — the DEV-only status indicator harness: each capture
 * state reaches the REAL indicator through the in-memory `terminalStatus`
 * bridge (never by writing the store), inside the real frame.
 *
 * RT-605 (VN-S6 S6-4): the same harness drives the notices-stack banners
 * (M-O1, M-O3) for their captures, with two more states.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { useTerminalStatusStore } from '../../terminal-status/terminal-status-store';
import {
  STATUS_PROOF_STATES,
  StatusIndicatorProof,
  readStatusProofCount,
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
  Sending: ['متصل', 'جارٍ إرسال 3 عمليات…'],
  Paused: ['متصل', 'عمليتان بانتظار الإرسال'],
  Attention: ['متصل', 'تحتاج مراجعة'],
  Attention24h: ['متصل', 'تحتاج مراجعة'],
  OfflineAttention: ['غير متصل', 'تحتاج مراجعة'],
  PrinterFailed: ['متصل', null],
};

/** RT-605: the notices-stack banners each state shows (M-O3 text, M-O1). */
const BANNERS: Record<(typeof STATUS_PROOF_STATES)[number], [string | null, boolean]> = {
  Connected: [null, false],
  Checking: [null, false],
  Offline: [null, true],
  Degraded: [null, true],
  OfflinePending: [null, true],
  Sending: [null, false],
  Paused: [null, false],
  Attention: ['تعذّر إرسال عمليتين. راجع المدير.', false],
  Attention24h: ['تعذّر إرسال عمليتين. راجع المدير.', false],
  OfflineAttention: ['تعذّر إرسال عملية واحدة. راجع المدير.', true],
  PrinterFailed: [null, false],
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

  it.each(STATUS_PROOF_STATES)('%s shows its notices-stack banners (RT-605)', async (state) => {
    window.location.hash = `#/dev/status-proof?state=${state}`;
    render(<StatusIndicatorProof />);
    await screen.findByTestId('v5-status-indicator');
    const [attention, offline] = BANNERS[state];
    await waitFor(() => {
      expect(useTerminalStatusStore.getState().snapshot).not.toBeNull();
    });
    const attentionBanner = screen.queryByTestId('v5-sync-attention-banner');
    if (attention === null) expect(attentionBanner).toBeNull();
    else expect(attentionBanner).toHaveTextContent(attention);
    expect(screen.queryByTestId('v5-offline-banner') !== null).toBe(offline);
  });

  it('reads an optional count from the hash (RT-646), ignoring anything but a positive integer', () => {
    window.location.hash = '#/dev/status-proof?state=Sending&count=11';
    expect(readStatusProofCount()).toBe(11);
    for (const bad of ['', '&count=0', '&count=-2', '&count=1.5', '&count=x']) {
      window.location.hash = `#/dev/status-proof?state=Sending${bad}`;
      expect(readStatusProofCount()).toBeNull();
    }
  });

  it.each([
    ['OfflinePending', 1, 'عملية واحدة بانتظار الإرسال', null],
    ['OfflinePending', 2, 'عمليتان بانتظار الإرسال', null],
    ['Sending', 3, 'جارٍ إرسال 3 عمليات…', null],
    ['Sending', 11, 'جارٍ إرسال 11 عملية…', null],
    ['Attention', 1, 'تحتاج مراجعة', 'تعذّر إرسال عملية واحدة. راجع المدير.'],
    ['Attention', 11, 'تحتاج مراجعة', 'تعذّر إرسال 11 عملية. راجع المدير.'],
  ] as const)(
    '%s with count=%i drives the count-aware copy (RT-646)',
    async (state, n, sync, banner) => {
      window.location.hash = `#/dev/status-proof?state=${state}&count=${String(n)}`;
      render(<StatusIndicatorProof />);
      const indicator = await screen.findByTestId('v5-status-indicator');
      await waitFor(() => {
        expect(indicator.querySelector('[data-row="sync"]')).toHaveTextContent(sync);
      });
      const attention = screen.queryByTestId('v5-sync-attention-banner');
      if (banner === null) expect(attention).toBeNull();
      else expect(attention).toHaveTextContent(banner);
    },
  );

  it('offers the RT-605 banner states: attention via 24 h, and offline + attention', () => {
    expect(STATUS_PROOF_STATES).toEqual(
      expect.arrayContaining(['Attention24h', 'OfflineAttention']),
    );
  });
});
