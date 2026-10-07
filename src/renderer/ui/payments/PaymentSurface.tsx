import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { useOperatorSessionStore } from '../../stores/operator-session-store.js';
import {
  usePaymentStore,
  type CancelHold,
  type CancelRecovery,
} from '../../stores/payment-store.js';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store.js';
import { OperatorBadge } from '../operator/OperatorBadge.js';
import { useScanOwner } from '../../scan/ScanGuardHost.js';
import { SCAN_SALE_COMPLETE_MESSAGE } from '../../scan/scan-messages.js';
import { useScanNoticeStore } from '../../scan/scan-notice-store.js';
import { formatCheckoutMoney } from './format-checkout-money.js';
import { TenderSelection, type TenderKind } from './TenderSelection.js';
import { PaymentCartSummary } from './PaymentCartSummary.js';
import { CashEntry } from './CashEntry.js';
import { CheckoutActionBar, FocusWhen, PrimarySlotContext } from './CheckoutActionBar.js';
import { ExternalCardTerminalEntry } from './ExternalCardTerminalEntry.js';
import { VoucherEntry } from './VoucherEntry.js';
import type { BackToSaleEligibility } from '../../sale/useCheckoutBackToSale.js';
import type {
  PaymentsBridgeAPI,
  PreloadBridgeAPI,
  SalesBridgeAPI,
  TenderBridgeAPI,
} from '../../../shared/bridge-api.js';
import type { PaymentAttemptRendererView } from '../../../shared/payments/types.js';

/**
 * 006-payments-tender S1 + S3d T152 — PaymentSurface.
 *
 * Route guard: returns null unless both a signed-in operator session and a
 * non-null payment envelope exist. This prevents the surface from mounting
 * in an inconsistent state.
 *
 * Modes:
 *   • Slice-1 (no bridge): renders TenderSelection + PaymentCartSummary +
 *     a "tender selected" status banner. No bridge calls. Backwards
 *     compatible with existing tests + Slice-1/Slice-2 callers.
 *   • S3d (bridge wired): when `_testBridge` (tests) or `window.api`
 *     (production) provides `payments` + `tender`, picking a tender
 *     triggers `payments.start`, mounts the entry component with the T151
 *     bridge wiring, and surfaces a "Confirm payment" button when at
 *     least one tender line is applied. Confirm click → `payments.confirm`.
 *     On settled, transitions to a placeholder per FR-031.
 *
 * SECURITY:
 *   - No sensitive IDs in DOM (FR-035).
 *   - No card data (PAN, CVV, cardholder name) of any kind.
 *   - No raw bridge reason strings displayed to cashier. Refusal copy is
 *     generic per FR-005 / FR-006B.
 *   - Manager identity never in cashier-visible UI.
 */

export interface PaymentSurfaceProps {
  /**
   * Test seam: injects payments + tender (+ optional sales) bridge in place of
   * `window.api`. The same injected-bridge pattern the Sale controllers use
   * (renderer/sale). When omitted in production, the surface reads from
   * `window.api.payments` + `window.api.tender` (+ `window.api.sales`) — the
   * typed preload bridge.
   */
  _testBridge?: {
    payments: PaymentsBridgeAPI;
    tender: TenderBridgeAPI;
    sales?: SalesBridgeAPI;
  };
  /**
   * Invoked when the cashier clicks "New sale" on the settled/completed
   * surface. The route owner (CheckoutRoute) wires this to reset the payment +
   * cart stores and navigate back to /app/cart — keeping PaymentSurface
   * Router-agnostic (mirrors the Sale screen's onContinue seam, so the
   * bare-render unit tests need no Router ancestor). Optional + guarded: when
   * omitted (tests / Slice-1), the button still renders and is a safe no-op.
   */
  onNewSale?: () => void;
  /**
   * RT-26 — Checkout Back / Esc to the same sale. Resolves `true` once main
   * returned the cart to the Sale (the route then leaves this surface), `false`
   * when main refused or the call failed (the cashier stays here). Optional:
   * without it no Back control renders and Esc does nothing (Slice-1 / bare
   * renders). The surface only DISABLES Back while it can see tender activity
   * or an operation in flight — main is the authority either way.
   */
  onBackToSale?: () => Promise<boolean>;
  /**
   * RT-26 — main's durable eligibility for this handoff
   * (`cart.returnToSaleEligibility`). Back is enabled only on `returnable`;
   * `unknown` (the default: not asked yet, or no answer) keeps it disabled, and
   * `blocked` shows the reason. Survives remounts, unlike component state.
   */
  backToSaleEligibility?: BackToSaleEligibility;
}

/** Shown when main refuses (or cannot be reached for) a Back. Generic, no reason. */
const BACK_REFUSED_COPY = 'تعذّر الرجوع إلى البيع. أكمل الدفع أو ألغِه.';

/** What the Back control may do right now (RT-26). Pure; main still decides. */
interface BackControl {
  /** The control is shown: wired, signed in, an envelope, not settled. */
  readonly offered: boolean;
  /** Tender was seen (projection, a reversing cancel, or main says blocked). */
  readonly tenderBlocked: boolean;
  /** Back / Esc may ask main now. */
  readonly enabled: boolean;
  /** Why Back is not available, as a catalog line (RT-240), or null when it is. */
  readonly reason: BackReason | null;
  /** Show the reason line under the header. */
  readonly showReason: boolean;
  /** `aria-disabled` for the control (mirrors `disabled`). */
  readonly ariaDisabled: 'true' | undefined;
}

interface BackControlInput {
  readonly wired: boolean;
  /** Signed in, an envelope mounted, and the surface is not settled. */
  readonly onOpenCheckout: boolean;
  readonly eligibility: BackToSaleEligibility;
  /** Tender lines in the current projection (any state); undefined = no attempt. */
  readonly projectedTenderLines: number | undefined;
  /** A payments.cancel in this mount reversed tender. */
  readonly tenderTouched: boolean;
  /**
   * That cancel PROVED the reversal (`cancelProvesReversal`): cash lines
   * came back reversed and none are still pending. Only this may say
   * «أُلغي المبلغ المسجَّل» (M-P2).
   */
  readonly tenderReversed: boolean;
  /**
   * RT-256 — a cancel in this Checkout reversed (or left pending) an
   * external-card line. Cancel cannot void the charge on the standalone
   * terminal (`manual_void_required`), so the cashier must void there before
   * any new charge (M-P13). Wins over every other reason, M-P1 included, for
   * the rest of this Checkout.
   */
  readonly cardVoidRequired: boolean;
  /** start / confirm / cancel / back in flight. */
  readonly busy: boolean;
  /**
   * A tender entry panel (cash / card / voucher) is open. Back is never offered
   * from inside it: Esc there closes only the panel, so a card already charged
   * on the standalone terminal cannot be walked away from in one keystroke.
   */
  readonly entryOpen: boolean;
}

/**
 * RT-240 — Back's reason, from the message catalog (15 §5), chosen by state so
 * it never claims more than is known (I-7):
 *   recorded   — money is on this attempt now (M-P1);
 *   reversed   — a cancel in this mount proved the reversal (M-P2, N-13);
 *   blocked    — Back is closed but nothing proves why: main's durable
 *                `blocked` (settled, force-failed, unresolved or refused
 *                tender, mismatched attempt) or a reversal still pending.
 *                Neutral wording: saying the amount was cancelled could
 *                invite a second charge;
 *   entry_open — an amount entry is open; Esc closes it first (M-P3);
 *   card_void  — a cancel in this mount reversed an external-card line locally;
 *                the charge may still stand on the terminal, so the line says
 *                to void it there before any new charge and never suggests
 *                completing or retrying the payment (RT-256, M-P13).
 */
type BackReason = 'recorded' | 'reversed' | 'blocked' | 'entry_open' | 'card_void';

