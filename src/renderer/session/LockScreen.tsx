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
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '../ui/operator/PinPad';
import { Dialog, DialogHost } from '../v5/foundation/Dialog';
import { V5Icon } from '../v5/foundation/V5Icon';
import '../v5/sale/live-sale.css';
import '../v5/shift/shift.css';
import './lock-screen.css';

/**
 * RT-117 (RT-116 §2, VN-R8) / RT-593 (VN-S8 lock) — the inactivity lock screen.
 *
 * Offers the same-operator unlock: a PIN for a cashier, the interim online
 * credential for a manager/admin (owner decision Z3). Nothing of the sale is
 * shown: no lines, no count, no amounts (doc 15 §2.1, owner decision L3;
 * the summary field stays in main and the bridge, this screen never reads it).
 * Esc clears the entry but never dismisses the lock. Refusals render one
 * generic message family (NFR-003) and never echo what was typed. It renders
 * through the one V5 Dialog, in its own host: the app subtree is concealed.
 */

export interface LockScreenProps {
  view: LockStateView;
  unlock: (req: UnlockSessionRequest) => Promise<UnlockSessionResponse>;
  onUnlocked: () => void;
  /**
   * RT-444 (RT-116 §4) — another operator signs in on this terminal. The lock
   * stays in main; the sign-in either ends it (`superseded_at_lock`) or is
   * refused, and the original operator can still come back and unlock.
   */
  onSwitchOperator?: () => void;
}

/** 004 cashier PIN format — same bounds as the sign-in PinPad (4–6 digits). */
const PIN_FORMAT = new RegExp(`^\\d{${String(PIN_MIN_LENGTH)},${String(PIN_MAX_LENGTH)}}$`);

/**
 * M-L1 (doc 15 §5): «الطرفية مقفلة. أدخل الرقم السري للمتابعة.» (cashier);
 * M-L1b: «الطرفية مقفلة. أدخل بيانات الدخول للمتابعة.» (manager/admin).
 */
const LOCK_TITLE = 'الطرفية مقفلة';
const LOCK_PROMPT_PIN = 'أدخل الرقم السري للمتابعة.';
const LOCK_PROMPT_CREDENTIALS = 'أدخل بيانات الدخول للمتابعة.';

function refusalMessage(category: RefusalCategory): string {
  if (category === 'rate_limited') return 'محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.';
  if (category === 'no_connection') return 'تعذّر الاتصال. فتح قفل المدير يتطلب اتصالاً بالشبكة.';
  return 'تعذّر فتح القفل. تحقّق من البيانات وحاول مرة أخرى.';
}

export function LockScreen({
  view,
  unlock,
  onUnlocked,
  onSwitchOperator,
}: Readonly<LockScreenProps>): JSX.Element {
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
  const cancelEntry = (): void => {
    setPin('');
    setIdentifier('');
    setPassword('');
    setError(null);
    firstFieldRef.current?.focus();
  };
  const onLockKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    if (e.key !== 'Escape') return;
    e.preventDefault();
    cancelEntry();
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

  return (
    <div ref={rootRef} className="session-lock" onKeyDown={onLockKeyDown}>
      <DialogHost>
        <Dialog
          label={LOCK_TITLE}
          describedBy={descId}
          onCancel={cancelEntry}
          initialFocusRef={firstFieldRef}
          restoreFocus={false}
        >
          <div className="session-lock__head">
            <span className="session-lock__mark" aria-hidden="true">
              <V5Icon name="lock" size={28} />
            </span>
            <h2 id={titleId} className="v5-live-dialog-title session-lock__title">
              {LOCK_TITLE}
            </h2>
          </div>
          <p id={descId} className="session-lock__prompt">
            {isCashier ? LOCK_PROMPT_PIN : LOCK_PROMPT_CREDENTIALS}
          </p>
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
              <div className="v5-shift-fields">
                <label htmlFor={`${titleId}-pin`}>رمز PIN</label>
                <input
                  className="v5-shift-input"
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
                <div className="v5-shift-fields">
                  <label htmlFor={`${titleId}-id`}>البريد أو اسم المستخدم</label>
                  <input
                    className="v5-shift-input"
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
                <div className="v5-shift-fields">
                  <label htmlFor={`${titleId}-pw`}>كلمة المرور</label>
                  <input
                    className="v5-shift-input"
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
              <p id={errId} role="alert" className="session-lock__error">
                <V5Icon name="status-danger" size={18} />
                <span>{error}</span>
              </p>
            )}
            <div>
              <button
                type="submit"
                className="v5-live-btn v5-live-btn--primary"
                disabled={busy}
                aria-busy={busy ? 'true' : undefined}
              >
                فتح القفل
              </button>
              {onSwitchOperator !== undefined && (
                <button
                  type="button"
                  className="v5-live-btn"
                  disabled={busy}
                  onClick={onSwitchOperator}
                >
                  دخول موظف آخر
                </button>
              )}
            </div>
          </form>
        </Dialog>
      </DialogHost>
    </div>
  );
}
