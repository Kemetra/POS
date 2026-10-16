/**
 * RT-542 — the history parts on their own: the copy tables, the local-sale
 * detail, the store-sale detail's edge states and the list state hook.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type {
  ReceiptsBridgeAPI,
  SalesBridgeAPI,
  SaleSummary,
} from '../../../../../../shared/bridge-api';
import type { SaleId } from '../../../../../../shared/sales/types';
import type {
  SaleHistoryBridgeAPI,
  SaleHistoryDetail,
  SaleHistoryListResponse,
  SaleHistoryLocalPage,
  SaleHistoryRow,
  SaleHistoryServerPage,
} from '../../../../../../shared/sale-history/types';
import { format as formatMoney, of as moneyOf } from '../../../../../../shared/money';
import { HistoryDetail } from '../HistoryDetail';
import { LocalSaleDetail } from '../LocalSaleDetail';
import { HISTORY_COPY as C, erpCopy, refusalCopy, syncCopy } from '../history-copy';
import { useSaleHistory } from '../useSaleHistory';

afterEach(() => {
  cleanup();
});

const REF = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b';
const RANGE = { from_day: '2026-10-16', to_day: '2026-10-16' };
const egp = (minor: number): string => formatMoney(moneyOf(minor, 'EGP'));

function row(over: Partial<SaleHistoryRow> = {}): SaleHistoryRow {
  return {
    sale_ref: REF,
    sale_number: 'T1-20261016-0001',
    business_day: '2026-10-16',
    occurred_at: '2026-10-16T07:00:00.000Z',
    received_at: '2026-10-16T07:00:05.000Z',
    device_label: 'Till 2',
    device_label_source: 'snapshot',
    operator_display_name: 'منى',
    operator_name_source: 'snapshot',
    total_minor: 2550,
    sync_status: 'synced',
    voided: false,
    return_state: 'none',
    erp_state: 'posted',
    local_sale_id: null,
    ...over,
  };
}

function detail(over: Partial<SaleHistoryDetail> = {}): SaleHistoryDetail {
  return {
    summary: row(),
    lines: [
      {
        line_ref: 'l1',
        sequence: 1,
        name: 'Panadol',
        unit_price_minor: 1275,
        quantity: '2',
        line_minor: 2550,
        tax_minor: 0,
        unit: 'box',
        returned_quantity: '0',
      },
    ],
    line_order: 'recorded',
    tender_state: 'recorded',
    tenders: [{ method: 'cash', amount_minor: 2550, reference: null, sequence: 1 }],
    change_minor: 0,
    settled_at: '2026-10-16T07:00:00.000Z',
    receipt_number: 'T1-20261016-0001',
    receipt_header: { branch_name: 'B', branch_address: 'A', tax_registration_id: 'T' },
    void: null,
    returns: [],
    erp: {
      sale: 'posted',
      sale_document_ref: 'ACC-1',
      reversal: null,
      reversal_document_ref: null,
    },
    receipt_facts: 'complete',
    reprint: { duplicate: 'allowed', marks: [] },
    ...over,
  };
}

function serverPage(over: Partial<SaleHistoryServerPage> = {}): SaleHistoryServerPage {
  return {
    kind: 'ok',
    source: 'server',
    rows: [row()],
    next_cursor: null,
    as_of: '2026-10-16T07:30:00.000Z',
    store_timezone: 'Africa/Cairo',
    visibility: 'store',
    from_day: '2026-10-16',
    to_day: '2026-10-16',
    unsynced: [],
    unsynced_truncated: false,
    ...over,
  };
}

function localPage(over: Partial<SaleHistoryLocalPage> = {}): SaleHistoryLocalPage {
  return {
    kind: 'ok',
    source: 'local',
    coverage: 'this_device_only',
    offline_reason: 'no_connection',
    rows: [],
    next_cursor: null,
    ...over,
  };
}

function summary(over: Partial<SaleSummary> = {}): SaleSummary {
  return {
    sale_id: 'local-1',
    sale_number: 'T1-20261016-0009',
    receipt_number: 'T1-20261016-0009',
    tenant_id: 't1',
    branch_id: 'b1',
    terminal_id: 'term1',
    terminal_label: 'Till 1',
    selling_operator_id: 'op1',
    selling_operator_display_name: 'منى',
    subtotal_minor: 1000,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    tender_lines_summary: [],
    finalized_at: '2026-10-16T07:40:00Z',
    latest_print_event: { outcome: 'success' } as SaleSummary['latest_print_event'],
    ...over,
  } as SaleSummary;
}

function historyBridge(over: Partial<SaleHistoryBridgeAPI> = {}): SaleHistoryBridgeAPI {
  return {
    list: vi.fn(() => Promise.resolve(serverPage())),
    read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, detail: detail() })),
    reprint: vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, reason: 'printer_unavailable' as const }),
    ),
    zoneStatus: vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        status: 'unknown' as const,
        expected: 'Africa/Cairo',
        reported: null,
      }),
    ),
    ...over,
  };
}

describe('RT-542 history copy tables', () => {
  it('names every ERP and sync state', () => {
    expect(['posted', 'pending', 'failed', 'unknown'].map((s) => erpCopy(s as never))).toEqual([
      'مُرحّل',
      'بانتظار الترحيل',
      'تعذّر الترحيل',
      'غير معروفة',
    ]);
    expect(['not_started', 'pending', 'dead_letter'].map((s) => syncCopy(s as never))).toEqual([
      'لم يُرسل بعد',
      'قيد الإرسال',
      'رفضه الخادم',
    ]);
  });

  it('falls back to generic copy for a refusal without its own text', () => {
    expect(refusalCopy('unavailable')).toBe('تعذّر إتمام الطلب. حاول مرة أخرى.');
    expect(refusalCopy('busy')).toBe('طباعة هذا البيع جارية بالفعل.');
  });

  it('says "no connection" for a local network problem, distinct from a server outage', () => {
    expect(C.offlineNoConnection).not.toBe(C.offlineServerUnavailable);
    expect(C.offlineNoConnection).not.toContain('الخادم');
  });
});

describe('RT-542 LocalSaleDetail', () => {
  function salesWith(read: SalesBridgeAPI['read']): SalesBridgeAPI {
    return { read } as unknown as SalesBridgeAPI;
  }

  it('shows this terminal’s own record', async () => {
    const read = vi.fn(() => Promise.resolve({ kind: 'ok' as const, sale: summary() }));
    const receipts = { preview: vi.fn(), reprint: vi.fn() } as unknown as ReceiptsBridgeAPI;
    render(
      <LocalSaleDetail
        saleId={'local-1' as SaleId}
        sales={salesWith(read as never)}
        receipts={receipts}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(C.loading)).toBeInTheDocument();
    expect(await screen.findByTestId('sale-result')).toHaveTextContent('T1-20261016-0009');
  });

  it('says "not recorded" when the record is missing or the read fails', async () => {
    const refused = vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, reason: 'sale_not_found' as const }),
    );
    render(
      <LocalSaleDetail
        saleId={'local-1' as SaleId}
        sales={salesWith(refused as never)}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(C.notRecorded)).toBeInTheDocument();
    cleanup();
    const failed = vi.fn(() => Promise.reject(new Error('ipc down')));
    render(
      <LocalSaleDetail
        saleId={'local-1' as SaleId}
        sales={salesWith(failed as never)}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText(C.notRecorded)).toBeInTheDocument();
  });

  it('closes on request', async () => {
    const onClose = vi.fn();
    const read = vi.fn(() => new Promise<never>(() => undefined));
    render(
      <LocalSaleDetail
        saleId={'local-1' as SaleId}
        sales={salesWith(read as never)}
        onClose={onClose}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: C.close }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('RT-542 HistoryDetail — edge states', () => {
  it('says the sale could not be read when the bridge call fails or is refused', async () => {
    const failing = historyBridge({ read: vi.fn(() => Promise.reject(new Error('down'))) });
    render(<HistoryDetail saleRef={REF} bridge={failing} onClose={() => undefined} />);
    expect(await screen.findByTestId('history-detail-refused')).toHaveTextContent(
      refusalCopy('unavailable'),
    );
    cleanup();
    const refused = historyBridge({
      read: vi.fn(() =>
        Promise.resolve({ kind: 'refused' as const, reason: 'sale_not_found' as const }),
      ),
    });
    render(<HistoryDetail saleRef={REF} bridge={refused} onClose={() => undefined} />);
    expect(await screen.findByTestId('history-detail-refused')).toHaveTextContent(
      refusalCopy('sale_not_found'),
    );
  });

  it('shows card tenders, an unrecorded change, returns and a pending ERP state', async () => {
    const bridge = historyBridge({
      read: vi.fn(() =>
        Promise.resolve({
          kind: 'ok' as const,
          detail: detail({
            tenders: [
              { method: 'card_external', amount_minor: 2550, reference: 'R1', sequence: 1 },
            ],
            change_minor: null,
            returns: [
              {
                return_ref: 'r1',
                recorded_at: '2026-10-16T08:00:00.000Z',
                business_day: '2026-10-16',
                total_minor: 1275,
                lines: [{ line_ref: 'l1', quantity: '1', line_minor: 1275 }],
              },
            ],
            erp: {
              sale: 'pending',
              sale_document_ref: null,
              reversal: null,
              reversal_document_ref: null,
            },
          }),
        }),
      ),
    });
    render(<HistoryDetail saleRef={REF} bridge={bridge} onClose={() => undefined} />);
    const panel = await screen.findByTestId('history-detail');
    const erp = await within(panel).findByTestId('history-erp');
    expect(erp).toHaveTextContent(erpCopy('pending'));
    const tenders = within(panel).getByRole('region', { name: C.tenders });
    expect(tenders).toHaveTextContent(C.card);
    expect(tenders).toHaveTextContent(C.notRecorded);
    const returns = within(panel).getByRole('region', { name: C.returns });
    expect(returns).toHaveTextContent(egp(1275));
    expect(within(panel).queryByTestId('history-voided')).toBeNull();
  });

  it('shows a printer refusal, and a failed bridge call as a generic refusal', async () => {
    const bridge = historyBridge();
    render(<HistoryDetail saleRef={REF} bridge={bridge} onClose={() => undefined} />);
    await screen.findByTestId('history-erp');
    await userEvent.click(screen.getByRole('button', { name: C.reprintRecord }));
    expect(await screen.findByTestId('history-reprint-result')).toHaveTextContent(
      refusalCopy('printer_unavailable'),
    );
    cleanup();
    const failing = historyBridge({ reprint: vi.fn(() => Promise.reject(new Error('down'))) });
    render(<HistoryDetail saleRef={REF} bridge={failing} onClose={() => undefined} />);
    await screen.findByTestId('history-erp');
    await userEvent.click(screen.getByRole('button', { name: C.reprintDuplicate }));
    expect(await screen.findByTestId('history-reprint-result')).toHaveTextContent(
      refusalCopy('unavailable'),
    );
  });

  it('sends one reprint at a time', async () => {
    let finish: () => void = () => undefined;
    const reprint = vi.fn(
      () =>
        new Promise<{ kind: 'refused'; reason: 'busy' }>((resolve) => {
          finish = () => {
            resolve({ kind: 'refused', reason: 'busy' });
          };
        }),
    );
    render(
      <HistoryDetail saleRef={REF} bridge={historyBridge({ reprint })} onClose={() => undefined} />,
    );
    await screen.findByTestId('history-erp');
    const button = screen.getByRole('button', { name: C.reprintRecord });
    button.click();
    button.click();
    expect(await screen.findByText(C.printing)).toBeInTheDocument();
    act(() => {
      finish();
    });
    await screen.findByTestId('history-reprint-result');
    expect(reprint).toHaveBeenCalledTimes(1);
  });
});

describe('RT-542 useSaleHistory', () => {
  it('does nothing without a bridge', async () => {
    const { result } = renderHook(() => useSaleHistory(null));
    await act(() => result.current.search(RANGE));
    await act(() => result.current.loadMore());
    expect(result.current.view).toEqual({ phase: 'idle' });
  });

  it('turns a failed first call into an "unavailable" refusal', async () => {
    const bridge = historyBridge({ list: vi.fn(() => Promise.reject(new Error('down'))) });
    const { result } = renderHook(() => useSaleHistory(bridge));
    await act(() => result.current.search(RANGE));
    expect(result.current.view).toEqual({ phase: 'refused', reason: 'unavailable' });
  });

  it('appends the next page of a local walk', async () => {
    const list = vi.fn((req: { cursor?: string }) =>
      Promise.resolve(
        req.cursor === undefined
          ? localPage({ next_cursor: 'n.1', rows: [{ sale_id: 'a' } as never] })
          : localPage({ rows: [{ sale_id: 'b' } as never] }),
      ),
    );
    const bridge = historyBridge({ list: list as SaleHistoryBridgeAPI['list'] });
    const { result } = renderHook(() => useSaleHistory(bridge));
    await act(() => result.current.search(RANGE));
    await act(() => result.current.loadMore());
    const view = result.current.view;
    expect(view.phase).toBe('local');
    if (view.phase === 'local') {
      expect(view.rows.map((r) => r.sale_id)).toEqual(['a', 'b']);
      expect(view.cursor).toBeNull();
      expect(view.more).toEqual({ kind: 'idle' });
    }
    // No cursor left: nothing more to load.
    await act(() => result.current.loadMore());
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('never mixes sources: a page from the other source fails the continuation', async () => {
    const list = vi.fn((req: { cursor?: string }) =>
      Promise.resolve<SaleHistoryListResponse>(
        req.cursor === undefined ? serverPage({ next_cursor: 's.1' }) : localPage(),
      ),
    );
    const bridge = historyBridge({ list: list as SaleHistoryBridgeAPI['list'] });
    const { result } = renderHook(() => useSaleHistory(bridge));
    await act(() => result.current.search(RANGE));
    await act(() => result.current.loadMore());
    const view = result.current.view;
    expect(view.phase).toBe('server');
    if (view.phase === 'server') {
      expect(view.rows).toHaveLength(1);
      expect(view.more).toEqual({ kind: 'failed', reason: 'continuation_failed' });
    }
  });

  it('keeps the rows when the next-page call itself fails', async () => {
    const list = vi.fn((req: { cursor?: string }) =>
      req.cursor === undefined
        ? Promise.resolve(serverPage({ next_cursor: 's.1' }))
        : Promise.reject(new Error('down')),
    );
    const bridge = historyBridge({ list: list as SaleHistoryBridgeAPI['list'] });
    const { result } = renderHook(() => useSaleHistory(bridge));
    await act(() => result.current.search(RANGE));
    await act(() => result.current.loadMore());
    const view = result.current.view;
    expect(view.phase === 'server' && view.more).toEqual({
      kind: 'failed',
      reason: 'continuation_failed',
    });
  });

  it('drops the answer of a walk a newer search replaced', async () => {
    let release: (value: SaleHistoryListResponse) => void = () => undefined;
    const list = vi
      .fn<SaleHistoryBridgeAPI['list']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementation(() => Promise.resolve(localPage()));
    const { result } = renderHook(() => useSaleHistory(historyBridge({ list })));
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.search(RANGE);
    });
    await act(() => result.current.search({ from_day: '2026-10-15', to_day: '2026-10-15' }));
    await act(async () => {
      release(serverPage());
      await first;
    });
    await waitFor(() => {
      expect(result.current.view.phase).toBe('local');
    });
  });
});
