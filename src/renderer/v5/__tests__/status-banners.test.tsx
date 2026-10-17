/**
 * RT-605 (VN-S6 S6-4, doc 24 §4.3) — the offline banner M-O1 and the
 * sync-attention banner M-O3 in the `V5OperationalNotices` stack. They read
 * the S6-3 terminal-status store (one subscription, owned by the indicator)
 * and the S6-3 mapping, so there is no second subscription and no second 24 h
 * rule. The connection banner has moved out of the frame's 007 StatusBanner,
 * so offline is never shown twice.
 */
import { act, cleanup, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatusSnapshot } from '../../../shared/terminal-status/types';
import { STATUS_NOW as NOW, snap } from '../../terminal-status/__tests__/__helpers__/snapshot';
import { SYNC_ATTENTION_AGE_MS } from '../../terminal-status/status-mapping';
import { expectNoAxeViolations } from '../../test-utils/axe-config';
import { V5OperationalNotices } from '../frame/V5OperationalNotices';
import {
  installStatusApi,
  renderStatusFrame,
  resetStatusKit,
  signInCashier,
  useStatusClock,
  type StatusApi,
} from './__helpers__/terminal-status-kit';

const M_O1 = 'غير متصل — البيع محفوظ على هذا الجهاز وسيُرسَل عند عودة الاتصال.';

let api: StatusApi;
let printFailed = false;

function installApi(first: TerminalStatusSnapshot): void {
  api = installStatusApi(first, { printFailed });
}

async function renderAt(path = '/app/dashboard', forcedClose = false): Promise<void> {
  signInCashier(forcedClose);
  await renderStatusFrame(path, <V5OperationalNotices />);
}

function notices(): HTMLElement {
  return screen.getByTestId('v5-frame-notices');
}

function offlineBanner(): HTMLElement | null {
  return screen.queryByTestId('v5-offline-banner');
}

function attentionBanner(): HTMLElement | null {
  return screen.queryByTestId('v5-sync-attention-banner');
}

beforeEach(() => {
  useStatusClock();
  printFailed = false;
});

afterEach(() => {
  cleanup();
  resetStatusKit();
});

describe('offline banner M-O1 (U3)', () => {
  it.each(['offline', 'degraded'] as const)(
    'shows the frozen M-O1 as a persistent warning while %s',
    async (connection) => {
      installApi(snap(connection));
      await renderAt();
      const banner = offlineBanner();
      expect(banner).not.toBeNull();
      expect(banner).toHaveAttribute('data-tone', 'warning');
      expect(banner).toHaveAttribute('role', 'status');
      expect(banner).toHaveTextContent(M_O1);
      expect(within(notices()).getByTestId('v5-offline-banner')).toBe(banner);
      // Persistent: no dismiss, it leaves only when the connection is back.
      expect(within(banner as HTMLElement).queryByRole('button')).toBeNull();
    },
  );

  it.each(['online', 'checking'] as const)('shows nothing while %s', async (connection) => {
    installApi(snap(connection));
    await renderAt();
    expect(offlineBanner()).toBeNull();
  });

  it('shows nothing before the first snapshot (never a guess)', async () => {
    installApi(snap('offline'));
    api.getStatus.mockReturnValue(new Promise(() => undefined));
    await renderAt();
    expect(offlineBanner()).toBeNull();
  });

  it('follows the push: appears when the connection drops and leaves when it is back', async () => {
    installApi(snap('online'));
    await renderAt();
    expect(offlineBanner()).toBeNull();
    await api.push(snap('offline'));
    expect(offlineBanner()).toHaveTextContent(M_O1);
    await api.push(snap('online'));
    expect(offlineBanner()).toBeNull();
  });

  it('lists no online-only actions (D-6-9)', async () => {
    installApi(snap('offline'));
    await renderAt();
    const banner = offlineBanner() as HTMLElement;
    expect(banner.querySelectorAll('li')).toHaveLength(0);
    expect(within(banner).queryByRole('link')).toBeNull();
  });
});

