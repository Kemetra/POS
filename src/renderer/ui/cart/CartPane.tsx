/**
 * 005-sales-cart T027 (S1 shell) + T052 (S2 live line list) — Cart pane.
 *
 * Layout: three-region vertical stack per S0 contact sheet §"Layout strategy":
 *   - Header strip (pane label).
 *   - Scrollable body (EmptyCartPlaceholder or live line list).
 *   - Footer strip (Σ subtotal, hand-off button — disabled for S2).
 *
 * Visibility rules:
 *   - Pane is rendered only when an operator session is signed in.
 *   - When signed out, the component returns null (no cart-shaped region
 *     leaked to unauthenticated screens).
 *
 * Live line list (T052):
 *   - CartPane maintains a local `lines` state array (with per-line `version`)
 *     to hold bridge-confirmed line display snapshots. The Zustand cartStore
 *     tracks only FSM state and cart_id.
 *   - Lines are added via the `onLineAdded` register-callback prop: the caller
 *     (item scan / product search surface) receives a `addLine` function and
 *     calls it after a successful `cart.lines.add` bridge response. CartPane
 *     appends a new row (merged=false) or updates subtotal+version (merged=true).
 *   - For tests, `_testInitialLines` seeds the list without any bridge call.
 *   - Bridge calls for update/remove/setNote use a typed defensive accessor
 *     identical to the PairedScreen / PairingForm pattern.
 *   - The renderer-side role gate here is a UX defence; main-process
 *     `requireOperatorSession` is the load-bearing trust boundary (AD-1).
 *
 * SECURITY:
 *   - Renderer never receives JWT, device_token, PIN, or credentials.
 *   - Note content is displayed as-is (display only); no logging (NFR-006).
 */

import { useState, useEffect, type JSX } from 'react';

import type { CartBridgeAPI } from '../../../shared/bridge-api.js';
import type { PaymentIntentEnvelope } from '../../../shared/cart/handoff-envelope.js';
import { EmptyCartPlaceholder } from './EmptyCartPlaceholder.js';
import { CartInteractionShell } from './CartInteractionShell.js';
import { LineItemRow } from './LineItemRow.js';
import { LineNotePopover } from './LineNotePopover.js';
import { VoidConfirmation } from './VoidConfirmation.js';
import { DiscountPlaceholderRow } from './DiscountPlaceholderRow.js';
import { HandoffSummary } from './HandoffSummary.js';
import { useOperatorSessionStore } from '../../stores/operator-session-store.js';
import { useCartStore } from '../../stores/cart-store.js';
import { useFeatureFlagsStore } from '../../stores/feature-flags-store.js';
import { CartState } from '../../../shared/cart/cart-state.js';
import {
  useSaleCartController,
  type AddedLineResult,
  type CartLineItem,
  type DiscountPlaceholderSeed,
} from '../../sale/useSaleCartController.js';

export type {
  AddedLineResult,
  CartLineItem,
  DiscountPlaceholderSeed,
} from '../../sale/useSaleCartController.js';

export interface CartPaneProps {
  /**
   * Test-only: seeds the initial line list without a bridge call.
   * Production wiring supplies lines via the bridge add-line flow.
   * This prop is not part of the public API and MUST NOT be used in production.
   */
  _testInitialLines?: CartLineItem[];
  /**
   * Test-only: injects the cart bridge instead of reading window.api.
   * MUST NOT be used in production.
   */
  _testBridge?: CartBridgeAPI;
  /**
   * Test-only: seeds discount placeholder rows without a bridge call.
   * MUST NOT be used in production.
   */
  _testDiscountPlaceholders?: DiscountPlaceholderSeed[];
  /**
   * Test-only: seeds the envelope for pre-frozen cart state.
   * MUST NOT be used in production.
   */
  _testInitialEnvelope?: PaymentIntentEnvelope;
  /**
   * Registers a callback that the caller must invoke after a successful
   * cart.lines.add bridge call. CartPane updates its local line list
   * (append for merged=false, update subtotal+version for merged=true).
   *
   * Registration is idempotent-overwrite: if onLineAdded identity changes,
   * the latest handleAddLine reference is re-registered. Wrap with useCallback
   * in the caller to avoid re-registration churn; omitting it is safe but wasteful.
   */
  onLineAdded?: (addLine: (res: AddedLineResult) => void) => void;
  /**
   * Invoked when the operator clicks "Continue to payment" on the frozen
   * handoff summary, AFTER the envelope is mounted into the payment store.
   * The route owner (CartWorkspace) wires this to navigate to /app/checkout,
   * where PaymentSurface picks the envelope up from the store. Optional so
   * CartPane stays Router-agnostic — bare-render tests omit it (the call is
   * guarded), keeping CartPane testable without a Router ancestor.
   */
  onPaymentContinue?: () => void;
}