const BACK_REASON_COPY: Readonly<Record<BackReason, string>> = {
  recorded: 'لا يمكن الرجوع إلى البيع بعد تسجيل مبلغ. أكمل الدفع أو ألغِه.',
  reversed: 'أُلغي المبلغ المسجَّل. اختر طريقة دفع أخرى أو ألغِ البيع.',
  blocked: BACK_REFUSED_COPY,
  entry_open: 'اضغط Esc لإغلاق إدخال المبلغ أولاً.',
  card_void: 'أُلغي الدفع هنا فقط. ألغِ العملية على جهاز البطاقات قبل أي خصم جديد.',
};

/**
 * A cancel proves the money went back only when every reversed line is cash and
 * nothing is still pending. Cancel reverses lines locally only: a card cannot
 * be voided on the terminal (`manual_void_required`), and a voucher's authority
 * reservation is not released (only tender.reverse calls vouchers.reverse). So
 * cash is the one tender whose reversal the cancel response actually confirms.
 */
const CANCEL_CONFIRMED_TENDERS: ReadonlySet<string> = new Set(['cash']);

function cancelProvesReversal(
  response: {
    readonly reversed_tender_line_ids: readonly string[];
    readonly reversal_pending_tender_line_ids: readonly string[];
  },
  lines: PaymentAttemptRendererView['tender_lines'],
): boolean {
  const reversed = response.reversed_tender_line_ids;
  if (reversed.length === 0 || response.reversal_pending_tender_line_ids.length > 0) return false;
  const typeById = new Map(lines.map((l) => [l.tender_line_id, l.tender_type]));
  return reversed.every((id) => CANCEL_CONFIRMED_TENDERS.has(typeById.get(id) ?? ''));
}

/**
 * RT-256 — the cancel touched an external-card line, which main cannot void on
 * the terminal. Card lines come from the projection AND from the card applies
 * seen in this Checkout: after a failed post-apply read the projection has no
 * card line yet, but the apply did happen in main (Codex P1 on #572).
 */
function cancelTouchedCard(
  response: {
    readonly reversed_tender_line_ids: readonly string[];
    readonly reversal_pending_tender_line_ids: readonly string[];
  },
  lines: PaymentAttemptRendererView['tender_lines'],
  appliedCardLineIds: ReadonlySet<string>,
): boolean {
  const cardIds = new Set(appliedCardLineIds);
  for (const l of lines) {
    if (l.tender_type === 'external_card_terminal') cardIds.add(l.tender_line_id);
  }
  const touched = [
    ...response.reversed_tender_line_ids,
    ...response.reversal_pending_tender_line_ids,
  ];
  return touched.some((id) => cardIds.has(id));
}

/**
 * RT-256 — a successful cancel needs the terminal-void warning when it touched
 * a card line, OR when a card apply was ATTEMPTED in this Checkout at all. The
 * terminal is standalone: the customer is charged there before the POS records
 * anything, so a card apply whose outcome never reached the renderer (lost
 * response, or a rejection before main persisted a line, leaving the cancel
 * with zero lines) may still stand as a charge (Codex P1 rounds on #572).
 */
function cancelNeedsTerminalVoid(
  response: Parameters<typeof cancelTouchedCard>[0],
  lines: PaymentAttemptRendererView['tender_lines'],
  card: { readonly appliedLineIds: ReadonlySet<string>; readonly attempted: boolean },
): boolean {
  return card.attempted || cancelTouchedCard(response, lines, card.appliedLineIds);
}

/** The reversal outcome of a cancel: main's response, or rebuilt from a read. */
interface CancelOutcome {
  readonly reversed_tender_line_ids: readonly string[];
  readonly reversal_pending_tender_line_ids: readonly string[];
}

/**
 * RT-298 — a cancelled attempt read back from main carries the same outcome the
 * lost cancel response would have: the lines it reversed (or left pending), LIFO
 * like the cancel handler's own replay.
 */
function cancelOutcomeFromRead(attempt: PaymentAttemptRendererView): CancelOutcome {
  const lifo = [...attempt.tender_lines].sort((a, b) => b.apply_order - a.apply_order);
  return {
    reversed_tender_line_ids: lifo
      .filter((l) => l.state === 'reversed')
      .map((l) => l.tender_line_id),
    reversal_pending_tender_line_ids: lifo
      .filter((l) => l.state === 'reversal_pending')
      .map((l) => l.tender_line_id),
  };
}

/**
 * RT-298 — cancel copy after an ambiguous outcome (UX-07: name the retry, and
 * never offer a retry that cannot succeed).
 *   failed     — main still holds the attempt open: Cancel again can work.
 *   unknown    — main could not be read: the cancel may have happened, so no new
 *                amount until Cancel again settles it (it replays the same key).
 *   not_open   — the attempt ended some other way: nothing left to cancel.
 *   live_tender — force-failed with live tender: no payment here, a manager
 *                reviews it.
 */
const CANCEL_FAILED_COPY = 'تعذّر إلغاء عملية الدفع. اضغط «إلغاء» للمحاولة مرة أخرى.';
const CANCEL_UNKNOWN_COPY =
  'تعذّر التأكد من إلغاء عملية الدفع. لا تسجّل أي مبلغ. اضغط «إلغاء» مرة أخرى للتحقق.';
const CANCEL_NOT_OPEN_COPY = 'لم تعد عملية الدفع هذه مفتوحة، فلا يمكن إلغاؤها.';
const CANCEL_LIVE_TENDER_COPY =
  'أوقف المدير عملية الدفع هذه وفيها مبالغ مسجّلة، فلا يمكن الدفع لهذا البيع الآن. اطلب من المدير مراجعتها.';

/** RT-298 — the line a cancel hold shows; it comes back with the hold on a remount. */
const CANCEL_HOLD_COPY: Readonly<Record<CancelHold, string | null>> = {
  none: null,
  // Seen only after a remount: this view never learns how that cancel ended.
  in_flight: CANCEL_UNKNOWN_COPY,
  unconfirmed: CANCEL_UNKNOWN_COPY,
  live_tender: CANCEL_LIVE_TENDER_COPY,
};

/** A kept attempt a remounted Checkout resumes instead of clearing. */
function isResumable(kept: string | undefined, hold: CancelHold): boolean {
  if (kept === 'started' || kept === 'settled') return true;
  return kept === 'force_failed' && hold === 'live_tender';
}

/** The phase a resumed attempt comes back in: an unconfirmed cancel reopens on its Cancel. */
function resumePhase(kept: string | undefined, hold: CancelHold): Phase {
  if (kept === 'settled') return 'settled';
  return hold === 'unconfirmed' || hold === 'in_flight' ? 'entry' : 'tender_selection';
}

/** RT-298 — the hold recorded for this handoff's current attempt, if any. */
function holdFor(
  recovery: CancelRecovery | null,
  handoffId: string | null,
  attemptId: string | null,
): CancelHold {
  if (recovery === null) return 'none';
  const current = recovery.handoffId === handoffId && recovery.attemptId === attemptId;
  return current ? recovery.hold : 'none';
}

/** Tender main still counts as live on a force-failed attempt (cart-payment-eligibility). */
const LIVE_TENDER_STATES: ReadonlySet<string> = new Set([
  'applying',
  'applied',
  'reversal_pending',
]);

function backReason(input: BackControlInput, tenderBlocked: boolean): BackReason | null {
  // M-P13 first: a new recorded tender must not replace the terminal-void
  // warning with «أكمل الدفع أو ألغِه» (Codex P1 on #572).
  if (input.cardVoidRequired) return 'card_void';
  if ((input.projectedTenderLines ?? 0) > 0) return 'recorded';
  if (input.tenderReversed) return 'reversed';
  if (tenderBlocked) return 'blocked';
  return input.entryOpen ? 'entry_open' : null;
}

