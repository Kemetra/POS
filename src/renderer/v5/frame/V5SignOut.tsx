import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import type { PreloadBridgeAPI } from '../../../shared/bridge-api';
import { useOperatorSessionStore } from '../../stores/operator-session-store';
import { usePaymentStore } from '../../stores/payment-store';

const SIGN_OUT_ERROR = 'تعذّر تسجيل الخروج — حاول مرة أخرى';
const PAYMENT_OPEN_HINT = 'أكمل الدفع أو ألغِه أولاً';
const HINT_ID = 'v5-sign-out-hint';

function signOutThroughMain(): Promise<unknown> {
  const api = (window as unknown as { api?: PreloadBridgeAPI }).api;
  if (!api?.operator) return Promise.reject(new Error('operator bridge unavailable'));
  return api.operator.signOut();
}

interface SignOutFlow {
  confirming: boolean;
  busy: boolean;
  error: string | null;
  openerRef: RefObject<HTMLButtonElement | null>;
  confirmRef: RefObject<HTMLButtonElement | null>;
  ask: () => void;
  cancel: () => void;
  confirm: () => Promise<void>;
}

/** Ask → confirm → main signs out → renderer leaves `signedIn`. Focus follows the step. */
function useSignOutFlow(): SignOutFlow {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
      return;
    }
    if (returnFocus.current) {
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

  return {
    confirming,
    busy,
    error,
    openerRef,
    confirmRef,
    ask: () => {
      setConfirming(true);
    },
    cancel,
    confirm,
  };
}

function SignOutButton({ flow }: { flow: SignOutFlow }): JSX.Element {
  const paymentOpen = usePaymentStore((s) => s.paymentSlice?.state === 'started');
  return (
    <div className="v5-frame__sign-out">
      <button
        ref={flow.openerRef}
        type="button"
        disabled={paymentOpen}
        aria-describedby={paymentOpen ? HINT_ID : undefined}
        onClick={flow.ask}
      >
        تسجيل الخروج
      </button>
      {paymentOpen && (
        <span id={HINT_ID} className="v5-frame__sign-out-hint">
          {PAYMENT_OPEN_HINT}
        </span>
      )}
    </div>
  );
}

function SignOutConfirm({ flow }: { flow: SignOutFlow }): JSX.Element {
  return (
    <div
      className="v5-frame__sign-out v5-frame__sign-out--confirming"
      role="group"
      aria-label="تأكيد تسجيل الخروج"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        flow.cancel();
      }}
    >
      <button
        ref={flow.confirmRef}
        type="button"
        className="v5-frame__sign-out-confirm"
        disabled={flow.busy}
        onClick={() => void flow.confirm()}
      >
        تأكيد تسجيل الخروج
      </button>
      <button type="button" disabled={flow.busy} onClick={flow.cancel}>
        البقاء مسجّلاً
      </button>
      {flow.error !== null && (
        <p className="v5-frame__sign-out-error" role="alert">
          {flow.error}
        </p>
      )}
    </div>
  );
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
  const flow = useSignOutFlow();
  return flow.confirming ? <SignOutConfirm flow={flow} /> : <SignOutButton flow={flow} />;
}