function formatMinorUnits(minor: number): string {
  const whole = Math.floor(minor / 100);
  const frac = Math.abs(minor % 100)
    .toString()
    .padStart(2, '0');
  return `¤${String(whole)}.${frac}`;
}

export function CartPane({
  _testInitialLines,
  _testBridge,
  _testDiscountPlaceholders,
  _testInitialEnvelope,
  onLineAdded,
  onPaymentContinue,
}: CartPaneProps = {}): JSX.Element | null {
  const sessionState = useOperatorSessionStore((s) => s.state);
  const sessionKind = sessionState.kind;
  const sessionRole = sessionState.kind === 'signedIn' ? sessionState.session.role : null;
  const activeCart = useCartStore((s) => s.activeCart);
  const paymentsFlag = useFeatureFlagsStore((s) => s.payments);
  const {
    lines,
    discountPlaceholders,
    envelope,
    handoffError,
    subtotalMinor: cartSubtotalMinor,
    itemCount: cartItemCount,
    acceptAddedLine,
    incrementLine,
    decrementLine,
    removeLine,
    saveNote,
    handoff,
    voidCart,
    removeDiscount,
    continueToPayment,
  } = useSaleCartController({
    ...(_testInitialLines !== undefined ? { initialLines: _testInitialLines } : {}),
    ...(_testDiscountPlaceholders !== undefined
      ? { initialDiscountPlaceholders: _testDiscountPlaceholders }
      : {}),
    ...(_testInitialEnvelope !== undefined ? { initialEnvelope: _testInitialEnvelope } : {}),
    ...(_testBridge !== undefined ? { bridge: _testBridge } : {}),
  });
  const [noteOpenLineId, setNoteOpenLineId] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [voidDialogOpen, setVoidDialogOpen] = useState(false);

  useEffect(() => {
    if (onLineAdded === undefined) return;
    onLineAdded(acceptAddedLine);
  }, [onLineAdded, acceptAddedLine]);

  if (sessionKind !== 'signedIn') {
    return null;
  }

  const showEmpty = activeCart === null || activeCart.state === CartState.empty;

  const isFrozen = activeCart?.state === CartState.frozen_handed_off;
  const isHandingOff = activeCart?.state === CartState.handing_off;
  const isCancelled = activeCart?.state === CartState.cancelled;
  // Void hidden in empty/cancelled states (contact-sheet Surfaces 1, cancelled).
  // Post-handoff Void is manager/admin only and renders inside HandoffSummary
  // footer (Surface 8) whenever the envelope is hydrated. If the cart is
  // frozen but the envelope has not yet hydrated (rare pre-render edge case),
  // the header retains Void as a degraded fallback so the manager/admin
  // affordance is never lost.
  const canVoid =
    activeCart !== null &&
    activeCart.state !== CartState.empty &&
    activeCart.state !== CartState.cancelled &&
    (!isFrozen || sessionRole === 'manager' || sessionRole === 'admin');
  const handoffHostsVoid = isFrozen && envelope !== null;
  const showVoidInHeader = canVoid && !handoffHostsVoid;
  const showVoidInHandoff = canVoid && handoffHostsVoid;
  const canHandoff =
    activeCart !== null && activeCart.state === CartState.editing && lines.length > 0;
  const showHandoffButton = !isFrozen && !isCancelled;

  async function handleVoidConfirm(): Promise<void> {
    if (await voidCart()) setVoidDialogOpen(false);
  }

  // Group discount placeholders by their associated line for inline rendering
  // (contact-sheet Surface 2 / Surface 7). A placeholder is rendered inline
  // only when its `lineId` matches an existing line in the current cart;
  // stale, removed, null, or undefined `lineId` values fall through to
  // `orphanDiscounts` so the placeholder remains visible at the tail of the
  // same line list rather than disappearing silently if a line is removed
  // while a discount referencing it is in flight.
  const existingLineIds = new Set(lines.map((l) => l.lineId));
  const discountsByLine = new Map<string, DiscountPlaceholderSeed[]>();
  const orphanDiscounts: DiscountPlaceholderSeed[] = [];
  for (const dp of discountPlaceholders) {
    if (dp.lineId !== undefined && dp.lineId !== null && existingLineIds.has(dp.lineId)) {
      const list = discountsByLine.get(dp.lineId) ?? [];
      list.push(dp);
      discountsByLine.set(dp.lineId, list);
    } else {
      orphanDiscounts.push(dp);
    }
  }

  async function handleSaveNote(
    lineId: string,
    version: number,
    note: string | null,
  ): Promise<void> {
    setNoteError(null);
    if (await saveNote(lineId, version, note)) {
      setNoteOpenLineId(null);
    } else {
      setNoteError('Note rejected');
    }
  }

  return (
    // dir="rtl": Arabic-first systemic direction (standard HTML attribute, not a
    // new prop). Money + line codes inside re-isolate to dir="ltr" so numerals
    // never bidi-reorder (Slice-1 review fix, preserved + extended below).
    <section className="cart-pane" data-testid="cart-pane" aria-label="Cart" dir="rtl">
      {voidDialogOpen && (
        <VoidConfirmation
          onConfirm={() => {
            void handleVoidConfirm();
          }}
          onCancel={() => {
            setVoidDialogOpen(false);
          }}
        />
      )}
      <header className="cart-pane__header">
        {/* Arabic-first title; the LTR "Cart" companion preserves the pane's
            accessible/region-name parity (the section keeps aria-label="Cart"). */}
        <h2 className="cart-pane__title">
          نقطة البيع · السلة
          <span className="cart-pane__title-en" dir="ltr">
            {' '}
            · Cart
          </span>
        </h2>
        {showVoidInHeader && (
          <button
            type="button"
            className="cart-pane__void"
            data-testid="cart-void-button"
            data-variant="danger"
            onClick={() => {
              setVoidDialogOpen(true);
            }}
          >
            إلغاء البيع
          </button>
        )}
      </header>
      {isFrozen && envelope !== null ? (
        <div className="cart-pane__frozen-body">
          {showVoidInHandoff ? (
            <HandoffSummary
              envelope={envelope}
              showVoid={true}
              onVoidRequest={() => {
                setVoidDialogOpen(true);
              }}
              {...(paymentsFlag
                ? {
                    onContinue: () => {
                      continueToPayment(onPaymentContinue);
                    },
                  }
                : {})}
            />
          ) : (
            <HandoffSummary
              envelope={envelope}
              {...(paymentsFlag
                ? {
                    onContinue: () => {
                      continueToPayment(onPaymentContinue);
                    },
                  }
                : {})}
            />
          )}
        </div>
      ) : (
        <>
          <div className="cart-pane__body">
            {showEmpty ? (
              <EmptyCartPlaceholder />
            ) : (
              <>
                {/* Drug-interaction callout — ENRICHMENT SHELL only. Interaction
                    data is not in the cart/catalogue contract (POS-013 deferred),
                    so this holds the prototype's callout footprint with a
                    truthful "not available yet" placeholder; it never asserts a
                    live interaction. */}
                <CartInteractionShell />
                <ol className="cart-pane__line-list" aria-label="Cart items">
                  {lines.map((line) => {
                    const lineDiscounts = discountsByLine.get(line.lineId) ?? [];
                    return (
                      <li key={line.lineId} className="cart-pane__line-list-item">
                        <LineItemRow
                          lineId={line.lineId}
                          displayName={line.displayName}
                          quantity={line.quantity}
                          unitPriceMinor={line.unitPriceMinor}
                          lineSubtotalMinor={line.lineSubtotalMinor}
                          note={line.note}
                          hasNote={line.note !== null}
                          onQuantityIncrement={() => {
                            void incrementLine(line.lineId, line.version);
                          }}
                          onQuantityDecrement={() => {
                            void decrementLine(line.lineId, line.version);
                          }}
                          onRemove={() => {
                            void removeLine(line.lineId, line.version);
                          }}
                          onNoteOpen={() => {
                            setNoteError(null);
                            setNoteOpenLineId(line.lineId);
                          }}
                        />
                        {noteOpenLineId === line.lineId && (
                          <LineNotePopover
                            open={true}
                            currentNote={line.note}
                            error={noteError}
                            onSave={(note) => {
                              void handleSaveNote(line.lineId, line.version, note);
                            }}
                            onClose={() => {
                              setNoteError(null);
                              setNoteOpenLineId(null);
                            }}
                          />
                        )}
                        {lineDiscounts.map((dp) => (
                          <DiscountPlaceholderRow
                            key={dp.placeholderId}
                            placeholderId={dp.placeholderId}
                            onRemove={() => {
                              void removeDiscount(dp.placeholderId);
                            }}
                          />
                        ))}
                      </li>
                    );
                  })}
                  {orphanDiscounts.map((dp) => (
                    <li key={dp.placeholderId} className="cart-pane__line-list-item">
                      <DiscountPlaceholderRow
                        placeholderId={dp.placeholderId}
                        onRemove={() => {
                          void removeDiscount(dp.placeholderId);
                        }}
                      />
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
          <footer className="cart-pane__footer">
            {/* Totals (prototype .totals-rows). MONEY HONESTY (ADR-0003 / spec
                §12 tax-pending): the cart engine computes ONLY the subtotal
                (Σ lineSubtotalMinor). There is NO VAT field and NO grand-total
                in the engine, and tax is NOT asserted. So:
                  • Subtotal = REAL (cartSubtotalMinor).
                  • VAT      = a tax-pending PLACEHOLDER ("—") — NEVER a computed
                               14% figure (the prototype's live VAT is a mock).
                  • Total    = the subtotal (no fake VAT added until tax lands).
                Money figures re-isolate to dir="ltr" mono. */}
            <div className="totals-rows" data-testid="cart-totals">
              <div className="totals-row">
                <span className="totals-row__label">
                  المجموع · Subtotal{showEmpty ? '' : ` · ${String(cartItemCount)} صنف`}
                </span>
                {showEmpty ? (
                  <span className="cart-pane__subtotal-value" aria-label="subtotal placeholder">
                    —
                  </span>
                ) : (
                  <span
                    className="cart-pane__subtotal-value mono"
                    data-testid="cart-subtotal-value"
                    aria-label="cart subtotal"
                    dir="ltr"
                  >
                    {formatMinorUnits(cartSubtotalMinor)}
                  </span>
                )}
              </div>
              <div className="totals-row totals-row--vat-pending">
                <span className="totals-row__label">ض.ق.م (VAT)</span>
                {/* tax-pending: an honest placeholder, never a 14% computation. */}
                <span
                  className="totals-row__pending"
                  data-testid="cart-vat-value"
                  aria-label="VAT tax-pending"
                  dir="ltr"
                >
                  — <small className="totals-row__pending-note">قيد الإضافة · tax-pending</small>
                </span>
              </div>
              <div className="totals-row totals-row--grand">
                <span className="totals-row__label">الإجمالي المطلوب · Total</span>
                {showEmpty ? (
                  <span className="cart-pane__subtotal-value" aria-label="total placeholder">
                    —
                  </span>
                ) : (
                  // Tax-pending: total == subtotal until tax lands. No fake VAT.
                  <span
                    className="cart-pane__subtotal-value mono"
                    data-testid="cart-total-value"
                    aria-label="cart total"
                    dir="ltr"
                  >
                    {formatMinorUnits(cartSubtotalMinor)}
                  </span>
                )}
              </div>
            </div>
            {handoffError !== null && (
              <p className="cart-pane__handoff-error" data-testid="cart-handoff-error" role="alert">
                {handoffError}
              </p>
            )}
            {showHandoffButton && (
              <div className="cart-actions-row">
                {/* Hold sale (prototype F3) — SHELL ONLY. There is no
                    suspend/park/hold action in the cart engine, so this is
                    rendered permanently disabled (an enrichment affordance the
                    real flow can light up later). It is wired to nothing. */}
                <button
                  type="button"
                  className="cart-pane__hold"
                  data-testid="cart-hold-button"
                  disabled
                  aria-disabled="true"
                  title="تعليق البيع غير متاح بعد · hold not available yet"
                >
                  تعليق · Hold
                </button>
                <button
                  type="button"
                  className="cart-pane__handoff"
                  disabled={!canHandoff || isHandingOff}
                  aria-disabled={!canHandoff || isHandingOff ? 'true' : undefined}
                  data-testid="cart-handoff-button"
                  onClick={() => {
                    void handoff();
                  }}
                >
                  {isHandingOff ? 'جارٍ الانتقال…' : 'الانتقال للدفع · Hand off to payment'}
                </button>
              </div>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