/** Any sign of tender for this handoff: projected lines, a reversing cancel, or main. */
function isTenderBlocked(input: BackControlInput): boolean {
  if ((input.projectedTenderLines ?? 0) > 0 || input.tenderTouched) return true;
  return input.eligibility === 'blocked';
}

function deriveBackControl(input: BackControlInput): BackControl {
  const offered = input.wired && input.onOpenCheckout;
  const tenderBlocked = isTenderBlocked(input);
  const ready = input.eligibility === 'returnable' && !tenderBlocked;
  const enabled = offered && ready && !(input.busy || input.entryOpen);
  const reason = offered ? backReason(input, tenderBlocked) : null;
  return {
    offered,
    tenderBlocked,
    enabled,
    reason,
    showReason: reason !== null,
    ariaDisabled: enabled ? undefined : 'true',
  };
}

/** Checkout is open on a live envelope (signed in, envelope mounted, not settled). */
function isOpenCheckout(sessionKind: string, hasEnvelope: boolean, phase: Phase): boolean {
  if (sessionKind !== 'signedIn') return false;
  return hasEnvelope && phase !== 'settled';
}

/** A fresh Esc press no inner layer has already handled. */
function isEscapePress(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape') return false;
  return !event.defaultPrevented && !event.repeat;
}

/**
 * Runs `onEscape` for an Esc press while `enabled`, consuming the event
 * (preventDefault) so no other Esc handler acts on it. Re-subscribed every
 * render so the handler always sees current state. Used for the RT-24 layer
 * order: an open entry panel closes first; only then is Esc = Back.
 */
function useEscapeKey(enabled: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isEscapePress(event)) return;
      event.preventDefault();
      onEscape();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  });
}

/** RT-26 — Back to the same sale (Esc). Rendered only while offered. */
function BackToSaleButton(props: { back: BackControl; onBack: () => void }): JSX.Element | null {
  if (!props.back.offered) return null;
  return (
    <button
      type="button"
      className="btn btn--md btn--secondary payment-surface__back"
      data-testid="payment-surface-back"
      disabled={!props.back.enabled}
      aria-disabled={props.back.ariaDisabled}
      aria-keyshortcuts="Escape"
      onClick={props.onBack}
    >
      رجوع إلى البيع
      <kbd className="payment-surface__back-key" dir="ltr">
        Esc
      </kbd>
    </button>
  );
}

/** Why Back is disabled: money recorded, money reversed, or an entry is open. */
function BackBlockedReason(props: { back: BackControl }): JSX.Element | null {
  if (!props.back.showReason || props.back.reason === null) return null;
  return (
    <p
      className={
        props.back.reason === 'card_void'
          ? 'payment-surface__back-blocked payment-surface__back-blocked--danger'
          : 'payment-surface__back-blocked'
      }
      data-testid="payment-surface-back-blocked"
      data-tone={props.back.reason === 'card_void' ? 'danger' : 'info'}
      role="status"
    >
      {BACK_REASON_COPY[props.back.reason]}
    </p>
  );
}

type Phase = 'tender_selection' | 'entry' | 'settled';

/** RT-239 (M-S7): a scan on a completed sale starts nothing; it says what to do. */
function notifySaleComplete(): void {
  useScanNoticeStore.getState().show(SCAN_SALE_COMPLETE_MESSAGE);
}

/** Mounted only while the settled screen is on, so it owns scans exactly then. */
function SettledScanOwner(): null {
  useScanOwner(notifySaleComplete);
  return null;
}

interface ResolvedBridge {
  payments: PaymentsBridgeAPI;
  tender: TenderBridgeAPI;
  /**
   * The read-only sales bridge, used after settlement to poll the terminal's
   * most-recently-finalized sale (`subscribe({ topic: 'recent' })`) so the
   * completed surface can show the cashier-quotable sale number. Optional: the
   * surface degrades gracefully (completed state + New sale, no sale number)
   * when sales is absent — `payments.confirm` carries no sale id/number, and
   * the sale finalizes asynchronously in the main process.
   */
  sales?: SalesBridgeAPI;
}

/**
 * Resolve the payments + tender (+ sales) bridge. In tests the bridge is
 * supplied via the `_testBridge` prop; in production we read it from the typed
 * preload `window.api`. Returns null only when payments OR tender is absent
 * (e.g. happy-dom with no prop injection — Slice-1 fall-back) so the surface
 * can degrade gracefully. `sales` is optional and never gates resolution.
 */
function resolveBridge(testBridge: ResolvedBridge | undefined): ResolvedBridge | null {
  if (testBridge !== undefined) {
    return testBridge;
  }
  /* v8 ignore next 9 — only reachable in Electron; jsdom never sets window.api */
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (api === undefined || api.payments === undefined || api.tender === undefined) {
    return null;
  }
  // Spread `sales` only when present — `exactOptionalPropertyTypes` forbids
  // assigning an explicit `undefined` to the optional `sales?` property.
  return {
    payments: api.payments,
    tender: api.tender,
    ...(api.sales !== undefined ? { sales: api.sales } : {}),
  };
}

