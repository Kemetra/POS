import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type {
  LockStateView,
  UnlockSessionRequest,
  UnlockSessionResponse,
} from '../../shared/bridge-api';
import type { RefusalCategory } from '../../shared/audit/event-shape';
import { formatCheckoutMoney } from '../ui/payments/format-checkout-money';
import { Button } from '../ui/primitives';
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '../ui/operator/PinPad';

/**
 * RT-117 (RT-116 §2, VN-R8) — the inactivity lock screen.
 *
 * Shows that the sale is preserved (totals only — RT-116 §7.2) and offers the
 * same-operator unlock: a PIN for a cashier, the interim online credential for
 * a manager/admin (owner decision Z3). Esc does nothing: a lock is not a
 * dialog the operator can dismiss. Refusals render one generic message family
 * (NFR-003) and never echo what was typed.
 */

export interface LockScreenProps {
  view: LockStateView;
  unlock: (req: UnlockSessionRequest) => Promise<UnlockSessionResponse>;
  onUnlocked: () => void;
}

/** 004 cashier PIN format — same bounds as the sign-in PinPad (4–6 digits). */
const PIN_FORMAT = new RegExp(`^\\d{${String(PIN_MIN_LENGTH)},${String(PIN_MAX_LENGTH)}}$`);

function refusalMessage(category: RefusalCategory): string {
  if (category === 'rate_limited') return 'محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.';
  if (category === 'no_connection') return 'تعذّر الاتصال. فتح قفل المدير يتطلب اتصالاً بالشبكة.';
  return 'تعذّر فتح القفل. تحقّق من البيانات وحاول مرة أخرى.';
}

export function LockScreen({ view, unlock, onUnlocked }: LockScreenProps): JSX.Element {
  const titleId = useId();
  const descId = useId();
  const errId = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const [pin, setPin] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isCashier = view.role === 'cashier';

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);

  // While locked, no key may reach the sale behind the lock: `inert` stops
  // focus and clicks, but not document/window key listeners (Dialog Escape,
  // receipt shortcuts…). Keys aimed outside the lock are swallowed here in the
  // capture phase, before any other listener sees them.
  useEffect(() => {
    const swallowOutside = (e: KeyboardEvent): void => {
      const target = e.target as Node | null;
      if (target !== null && rootRef.current?.contains(target) === true) return;
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', swallowOutside, { capture: true });
    return () => {
      window.removeEventListener('keydown', swallowOutside, { capture: true });
    };
  }, []);

  // Keys typed ON the lock stop here, so document/window listeners behind it
  // never hear them. A lock is never dismissible: Escape cancels the ENTRY in
  // progress (clears typed secrets and the error) and keeps the lock
  // (DESIGN.md "Esc cancels"; keyboard users can always restart the entry).
  const onLockKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    if (e.key !== 'Escape') return;
    e.preventDefault();
    setPin('');
    setIdentifier('');
    setPassword('');
    setError(null);
    firstFieldRef.current?.focus();
  };

  const submit = async (event: { preventDefault(): void }): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    // RT-24 I-4 — a scanner burst (or any non-PIN entry) never reaches main as
    // a PIN attempt, so it cannot count toward the 004 lockout.
    if (isCashier && !PIN_FORMAT.test(pin)) {
      setPin('');
      setError('رمز PIN من 4 إلى 6 أرقام.');
      firstFieldRef.current?.focus();
      return;
    }
    const req: UnlockSessionRequest = isCashier
      ? { method: 'pin', pin }
      : { method: 'online_credential', identifier, password };
    setBusy(true);
    try {
      const res = await unlock(req);
      if (res.kind === 'unlocked') {
        onUnlocked();
        return;
      }
      setError(refusalMessage(res.category));
    } catch {
      setError(refusalMessage('invalid_input'));
    } finally {
      // Never keep a secret in component state after an attempt.
      setPin('');
      setPassword('');
      setBusy(false);
      firstFieldRef.current?.focus();
    }
  };

  const summary = view.summary;
  return (
    <div ref={rootRef} className="session-lock" onKeyDown={onLockKeyDown}>
      <div className="dialog-overlay" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="dialog-panel session-lock__panel"
      >
        <h2 id={titleId}>الجهاز مقفل</h2>
        <p id={descId}>قُفل الجهاز بعد فترة من عدم النشاط. لم يُفقد شيء — البيع محفوظ كما تركته.</p>

        {summary !== null && (
          <dl className="session-lock__summary">
            <div>
              <dt>عدد الأصناف</dt>
              <dd>
                <bdi>{summary.line_count}</bdi>
              </dd>
            </div>
            <div>
              <dt>الإجمالي</dt>
              <dd>
                <bdi>{formatCheckoutMoney(summary.total_minor)}</bdi>
              </dd>
            </div>
            {summary.tender_applied_minor > 0 && (
              <div>
                <dt>مدفوع حتى الآن</dt>
                <dd>
                  <bdi>{formatCheckoutMoney(summary.tender_applied_minor)}</bdi>
                </dd>
              </div>
            )}
          </dl>
        )}

        <form
          className="session-lock__form"
          onSubmit={(e) => {
            void submit(e);
          }}
        >
          {view.display_name !== null && (
            <p className="session-lock__operator">
              فتح القفل لـ <bdi>{view.display_name}</bdi>
            </p>
          )}
          {isCashier ? (
            <div className="input-field">
              <label htmlFor={`${titleId}-pin`}>رمز PIN</label>
              <input
                ref={firstFieldRef}
                id={`${titleId}-pin`}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                dir="ltr"
                value={pin}
                aria-invalid={error !== null ? 'true' : undefined}
                aria-describedby={error !== null ? errId : undefined}
                onChange={(e) => {
                  setPin(e.target.value);
                }}
              />
            </div>
          ) : (
            <>
              <div className="input-field">
                <label htmlFor={`${titleId}-id`}>البريد أو اسم المستخدم</label>
                <input
                  ref={firstFieldRef}
                  id={`${titleId}-id`}
                  type="text"
                  autoComplete="username"
                  dir="ltr"
                  value={identifier}
                  onChange={(e) => {
                    setIdentifier(e.target.value);
                  }}
                />
              </div>
              <div className="input-field">
                <label htmlFor={`${titleId}-pw`}>كلمة المرور</label>
                <input
                  id={`${titleId}-pw`}
                  type="password"
                  autoComplete="current-password"
                  dir="ltr"
                  value={password}
                  aria-invalid={error !== null ? 'true' : undefined}
                  aria-describedby={error !== null ? errId : undefined}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                />
              </div>
            </>
          )}
          {error !== null && (
            <p id={errId} role="alert" className="input-field__error">
              {error}
            </p>
          )}
          <div className="dialog-panel__actions">
            <Button intent="primary" type="submit" loading={busy}>
              فتح القفل
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
