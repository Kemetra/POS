import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { CartBridgeAPI } from '../../../../shared/bridge-api';
import { CartState } from '../../../../shared/cart/cart-state';
import type {
  CartParkBridgeAPI,
  CartPreviewResumeResponse,
  CartResumeResponse,
  ParkedSaleView,
} from '../../../../shared/cart/park-types';
import { ScanGuardHost, resetScanGuardForTests } from '../../../scan/ScanGuardHost';
import { SCAN_PAUSED_DIALOG_STATUS } from '../../../scan/scan-messages';
import { useCartStore } from '../../../stores/cart-store';
import { ParkedSalesScreen } from '../ParkedSalesScreen';
import { PARK_COPY } from '../park-copy';

/**
 * RT-672: a fixed mid-day instant (12:00 in Cairo), so «today» never depends
 * on when the suite runs. Only `Date` is faked: userEvent and waitFor keep
 * real timers.
 */
const NOW = Date.parse('2026-10-17T09:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  useCartStore.getState().reset();
  resetScanGuardForTests();
});

const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

const ROWS: ParkedSaleView[] = [
  { cart_id: 'p1', label: null, line_count: 1, total_minor: 4500, parked_at: at(5), stale: false },
  {
    cart_id: 'p2',
    label: 'ينتظر الروشتة',
    line_count: 4,
    total_minor: 21_200,
    parked_at: at(20),
    stale: false,
  },
  {
    cart_id: 'p3',
    label: 'طلب التوصيل',
    line_count: 5,
    total_minor: 64_025,
    parked_at: at(26 * 60),
    stale: true,
  },
];

function nthRow(i: number): ParkedSaleView {
  const row = ROWS[i];
  if (row === undefined) throw new Error(`no fixture row ${String(i)}`);
  return row;
}

const CHANGE = {
  line_id: 'l1',
  display_name: 'فولتارين جل 1% — 50 جم',
  quantity: 1,
  old_unit_minor: 6800,
  new_unit_minor: 6400,
};
const RISE = {
  line_id: 'l2',
  display_name: 'بنادول إكسترا',
  quantity: 2,
  old_unit_minor: 4500,
  new_unit_minor: 4800,
};
const GONE = { line_id: 'l3', display_name: 'كونجستال أقراص', quantity: 1 };

function preview(over: Partial<Extract<CartPreviewResumeResponse, { kind: 'preview' }>> = {}) {
  return { kind: 'preview' as const, changes: [], unavailable: [], diff_token: 'd1', ...over };
}

interface Setup {
  items?: ParkedSaleView[];
  preview?: CartPreviewResumeResponse | (() => CartPreviewResumeResponse);
  resume?: CartResumeResponse[];
  /** The session's current sale: lines and state (none = no active cart). */
  current?: { lines: number; state?: CartState };
}

function setup(opts: Setup = {}) {
  const listParked = vi.fn<CartParkBridgeAPI['listParked']>(() =>
    Promise.resolve({ kind: 'parked_sales', items: opts.items ?? ROWS }),
  );
  const previewAnswer = opts.preview ?? preview();
  const previewResume = vi.fn<CartParkBridgeAPI['previewResume']>(() =>
    Promise.resolve(typeof previewAnswer === 'function' ? previewAnswer() : previewAnswer),
  );
  const answers = [...(opts.resume ?? [{ kind: 'resumed', cart_id: 'p2' }])];
  const resume = vi.fn<CartParkBridgeAPI['resume']>(() =>
    Promise.resolve(
      (answers.length > 1 ? answers.shift() : answers[0]) ?? { kind: 'resumed', cart_id: 'p2' },
    ),
  );
  const parked = { park: vi.fn(), listParked, previewResume, resume } as CartParkBridgeAPI;
  const current = opts.current;
  if (current) useCartStore.getState().applyCartCreated('current');
  const cart = {
    snapshot: vi.fn(() =>
      Promise.resolve({
        kind: 'ok',
        snapshot: {
          cart_id: 'current',
          state: current?.state ?? CartState.editing,
          lines: Array.from({ length: current?.lines ?? 0 }, (_, i) => ({
            line_id: `c${String(i)}`,
            display_name: 'صنف',
            quantity: 1,
            unit_price_minor: 4750,
            line_subtotal_minor: 4750,
            note: null,
            version: 1,
          })),
          discount_placeholders: [],
          paid: false,
          envelope: null,
        },
      }),
    ),
  } as unknown as CartBridgeAPI;
  const onResumed = vi.fn();
  const onBackToSale = vi.fn();
  render(
    <>
      <ScanGuardHost />
      <ParkedSalesScreen
        parked={parked}
        cart={cart}
        onResumed={onResumed}
        onBackToSale={onBackToSale}
      />
    </>,
  );
  return { listParked, previewResume, resume, onResumed, onBackToSale, user: userEvent.setup() };
}

