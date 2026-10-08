/**
 * T272 — print pipeline (008 Slice 3).
 *
 * Renders a `ReceiptPayload` ONCE via the Slice 2 template engine (AD-6
 * single-source), then path-selects: ESC/POS-direct preferred, OS-print
 * fallback when the printer does not report ESC/POS support. Awaits the
 * adapter ack and returns a typed pipeline result carrying the `render_path`
 * for audit.
 *
 * This module owns the shared adapter port types (`PrintAdapter`,
 * `RenderedReceipt`, `PrintAdapterResult`) so both adapters conform to one
 * contract and the pipeline treats them uniformly (strategy pattern).
 *
 * The `print_events` row INSERT + audit-event emission is the responsibility
 * of the caller wiring (T240/T241 integration tests + the receipts bridge);
 * keeping the pipeline itself a pure render+dispatch unit makes path selection
 * (T210-T212) testable in isolation. The Sale row is NEVER mutated here — the
 * print is not part of the AD-2 atomic transaction (T273 wiring), so a print
 * failure leaves the Sale durable.
 */

import { renderReceipt } from './template-engine.js';
import type {
  PrintEventFailureReason,
  PrintEventRenderPath,
} from '../sales/repositories/print-events.repository.js';
import type { ReceiptPayload } from '../../shared/receipts/types.js';

/** The dual-output render struct produced by the Slice 2 template engine. */
export interface RenderedReceipt {
  escpos: Uint8Array;
  html: string;
}

/**
 * Typed adapter outcome. Both success AND failure carry the `render_path` —
 * a failed print still chose a path (the `print_events` CHECK constraint
 * requires `render_path IS NOT NULL` for both outcomes; only manual_override
 * may be null). Success additionally needs nothing else; failure carries the
 * closed `failure_reason`.
 */
export type PrintAdapterResult =
  | { ok: true; render_path: PrintEventRenderPath }
  | { ok: false; render_path: PrintEventRenderPath; failure_reason: PrintEventFailureReason };

/** Common port both adapters conform to (ESC/POS-direct + OS-print). */
export interface PrintAdapter {
  readonly render_path: PrintEventRenderPath;
  print(rendered: RenderedReceipt): Promise<PrintAdapterResult>;
}

export interface PrintPipelineDependencies {
  escposAdapter: PrintAdapter;
  osPrintAdapter: PrintAdapter;
  /**
   * Probes the connected printer's status byte for ESC/POS support. `true`
   * → use the ESC/POS-direct adapter; `false` → OS-print fallback. Injected
   * so path selection is testable without hardware (T210).
   */
  probeEscposSupport(): Promise<boolean>;
}

/** The pipeline result mirrors the adapter result (path-opaque on success). */
export type PrintPipelineResult = PrintAdapterResult;

export interface PrintPipeline {
  /**
   * Render the payload once, path-select, dispatch to the chosen adapter, and
   * return the typed result. Does NOT write `print_events` or emit audit — the
   * caller wiring owns persistence (so the pure render+dispatch stays unit-
   * testable).
   */
  render(payload: ReceiptPayload): Promise<PrintPipelineResult>;
  /**
   * RT-15 S4 — path-select and dispatch an already-rendered slip (the cash
   * return slip, composed by the same band serialisers). Same adapters, same
   * path selection as `render`; no persistence, no audit.
   */
  printRendered(rendered: RenderedReceipt): Promise<PrintPipelineResult>;
}

export function createPrintPipeline(deps: PrintPipelineDependencies): PrintPipeline {
  const { escposAdapter, osPrintAdapter } = deps;

  async function printRendered(rendered: RenderedReceipt): Promise<PrintPipelineResult> {
    // Call via `deps.` (not destructured) to preserve any `this` binding the
    // caller's probe may rely on (unbound-method).
    const useEscpos = await deps.probeEscposSupport();
    const adapter = useEscpos ? escposAdapter : osPrintAdapter;
    return adapter.print(rendered);
  }

  return {
    render(payload: ReceiptPayload): Promise<PrintPipelineResult> {
      // Render ONCE — both paths transport the same template output (R-4 / AD-6).
      return printRendered(renderReceipt(payload));
    },
    printRendered,
  };
}
