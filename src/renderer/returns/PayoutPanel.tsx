import type { JSX, Ref } from 'react';

import type {
  ReturnJournalView,
  ReturnPayoutMethod,
  ReturnsBridgeAPI,
} from '../../shared/returns/types.js';
import { ToneIcon, type Tone as NoticeTone } from '../v5/foundation/ToneIcon';
import { RefundTotal } from './ReturnsPanel';
import type { PayoutPhase } from './payout-state.js';
import { formatReturnMoney, formatReturnTime } from './returns-format.js';
import {
  PAYOUT_COPY,
  drawerFailureMessage,
  refusalMessage,
  reprintMessage,
} from './returns-messages.js';
import { useFocusOnMount } from './useFocusOnMount.js';
import { usePayout, type Payout, type Reload } from './usePayout.js';

/**
 * RT-15 S4 — pay out a confirmed return's cash (AC9) and print its slip (AC12).
 *
 * Honest by construction: "paid" only after main recorded the payout; a
 * drawer that did not open says nothing was recorded; a payout started
 * elsewhere is completed, never started afresh, after checking the customer;
 * a manual payout needs a second, explicit step whose first focus is Cancel.
 */
type Tone = 'success' | 'warning' | 'danger' | 'neutral';

/** A neutral region keeps the info glyph, drawn muted (G6R notice-neutral). */
function glyphOf(tone: Tone): NoticeTone {
  return tone === 'neutral' ? 'info' : tone;
}

const TONES: Readonly<Record<PayoutPhase['kind'], Tone>> = {
  ready: 'neutral',
  interrupted: 'warning',
  drawer_failed: 'warning',
  confirm_manual: 'warning',
  paid: 'success',
  refused: 'danger',
  wait: 'warning',
  unknown: 'danger',
};

/**
 * DESIGN.md: a printer failure after a completed payout is degraded amber
 * (operable: the payout stands, a copy can be printed), not success green.
 */
function toneOf(state: Payout['state']): Tone {
  const slipFailed = state.phase.kind === 'paid' && state.phase.slip === 'failed';
  const reprintNotPrinted = state.reprint !== null && state.reprint.kind !== 'printed';
  return slipFailed || reprintNotPrinted ? 'warning' : TONES[state.phase.kind];
}

/** How the cash left the till, in words (RT-531: a no-drawer terminal never says "the drawer is open"). */
const PAID_HOW: Readonly<Record<ReturnPayoutMethod, string>> = {
  drawer: PAYOUT_COPY.paidDrawer,
  manual: PAYOUT_COPY.paidManual,
  no_drawer: PAYOUT_COPY.paidNoDrawer,
};

function paidLines(phase: Extract<PayoutPhase, { kind: 'paid' }>): string[] {
  if (phase.slip === null) return [PAYOUT_COPY.paidEarlier];
  const how = PAID_HOW[phase.method ?? 'drawer'];
  const slip = phase.slip === 'printed' ? PAYOUT_COPY.slipPrinted : PAYOUT_COPY.slipFailed;
  return [PAYOUT_COPY.paid, how, slip];
}

/**
 * P2-1: only a kick that provably never left "did not open"; anything else
 * (timeout, fault) is unknown: count the drawer, attest manually.
 */
function drawerFailedLines(phase: Extract<PayoutPhase, { kind: 'drawer_failed' }>): string[] {
  const headline = phase.retryable ? PAYOUT_COPY.drawerFailed : PAYOUT_COPY.drawerUnknown;
  return [headline, drawerFailureMessage(phase.reason)];
}

type LinesOf = {
  readonly [K in PayoutPhase['kind']]: (phase: Extract<PayoutPhase, { kind: K }>) => string[];
};

/** Per phase, what is true now, one sentence per line. */
const STATUS_LINES: LinesOf = {
  ready: () => [PAYOUT_COPY.ready],
  interrupted: () => [PAYOUT_COPY.interrupted, PAYOUT_COPY.interruptedCheck],
  drawer_failed: drawerFailedLines,
  confirm_manual: () => [PAYOUT_COPY.confirmManual],
  paid: paidLines,
  refused: (phase) => [refusalMessage(phase.reason)],
  wait: (phase) => [refusalMessage(phase.reason)],
  unknown: () => [PAYOUT_COPY.unknown],
};

function statusLines(phase: PayoutPhase): string[] {
  // The map is keyed by kind, so each builder gets its own phase.
  const build = STATUS_LINES[phase.kind] as (p: PayoutPhase) => string[];
  return build(phase);
}

interface ActionProps {
  readonly payout: Payout;
}