describe('sync-attention banner M-O3 (U2)', () => {
  it('shows the frozen M-O3 as a persistent danger on a dead letter', async () => {
    installApi(snap('online', { deadLetter: 2 }));
    await renderAt();
    const banner = attentionBanner();
    expect(banner).not.toBeNull();
    expect(banner).toHaveAttribute('data-tone', 'danger');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('تعذّر إرسال عمليتين. راجع المدير.');
    expect(within(banner as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('isolates the count as an LTR run in Western digits', async () => {
    installApi(snap('online', { deadLetter: 12 }));
    await renderAt();
    const num = attentionBanner()?.querySelector('[dir="ltr"]');
    expect(num).toHaveTextContent(/^12$/);
    expect(attentionBanner()).toHaveTextContent('تعذّر إرسال 12 عملية. راجع المدير.');
  });

  it('writes 1 as a word, with no number run (RT-646)', async () => {
    installApi(snap('online', { deadLetter: 1 }));
    await renderAt();
    expect(attentionBanner()).toHaveTextContent('تعذّر إرسال عملية واحدة. راجع المدير.');
    expect(attentionBanner()?.querySelector('[dir="ltr"]')).toBeNull();
  });

  it('shows when the oldest pending sale is older than 24 h', async () => {
    const oldest = new Date(NOW - SYNC_ATTENTION_AGE_MS - 60_000).toISOString();
    installApi(snap('online', { pending: 3, oldestPendingAt: oldest }));
    await renderAt();
    expect(attentionBanner()).toHaveTextContent('تعذّر إرسال 3 عمليات. راجع المدير.');
  });

  it('appears once the oldest pending sale passes 24 h, with no extra read', async () => {
    const since = NOW - SYNC_ATTENTION_AGE_MS + 60_000;
    installApi(snap('online', { pending: 1, oldestPendingAt: new Date(since).toISOString() }));
    await renderAt();
    expect(attentionBanner()).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(60_001);
      await Promise.resolve();
    });
    expect(attentionBanner()).toHaveTextContent('تعذّر إرسال عملية واحدة. راجع المدير.');
    expect(api.getStatus).toHaveBeenCalledTimes(1);
  });

  it('shows nothing for pending sales younger than 24 h, or for a paused queue', async () => {
    const oldest = new Date(NOW - 60_000).toISOString();
    installApi(
      snap('online', { pending: 2, oldestPendingAt: oldest, paused: 'no_operator_credential' }),
    );
    await renderAt();
    expect(attentionBanner()).toBeNull();
  });
});

describe('the stack (doc 24 §4.3)', () => {
  it('orders: sync attention, shift closed, offline, then the printer banner', async () => {
    printFailed = true;
    installApi(snap('offline', { deadLetter: 1 }));
    await renderAt('/app/dashboard', true);
    const printer = await screen.findByTestId('printer-failure-banner');
    const attention = attentionBanner() as HTMLElement;
    const offline = offlineBanner() as HTMLElement;
    const shiftClosed = within(notices())
      .getAllByRole('status')
      .find((el) => el !== offline && !printer.contains(el) && el !== printer) as HTMLElement;
    expect(shiftClosed).toBeDefined();
    const pairs: [HTMLElement, HTMLElement][] = [
      [attention, shiftClosed],
      [shiftClosed, offline],
      [offline, printer],
    ];
    for (const [before, after] of pairs) {
      expect(before.compareDocumentPosition(after)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it('never shows offline twice: the frame no longer renders the 007 connection banner', async () => {
    installApi(snap('offline'));
    await renderAt();
    expect(screen.getAllByText(/^غير متصل —/)).toHaveLength(1);
    expect(document.querySelector('[data-state="offline"]')).toBeNull();
    expect(screen.queryByText('غير متصل — البيع من قائمة الانتظار المحلية')).toBeNull();
  });

  it('reads the indicator’s store: one get and one push subscription for the whole frame', async () => {
    installApi(snap('offline', { deadLetter: 1 }));
    await renderAt();
    expect(offlineBanner()).not.toBeNull();
    expect(attentionBanner()).not.toBeNull();
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    expect(api.onChanged).toHaveBeenCalledTimes(1);
  });

  it.each(['/app/dashboard', '/app/cart'])(
    'shows both banners in the frame at %s',
    async (path) => {
      installApi(snap('offline', { deadLetter: 1 }));
      await renderAt(path);
      expect(within(notices()).getByTestId('v5-offline-banner')).toBeInTheDocument();
      expect(within(notices()).getByTestId('v5-sync-attention-banner')).toBeInTheDocument();
    },
  );

  it('is axe-clean with both banners, in the labelled panel and the slim rail', async () => {
    installApi(snap('offline', { deadLetter: 1 }));
    await renderAt('/app/dashboard');
    await expectNoAxeViolations(notices());
    cleanup();
    await renderAt('/app/cart');
    await expectNoAxeViolations(notices());
  });
});
