import type { JSX } from 'react';

import type { Role } from '../../../shared/operator/role';
import type { ShiftCashupBridgeAPI, ShiftStatusView } from '../../../shared/shift-cashup/types';
import { V5Icon } from '../foundation/V5Icon';
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
        <div className="v5-shift-manager-screen">
          <ShiftStatusPanel bridge={api} />
          <ManagerPinEnrollment bridge={api} />
        </div>
      )}
    </ShiftScreen>
  );
}

function ShiftStatusPanel({ bridge }: Readonly<{ bridge: ShiftCashupBridgeAPI }>): JSX.Element {
  const { state, reload } = useShiftStatus(bridge);
  if (state.kind === 'loading') {
    return (
      <div className="v5-shift-mgr-panel">
        <p className="v5-shift-mgr-body v5-shift-message">{SHIFT_COPY.loading}</p>
      </div>
    );
  }
  if (state.kind === 'refused') {
    return (
      <div className="v5-shift-mgr-panel">
        <div className="v5-shift-mgr-body">
          <p className="v5-shift-message">{shiftRefusalMessage(state.reason)}</p>
          <ReloadButton label={SHIFT_COPY.retry} onClick={reload} />
        </div>
      </div>
    );
  }
  return (
    <>
      {hasStranded(state.status) ? (
        <div
          className="v5-shift-banner v5-shift-mgr-banner"
          role="alert"
          data-testid="shift-stranded-warning"
        >
          <V5Icon name="status-warning" />
          <p>{SHIFT_COPY.strandedWarning}</p>
        </div>
      ) : null}
      <section className="v5-shift-mgr-panel" aria-labelledby="v5-shift-mgr-status">
        <header className="v5-shift-mgr-head">
          <h2 id="v5-shift-mgr-status">{SHIFT_COPY.statusHeading}</h2>
          <ReloadButton label={SHIFT_COPY.refresh} onClick={reload} />
        </header>
        <div className="v5-shift-mgr-body">
          <OpenShiftFacts status={state.status} />
          <div className="v5-shift-mgr-groups">
            <Counts heading={SHIFT_COPY.queueHeading} rows={queueRows(state.status)} />
            <Counts heading={SHIFT_COPY.strandedHeading} rows={strandedRows(state.status)} />
            <Counts heading={SHIFT_COPY.pendingHeading} rows={pendingRows(state.status)} />
            <Counts heading={SHIFT_COPY.probeHeading} rows={probeRows(state.status)} />
          </div>
        </div>
      </section>
    </>
  );
}

function ReloadButton({
  label,
  onClick,
}: Readonly<{ label: string; onClick: () => void }>): JSX.Element {
  return (
    <button type="button" className="v5-shift-btn v5-shift-mgr-reload" onClick={onClick}>
      <V5Icon name="retry" size={18} />
      {label}
    </button>
  );
}

/** Records outside this pairing exist: unsent facts or a shift left open. */
function hasStranded({ stranded }: ShiftStatusView): boolean {
  return stranded.unsyncedFacts > 0 || stranded.openShifts > 0;
}

function OpenShiftFacts({ status }: Readonly<{ status: ShiftStatusView }>): JSX.Element {
  const open = status.openShift;
  if (open === null) {
    return (
      <p className="v5-shift-mgr-closed">
        <V5Icon name="manager-shift" />
        {SHIFT_COPY.noOpenShift}
      </p>
    );
  }
  const money = (minor: number): JSX.Element => (
    <span className="v5-ltr v5-shift-money">{formatShiftMoney(minor, open.currencyCode)}</span>
  );
  return (
    <dl className="v5-shift-mgr-open" data-testid="shift-status-open">
      <div>
        <dt>{SHIFT_COPY.openSince}</dt>
        <dd className="v5-ltr">{formatShiftTime(open.openedAt)}</dd>
      </div>
      <div>
        <dt>{SHIFT_COPY.floatRow}</dt>
        <dd>{money(open.openingFloatMinor)}</dd>
      </div>
      <div>
        <dt>{SHIFT_COPY.payInsRow}</dt>
        <dd>{money(open.payInTotalMinor)}</dd>
      </div>
      <div>
        <dt>{SHIFT_COPY.payOutsRow}</dt>
        <dd>{money(open.payOutTotalMinor)}</dd>
      </div>
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

/** A count group: zero reads quiet, anything else stands out in a neutral badge. */
function Counts({ heading, rows }: Readonly<{ heading: string; rows: Row[] }>): JSX.Element {
  return (
    <div className="v5-shift-mgr-group">
      <h3>{heading}</h3>
      <dl className="v5-shift-mgr-counts">
        {rows.map(([label, count]) => (
          <div key={label} className="v5-shift-mgr-count">
            <dt>{label}</dt>
            <dd className="v5-ltr" data-zero={count === 0 ? 'true' : undefined}>
              {count}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