export function PaymentSurface({
  _testBridge,
  onNewSale,
  onBackToSale,
  backToSaleEligibility = 'unknown',
}: PaymentSurfaceProps = {}): JSX.Element | null {
  const sessionState = useOperatorSessionStore((s) => s.state);
  const envelope = usePaymentStore((s) => s.envelope);
  const paymentSlice = usePaymentStore((s) => s.paymentSlice);

  const [selectedTender, setSelectedTender] = useState<TenderKind | null>(null);
  const [phase, setPhase] = useState<Phase>('tender_selection');
  // RT-238: the pinned primary slot the entry components render their apply-commit into.
  const [primarySlot, setPrimarySlot] = useState<HTMLElement | null>(null);
  // RT-238 / I-9: when focus is moved onto the settle commit, a held or doubled
  // Enter from the apply that preceded it must not settle on its own.
  const commitFocusedAtRef = useRef(0);
  // RT-238 / Codex P1: after a successful apply the projection must be re-read
  // before anything else is offered. Until it is, the apply is not offered again
  // (a second press would record the whole amount a second time, as change).
  const [afterApply, setAfterApply] = useState<'idle' | 'reading' | 'failed'>('idle');

  // RT-238: the entry opens below the method tiles, inside the scrolling panes;
  // bring it into view so the cashier never has to hunt for the amount field.
  useEffect(() => {
    if (phase !== 'entry') return;
    const entry = document.querySelector('.payment-surface__entry');
    // jsdom has no layout and no scrollIntoView; the real window always does.
    if (entry !== null && 'scrollIntoView' in entry) entry.scrollIntoView({ block: 'nearest' });
  }, [phase]);
  const [bridgeRefusalCopy, setBridgeRefusalCopy] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState<boolean>(false);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  // RT-298 — the cancel key and any hold live in the payment store, so a
  // Checkout remount keeps both (Codex P2, #576). See `cancelHold` below.
  const cancelRecovery = usePaymentStore((s) => s.cancelRecovery);
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [reversalPending, setReversalPending] = useState<boolean>(false);
  // RT-26 — a Back is in flight, and whether this handoff ever had tender
  // (a payments.cancel that reversed lines clears the projection, but main
  // still refuses Back for that cart, so the control stays disabled).
  const [isReturning, setIsReturning] = useState<boolean>(false);
  const [tenderTouched, setTenderTouched] = useState<boolean>(false);
  const [tenderReversed, setTenderReversed] = useState<boolean>(false);
  // RT-256 — card facts for this handoff live in the payment store, so they
  // survive a Checkout remount and the attempt clear on cancel (Codex P1, #572).
  const cardSafety = usePaymentStore((s) => s.cardSafety);
  // 022 US4a (T011) — the sale id is NO LONGER retained.
  //
  // It existed to mount ReceiptPreview and to discriminate T013a's two settled
  // states. External review round 2 established that neither use is sound: the
  // `recent` row cannot be tied to THIS payment, so an id taken from it could
  // belong to a prior sale. Both the receipt (T017) and the completion claim
  // (T013a) are blocked on a correlating identifier, so holding the id would
  // be dead state inviting the same mistake again. Re-introduce it together
  // with the correlation key, not before.
  // `settled_at` is no longer retained: it existed solely to discriminate the
  // recent-sale poll's results, and that poll is gone (round-3 P1 above). It
  // returns with the correlating identifier, if the correlation ends up
  // needing it.
  // 008's finalize listener is gated on this flag. With it off no receipt is
  // ever written, so the completion surface must say so rather than imply a
  // document is on its way.
  const saleFinalizationFlag = useFeatureFlagsStore((s) => s.saleFinalization);
  // RT-103: vouchers are excluded from the pilot (RT-10 D2). Off (the default)
  // disables the voucher tile and refuses a voucher selection here as well.
  const voucherTenderFlag = useFeatureFlagsStore((s) => s.voucherTender);

  const bridge = resolveBridge(_testBridge);

  // paymentAttemptId is the source-of-truth from the paymentSlice projection
  // (set by payments.start → payments.read flow, or seeded by tests via
  // applyAttemptSnapshot). Keeping a single source avoids drift.
  const paymentAttemptId = paymentSlice?.payment_attempt_id ?? null;

  // Reset surface state when envelope or session context changes; otherwise a
  // stale "tender selected" status banner could carry across a new payment
  // attempt.
  const envelopeHandoffId = envelope?.handoff_action_id ?? null;
  // RT-298 — payment actions held closed after a cancel:
  //   unconfirmed  — main could not confirm the outcome (response and read both
  //                  lost); Cancel again resolves it, replaying the same key.
  //   live_tender  — the attempt was force-failed with live tender; main refuses
  //                  any new payment for this cart, so only a manager can move on.
  const cancelHold = holdFor(cancelRecovery, envelopeHandoffId, paymentAttemptId);
  useEffect(() => {
    setSelectedTender(null);
    setBridgeRefusalCopy(null);
    setIsConfirming(false);
    setIsCancelling(false);
    setIsStarting(false);
    setReversalPending(false);
    setIsReturning(false);
    setTenderTouched(false);
    setTenderReversed(false);
    setAfterApply('idle');
    // Resume a same-handoff attempt across a remount (leaving checkout and
    // coming back): a `started` one is still held by main, so forgetting it
    // would re-enable sign-out and make the next tender re-run payments.start,
    // which main refuses; a `settled` one must come back as the settled
    // screen, never as tender selection. A cancel hold comes back too (RT-298):
    // an unconfirmed cancel reopens on its Cancel with its line, and a
    // force-failed attempt with live tender stays held. Anything else (another
    // handoff, no session, or a terminal attempt with nothing to resume) is
    // cleared.
    const store = usePaymentStore.getState();
    const kept = store.paymentSlice?.state;
    const hold = holdFor(
      store.cancelRecovery,
      envelopeHandoffId,
      store.paymentSlice?.payment_attempt_id ?? null,
    );
    const resumable =
      sessionState.kind === 'signedIn' &&
      store.attemptHandoffId === envelopeHandoffId &&
      isResumable(kept, hold);
    if (!resumable) store.clearAttempt();
    setPhase(resumable ? resumePhase(kept, hold) : 'tender_selection');
    setBridgeRefusalCopy(resumable ? CANCEL_HOLD_COPY[hold] : null);
  }, [sessionState.kind, envelopeHandoffId]);

  // EXTERNAL REVIEW P1 (round 3) — "Stop polling until finalized sales can be
  // correlated". The recent-sale poll is REMOVED, not merely capped.
  //
  // Round 2 replaced a 10-attempt cap with a backoff that kept watching for the
  // life of the settled surface. That fixed "late finalization is never seen"
  // and, in doing so, widened the miscorrelation window from a bounded ~2s to
  // UNBOUNDED: any prior sale finalizing at any later point satisfies
  // `finalized_at >= settled_at` and would be adopted as this sale's number.
  //
  // The number rested on exactly the evidence that already disqualified the
  // receipt (T017) and the completion claim (T013a) — a terminal-wide row with
  // no tie to this payment. It survived earlier rounds only on "no worse than
  // `main`", and the uncapped poll made that false: `main` was bounded.
  //
  // So the surface shows no sale number, and nothing polls for one. This is a
  // DELIBERATE REDUCTION below `main` (it contradicts 006 invariant 13, which
  // asserts the number displays) accepted on safety grounds: a wrong
  // cashier-quotable reference is worse than none. It returns with the
  // correlating identifier, alongside T013a and T017.

  // RT-256 — M-P13 for this handoff: sticky for the rest of the Checkout,
  // including Completion after another tender settles (Codex P1, #572).
  const cardVoidRequired =
    cardSafety !== null && cardSafety.voidRequired && cardSafety.handoffId === envelopeHandoffId;

  // RT-26 — Back is offered before any tender (see deriveBackControl).
  const back = deriveBackControl({
    wired: onBackToSale !== undefined,
    onOpenCheckout: isOpenCheckout(sessionState.kind, envelope !== null, phase),
    eligibility: backToSaleEligibility,
    projectedTenderLines: paymentSlice?.tender_lines.length,
    tenderTouched,
    cardVoidRequired,
    tenderReversed,
    busy: [isStarting, isConfirming, isCancelling, cancelHold !== 'none', isReturning].some(
      Boolean,
    ),
    entryOpen: phase === 'entry',
  });

  async function handleBackToSale(): Promise<void> {
    if (!back.enabled || onBackToSale === undefined) return;
    setBridgeRefusalCopy(null);
    setIsReturning(true);
    const returned = await onBackToSale().catch(() => false);
    // On success the route leaves this surface; only a refusal stays here.
    if (!returned) {
      setIsReturning(false);
      setBridgeRefusalCopy(BACK_REFUSED_COPY);
    }
  }

  // Esc closes an open entry panel (only the panel: the attempt and any
  // recorded tender are untouched, and Back stays a separate, second action).
  // RT-298: nothing new is recorded or settled while a cancel is in flight or
  // its outcome is unconfirmed; main is read first. Esc must not close the
  // panel either: Cancel lives there and is the named way out (Codex P2, #576).
  const cancelOpen = isCancelling || cancelHold !== 'none';
  useEscapeKey(phase === 'entry' && !cancelOpen, () => {
    setSelectedTender(null);
    setPhase('tender_selection');
  });
  useEscapeKey(back.enabled, () => {
    void handleBackToSale();
  });

  if (sessionState.kind !== 'signedIn' || envelope === null) {
    return null;
  }

  const { display_name, role } = sessionState.session;

  async function handleTenderSelect(tender: TenderKind): Promise<void> {
    // Defence in depth behind the disabled tile: never start or select a
    // voucher payment while the pilot restriction is active.
    if (tender === 'internal_voucher' && !voucherTenderFlag) return;
    // RT-298: no tender while a cancel hold stands (outcome unknown, or main
    // refuses every payment for this cart until a manager acts). Its line stays.
    if (cancelHold !== 'none') return;
    setSelectedTender(tender);
    setBridgeRefusalCopy(null);

    if (bridge === null || envelope === null) {
      // Slice-1 behaviour: status banner only.
      return;
    }

    // Split-tender path: an attempt is already started (paymentSlice holds the
    // attempt id from a prior payments.start). Calling payments.start again
    // would be refused with `attempt_already_started_on_terminal`. Skip
    // straight to mounting the new entry component for the remaining balance.
    if (paymentAttemptId !== null) {
      setPhase('entry');
      return;
    }

    // CR-9 guard: rapid-double clicks before the first start/read cycle
    // completes would otherwise fire payments.start multiple times in
    // parallel. paymentAttemptId only updates after the read response lands.
    if (isStarting) {
      return;
    }

    setIsStarting(true);
    try {
      const startResponse = await bridge.payments.start({
        envelope_handoff_action_id: envelope.handoff_action_id,
        envelope_cart_id: envelope.cart_id,
        envelope_subtotal_minor: envelope.subtotal_minor,
        envelope_version: 'v1',
        idempotency_key: crypto.randomUUID(),
      });

      if (startResponse.kind === 'refused') {
        setBridgeRefusalCopy('تعذّر بدء عملية الدفع. يرجى المحاولة مرة أخرى.');
        return;
      }

      setPhase('entry');
      setAfterApply('idle');

      // Main now holds a started attempt: record it at once, so an open
      // payment is known (and V5 sign-out blocked) even if the read below is
      // slow or fails. The read then replaces this with main's snapshot.
      usePaymentStore.getState().applyAttemptSnapshot({
        payment_attempt_id: startResponse.payment_attempt_id,
        state: 'started',
        envelope_subtotal_minor: envelope.subtotal_minor,
        started_at: new Date().toISOString(),
        tender_lines: [],
      });

      // Seed the paymentSlice with an initial read so the surface can react to
      // applied lines as they land. This also populates the paymentAttemptId
      // derivation above.
      const readResponse = await bridge.payments.read({
        payment_attempt_id: startResponse.payment_attempt_id,
      });
      if (readResponse.kind === 'ok') {
        usePaymentStore.getState().applyAttemptSnapshot(readResponse.payment_attempt);
      }
    } catch {
      // Bridge rejection (network / IPC layer error). Treat as a generic
      // refusal — no structured reason crosses into the DOM (FR-005 / FR-017).
      setBridgeRefusalCopy('تعذّر بدء عملية الدفع. يرجى المحاولة مرة أخرى.');
    } finally {
      setIsStarting(false);
    }
  }

  /** A read is idempotent: a transient IPC failure is retried before giving up. */
  const READ_ATTEMPTS = 3;

  async function readAttemptWithRetry(
    attemptId: string,
  ): Promise<PaymentAttemptRendererView | null> {
    if (bridge === null) return null;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
      try {
        const readResponse = await bridge.payments.read({ payment_attempt_id: attemptId });
        if (readResponse.kind === 'ok') return readResponse.payment_attempt;
        return null;
      } catch {
        // Retry: the line itself was applied in main; only the read failed.
      }
    }
    return null;
  }

  /**
   * The payment context a read was started for is still the current one. A
   * cancel (or a new sale) can clear it while the read is in flight; main then
   * answers with the now-terminal attempt, which must not be written back.
   */
  function isStillCurrent(attemptId: string, envelopeAtStart: unknown): boolean {
    const store = usePaymentStore.getState();
    return (
      store.envelope === envelopeAtStart && store.paymentSlice?.payment_attempt_id === attemptId
    );
  }

  /**
   * RT-298 — the attempt a cancel was sent for is still this sale's current
   * one. Keyed on ids, not the envelope object, so the answer of a cancel sent
   * before a Checkout remount still lands on the same attempt.
   */
  function isCancelStillCurrent(attemptId: string, handoffId: string): boolean {
    const store = usePaymentStore.getState();
    return (
      store.envelope?.handoff_action_id === handoffId &&
      store.paymentSlice?.payment_attempt_id === attemptId
    );
  }

  async function handleLineApplied(): Promise<void> {
    if (bridge === null || paymentAttemptId === null || envelope === null) {
      return;
    }
    const attemptId = paymentAttemptId;
    const envelopeAtStart = usePaymentStore.getState().envelope;
    setAfterApply('reading');
    const attempt = await readAttemptWithRetry(attemptId);
    if (!isStillCurrent(attemptId, envelopeAtStart)) return;
    if (attempt === null) {
      // The apply succeeded in main but its state could not be read. Keep the
      // apply out of reach and offer a retry instead.
      setAfterApply('failed');
      return;
    }
    usePaymentStore.getState().applyAttemptSnapshot(attempt);
    setAfterApply('idle');
    // Split-tender (T154): if the running sum is still below the subtotal,
    // return to tender selection so the cashier may add another line. When
    // the sum equals the subtotal, the surface stays put and the confirm
    // button becomes visible. The settlement invariant itself is enforced
    // on the main process at payments.confirm time.
    // CR-11: guard every accumulator step with Number.isSafeInteger
    // (Constitution §II). A malformed minor value silently produces a
    // float-tainted running sum without this check.
    let sumApplied = 0;
    for (const line of attempt.tender_lines) {
      if (line.state !== 'applied') continue;
      if (!Number.isSafeInteger(line.amount_applied_minor)) continue;
      sumApplied += line.amount_applied_minor;
      if (!Number.isSafeInteger(sumApplied)) {
        // Running sum overflowed — bail out without changing the phase.
        return;
      }
    }
    if (sumApplied < envelope.subtotal_minor) {
      setSelectedTender(null);
      setPhase('tender_selection');
    }
  }

  /**
   * RT-238: the settle commit is blocked while the projection says money is
   * owed. If that projection is stale (a failed read after a successful apply),
   * the cashier must not be stuck: a click on the blocked commit re-reads the
   * attempt from main, and an up-to-date projection unblocks it.
   */
  async function rereadAttempt(): Promise<void> {
    if (bridge === null || paymentAttemptId === null) return;
    const attemptId = paymentAttemptId;
    const envelopeAtStart = usePaymentStore.getState().envelope;
    try {
      const readResponse = await bridge.payments.read({ payment_attempt_id: attemptId });
      if (!isStillCurrent(attemptId, envelopeAtStart)) return;
      if (readResponse.kind === 'ok') {
        usePaymentStore.getState().applyAttemptSnapshot(readResponse.payment_attempt);
      }
    } catch {
      // Keep the current projection; the next click retries.
    }
  }

  /** A held or doubled Enter right after focus moved here is not a decision to settle. */
  const COMMIT_ARM_MS = 400;

  /**
   * I-9 duplicate-submit: the Enter that applied the cash can repeat (key held)
   * or be tapped twice, and focus has just moved onto the settle commit. Swallow
   * an Enter that is a key repeat or arrives inside the arm window. Pointer and
   * programmatic clicks are not affected.
   */
  function guardCommitKey(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const tooSoon = Date.now() - commitFocusedAtRef.current < COMMIT_ARM_MS;
    if (event.repeat || tooSoon) event.preventDefault();
  }

  function handleCommitClick(payable: boolean): void {
    if (payable) void handleConfirm();
    else void rereadAttempt();
  }

  /** M-P13 when a card line was touched or a card apply was attempted. Sticky for this handoff. */
  function flagTerminalVoid(
    outcome: CancelOutcome,
    lines: PaymentAttemptRendererView['tender_lines'],
  ): void {
    const store = usePaymentStore.getState();
    const card = {
      appliedLineIds: new Set(store.cardSafety?.appliedCardLineIds ?? []),
      attempted: store.cardSafety?.cardApplyAttempted ?? false,
    };
    if (cancelNeedsTerminalVoid(outcome, lines, card)) store.markCardVoidRequired();
  }

  /**
   * Main cancelled the attempt. `lines` classify the reversed ids: the
   * projection for a cancel response, main's own lines for a read-back.
   */
  function applyCancelOutcome(
    outcome: CancelOutcome,
    lines: PaymentAttemptRendererView['tender_lines'],
  ): void {
    setReversalPending(outcome.reversal_pending_tender_line_ids.length > 0);
    if (
      outcome.reversed_tender_line_ids.length > 0 ||
      outcome.reversal_pending_tender_line_ids.length > 0
    ) {
      setTenderTouched(true);
    }
    setTenderReversed(cancelProvesReversal(outcome, lines));
    flagTerminalVoid(outcome, lines);
    usePaymentStore.getState().clearCancelRecovery();
    setSelectedTender(null);
    setPhase('tender_selection');
    // The attempt is gone, and with it any pending or failed post-apply read.
    setAfterApply('idle');
    usePaymentStore.getState().clearAttempt();
  }

  /**
   * RT-298 — the cancel threw or was refused, but main may still have committed
   * it (the FSM commits before the audits, so a late failure loses the
   * response). Read the attempt before re-opening any payment action, and act
   * on main's durable state rather than on the lost answer.
   */
  async function reconcileAfterCancel(attemptId: string, handoffId: string): Promise<void> {
    const attempt = await readAttemptWithRetry(attemptId);
    if (!isCancelStillCurrent(attemptId, handoffId)) return;
    if (attempt === null) {
      usePaymentStore.getState().setCancelHold('unconfirmed');
      setBridgeRefusalCopy(CANCEL_UNKNOWN_COPY);
      return;
    }
    if (attempt.state === 'cancelled') {
      applyCancelOutcome(cancelOutcomeFromRead(attempt), attempt.tender_lines);
      return;
    }
    usePaymentStore.getState().setCancelHold('none');
    if (attempt.state === 'started') {
      usePaymentStore.getState().applyAttemptSnapshot(attempt);
      setBridgeRefusalCopy(CANCEL_FAILED_COPY);
      return;
    }
    setBridgeRefusalCopy(CANCEL_NOT_OPEN_COPY);
    // As on a remount of the same handoff: settled comes back as the settled
    // screen; any other ended attempt is dropped, so the next tender starts anew.
    if (attempt.state === 'settled') {
      usePaymentStore.getState().applyAttemptSnapshot(attempt);
      setPhase('settled');
      return;
    }
    const live = attempt.tender_lines.filter((l) => LIVE_TENDER_STATES.has(l.state));
    if (attempt.state === 'force_failed' && live.length > 0) {
      holdForceFailedLiveTender(attempt, live);
      return;
    }
    leaveEndedAttempt(attempt);
  }

  /**
   * Codex P1 on #576 — force-fail does not reverse tender, and main refuses any
   * new payments.start for a cart whose force-failed attempt still holds live
   * tender. Keep the attempt visible and every payment action closed rather than
   * offering a start main will refuse; a card among the live lines may still
   * stand on the terminal (M-P13).
   */
  function holdForceFailedLiveTender(
    attempt: PaymentAttemptRendererView,
    live: PaymentAttemptRendererView['tender_lines'],
  ): void {
    flagTerminalVoid(
      {
        reversed_tender_line_ids: live.map((l) => l.tender_line_id),
        reversal_pending_tender_line_ids: [],
      },
      attempt.tender_lines,
    );
    usePaymentStore.getState().applyAttemptSnapshot(attempt);
    usePaymentStore.getState().setCancelHold('live_tender');
    setBridgeRefusalCopy(CANCEL_LIVE_TENDER_COPY);
    setSelectedTender(null);
    setPhase('tender_selection');
  }

  /**
   * The attempt ended without this cancel (failed / force-failed). Nothing was
   * reversed here, so a card the customer may have been charged for still
   * needs the terminal void before any new charge (M-P13).
   */
  function leaveEndedAttempt(attempt: PaymentAttemptRendererView): void {
    const lineIds = attempt.tender_lines.map((l) => l.tender_line_id);
    flagTerminalVoid(
      { reversed_tender_line_ids: lineIds, reversal_pending_tender_line_ids: [] },
      attempt.tender_lines,
    );
    usePaymentStore.getState().clearCancelRecovery();
    setSelectedTender(null);
    setPhase('tender_selection');
    setAfterApply('idle');
    usePaymentStore.getState().clearAttempt();
  }

  async function handleCancel(): Promise<void> {
    if (bridge === null || paymentAttemptId === null || envelope === null) {
      return;
    }
    const attemptId = paymentAttemptId;
    const handoffId = envelope.handoff_action_id;
    setBridgeRefusalCopy(null);
    setIsCancelling(true);
    const store = usePaymentStore.getState();
    const key = store.cancelKeyFor(attemptId);
    // Held from the moment it is sent: leaving and re-entering Checkout before
    // main answers must not reopen payment actions (Codex P2, #576).
    store.setCancelHold('in_flight');
    try {
      const response = await bridge.payments
        .cancel({ payment_attempt_id: attemptId, idempotency_key: key })
        .catch(() => null);
      // A late answer (a retry after a remount already settled this cancel,
      // and another attempt may have begun) must not touch that newer attempt
      // (Codex P1, #576).
      if (!isCancelStillCurrent(attemptId, handoffId)) return;
      if (response?.kind === 'ok') {
        const linesAtCancel = usePaymentStore.getState().paymentSlice?.tender_lines ?? [];
        applyCancelOutcome(response, linesAtCancel);
      } else {
        await reconcileAfterCancel(attemptId, handoffId);
      }
    } finally {
      setIsCancelling(false);
    }
  }

  // 023 V5 sale lifecycle — the settled phase above is component state and
  // dies with this surface, so the payment projection must carry the settle
  // for a Sale screen reopened later to recognise the sale as paid.
  // The confirm `ok` is main's authoritative settle: record it at once so a
  // failed follow-up read can never leave the sale payable again. The re-read
  // then only refines the projection, and is discarded if the payment context
  // moved on (New sale / another envelope) while it was in flight.
  function recordSettledFromConfirm(attemptId: string, settledAt: string): void {
    const store = usePaymentStore.getState();
    const slice = store.paymentSlice;
    if (slice?.payment_attempt_id !== attemptId) return;
    store.applyAttemptSnapshot({ ...slice, state: 'settled', settled_at: settledAt });
  }

  async function refineSettledAttempt(attemptId: string): Promise<void> {
    if (bridge === null) return;
    const envelopeAtConfirm = usePaymentStore.getState().envelope;
    try {
      const readResponse = await bridge.payments.read({ payment_attempt_id: attemptId });
      const store = usePaymentStore.getState();
      const sameContext =
        store.envelope === envelopeAtConfirm &&
        store.paymentSlice?.payment_attempt_id === attemptId;
      if (
        readResponse.kind === 'ok' &&
        sameContext &&
        readResponse.payment_attempt.payment_attempt_id === attemptId
      ) {
        store.applyAttemptSnapshot(readResponse.payment_attempt);
      }
    } catch {
      // Keep the settle already recorded from the confirm response.
    }
  }

  async function handleConfirm(): Promise<void> {
    if (bridge === null || paymentAttemptId === null) {
      return;
    }
    setBridgeRefusalCopy(null);
    setIsConfirming(true);
    try {
      const response = await bridge.payments.confirm({
        payment_attempt_id: paymentAttemptId,
        idempotency_key: crypto.randomUUID(),
      });
      if (response.kind === 'ok') {
        setPhase('settled');
        recordSettledFromConfirm(paymentAttemptId, response.settled_at);
        void refineSettledAttempt(paymentAttemptId);
      } else {
        setBridgeRefusalCopy('تعذّر إتمام عملية الدفع. يرجى المحاولة مرة أخرى.');
      }
    } catch {
      setBridgeRefusalCopy('تعذّر إتمام عملية الدفع. يرجى المحاولة مرة أخرى.');
    } finally {
      setIsConfirming(false);
    }
  }

  const appliedLines = (paymentSlice?.tender_lines ?? []).filter((l) => l.state === 'applied');
  const hasAppliedLine = appliedLines.length > 0;
  // Split-tender remaining-balance derivation (T154). Pass to entry components
  // so each successive line is scoped to what's still owed, not the full
  // subtotal.
  // CR-11: skip any line whose amount_applied_minor isn't a safe integer
  // (Constitution §II). The main-process projection should always emit safe
  // integers; this is the renderer-side belt to that braces.
  let sumAppliedMinor = 0;
  for (const line of appliedLines) {
    if (!Number.isSafeInteger(line.amount_applied_minor)) continue;
    sumAppliedMinor += line.amount_applied_minor;
  }
  const remainingBalanceMinor = Number.isSafeInteger(sumAppliedMinor)
    ? Math.max(envelope.subtotal_minor - sumAppliedMinor, 0)
    : 0;

  // RT-237 — the change to hand back is main's `change_due_minor` on the
  // applied lines, never recomputed here. Shown after apply (CashEntry) and on
  // completion; unsafe values are skipped like the amount accumulator above.
  let appliedChangeDueMinor = 0;
  for (const line of appliedLines) {
    const change = line.change_due_minor;
    if (change === undefined || !Number.isSafeInteger(change) || change <= 0) continue;
    appliedChangeDueMinor += change;
  }
  if (!Number.isSafeInteger(appliedChangeDueMinor)) {
    appliedChangeDueMinor = 0;
  }

  // RT-238: exactly one control owns the primary slot at a time. While an entry
  // is open and money is still owed, that is the entry's own apply-commit; the
  // settle commit cannot proceed yet, so it waits out of the slot.
  const fullyTendered = hasAppliedLine && remainingBalanceMinor === 0;
  // While a post-apply read is pending or failed, nobody gets an apply or a settle:
  // the projection is not trustworthy until main has been read again.
  const entryOwnsPrimary = phase === 'entry' && remainingBalanceMinor > 0 && afterApply === 'idle';
  const showSettle = hasAppliedLine && !entryOwnsPrimary && afterApply === 'idle' && !cancelOpen;

  // Refusals and hints stay next to the commit, in the pinned bar. With no bridge
  // (Slice-1 mode) there is no bar, so they render in the surface as before.
  const notices = (
    <>
      {/* Slice-4 voucher path: hint shown when reversal_pending_tender_line_ids
                  was non-empty in the most recent cancel response. Copy is fixed (no
                  id interpolation) per FR-017 / token minimisation. */}
      {reversalPending && (
        <div
          className="payment-surface__reversal-pending-hint"
          data-testid="payment-surface-reversal-pending-hint"
          role="status"
          aria-live="polite"
        >
          هناك عمليات عكس قيد المعالجة وستتم قريباً.
        </div>
      )}
      {bridgeRefusalCopy !== null && (
        <div
          className="payment-surface__bridge-refusal"
          data-testid="payment-surface-bridge-refusal"
          role="status"
          aria-live="polite"
        >
          {bridgeRefusalCopy}
        </div>
      )}
    </>
  );

  if (phase === 'settled') {
    // 022 US4a — NFR-6 / P2, as REVISED by external review round 2.
    //
    // The original design split this phase in two: "payment taken, sale not
    // yet finalized" vs "sale finalized". That split required knowing the
    // finalized record belongs to THIS payment — and the terminal cannot know
    // that. `RecentSaleSummary` carries no attempt/handoff identifier and
    // `payments.confirm` returns only `settled_at`, so `finalized_at >=
    // settled_at` is the only available test and a PRIOR sale finalizing late
    // satisfies it.
    //
    // Round 1 dropped the receipt but kept the "sale complete" headline on
    // that same evidence — fixing the symptom while keeping the assertion.
    // So the states collapse to the ONE the terminal can actually support:
    // the payment was taken. No sale number or receipt is shown without a
    // correlation key tying the finalized sale to this attempt.
    //
    // T013a and T017 are both unticked, blocked on the same backend gap: an
    // identifier on the `recent` projection tying the finalized sale to this
    // payment. 011 already derives one from `envelope_handoff_action_id`.

    return (
      <section
        className="v4-screen payment-surface--settled"
        data-testid="payment-surface"
        aria-label="الدفع"
      >
        <header className="v4-screen__header">
          <h1 className="v4-screen__title">الدفع</h1>
          <OperatorBadge display_name={display_name} role={role} />
        </header>

        {/* `payment-surface-settled` is the STABLE marker for "the settled
            phase is on screen" — the contract existing tests assert (006
            FR-031, invariant 14's never-stuck check, and the cart→checkout
            integration walk). 022 US4a splits what is *inside* it into the two
            truthful states below; the wrapper's meaning is unchanged, so those
            tests keep passing unmodified. */}
        <SettledScanOwner />
        {cardVoidRequired && (
          <p
            className="payment-surface__back-blocked payment-surface__back-blocked--danger"
            data-testid="payment-surface-settled-card-void"
            data-tone="danger"
            role="status"
          >
            {BACK_REASON_COPY.card_void}
          </p>
        )}
        <div className="v4-panel payment-surface__settled" data-testid="payment-surface-settled">
          {/* EXTERNAL REVIEW P1 (round 2) — "Require correlation before
              declaring the current sale complete".
              
              Round 1 removed the receipt but LEFT an `isFinalized` branch that
              rendered "تم إتمام البيع" (the sale is complete) from the SAME
              uncorrelated `recent` row. That fixed the symptom and kept the
              assertion: a prior sale finalizing late still promoted an
              unrelated record into proof that THIS sale completed.

              The terminal cannot establish that correlation — `recent` carries
              no attempt/handoff identifier and `confirm` returns only
              `settled_at` — so it must not claim completion at all. The two
              truthful states of T013a collapse into the one the terminal can
              actually support: the payment was taken.

              Unblocks with T017, on the same backend identifier. */}
          <div
            className="v4-stack payment-surface__settled-pending"
            data-testid="payment-surface-settled-pending"
            // role="status", never "alert" — a truthful terminal state, not an
            // error and not a failure.
            role="status"
            aria-live="polite"
          >
            <span className="payment-surface__settled-mark" aria-hidden="true">
              ✓
            </span>
            <p className="payment-surface__settled-headline">تم استلام المبلغ</p>
            {/* The flag governs what can be said about the RECEIPT only.
                ON: 008's listener may write one, but the worker also starts
                only for a terminal paired at boot (src/main/index.ts:1120-1126),
                so we say no receipt has issued YET rather than promising one is
                underway — true whether it arrives shortly or next launch, since
                the startup recovery scan re-fires settled-but-unfinalized rows.
                OFF: the whole 008 stack is unregistered (:441, :983), so no
                receipt will ever exist and the copy says exactly that. */}
            <p className="payment-surface__settled-detail">
              {saleFinalizationFlag
                ? 'تم تسجيل المبلغ. لم يصدر إيصال بعد.'
                : 'لن يُسجَّل هذا البيع ولا يوجد إيصال له.'}
            </p>
            {/* FR-16: the settled amount is the dominant numeric element.
                dir="ltr" isolates the numeral run inside RTL copy (FR-21). */}
            <p
              className="payment-surface__settled-amount"
              data-testid="payment-surface-settled-amount"
              dir="ltr"
            >
              {formatCheckoutMoney(envelope.subtotal_minor)}
            </p>
            {/* RT-237 (M-P5 / M-C1) — the change to hand back, as main
                computed it at apply time. Absent for exact cash and for
                non-cash sales: no change line rather than a 0.00 one. */}
            {appliedChangeDueMinor > 0 && (
              <p
                className="payment-surface__settled-change"
                data-testid="payment-surface-settled-change"
              >
                الباقي للعميل <span dir="ltr">{formatCheckoutMoney(appliedChangeDueMinor)}</span>
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          className="btn btn--lg btn--primary payment-surface__new-sale"
          data-testid="payment-surface-new-sale"
          onClick={() => {
            // Routing + store reset is delegated to the route owner so this
            // component stays Router-agnostic. Guarded — a missing handler is
            // a safe no-op (Slice-1 / bare-render tests).
            onNewSale?.();
          }}
        >
          بيع جديد
        </button>
      </section>
    );
  }

  return (
    <PrimarySlotContext.Provider value={{ node: primarySlot, entryOwnsPrimary }}>
      <section className="payment-surface" data-testid="payment-surface" aria-label="الدفع">
        <header className="payment-surface__header">
          <h1 className="payment-surface__title">الدفع</h1>
          {/* RT-26 — Back to the same sale (Esc). Disabled, with the reason
            below, once tender exists; main refuses it in that case too. */}
          <BackToSaleButton
            back={back}
            onBack={() => {
              void handleBackToSale();
            }}
          />
          <OperatorBadge display_name={display_name} role={role} />
        </header>

        <BackBlockedReason back={back} />

        {/*
        022 US3 T070 — three-column composition.

        DOM ORDER IS AMOUNT → METHODS → SUMMARY, and that is load-bearing, not
        incidental. Tab order follows DOM order; neither CSS placement nor
        `dir="rtl"` reorders it. The design handoff's own README orders page
        shells left-to-right in source (summary → methods → amount), which would
        send keyboard focus to the centre methods column before the visually
        preceding amount panel — violating spec FR-23 ("Keyboard focus traversal
        order MUST follow the RTL visual order"). The prototype had no keyboard
        requirement; this product does, so the source order is RTL here and the
        stylesheet does not re-order it.

        The 1024–1279px reflow (amount panel drops below the methods) is a media
        query on `.payment-surface__body`, NOT a `useViewportTier` branch — the
        hook debounces tier changes by 100ms while CSS applies instantly, so a
        React-gated reflow would leave ~100ms of broken layout on every
        crossing. Same reasoning as the `.sale-layout` / `.tender-method-grid`
        narrow rules, which #450/#451 documented as NOT dead CSS.
      */}
        <div className="payment-surface__body" data-testid="payment-surface-body">
          <section className="payment-surface__amount" aria-label="المبلغ المستحق">
            <span
              className="payment-surface__amount-label"
              data-testid="payment-surface-amount-label"
            >
              المبلغ المستحق
            </span>
            <span
              className="payment-surface__amount-value"
              data-testid="payment-surface-amount-due"
              dir="ltr"
            >
              {formatCheckoutMoney(remainingBalanceMinor)}
            </span>
          </section>

          <div className="payment-surface__panes">
            <div className="payment-surface__methods">
              <TenderSelection
                envelope={envelope}
                selectedTender={selectedTender}
                voucherEnabled={voucherTenderFlag}
                onTenderSelect={(tender) => {
                  void handleTenderSelect(tender);
                }}
              />

              {/* S3d mode: entry component for the selected tender. */}
              {bridge !== null && phase === 'entry' && paymentAttemptId !== null && !cancelOpen && (
                <div className="payment-surface__entry" data-testid="payment-surface-entry">
                  {selectedTender === 'cash' && (
                    <CashEntry
                      remainingBalanceMinor={remainingBalanceMinor}
                      paymentAttemptId={paymentAttemptId}
                      tenderApply={(req) => bridge.tender.apply(req)}
                      appliedChangeDueMinor={appliedChangeDueMinor}
                      onApplied={() => {
                        void handleLineApplied();
                      }}
                    />
                  )}
                  {selectedTender === 'external_card_terminal' && (
                    <ExternalCardTerminalEntry
                      remainingBalanceMinor={remainingBalanceMinor}
                      paymentAttemptId={paymentAttemptId}
                      tenderApply={(req) => {
                        // Recorded before the call: if main commits but the
                        // response is lost, a later cancel still warns (RT-256).
                        usePaymentStore.getState().recordCardApplyAttempted();
                        return bridge.tender.apply(req);
                      }}
                      onApplied={(response) => {
                        usePaymentStore.getState().recordCardApplied(response.tender_line_id);
                        void handleLineApplied();
                      }}
                    />
                  )}
                  {selectedTender === 'internal_voucher' && voucherTenderFlag && (
                    <VoucherEntry
                      remainingBalanceMinor={remainingBalanceMinor}
                      paymentAttemptId={paymentAttemptId}
                      tenderApply={(req) => bridge.tender.apply(req)}
                      onApplied={() => {
                        void handleLineApplied();
                      }}
                    />
                  )}
                </div>
              )}
            </div>

            <div className="payment-surface__summary">
              <PaymentCartSummary envelope={envelope} />
            </div>
          </div>
        </div>

        {/* Slice-1 mode: status banner only (no bridge wiring). */}
        {bridge === null && selectedTender !== null && (
          <div
            className="payment-surface__tender-selected"
            data-testid="payment-surface-tender-selected"
            role="status"
            aria-live="polite"
          >
            {selectedTender === 'cash'
              ? 'تم اختيار النقد'
              : selectedTender === 'external_card_terminal'
                ? 'تم اختيار جهاز الشبكة'
                : 'تم اختيار القسيمة'}
          </div>
        )}

        {/*
        RT-238 — the pinned action bar (15 §4 A2). Cancel lives at inline-start,
        the primary/commit at inline-end, and neither slot is ever filled by an
        action of the opposite consequence. The bar is outside the scrolling
        panes, so the commit cannot scroll out of view; refusals stay with it.
      */}
        {bridge !== null && (
          <CheckoutActionBar
            endSlotRef={setPrimarySlot}
            cancel={
              phase === 'entry' ? (
                <button
                  type="button"
                  className="payment-surface__cancel"
                  data-testid="payment-surface-cancel"
                  disabled={isCancelling}
                  aria-disabled={isCancelling ? 'true' : undefined}
                  onClick={() => {
                    void handleCancel();
                  }}
                >
                  إلغاء
                </button>
              ) : null
            }
            // RT-298: while a cancel is open nothing here may move the attempt
            // on, the post-apply read retry included (Codex P2, #576).
            commit={
              cancelOpen ? null : afterApply === 'failed' ? (
                <button
                  type="button"
                  className="checkout-commit"
                  data-testid="payment-surface-reread"
                  onClick={() => {
                    void handleLineApplied();
                  }}
                >
                  إعادة المحاولة
                </button>
              ) : showSettle ? (
                <button
                  type="button"
                  className="payment-surface__confirm checkout-commit"
                  data-testid="payment-surface-confirm"
                  disabled={isConfirming}
                  aria-disabled={isConfirming || !fullyTendered ? 'true' : undefined}
                  aria-describedby={fullyTendered ? undefined : 'payment-commit-reason'}
                  onKeyDown={guardCommitKey}
                  onClick={() => {
                    handleCommitClick(fullyTendered);
                  }}
                >
                  تأكيد الدفع
                </button>
              ) : null
            }
            reason={
              cancelOpen ? null : afterApply === 'failed' ? (
                <p
                  className="checkout-actions__reason"
                  data-testid="payment-surface-reread-notice"
                  role="status"
                >
                  تم تسجيل المبلغ، لكن تعذّر تحديث حالة الدفع. لا تكرر الدفع.
                </p>
              ) : showSettle && !fullyTendered ? (
                <p
                  id="payment-commit-reason"
                  className="checkout-actions__reason"
                  data-testid="payment-surface-commit-reason"
                >
                  المبلغ أقل من المستحق
                </p>
              ) : null
            }
            notices={notices}
          />
        )}
        {/* The primary action changes under the cashier's hands; keep focus with them. */}
        {bridge === null && notices}
        <FocusWhen
          active={fullyTendered}
          find={() =>
            document.querySelector<HTMLElement>('[data-testid="payment-surface-confirm"]')
          }
          onFocused={() => {
            commitFocusedAtRef.current = Date.now();
          }}
        />
        <FocusWhen
          active={phase === 'tender_selection' && hasAppliedLine && !fullyTendered}
          find={() =>
            document.querySelector<HTMLElement>('.payment-surface__methods button:not([disabled])')
          }
        />
      </section>
    </PrimarySlotContext.Provider>
  );
}