const rows = (): HTMLElement[] => screen.getAllByRole('listitem');
function nth(list: HTMLElement[], i: number): HTMLElement {
  const el = list[i];
  if (el === undefined) throw new Error(`no row ${String(i)}`);
  return el;
}

async function openReview(user: ReturnType<typeof userEvent.setup>, index = 1): Promise<void> {
  await screen.findAllByRole('listitem');
  await user.click(within(nth(rows(), index)).getByRole('button', { name: PARK_COPY.resume }));
}

describe('the parked list (PK3-List*)', () => {
  it('shows this operator’s sales in main’s order, each with count, absolute time and total', async () => {
    setup();
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(PARK_COPY.listTitle);
    expect(items[0]).toHaveTextContent(PARK_COPY.unnamed);
    expect(items[0]).toHaveTextContent('صنف واحد');
    expect(items[1]).toHaveTextContent('ينتظر الروشتة');
    expect(items[1]).toHaveTextContent('4 أصناف');
    expect(items[1]).toHaveTextContent('212.00 EGP');
    expect(items[1]?.querySelector('time')?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(screen.getByText('3 من مبيعاتك')).toBeInTheDocument();
    expect(screen.getByText(PARK_COPY.listFoot)).toBeInTheDocument();
    // Arriving, focus is on the newest sale's resume.
    await waitFor(() => {
      expect(within(nth(items, 0)).getByRole('button', { name: PARK_COPY.resume })).toHaveFocus();
    });
  });

  it('K4: «قديم» only on a stale sale, with an earlier day’s date (display only)', async () => {
    setup();
    const items = await screen.findAllByRole('listitem');
    expect(items[2]).toHaveTextContent(PARK_COPY.stale);
    expect(items[2]?.querySelector('time')?.textContent).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(items[0]).not.toHaveTextContent(PARK_COPY.stale);
  });

  it('OD-12: a sale parked just before the Cairo midnight shows its date once the day turns', async () => {
    vi.setSystemTime(Date.parse('2026-10-17T21:05:00Z')); // 00:05 on 18/10 in Cairo
    const item = { ...nthRow(1), parked_at: '2026-10-17T20:45:00Z' }; // 23:45 on 17/10
    setup({ items: [item] });
    const [row] = await screen.findAllByRole('listitem');
    expect(row?.querySelector('time')?.textContent).toBe('17/10 23:45');
  });

  it('empty: the drawn line, «لا شيء», focus on «رجوع إلى البيع»', async () => {
    const { onBackToSale, user } = setup({ items: [] });
    expect(await screen.findByText(PARK_COPY.listEmpty)).toBeInTheDocument();
    expect(screen.getByText(PARK_COPY.listNone)).toBeInTheDocument();
    const back = screen.getByRole('button', { name: PARK_COPY.backToSale });
    await waitFor(() => {
      expect(back).toHaveFocus();
    });
    await user.click(back);
    expect(onBackToSale).toHaveBeenCalledOnce();
  });

  it('RT-239 / OD-15: a scan while the list is open is refused with the scan-paused status', async () => {
    setup();
    await screen.findAllByRole('listitem');
    const target = document.body;
    for (const ch of '6223004355218') fireEvent.keyDown(target, { key: ch });
    fireEvent.keyDown(target, { key: 'Enter' });
    expect(await screen.findByTestId('scan-notice')).toHaveTextContent(SCAN_PAUSED_DIALOG_STATUS);
  });
});

describe('resume (spec 024 §3.3–§3.4)', () => {
  it('OD-6: a preview with no changes and no conflict resumes at once, keeping no current sale', async () => {
    const { previewResume, resume, onResumed, user } = setup();
    await openReview(user);
    await waitFor(() => {
      expect(onResumed).toHaveBeenCalledWith('p2');
    });
    expect(previewResume).toHaveBeenCalledWith({ cart_id: 'p2' });
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        cart_id: 'p2',
        accept_changes: false,
        diff_token: 'd1',
        current_cart: 'keep',
      }),
    );
    expect(screen.queryByText(PARK_COPY.reviewHeading)).not.toBeInTheDocument();
  });

  it('shows old, new and per-unit difference, and the removed lines; nothing happens before accept', async () => {
    const { resume, onResumed, user } = setup({
      preview: preview({ changes: [CHANGE, RISE], unavailable: [GONE] }),
    });
    await openReview(user);
    expect(await screen.findByText(PARK_COPY.reviewHeading)).toBeInTheDocument();
    expect(screen.getByText(PARK_COPY.reviewLead)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: PARK_COPY.changesTable });
    const [, fall, rise] = within(table).getAllByRole('row');
    expect(fall).toHaveTextContent('68.00 EGP');
    expect(fall).toHaveTextContent('64.00 EGP');
    expect(fall).toHaveTextContent('−4.00');
    expect(fall).toHaveTextContent(PARK_COPY.fell);
    expect(rise).toHaveTextContent('+3.00');
    expect(rise).toHaveTextContent(PARK_COPY.rose);
    const removed = screen.getByRole('table', { name: PARK_COPY.removedTable });
    expect(removed).toHaveTextContent('كونجستال أقراص');
    expect(removed).toHaveTextContent(PARK_COPY.removedTag);
    expect(resume).not.toHaveBeenCalled();

    const accept = screen.getByRole('button', { name: PARK_COPY.acceptChanges });
    expect(accept).toHaveFocus();
    await user.click(accept);
    await waitFor(() => {
      expect(onResumed).toHaveBeenCalledWith('p2');
    });
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ accept_changes: true, current_cart: 'keep' }),
    );
  });

  it('removed lines only: «قبول الحذف واستئناف البيع»', async () => {
    const { user } = setup({ preview: preview({ unavailable: [GONE] }) });
    await openReview(user);
    expect(
      await screen.findByRole('button', { name: PARK_COPY.acceptRemoval }),
    ).toBeInTheDocument();
  });

  it('«رجوع» is a local back to the list: no resume call', async () => {
    const { resume, user } = setup({ preview: preview({ changes: [CHANGE] }) });
    await openReview(user);
    await user.click(await screen.findByRole('button', { name: PARK_COPY.back }));
    expect(await screen.findAllByRole('listitem')).toHaveLength(3);
    expect(resume).not.toHaveBeenCalled();
  });

  it('VN-R10 with no changes: the swap parks the current sale in the same call (OD-7)', async () => {
    const { resume, onResumed, user } = setup({ current: { lines: 2 } });
    await openReview(user);
    const group = await screen.findByRole('group');
    expect(group).toHaveTextContent('لديك بيع نشط الآن: صنفان بقيمة');
    expect(group).toHaveTextContent('95.00 EGP');
    expect(group).toHaveTextContent(PARK_COPY.conflictBody);
    await user.click(screen.getByRole('button', { name: PARK_COPY.swap }));
    await waitFor(() => {
      expect(onResumed).toHaveBeenCalledWith('p2');
    });
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ current_cart: 'park', accept_changes: false }),
    );
    // OD-7: the renderer sends no label for the swapped-out sale; main parks it unnamed.
    expect(resume.mock.calls[0]?.[0]).not.toHaveProperty('label');
  });

  it('VN-R10 with changes: one combined action; «أبقِ البيع الحالي» makes no call (OD-8)', async () => {
    const { resume, user } = setup({
      current: { lines: 2 },
      preview: preview({ changes: [CHANGE], unavailable: [GONE] }),
    });
    await openReview(user);
    expect(
      await screen.findByRole('button', { name: PARK_COPY.swapWithChanges }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: PARK_COPY.keepCurrent }));
    expect(await screen.findAllByRole('listitem')).toHaveLength(3);
    expect(resume).not.toHaveBeenCalled();
  });

  it('an empty or handed-off current cart is not a conflict', async () => {
    const { resume, user } = setup({ current: { lines: 0 } });
    await openReview(user);
    await waitFor(() => {
      expect(resume).toHaveBeenCalledWith(expect.objectContaining({ current_cart: 'keep' }));
    });
  });

  it('OD-14: catalogue_unavailable shows the drawn refusal with «رجوع» only', async () => {
    const { resume, user } = setup({
      preview: { kind: 'refused', reason: 'catalogue_unavailable' },
    });
    await openReview(user);
    expect(await screen.findByText(PARK_COPY.catalogueUnavailable)).toBeInTheDocument();
    const actions = screen.getAllByRole('button').map((b) => b.textContent);
    expect(actions).toEqual([PARK_COPY.backToList, PARK_COPY.back]);
    expect(screen.getByRole('button', { name: PARK_COPY.back })).toHaveFocus();
    expect(resume).not.toHaveBeenCalled();
  });

  it('OD-14: price_changes_unaccepted re-runs the preview and shows the new review', async () => {
    let n = 0;
    const { previewResume, resume, user } = setup({
      preview: () => {
        n += 1;
        return preview({ changes: [CHANGE], diff_token: `d${String(n)}` });
      },
      resume: [
        { kind: 'refused', reason: 'price_changes_unaccepted' },
        { kind: 'resumed', cart_id: 'p2' },
      ],
    });
    await openReview(user);
    await user.click(await screen.findByRole('button', { name: PARK_COPY.acceptChanges }));
    expect(await screen.findByText(PARK_COPY.pricesChanged)).toBeInTheDocument();
    expect(previewResume).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: PARK_COPY.acceptChanges })).toHaveFocus();
    });
    await user.click(screen.getByRole('button', { name: PARK_COPY.acceptChanges }));
    await waitFor(() => {
      expect(resume).toHaveBeenCalledTimes(2);
    });
    expect(resume.mock.calls[1]?.[0].diff_token).toBe('d2');
    // A new diff is a new request: a new idempotency key.
    expect(resume.mock.calls[1]?.[0].idempotency_key).not.toBe(
      resume.mock.calls[0]?.[0].idempotency_key,
    );
  });

  it('checkout_in_progress shows the drawn refusal with «رجوع» only', async () => {
    const { user } = setup({
      current: { lines: 4, state: CartState.frozen_handed_off },
      resume: [{ kind: 'refused', reason: 'checkout_in_progress' }],
    });
    await openReview(user);
    expect(await screen.findByText(PARK_COPY.checkoutInProgress)).toBeInTheDocument();
  });

  it.each(['wrong_owner', 'not_parked', 'current_cart_active', 'authority_conflict'] as const)(
    'OD-9: %s is the generic line, then the list is read again',
    async (reason) => {
      const { listParked, user } = setup({ resume: [{ kind: 'refused', reason }] });
      await openReview(user);
      expect(await screen.findByText(PARK_COPY.generic)).toBeInTheDocument();
      expect(listParked).toHaveBeenCalledTimes(2);
      expect(await screen.findAllByRole('listitem')).toHaveLength(3);
    },
  );

  it('a failed preview call is the generic line too', async () => {
    const { listParked, user } = setup({ preview: { kind: 'refused', reason: 'not_parked' } });
    await openReview(user);
    expect(await screen.findByText(PARK_COPY.generic)).toBeInTheDocument();
    expect(listParked).toHaveBeenCalledTimes(2);
  });

  it('a second resume press while one is being prepared is ignored', async () => {
    let release: (v: CartPreviewResumeResponse) => void = () => undefined;
    const { previewResume, user } = setup();
    previewResume.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await openReview(user);
    expect(within(nth(rows(), 0)).getByRole('button', { name: PARK_COPY.resume })).toBeDisabled();
    await act(async () => {
      release(preview());
      await Promise.resolve();
    });
    expect(previewResume).toHaveBeenCalledTimes(1);
  });
});

describe('no bridge', () => {
  it('a build without the park bridge shows the generic line, never an empty list', () => {
    render(
      <ParkedSalesScreen parked={null} cart={null} onResumed={vi.fn()} onBackToSale={vi.fn()} />,
    );
    expect(screen.getByText(PARK_COPY.generic)).toBeInTheDocument();
    expect(screen.queryByText(PARK_COPY.listEmpty)).not.toBeInTheDocument();
  });
});

describe('scanner on the review (RT-239)', () => {
  it('a burst ending in Enter while «قبول …» has focus is refused and never resumes', async () => {
    const { resume, user } = setup({ preview: preview({ changes: [CHANGE] }) });
    await openReview(user);
    const accept = await screen.findByRole('button', { name: PARK_COPY.acceptChanges });
    expect(accept).toHaveFocus();
    for (const ch of '6223004355218') fireEvent.keyDown(accept, { key: ch });
    fireEvent.keyDown(accept, { key: 'Enter' });
    expect(await screen.findByTestId('scan-notice')).toHaveTextContent(SCAN_PAUSED_DIALOG_STATUS);
    expect(resume).not.toHaveBeenCalled();
  });
});
