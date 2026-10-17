import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import type {
  SaleHistoryBridgeAPI,
  SaleHistoryDetail,
  SaleHistoryListResponse,
  SaleHistoryRow,
  SaleHistoryServerPage,
} from '../../../../../../shared/sale-history/types';
import type { SalesBridgeAPI } from '../../../../../../shared/bridge-api';
import type { SaleId } from '../../../../../../shared/sales/types';
import { expectNoAxeViolations } from '../../../../../test-utils/axe-config';
import { SalesHistory } from '../SalesHistory';
import { HISTORY_COPY as C } from '../history-copy';

afterEach(() => {
  cleanup();
});

const REF = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b';
// 2026-10-16 08:00 UTC = 11:00 in Cairo.
const NOW = (): Date => new Date('2026-10-16T08:00:00.000Z');

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

function page(over: Partial<SaleHistoryServerPage> = {}): SaleHistoryServerPage {
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
        tax_minor: null,
        unit: 'box',
        returned_quantity: '0',
      },
    ],
    line_order: 'recorded',
    tender_state: 'recorded',
    tenders: [{ method: 'cash', amount_minor: 2550, reference: null, sequence: 1 }],
    change_minor: 450,
    settled_at: '2026-10-16T07:00:00.000Z',
    receipt_number: 'T1-20261016-0001',
    receipt_header: { branch_name: 'B', branch_address: 'A', tax_registration_id: 'T' },
    void: null,
    returns: [],
    erp: {
      sale: 'posted',
      sale_document_ref: 'ACC-SINV-0001',
      reversal: null,
      reversal_document_ref: null,
    },
    receipt_facts: 'complete',
    reprint: { duplicate: 'allowed', marks: [] },
    ...over,
  };
}

function bridgeWith(
  list: SaleHistoryListResponse | ((req: unknown) => Promise<SaleHistoryListResponse>),
  read: SaleHistoryDetail = detail(),
): SaleHistoryBridgeAPI & {
  list: Mock<SaleHistoryBridgeAPI['list']>;
  reprint: Mock<SaleHistoryBridgeAPI['reprint']>;
} {
  return {
    list: vi.fn<SaleHistoryBridgeAPI['list']>(
      typeof list === 'function' ? list : () => Promise.resolve(list),
    ),
    read: vi.fn(() => Promise.resolve({ kind: 'ok' as const, detail: read })),
    reprint: vi.fn<SaleHistoryBridgeAPI['reprint']>(() =>
      Promise.resolve({
        kind: 'ok' as const,
        printed: 'duplicate' as const,
        copy_number: 3,
        marks: [],
        printed_at: '2026-10-16T08:00:00.000Z',
      }),
    ),
    zoneStatus: vi.fn(() =>
      Promise.resolve({
        kind: 'ok' as const,
        status: 'unknown' as const,
        expected: 'Africa/Cairo',
        reported: null,
      }),
    ),
  };
}

async function show(bridge: SaleHistoryBridgeAPI): Promise<void> {
  render(<SalesHistory _testBridge={bridge} _now={NOW} />);
  await userEvent.click(screen.getByRole('button', { name: C.show }));
}

