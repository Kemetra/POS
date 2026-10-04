import type {
  ReturnJournalView,
  ReturnLineInput,
  ReturnQuoteView,
  ReturnableSaleView,
  ReturnsRefusalReason,
  ReturnsSubmitResponse,
} from '../../shared/returns/types.js';

/**
 * RT-15 S3 — the return flow's state, as pure data and transitions.
 *
 * lookup → select → summary → outcome. The renderer only holds what main
 * answered (the sale view, the quote, the journaled return) plus the
 * manager's picked whole quantities; it never derives an amount.
 */

/** A refusal from main, a rejected bridge call, or a blank sale number. */
export type FlowNotice =
  | { readonly kind: 'refused'; readonly reason: ReturnsRefusalReason }
  | { readonly kind: 'failed' }
  | { readonly kind: 'empty' };

export type Picked = Readonly<Record<string, number>>;

export type Outcome =
  | { readonly kind: 'confirmed'; readonly ret: ReturnJournalView; readonly replayed: boolean }
  | {
      readonly kind: 'unconfirmed';
      readonly ret: ReturnJournalView;
      /** True after a "check again" that still found no answer. */
      readonly still: boolean;
      readonly notice: FlowNotice | null;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ReturnsRefusalReason;
      readonly ret: ReturnJournalView | null;
    }
  /** The submit call itself was rejected: the result is not known. */
  | { readonly kind: 'failed' };

interface SaleContext {
  readonly saleNumber: string;
  readonly sale: ReturnableSaleView;
  readonly picked: Picked;
  readonly notice: FlowNotice | null;
}

export type FlowState =
  | { readonly step: 'lookup'; readonly notice: FlowNotice | null }
  | ({ readonly step: 'select' } & SaleContext)
  | ({ readonly step: 'summary'; readonly quote: ReturnQuoteView } & SaleContext)
  | { readonly step: 'outcome'; readonly outcome: Outcome };

export const INITIAL_FLOW: FlowState = { step: 'lookup', notice: null };

export function found(saleNumber: string, sale: ReturnableSaleView): FlowState {
  return { step: 'select', saleNumber, sale, picked: {}, notice: null };
}

/** Keep the step, show `notice` (outcome has its own notices). */
export function withNotice(state: FlowState, notice: FlowNotice): FlowState {
  return state.step === 'outcome' ? state : { ...state, notice };
}

/** A whole quantity clamped to 0..returnable for that line (A4). */
export function setQuantity(state: FlowState, lineRef: string, quantity: number): FlowState {
  if (state.step !== 'select') return state;
  const line = state.sale.lines.find((l) => l.lineRef === lineRef);
  if (line === undefined) return state;
  const bounded = Math.min(Math.max(Math.trunc(quantity), 0), line.returnableQuantity);
  return { ...state, picked: { ...state.picked, [lineRef]: bounded }, notice: null };
}

/** The picked lines with a quantity of at least one, in sale-line order. */
export function pickedLines(sale: ReturnableSaleView, picked: Picked): ReturnLineInput[] {
  return sale.lines
    .map((l) => ({ lineRef: l.lineRef, quantity: picked[l.lineRef] ?? 0 }))
    .filter((l) => l.quantity > 0);
}

export function quoted(state: FlowState, quote: ReturnQuoteView): FlowState {
  if (state.step !== 'select') return state;
  return { ...state, step: 'summary', quote, notice: null };
}

/** Back to the picker: the quote is discarded (A5). */
export function editQuantities(state: FlowState): FlowState {
  if (state.step !== 'summary') return state;
  const { saleNumber, sale, picked } = state;
  return { step: 'select', saleNumber, sale, picked, notice: null };
}

export function settled(outcome: Outcome): FlowState {
  return { step: 'outcome', outcome };
}

/** Refusals that may be reported AFTER the send (the session/gate was lost). */
const MAY_FOLLOW_SEND: ReadonlySet<ReturnsRefusalReason> = new Set<ReturnsRefusalReason>([
  'session_changed',
  'offline',
  'no_session',
  'role_denied',
  'feature_disabled',
]);

/** O5: a refusal with no journaled return whose cause may postdate the send. */
export function mayBeRecorded(outcome: Outcome): boolean {
  if (outcome.kind !== 'refused' || outcome.ret !== null) return false;
  return MAY_FOLLOW_SEND.has(outcome.reason);
}

export function outcomeOf(res: ReturnsSubmitResponse): Outcome {
  if (res.kind === 'confirmed') return { kind: 'confirmed', ret: res.ret, replayed: res.replayed };
  if (res.kind === 'unconfirmed') {
    return { kind: 'unconfirmed', ret: res.ret, still: false, notice: null };
  }
  return { kind: 'refused', reason: res.reason, ret: res.ret };
}

/** U1: what the journal now says about a return whose answer was lost. */
export function reconcile(ret: ReturnJournalView, row: ReturnJournalView | undefined): Outcome {
  if (row?.state === 'confirmed' || row?.state === 'paid_out') {
    return { kind: 'confirmed', ret: row, replayed: false };
  }
  if (row?.state === 'refused' && row.refusalReason !== null) {
    return { kind: 'refused', reason: row.refusalReason, ret: row };
  }
  return { kind: 'unconfirmed', ret: row ?? ret, still: true, notice: null };
}

/**
 * Apply a "check again" result only while that same unconfirmed return is
 * still on screen: a new return started meanwhile is never undone.
 */
export function afterCheck(state: FlowState, returnId: string, next: Outcome): FlowState {
  if (state.step !== 'outcome' || state.outcome.kind !== 'unconfirmed') return state;
  return state.outcome.ret.returnId === returnId ? settled(next) : state;
}
