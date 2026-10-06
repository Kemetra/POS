import type { JSX } from 'react';

import type { Role } from '../../../shared/operator/role';
import type { ShiftCashupBridgeAPI, ShiftStatusView } from '../../../shared/shift-cashup/types';
import { ManagerPinEnrollment } from './ManagerPinEnrollment';
import { useShiftStatus } from './shift-bridge';
import { SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { formatShiftMoney, formatShiftTime } from './shift-format';
import { ShiftScreen } from './ShiftScreen';

interface Props {
  /** Tests inject a bridge (null = none); production reads `window.api`. */
  readonly bridge?: ShiftCashupBridgeAPI | null;
}

const MANAGER_ROLES: ReadonlyArray<Role> = ['manager', 'admin'];

/**
 * RT-17 slice 4 part 3 — `/app/shift/manager`: the shift status (open shift,
 * the sync queue, facts stranded outside the pairing, drawer activity in
 * flight and the probe refusal counts) and the manager's own PIN enrolment.
 * Manager / admin only: the router guards the route and this screen leaves
 * for `/app` for any other role, before any call.
 */
export function V5ShiftManagerRoute({ bridge }: Props): JSX.Element | null {
  return (
    <ShiftScreen
      title={SHIFT_COPY.managerTitle}
      titleId="v5-shift-manager-title"
      bridge={bridge}
      allow={MANAGER_ROLES}
    >
      {(api) => (
        <div className="v5-shift-columns">
          <ShiftStatusPanel bridge={api} />
          <ManagerPinEnrollment bridge={api} />
        </div>
      )}
    </ShiftScreen>
  );
}

function ShiftStatusPanel({ bridge }: { bridge: ShiftCashupBridgeAPI }): JSX.Element {
  const { state, reload } = useShiftStatus(bridge);
  if (state.kind === 'loading') {
    return <p className="v5-shift-message">{SHIFT_COPY.loading}</p>;
  }
  if (state.kind === 'refused') {
    return (
      <div className="v5-shift-panel">
        <p className="v5-shift-message">{shiftRefusalMessage(state.reason)}</p>
        <button type="button" className="v5-shift-btn" onClick={reload}>
          {SHIFT_COPY.retry}
        </button>
      </div>
    );
  }
  return (
    <div className="v5-shift-panel">
      <h2>{SHIFT_COPY.statusHeading}</h2>
      {hasStranded(state.status) ? (
        <div className="v5-shift-banner" role="alert" data-testid="shift-stranded-warning">
          <p>{SHIFT_COPY.strandedWarning}</p>
        </div>
      ) : null}
      <OpenShiftFacts status={state.status} />
      <Counts heading={SHIFT_COPY.queueHeading} rows={queueRows(state.status)} />
      <Counts heading={SHIFT_COPY.strandedHeading} rows={strandedRows(state.status)} />
      <Counts heading={SHIFT_COPY.pendingHeading} rows={pendingRows(state.status)} />
      <Counts heading={SHIFT_COPY.probeHeading} rows={probeRows(state.status)} />
      <button type="button" className="v5-shift-btn" onClick={reload}>
        {SHIFT_COPY.refresh}
      </button>
    </div>
  );
}

/** Records outside this pairing exist: unsent facts or a shift left open. */
function hasStranded({ stranded }: ShiftStatusView): boolean {
  return stranded.unsyncedFacts > 0 || stranded.openShifts > 0;
}

function OpenShiftFacts({ status }: { status: ShiftStatusView }): JSX.Element {
  const open = status.openShift;
  if (open === null) return <p className="v5-shift-message">{SHIFT_COPY.noOpenShift}</p>;
  const money = (minor: number): JSX.Element => (
    <span className="v5-ltr v5-shift-money">{formatShiftMoney(minor, open.currencyCode)}</span>
  );
  return (
    <dl className="v5-shift-facts" data-testid="shift-status-open">
      <dt>{SHIFT_COPY.openSince}</dt>
      <dd className="v5-ltr">{formatShiftTime(open.openedAt)}</dd>
      <dt>{SHIFT_COPY.floatRow}</dt>
      <dd>{money(open.openingFloatMinor)}</dd>
      <dt>{SHIFT_COPY.payInsRow}</dt>
      <dd>{money(open.payInTotalMinor)}</dd>
      <dt>{SHIFT_COPY.payOutsRow}</dt>
      <dd>{money(open.payOutTotalMinor)}</dd>
    </dl>
  );
}

type Row = readonly [label: string, count: number];

const queueRows = ({ queue }: ShiftStatusView): Row[] => [
  [SHIFT_COPY.queuePending, queue.pending],
  [SHIFT_COPY.queueWaiting, queue.waiting],
  [SHIFT_COPY.queueBlocked, queue.blocked],
  [SHIFT_COPY.queueEnvelope, queue.envelopePending],
];

const strandedRows = ({ stranded }: ShiftStatusView): Row[] => [
  [SHIFT_COPY.strandedFacts, stranded.unsyncedFacts],
  [SHIFT_COPY.strandedShifts, stranded.openShifts],
];

const pendingRows = ({ pendingDrawerActivity }: ShiftStatusView): Row[] => [
  [SHIFT_COPY.pendingRefunds, pendingDrawerActivity.refundPayouts],
  [SHIFT_COPY.pendingSales, pendingDrawerActivity.unfinalizedSales],
];

const probeRows = ({ probeRefusals }: ShiftStatusView): Row[] => [
  [SHIFT_COPY.probePayOut, probeRefusals.payOut],
  [SHIFT_COPY.probeVariance, probeRefusals.varianceClose],
  [SHIFT_COPY.probeApprover, probeRefusals.approverFailure],
];

function Counts({ heading, rows }: { heading: string; rows: Row[] }): JSX.Element {
  return (
    <>
      <h3>{heading}</h3>
      <dl className="v5-shift-facts">
        {rows.map(([label, count]) => (
          <div key={label} className="v5-shift-fact">
            <dt>{label}</dt>
            <dd className="v5-ltr">{count}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