function Btn(props: {
  readonly label: string;
  readonly primary?: boolean;
  readonly busy?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly autoFocusRef?: Ref<HTMLButtonElement>;
}): JSX.Element {
  return (
    <button
      type="button"
      ref={props.autoFocusRef}
      className={
        props.primary === true ? 'v5-manager-btn v5-manager-btn--primary' : 'v5-manager-btn'
      }
      disabled={props.disabled}
      aria-busy={props.busy === true}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

function ConfirmManual({ payout }: ActionProps): JSX.Element {
  const cancel = useFocusOnMount<HTMLButtonElement>();
  const disabled = payout.busy !== null;
  return (
    <>
      <Btn
        label={PAYOUT_COPY.cancel}
        disabled={disabled}
        onClick={payout.cancelManual}
        autoFocusRef={cancel}
      />
      <Btn
        label={PAYOUT_COPY.confirmManualYes}
        primary
        busy={payout.busy === 'payout'}
        disabled={disabled}
        onClick={() => void payout.pay('manual')}
      />
    </>
  );
}

/**
 * Complete a started payout: the attested manual payout always; the drawer
 * again only when the last kick provably never reached it (P1).
 */
function CompleteActions({
  payout,
  phase,
}: ActionProps & { phase: Extract<PayoutPhase, { kind: 'drawer_failed' | 'interrupted' }> }) {
  const disabled = payout.busy !== null;
  const interrupted = phase.kind === 'interrupted';
  return (
    <>
      <Btn
        label={interrupted ? PAYOUT_COPY.interruptedManual : PAYOUT_COPY.manual}
        primary={!phase.retryable}
        disabled={disabled}
        onClick={payout.askManual}
      />
      {phase.retryable && (
        <Btn
          label={interrupted ? PAYOUT_COPY.interruptedRetry : PAYOUT_COPY.retryDrawer}
          primary={!interrupted}
          busy={payout.busy === 'payout'}
          disabled={disabled}
          onClick={() => void payout.pay('retry_drawer')}
        />
      )}
    </>
  );
}

/** The one safe set of next steps for the current phase. */
function Actions({ payout }: ActionProps): JSX.Element | null {
  const { phase } = payout.state;
  const disabled = payout.busy !== null;
  switch (phase.kind) {
    case 'ready':
      return (
        <Btn
          label={PAYOUT_COPY.start}
          primary
          busy={payout.busy === 'payout'}
          disabled={disabled}
          onClick={() => void payout.pay('start')}
        />
      );
    case 'drawer_failed':
    case 'interrupted':
      return <CompleteActions payout={payout} phase={phase} />;
    case 'confirm_manual':
      return <ConfirmManual payout={payout} />;
    case 'paid':
      return (
        <Btn
          label={PAYOUT_COPY.reprint}
          busy={payout.busy === 'reprint'}
          disabled={disabled}
          onClick={() => void payout.reprint()}
        />
      );
    case 'unknown':
    case 'wait':
      return (
        <Btn
          label={PAYOUT_COPY.refresh}
          busy={payout.busy === 'refresh'}
          disabled={disabled}
          onClick={() => void payout.refresh()}
        />
      );
    case 'refused':
      return null;
  }
}

function ReprintResult({ payout }: ActionProps): JSX.Element | null {
  const { reprint } = payout.state;
  if (reprint === null) return null;
  return <p>{reprintMessage(reprint)}</p>;
}

function Amount({ ret }: { readonly ret: ReturnJournalView }): JSX.Element {
  const minor = ret.returnTotalMinor;
  return (
    <RefundTotal
      label={PAYOUT_COPY.amountLabel}
      amount={minor === null ? '—' : formatReturnMoney(minor, ret.currencyCode)}
    />
  );
}

function StartedAt({ ret }: { readonly ret: ReturnJournalView }): JSX.Element | null {
  if (ret.payout === null || ret.payout.paidAt !== null) return null;
  return (
    <p className="v5-returns-meta">
      بدأ الصرف:{' '}
      <time dateTime={ret.payout.startedAt}>{formatReturnTime(ret.payout.startedAt)}</time>
    </p>
  );
}

export interface PayoutPanelProps {
  readonly bridge: ReturnsBridgeAPI;
  readonly ret: ReturnJournalView;
  readonly reload: Reload;
}

export function PayoutPanel({ bridge, ret, reload }: PayoutPanelProps): JSX.Element {
  const payout = usePayout(bridge, ret, reload);
  const { phase } = payout.state;
  const tone = toneOf(payout.state);
  return (
    <section className="v5-returns-payout" aria-labelledby="v5-returns-payout-heading">
      <h3 id="v5-returns-payout-heading">{PAYOUT_COPY.heading}</h3>
      <Amount ret={payout.state.ret} />
      <StartedAt ret={payout.state.ret} />
      {/* A persistent polite live region: each new phase is announced. */}
      <div className="v5-notice" data-tone={tone} aria-live="polite" aria-atomic="true">
        <ToneIcon tone={glyphOf(tone)} />
        <div className="v5-notice__text">
          {statusLines(phase).map((line) => (
            <p key={line}>{line}</p>
          ))}
          {payout.busy === 'payout' && <p>{PAYOUT_COPY.opening}</p>}
          <ReprintResult payout={payout} />
        </div>
      </div>
      <div className="v5-returns-actions v5-returns-actions--start">
        <Actions payout={payout} />
      </div>
    </section>
  );
}
