import { useEffect, useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { Notice } from '../foundation/Notice';
import { formatHumanMoney } from '../../ui/format/human-format';
import { ProofList, type ProofItem } from './ProofList';
import './completion.css';

/**
 * RT-243 W1-C (freeze 15 S13/S14, VN-S4) — Checkout's completion, on the V5
 * vocabulary. It lists only what the terminal can prove for THIS payment:
 *
 * - the payment was taken (`payments.confirm` returned `settled_at`): success;
 * - the change to hand back, main's `change_due_minor` (M-P5), when non-zero;
 * - the receipt as NOT issued yet (info), or as never issued when sale
 *   finalization is off (warning).
 *
 * Left out on purpose, not shown as unknown: the sale number (D-N1), receipt
 * «sent» (M-C2) and sync. Nothing on the bridge ties a finalized sale or its
 * receipt to this attempt (`payments.confirm` returns only `settled_at`;
 * `SaleSummary` excludes `envelope_handoff_action_id`), so claiming either
 * would promote an unrelated record into proof. They return with that
 * correlating identifier, not before. No «اكتمل البيع» for the same reason.
 */

/** A held or doubled Enter right after focus lands here is not a decision. */
const NEW_SALE_ARM_MS = 400;

const RECEIPT_COPY = {
  pending: 'لم يصدر إيصال بعد.',
  disabled: 'لن يُسجَّل هذا البيع ولا يوجد إيصال له.',
} as const;

/**
 * Test hooks the caller owns. The V5 tree stays free of legacy names (the
 * clean-room guard), while Checkout keeps the markers its suites already pin.
 */
export interface CompletionTestIds {
  readonly root?: string;
  readonly panel?: string;
  readonly proofs?: string;
  readonly amount?: string;
  readonly change?: string;
  readonly cardVoid?: string;
  readonly newSale?: string;
}

export interface CompletionPanelProps {
  /** The amount taken, integer minor units (the handoff subtotal). */
  readonly paidMinor: number;
  /** Main's change to hand back over the applied lines; 0 for none. */
  readonly changeDueMinor: number;
  /** False when sale finalization is off: no sale record or receipt will exist. */
  readonly saleFinalization: boolean;
  /** M-P13 copy when a card line was cancelled here and the terminal void is unproven. */
  readonly cardVoidCopy: string | null;
  /** The drawer notice slot (D-B1), only inside cash completion. */
  readonly drawerNotice: ReactNode;
  /** Operator identity for the titlebar. */
  readonly operator: ReactNode;
  readonly onNewSale?: (() => void) | undefined;
  readonly testIds?: CompletionTestIds;
}

export function CompletionPanel({
  paidMinor,
  changeDueMinor,
  saleFinalization,
  cardVoidCopy,
  drawerNotice,
  operator,
  onNewSale,
  testIds = {},
}: CompletionPanelProps): JSX.Element {
  const newSaleRef = useRef<HTMLButtonElement>(null);
  const focusedAtRef = useRef(0);

  // Freeze 15 §3.2: «بيع جديد» owns focus on Completion. The settle commit that
  // led here has just unmounted, so focus would otherwise fall to the body.
  useEffect(() => {
    newSaleRef.current?.focus();
    focusedAtRef.current = Date.now();
  }, []);

  /**
   * The Enter that confirmed the payment can repeat (key held) or be tapped
   * twice. Landing on «بيع جديد» it would clear the change before the cashier
   * read it, so swallow a repeat or an Enter inside the arm window.
   */
  function guardNewSaleKey(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const tooSoon = Date.now() - focusedAtRef.current < NEW_SALE_ARM_MS;
    if (event.repeat || tooSoon) event.preventDefault();
  }

  const items: ProofItem[] = [
    {
      id: 'payment',
      tone: 'success',
      label: 'تم استلام المبلغ',
      value: formatHumanMoney(paidMinor),
      // FR-16: the settled amount stays the dominant figure, change or not.
      emphasis: true,
      testId: 'completion-proof-payment',
      valueTestId: testIds.amount,
    },
  ];
  if (Number.isSafeInteger(changeDueMinor) && changeDueMinor > 0) {
    items.push({
      id: 'change',
      tone: 'neutral',
      label: 'الباقي للعميل',
      value: formatHumanMoney(changeDueMinor),
      emphasis: true,
      testId: testIds.change,
    });
  }
  items.push({
    id: 'receipt',
    tone: saleFinalization ? 'info' : 'warning',
    label: saleFinalization ? RECEIPT_COPY.pending : RECEIPT_COPY.disabled,
    testId: 'completion-proof-receipt',
  });

  return (
    <section className="v5-completion" data-testid={testIds.root} aria-label="الدفع">
      <header className="v5-completion__titlebar">
        <h1>الدفع</h1>
        {operator}
      </header>

      <div className="v5-completion__body">
        {cardVoidCopy !== null && (
          <Notice
            tone="danger"
            {...(testIds.cardVoid !== undefined ? { testId: testIds.cardVoid } : {})}
          >
            {cardVoidCopy}
          </Notice>
        )}

        <div className="v5-completion__panel" data-testid={testIds.panel}>
          {/* A truthful terminal state, announced politely; never an alert. */}
          <div role="status" aria-live="polite" data-testid={testIds.proofs}>
            <ProofList items={items} label="حالة البيع" />
          </div>
        </div>

        {drawerNotice}

        <div className="v5-completion__actions">
          <button
            ref={newSaleRef}
            type="button"
            className="v5-completion-btn v5-completion-btn--primary"
            data-testid={testIds.newSale}
            onKeyDown={guardNewSaleKey}
            onClick={() => {
              // Routing and the store reset belong to the route owner; a
              // missing handler is a safe no-op (bare-render tests).
              onNewSale?.();
            }}
          >
            بيع جديد
          </button>
        </div>
      </div>
    </section>
  );
}
