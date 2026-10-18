import { useEffect, useId, useRef, useState, type JSX } from 'react';

import { PARK_LABEL_MAX_LENGTH, type CartParkBridgeAPI } from '../../../shared/cart/park-types';
import { formatHumanMoney } from '../../ui/format/human-format';
import { Dialog } from '../foundation/Dialog';
import { Notice } from '../foundation/Notice';
import { Icon } from '../../icons/Icon';
import { callPark, newIdempotencyKey } from './park-bridge';
import { PARK_COPY, itemsLabel, parkRefusalView, type ParkRefusalView } from './park-copy';

interface Props {
  readonly bridge: CartParkBridgeAPI;
  readonly cartId: string;
  readonly lineCount: number;
  readonly totalMinor: number;
  /** Main answered `parked`: the Sale clears only now (I-13). */
  readonly onParked: (label: string | null) => void;
  /** Close with nothing parked («رجوع», Esc). */
  readonly onClose: () => void;
  /** The limit refusal's «عرض المبيعات المعلّقة». */
  readonly onShowParked: () => void;
  /** A refusal with no drawn state: the caller re-reads the parked count (OD-9). */
  readonly onRefused: () => void;
}

type Phase =
  | { kind: 'typing' }
  | { kind: 'saving' }
  | { kind: 'refused'; view: Exclude<ParkRefusalView, 'session_locked'> };

/** OD-10: whitespace is trimmed; an empty label is sent as no label. */
export function normaliseLabel(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * RT-445 — «تعليق البيع» (PK3-ParkDialog … ParkLimit). The label is optional
 * and warned against personal data (K2). The dialog stays up, with the sale
 * behind it, until main answers `parked` (durable save, then clear).
 */
export function ParkDialog(props: Readonly<Props>): JSX.Element {
  const inputId = useId();
  const piiId = useId();
  const msgId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const showParkedRef = useRef<HTMLButtonElement>(null);
  const [label, setLabel] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'typing' });
  // One key per request: a retry of the same label replays, a new label is a new request.
  const keyRef = useRef<{ label: string | null; key: string } | null>(null);
  const saving = phase.kind === 'saving';
  const refused = phase.kind === 'refused' ? phase.view : null;
  const limit = refused === 'park_limit_reached';
  const invalid = refused === 'invalid_label';

  const keyFor = (sent: string | null): string => {
    if (keyRef.current?.label !== sent) keyRef.current = { label: sent, key: newIdempotencyKey() };
    return keyRef.current.key;
  };

  const submit = (): void => {
    if (saving || limit) return;
    const sent = normaliseLabel(label);
    setPhase({ kind: 'saving' });
    // The submit button is disabled while saving; focus stays in the dialog, on the (read-only) field.
    inputRef.current?.focus();
    void callPark(() =>
      props.bridge.park({
        cart_id: props.cartId,
        ...(sent === null ? {} : { label: sent }),
        idempotency_key: keyFor(sent),
      }),
    ).then((answer) => {
      if (answer.kind === 'parked') {
        props.onParked(sent);
        return;
      }
      const view = answer.kind === 'refused' ? parkRefusalView(answer.reason) : 'generic';
      // The lock screen covers a locked session; nothing to say here.
      if (view === 'session_locked') {
        setPhase({ kind: 'typing' });
        return;
      }
      setPhase({ kind: 'refused', view });
      if (view === 'generic') props.onRefused();
    });
  };

  // The next step after each refusal is under the cashier's hand.
  useEffect(() => {
    if (refused === null) return;
    if (refused === 'park_limit_reached') showParkedRef.current?.focus();
    else inputRef.current?.focus();
  }, [refused]);

  const counted = invalid ? label.length : label.trim().length;
  return (
    <Dialog
      label={PARK_COPY.dialogTitle}
      initialFocusRef={inputRef}
      {...(saving ? {} : { onCancel: props.onClose })}
    >
      <h2 className="v5-park-dialog__title">{PARK_COPY.dialogTitle}</h2>
      <div className="v5-park-dialog__summary">
        <span>{itemsLabel(props.lineCount)}</span>
        <span dir="ltr" className="v5-park-num">
          {formatHumanMoney(props.totalMinor)}
        </span>
      </div>
      <form
        className="v5-park-form"
        data-testid="park-dialog"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="v5-park-field">
          <div className="v5-park-field__row">
            <label htmlFor={inputId}>{PARK_COPY.labelField}</label>
            <span className="v5-park-num v5-park-counter" aria-hidden="true">
              {`${String(counted)}/${String(PARK_LABEL_MAX_LENGTH)}`}
            </span>
          </div>
          <input
            ref={inputRef}
            id={inputId}
            className="v5-park-input"
            type="text"
            maxLength={PARK_LABEL_MAX_LENGTH}
            autoComplete="off"
            value={label}
            readOnly={saving}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? `${piiId} ${msgId}` : piiId}
            onChange={(event) => {
              setLabel(event.target.value);
              if (phase.kind === 'refused' && !limit) setPhase({ kind: 'typing' });
            }}
          />
          <p className="v5-park-pii" id={piiId}>
            <Icon name="status.warning" />
            <span>{PARK_COPY.pii}</span>
          </p>
        </div>
        <div className="v5-park-slot" id={msgId}>
          <DialogMessage phase={phase} />
        </div>
        <div className="v5-park-dialog__actions">
          <div>
            {limit && (
              <button
                ref={showParkedRef}
                type="button"
                className="v5-park-btn"
                onClick={props.onShowParked}
              >
                {PARK_COPY.showParked}
              </button>
            )}
          </div>
          <div className="v5-park-dialog__pair">
            <button type="button" className="v5-park-btn" disabled={saving} onClick={props.onClose}>
              {PARK_COPY.back}
            </button>
            <button
              type="submit"
              className="v5-park-btn v5-park-btn--primary"
              disabled={saving || limit}
            >
              {PARK_COPY.parkAction}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

const REFUSAL_LINE: Readonly<Record<string, string>> = {
  invalid_label: PARK_COPY.invalidLabel,
  park_limit_reached: PARK_COPY.limit,
};

function DialogMessage({ phase }: Readonly<{ phase: Phase }>): JSX.Element | null {
  if (phase.kind === 'saving') return <Notice tone="info">{PARK_COPY.saving}</Notice>;
  if (phase.kind !== 'refused') return null;
  return <Notice tone="warning">{REFUSAL_LINE[phase.view] ?? PARK_COPY.generic}</Notice>;
}
