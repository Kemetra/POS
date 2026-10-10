/**
 * RT-242 (owner decision D-C1) — the direct-add lane: a resolved scan or a
 * picked result adds at once; scans keep their order; exceptions are notices.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CartBridgeAPI, CatalogueLookupResponse } from '../../../shared/bridge-api';
import type { CartLinesAddRequest } from '../../../shared/cart/bridge-types';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import {
  SALE_ADD_FAILED_MESSAGE,
  SALE_FROZEN_MESSAGE,
  SCAN_AMBIGUOUS_MESSAGE,
  SCAN_CATALOGUE_UNAVAILABLE_MESSAGE,
  SCAN_SALE_COMPLETE_MESSAGE,
  scanNotFoundMessage,
} from '../../scan/scan-messages';
import { useDirectSaleAdd, type AddBlock, type DirectSaleAddOptions } from '../useDirectSaleAdd';

function product(id: string, name: string): ProductSnapshotDisplay {
  return {
    product_id: id,
    display_name_ar: name,
    price_minor: 1500,
    active: true,
    controlled_substance: false,
    prescription_required: false,
  };
}

const PANADOL = product('p-1', 'بنادول');
const BRUFEN = product('p-2', 'بروفين');

function okAdd(lineId: string, name: string) {
  return {
    kind: 'ok',
    line_id: lineId,
    merged: false,
    version: 1,
    display_name: name,
    unit_price_minor: 1500,
    line_subtotal_minor: 1500,
    quantity: 1,
  };
}

function setup(overrides: Partial<DirectSaleAddOptions> = {}, block: AddBlock = null) {
  const add = vi.fn((req: CartLinesAddRequest) =>
    Promise.resolve(okAdd(`line-${req.item_ref}`, req.item_ref)),
  );
  const bridge = { lines: { add } } as unknown as CartBridgeAPI;
  const options = {
    ensureCart: vi.fn().mockResolvedValue('cart-1'),
    lookupScan: vi.fn().mockResolvedValue({ kind: 'one', product: PANADOL }),
    addBlock: () => block,
    onLineAdded: vi.fn(),
    onQueued: vi.fn(),
    notify: vi.fn(),
    bridge,
    ...overrides,
  };
  const { result } = renderHook(() => useDirectSaleAdd(options));
  return { result, options, add };
}

describe('useDirectSaleAdd', () => {
  it('a resolved scan adds quantity 1 at once and reports the add key as the Undo target', async () => {
    const { result, options, add } = setup();
    await act(async () => {
      await result.current.scan('6223004355218');
    });
    expect(options.lookupScan).toHaveBeenCalledWith('6223004355218');
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ cart_id: 'cart-1', item_ref: 'p-1', quantity: 1 }),
    );
    const key = add.mock.calls[0]?.[0].idempotency_key;
    expect(options.onLineAdded).toHaveBeenCalledWith(
      expect.objectContaining({ line_id: 'line-p-1', merged: false }),
      key,
      PANADOL,
    );
    expect(options.notify).not.toHaveBeenCalled();
  });

  it('two quick scans add two lines in scan order, even when the first lookup is slower', async () => {
    let answerFirst: (value: CatalogueLookupResponse) => void = () => undefined;
    const lookupScan = vi
      .fn()
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ kind: 'one', product: BRUFEN });
    const { result, add } = setup({ lookupScan });
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.scan('111');
      second = result.current.scan('222');
    });
    // The second scan waits its turn: its lookup has not even started.
    await act(async () => Promise.resolve());
    expect(lookupScan).toHaveBeenCalledTimes(1);
    await act(async () => {
      answerFirst({ kind: 'one', product: PANADOL });
      await first;
      await second;
    });
    expect(add.mock.calls.map(([req]) => req.item_ref)).toEqual(['p-1', 'p-2']);
  });

  it('a pick adds the picked product directly, with no lookup', async () => {
    const { result, options, add } = setup();
    await act(async () => {
      await result.current.pick(BRUFEN);
    });
    expect(options.lookupScan).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ item_ref: 'p-2', quantity: 1 }));
  });

  it('withdraws any older Undo as soon as a scan or pick is queued', () => {
    const { result, options } = setup();
    act(() => {
      void result.current.scan('111');
      void result.current.pick(BRUFEN);
    });
    expect(options.onQueued).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ kind: 'not_found' }, scanNotFoundMessage('6220000000000')],
    [{ kind: 'ambiguous' }, SCAN_AMBIGUOUS_MESSAGE],
    [{ kind: 'catalogue_unavailable' }, SCAN_CATALOGUE_UNAVAILABLE_MESSAGE],
    [{ kind: 'refused', reason: 'no_session' }, SALE_ADD_FAILED_MESSAGE],
    [null, SALE_ADD_FAILED_MESSAGE],
  ])('a scan answered %o adds nothing and says so inline', async (answer, message) => {
    const { result, options, add } = setup({ lookupScan: vi.fn().mockResolvedValue(answer) });
    await act(async () => {
      await result.current.scan('6220000000000');
    });
    expect(add).not.toHaveBeenCalled();
    expect(options.notify).toHaveBeenCalledWith(message);
  });

  it('M-S3 keeps the scanned code left-to-right inside the Arabic copy', () => {
    expect(scanNotFoundMessage('6220000000000')).toBe(
      'الباركود ⁨6220000000000⁩ غير موجود في الكتالوج. امسح مرة أخرى أو ابحث بالاسم.',
    );
  });

  it.each([
    ['paid', SCAN_SALE_COMPLETE_MESSAGE],
    ['frozen', SALE_FROZEN_MESSAGE],
  ] as const)('a %s cart takes no line and creates no new cart', async (block, message) => {
    const { result, options, add } = setup({}, block);
    await act(async () => {
      await result.current.scan('111');
      await result.current.pick(BRUFEN);
    });
    expect(options.lookupScan).not.toHaveBeenCalled();
    expect(options.ensureCart).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(options.notify).toHaveBeenCalledWith(message);
  });

  it('a refused or failed add, or no cart, is a generic notice and no line', async () => {
    const add = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'refused', reason: 'wrong_owner' })
      .mockRejectedValueOnce(new Error('ipc'));
    const bridge = { lines: { add } } as unknown as CartBridgeAPI;
    const ensureCart = vi
      .fn()
      .mockResolvedValueOnce('cart-1')
      .mockResolvedValueOnce('cart-1')
      .mockResolvedValueOnce(null);
    const { result, options } = setup({ bridge, ensureCart });
    await act(async () => {
      await result.current.scan('111');
      await result.current.scan('111');
      await result.current.scan('111');
    });
    expect(add).toHaveBeenCalledTimes(2);
    expect(options.onLineAdded).not.toHaveBeenCalled();
    expect(options.notify).toHaveBeenCalledTimes(3);
    expect(options.notify).toHaveBeenLastCalledWith(SALE_ADD_FAILED_MESSAGE);
  });

  it('a lane job that throws does not block the next scan', async () => {
    const lookupScan = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ kind: 'one', product: PANADOL });
    const { result, add } = setup({ lookupScan });
    await act(async () => {
      await result.current.scan('111').catch(() => undefined);
      await result.current.scan('222');
    });
    expect(add).toHaveBeenCalledOnce();
  });
});
