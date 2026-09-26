import { useEffect, useRef, useState, type JSX } from 'react';
import type { PreloadBridgeAPI } from '../../../shared/bridge-api';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';

const SIGN_OUT_ERROR = 'تعذّر تسجيل الخروج — حاول مرة أخرى';
const PAYMENT_OPEN_HINT = 'أكمل الدفع أو ألغِه أولاً';

function signOutThroughMain(): Promise<unknown> {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api?.operator) return Promise.reject(new Error('operator bridge unavailable'));
  return api.operator.signOut();
}

/**
 * Two-step sign-out for the v5 frame. The first press asks inline; confirm
 * signs out through main, and only after main answers does the renderer leave
 * `signedIn` (the route guard then returns to sign-in, and the cart sign-out
 * hook clears renderer cart state). A failure keeps the session and shows a
 * generic, retryable error. Blocked while a payment attempt is open, so an
 * operator never walks away from tender in flight.
 */
export function V5SignOut(): JSX.Element {
  const paymentOpen = usePaymentStore((s) => s.paymentSlice?.state === 'started');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      openerRef.current?.focus();
    }
  }, [confirming]);

  const cancel = (): void => {
    if (busy) return;
    setError(null);
    returnFocus.current = true;
    setConfirming(false);
  };

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signOutThroughMain();
      const store = useOperatorSessionStore.getState();
      store.beginSignOut();
      store.resolveSignedOut();
    } catch {
      setError(SIGN_OUT_ERROR);
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <div className="v5-frame__sign-out">
        <button
          ref={openerRef}
          type="button"
          disabled={paymentOpen}
          aria-describedby={paymentOpen ? 'v5-sign-out-hint' : undefined}
          onClick={() => {
            setConfirming(true);
          }}
        >
          تسجيل الخروج
        </button>
        {paymentOpen && (
          <span id="v5-sign-out-hint" className="v5-frame__sign-out-hint">
            {PAYMENT_OPEN_HINT}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="v5-frame__sign-out v5-frame__sign-out--confirming"
      role="group"
      aria-label="تأكيد تسجيل الخروج"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <button
        ref={confirmRef}
        type="button"
        className="v5-frame__sign-out-confirm"
        disabled={busy}
        onClick={() => void confirm()}
      >
        تأكيد تسجيل الخروج
      </button>
      <button type="button" disabled={busy} onClick={cancel}>
        البقاء مسجّلاً
      </button>
      {error !== null && (
        <p className="v5-frame__sign-out-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
