/**
 * RT-15 S4 — `printRendered`: a slip composed elsewhere (the cash return slip)
 * goes through the SAME path selection and adapters as a sale receipt, so no
 * second printer path exists.
 */
import { describe, expect, it } from 'vitest';

import {
  createPrintPipeline,
  type PrintAdapter,
  type PrintAdapterResult,
  type RenderedReceipt,
} from '../../../../src/main/receipts/print-pipeline.js';

function recordingAdapter(
  render_path: 'escpos_direct' | 'os_print',
  result: PrintAdapterResult,
): PrintAdapter & { printed: RenderedReceipt[] } {
  const printed: RenderedReceipt[] = [];
  return {
    render_path,
    printed,
    print: (rendered) => {
      printed.push(rendered);
      return Promise.resolve(result);
    },
  };
}

const SLIP: RenderedReceipt = { escpos: new Uint8Array([0x1b, 0x40]), html: '<div>slip</div>' };

describe('print pipeline printRendered', () => {
  it.each<[boolean, 'escpos_direct' | 'os_print']>([
    [true, 'escpos_direct'],
    [false, 'os_print'],
  ])('ESC/POS support %s prints through %s, unchanged', async (escpos, path) => {
    const escposAdapter = recordingAdapter('escpos_direct', {
      ok: true,
      render_path: 'escpos_direct',
    });
    const osPrintAdapter = recordingAdapter('os_print', {
      ok: false,
      render_path: 'os_print',
      failure_reason: 'os_print_error',
    });
    const pipeline = createPrintPipeline({
      escposAdapter,
      osPrintAdapter,
      probeEscposSupport: () => Promise.resolve(escpos),
    });

    const result = await pipeline.printRendered(SLIP);

    const chosen = path === 'escpos_direct' ? escposAdapter : osPrintAdapter;
    const other = path === 'escpos_direct' ? osPrintAdapter : escposAdapter;
    expect(chosen.printed).toEqual([SLIP]);
    expect(other.printed).toEqual([]);
    expect(result.render_path).toBe(path);
    expect(result.ok).toBe(escpos);
  });
});