describe('RT-542 SalesHistory — states', () => {
  it('asks for today’s Cairo business day and says what the server had received, never "complete"', async () => {
    const bridge = bridgeWith(page());
    await show(bridge);
    expect(bridge.list).toHaveBeenCalledWith({ from_day: '2026-10-16', to_day: '2026-10-16' });
    const coverage = await screen.findByTestId('history-coverage');
    expect(coverage).toHaveTextContent(C.receivedUpTo('2026-10-16 10:30'));
    expect(screen.getByTestId('history-rows')).toHaveTextContent('T1-20261016-0001');
    expect(document.body.textContent).not.toMatch(/مكتمل لمبيعات المتجر\.$/);
  });

  it('tells a cashier the list is their own sales across the store', async () => {
    await show(bridgeWith(page({ visibility: 'own_sales' })));
    expect(await screen.findByTestId('history-coverage')).toHaveTextContent(C.ownSalesOnly);
  });

  it('lists this device’s unsent sales apart from the server rows', async () => {
    await show(
      bridgeWith(
        page({
          unsynced: [
            {
              sale_id: 'local-1' as SaleId,
              sale_number: 'T1-20261016-0009',
              business_day: '2026-10-16',
              finalized_at: '2026-10-16T07:40:00.000Z',
              terminal_label: 'Till 1',
              selling_operator_display_name: 'منى',
              subtotal_minor: 1000,
              total_tax_minor: 0,
              sync: 'dead_letter',
            },
          ],
          unsynced_truncated: true,
        }),
      ),
    );
    const unsynced = await screen.findByTestId('history-unsynced');
    expect(unsynced).toHaveTextContent(C.unsyncedHeading);
    expect(unsynced).toHaveTextContent('رفضه الخادم');
    expect(unsynced).toHaveTextContent(C.unsyncedTruncated);
  });

  it('says "this device only" offline', async () => {
    await show(
      bridgeWith({
        kind: 'ok',
        source: 'local',
        coverage: 'this_device_only',
        offline_reason: 'no_connection',
        rows: [],
        next_cursor: null,
      }),
    );
    expect(await screen.findByTestId('history-coverage')).toHaveTextContent(C.deviceOnly);
    expect(screen.getByTestId('history-empty')).toHaveTextContent(C.empty);
  });

  it('shows an empty online period and a refusal distinctly', async () => {
    await show(bridgeWith(page({ rows: [] })));
    expect(await screen.findByTestId('history-empty')).toHaveTextContent(C.empty);
    cleanup();
    await show(bridgeWith({ kind: 'refused', reason: 'role_denied' }));
    expect(await screen.findByTestId('history-refused')).toHaveTextContent('ليست لديك صلاحية');
  });

  it('labels a legacy row’s unrecorded and current names', async () => {
    await show(
      bridgeWith(
        page({
          rows: [
            row({
              sale_number: null,
              device_label: null,
              device_label_source: 'unavailable',
              operator_name_source: 'current',
            }),
          ],
        }),
      ),
    );
    const rows = await screen.findByTestId('history-rows');
    expect(within(rows).getAllByText(C.notRecorded).length).toBeGreaterThanOrEqual(2);
    expect(rows).toHaveTextContent(C.currentName);
  });

  it('has no axe violations online', async () => {
    const { container } = render(<SalesHistory _testBridge={bridgeWith(page())} _now={NOW} />);
    await userEvent.click(screen.getByRole('button', { name: C.show }));
    expect(await screen.findByTestId('history-rows')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('RT-542 SalesHistory — pages', () => {
  it('appends the next page of the same walk', async () => {
    const bridge = bridgeWith((req) =>
      Promise.resolve(
        (req as { cursor?: string }).cursor === 's.n1'
          ? page({
              rows: [
                row({ sale_ref: '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6c', sale_number: 'SECOND' }),
              ],
            })
          : page({ next_cursor: 's.n1' }),
      ),
    );
    await show(bridge);
    await userEvent.click(await screen.findByRole('button', { name: C.loadMore }));
    await waitFor(() => {
      expect(screen.getByTestId('history-rows')).toHaveTextContent('SECOND');
    });
    expect(screen.getByTestId('history-rows')).toHaveTextContent('T1-20261016-0001');
    expect(bridge.list).toHaveBeenLastCalledWith({
      from_day: '2026-10-16',
      to_day: '2026-10-16',
      cursor: 's.n1',
    });
  });

  it('keeps the rows and offers a retry when the next page fails', async () => {
    const bridge = bridgeWith((req) =>
      Promise.resolve(
        (req as { cursor?: string }).cursor === undefined
          ? page({ next_cursor: 's.n1' })
          : ({ kind: 'refused', reason: 'continuation_failed' } as const),
      ),
    );
    await show(bridge);
    await userEvent.click(await screen.findByRole('button', { name: C.loadMore }));
    expect(await screen.findByTestId('history-more-failed')).toBeInTheDocument();
    expect(screen.getByTestId('history-rows')).toHaveTextContent('T1-20261016-0001');
    expect(screen.getByRole('button', { name: C.retry })).toBeInTheDocument();
  });
});

describe('RT-542 SalesHistory — detail and reprint', () => {
  it('shows the ERP state as operational context and reprints a duplicate', async () => {
    const bridge = bridgeWith(page());
    await show(bridge);
    await userEvent.click(await screen.findByRole('button', { name: C.open }));
    const panel = await screen.findByTestId('history-detail');
    await within(panel).findByTestId('history-erp');
    expect(panel).toHaveTextContent('ACC-SINV-0001');
    expect(panel).toHaveTextContent(C.erpNote);
    await userEvent.click(within(panel).getByRole('button', { name: C.reprintDuplicate }));
    expect(bridge.reprint).toHaveBeenCalledWith({ sale_ref: REF, kind: 'duplicate' });
    expect(await within(panel).findByTestId('history-reprint-result')).toHaveTextContent(C.sent(3));
  });

  it('offers only the VOIDED sale record for a voided sale', async () => {
    const bridge = bridgeWith(
      page({ rows: [row({ voided: true })] }),
      detail({
        summary: row({ voided: true }),
        void: {
          voided_at: '2026-10-16T07:20:00.000Z',
          void_business_day: '2026-10-16',
          approved: true,
          approver_role: 'store_manager',
        },
        reprint: { duplicate: 'unavailable_voided', marks: ['voided'] },
      }),
    );
    await show(bridge);
    await userEvent.click(await screen.findByRole('button', { name: C.open }));
    const panel = await screen.findByTestId('history-detail');
    await within(panel).findByTestId('history-voided');
    expect(within(panel).queryByRole('button', { name: C.reprintDuplicate })).toBeNull();
    expect(panel).toHaveTextContent(C.duplicateVoided);
    await userEvent.click(within(panel).getByRole('button', { name: C.reprintRecord }));
    expect(bridge.reprint).toHaveBeenCalledWith({ sale_ref: REF, kind: 'sale_record' });
  });

  it('labels unrecorded receipt facts of a legacy sale', async () => {
    const bridge = bridgeWith(
      page(),
      detail({
        tender_state: 'unknown',
        tenders: [],
        change_minor: null,
        receipt_header: null,
        line_order: 'not_recorded',
        receipt_facts: 'partial',
        erp: {
          sale: 'unknown',
          sale_document_ref: null,
          reversal: null,
          reversal_document_ref: null,
        },
        reprint: { duplicate: 'unavailable_incomplete', marks: [] },
      }),
    );
    await show(bridge);
    await userEvent.click(await screen.findByRole('button', { name: C.open }));
    const panel = await screen.findByTestId('history-detail');
    await within(panel).findByTestId('history-erp');
    expect(panel).toHaveTextContent(C.tenderUnknown);
    expect(panel).toHaveTextContent(C.headerNotRecorded);
    expect(panel).toHaveTextContent(C.lineOrderNotRecorded);
    expect(panel).toHaveTextContent(C.duplicateIncomplete);
    expect(within(panel).getByTestId('history-erp')).toHaveTextContent('غير معروفة');
  });

  it('opens an unsent local sale through its own record', async () => {
    const read = vi.fn(() =>
      Promise.resolve({ kind: 'refused' as const, reason: 'sale_not_found' as const }),
    );
    const sales = { read } as unknown as SalesBridgeAPI;
    const bridge = bridgeWith(
      page({
        rows: [],
        unsynced: [
          {
            sale_id: 'local-1' as SaleId,
            sale_number: 'T1-20261016-0009',
            business_day: '2026-10-16',
            finalized_at: '2026-10-16T07:40:00.000Z',
            terminal_label: 'Till 1',
            selling_operator_display_name: 'منى',
            subtotal_minor: 1000,
            total_tax_minor: 0,
            sync: 'pending',
          },
        ],
      }),
    );
    render(<SalesHistory _testBridge={bridge} _testSalesBridge={sales} _now={NOW} />);
    await userEvent.click(screen.getByRole('button', { name: C.show }));
    await userEvent.click(await screen.findByRole('button', { name: C.open }));
    expect(await screen.findByTestId('history-local-detail')).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith({ sale_id: 'local-1' });
  });
});

describe('RT-542 review fixes — renderer', () => {
  it('says the server is not answering, distinct from no connection', async () => {
    await show(
      bridgeWith({
        kind: 'ok',
        source: 'local',
        coverage: 'this_device_only',
        offline_reason: 'server_unavailable',
        rows: [],
        next_cursor: null,
      }),
    );
    const coverage = await screen.findByTestId('history-coverage');
    expect(coverage).toHaveTextContent(C.offlineServerUnavailable);
    expect(coverage).not.toHaveTextContent(C.offlineNoConnection);
  });

  it('takes "today" from the clock at click time, not at mount', async () => {
    let now = new Date('2026-10-16T20:30:00.000Z'); // 23:30 in Cairo
    const bridge = bridgeWith(page());
    render(<SalesHistory _testBridge={bridge} _now={() => now} />);
    now = new Date('2026-10-16T21:30:00.000Z'); // 00:30 on the 17th in Cairo
    await userEvent.click(screen.getByRole('button', { name: C.today }));
    expect(bridge.list).toHaveBeenLastCalledWith({ from_day: '2026-10-17', to_day: '2026-10-17' });
  });

  it('loads the next page once on a double click', async () => {
    let release: (value: SaleHistoryListResponse) => void = () => undefined;
    const bridge = bridgeWith((req) =>
      (req as { cursor?: string }).cursor === undefined
        ? Promise.resolve(page({ next_cursor: 's.n1' }))
        : new Promise<SaleHistoryListResponse>((resolve) => {
            release = resolve;
          }),
    );
    await show(bridge);
    const more = await screen.findByRole('button', { name: C.loadMore });
    more.click();
    more.click();
    release(page({ rows: [] }));
    await waitFor(() => {
      expect(bridge.list).toHaveBeenCalledTimes(2);
    });
  });

  it('ends a walk whose local cursor is refused, instead of offering a retry that cannot work', async () => {
    const bridge = bridgeWith((req) =>
      Promise.resolve(
        (req as { cursor?: string }).cursor === undefined
          ? ({
              kind: 'ok',
              source: 'local',
              coverage: 'this_device_only',
              offline_reason: 'no_connection',
              rows: [],
              next_cursor: 'n.bad',
            } as const)
          : ({ kind: 'refused', reason: 'invalid_request' } as const),
      ),
    );
    await show(bridge);
    await userEvent.click(await screen.findByRole('button', { name: C.loadMore }));
    expect(await screen.findByTestId('history-refused')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: C.retry })).toBeNull();
  });

  it('never shows one unsent sale while another is loading', async () => {
    const unsent = (saleId: string, saleNumber: string) => ({
      sale_id: saleId as SaleId,
      sale_number: saleNumber,
      business_day: '2026-10-16',
      finalized_at: '2026-10-16T07:40:00.000Z',
      terminal_label: 'Till 1',
      selling_operator_display_name: 'منى',
      subtotal_minor: 1000,
      total_tax_minor: 0,
      sync: 'pending' as const,
    });
    const read = vi.fn((req: { sale_id: string }) =>
      req.sale_id === 'local-1'
        ? Promise.resolve({
            kind: 'ok' as const,
            sale: { sale_id: 'local-1', sale_number: 'FIRST', latest_print_event: null },
          })
        : new Promise<never>(() => undefined),
    );
    const sales = { read } as unknown as SalesBridgeAPI;
    const bridge = bridgeWith(
      page({ rows: [], unsynced: [unsent('local-1', 'FIRST'), unsent('local-2', 'SECOND')] }),
    );
    render(<SalesHistory _testBridge={bridge} _testSalesBridge={sales} _now={NOW} />);
    await userEvent.click(screen.getByRole('button', { name: C.show }));
    const opens = await screen.findAllByRole('button', { name: C.open });
    await userEvent.click(opens[0] as HTMLElement);
    expect(await screen.findByTestId('sale-result')).toHaveTextContent('FIRST');
    await userEvent.click(opens[1] as HTMLElement);
    const panel = await screen.findByTestId('history-local-detail');
    expect(within(panel).queryByTestId('sale-result')).toBeNull();
    expect(within(panel).getByText(C.loading)).toBeInTheDocument();
  });

  it('never shows one sale’s reprint result on another sale', async () => {
    const second = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6c';
    let finish: () => void = () => undefined;
    const bridge = bridgeWith(
      page({ rows: [row(), row({ sale_ref: second, sale_number: 'SECOND' })] }),
    );
    bridge.reprint.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve({
              kind: 'ok',
              printed: 'duplicate',
              copy_number: 9,
              marks: [],
              printed_at: 'x',
            });
          };
        }),
    );
    await show(bridge);
    const opens = await screen.findAllByRole('button', { name: C.open });
    await userEvent.click(opens[0] as HTMLElement);
    let panel = await screen.findByTestId('history-detail');
    await within(panel).findByTestId('history-erp');
    await userEvent.click(within(panel).getByRole('button', { name: C.reprintDuplicate }));
    await userEvent.click(opens[1] as HTMLElement);
    finish();
    panel = await screen.findByTestId('history-detail');
    await within(panel).findByTestId('history-erp');
    expect(within(panel).queryByText(C.sent(9))).toBeNull();
    expect(within(panel).getByRole('button', { name: C.reprintDuplicate })).toBeEnabled();
  });
});
