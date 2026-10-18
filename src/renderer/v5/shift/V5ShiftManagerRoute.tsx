import type { JSX } from 'react';

import type { Role } from '../../../shared/operator/role';
import type { ShiftCashupBridgeAPI, ShiftStatusView } from '../../../shared/shift-cashup/types';
import { Notice } from '../foundation/Notice';
import { Icon } from '../../icons/Icon';
import { ManagerPinEnrollment } from './ManagerPinEnrollment';
import { useShiftStatus } from './shift-bridge';
import { SHIFT_COPY, shiftRefusalMessage } from './shift-copy';
import { ShiftCard, ShiftMoney, ShiftTime } from './ShiftParts';
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
    <ShiftScreen title={SHIFT_COPY.managerTitle} bridge={bridge} allow={MANAGER_ROLES}>
      {(api) => <ManagerShift bridge={api} />}
    </ShiftScreen>
  );
}

/** RT-658 (G-2): the stranded warning above two cards, the status and the PIN. */
function ManagerShift({ bridge }: Readonly<{ bridge: ShiftCashupBridgeAPI }>): JSX.Element {
  const { state, reload } = useShiftStatus(bridge);
  return (
    <>
      {state.kind === 'status' && hasStranded(state.status) && (
        <div role="alert" data-testid="shift-stranded-warning">
          <Notice tone="warning" announce={false}>
            {SHIFT_COPY.strandedWarning}
          </Notice>
        </div>
      )}
      <div className="v5-shift-mgr-grid">
        <ShiftStatusCard state={state} onReload={reload} />
        <ManagerPinEnrollment bridge={bridge} />
      </div>
    </>
  );
}

type StatusState = ReturnType<typeof useShiftStatus>['state'];

function ShiftStatusCard(
  props: Readonly<{ state: StatusState; onReload: () => void }>,
): JSX.Element {
  const { state } = props;
  if (state.kind === 'loading') {
    return (
      <ShiftCard heading={SHIFT_COPY.statusHeading}>
        <output className="v5-shift-muted" aria-busy="true">
          {SHIFT_COPY.loading}
        </output>
      </ShiftCard>
    );
  }
  if (state.kind === 'refused') {
    return (
      <ShiftCard heading={SHIFT_COPY.statusHeading}>
        <Notice
          tone="warning"
          action={<ReloadButton label={SHIFT_COPY.retry} onClick={props.onReload} />}
        >
          {shiftRefusalMessage(state.reason)}
        </Notice>
      </ShiftCard>
    );
  }
  return (
    <ShiftCard
      heading={SHIFT_COPY.statusHeading}
      action={<ReloadButton label={SHIFT_COPY.refresh} onClick={props.onReload} />}
    >
      <OpenShiftFacts status={state.status} />
      <div className="v5-shift-groups">
        <Counts heading={SHIFT_COPY.queueHeading} rows={queueRows(state.status)} />
        <Counts heading={SHIFT_COPY.strandedHeading} rows={strandedRows(state.status)} />
        <Counts heading={SHIFT_COPY.pendingHeading} rows={pendingRows(state.status)} />
        <Counts heading={SHIFT_COPY.probeHeading} rows={probeRows(state.status)} />
      </div>
    </ShiftCard>
  );
}

function ReloadButton({
  label,
  onClick,
}: Readonly<{ label: string; onClick: () => void }>): JSX.Element {
  return (
    <button type="button" className="v5-shift-btn" onClick={onClick}>
      <Icon name="retry" />
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
      <p className="v5-shift-no-shift">
        <Icon name="shift" />
        {SHIFT_COPY.noOpenShift}
      </p>
    );
  }
  const money = (minor: number): JSX.Element => (
    <ShiftMoney minor={minor} currencyCode={open.currencyCode} />
  );
  return (
    <dl className="v5-shift-figures" data-testid="shift-status-open">
      <div>
        <dt>{SHIFT_COPY.openSince}</dt>
        <dd>
          <ShiftTime iso={open.openedAt} />
        </dd>
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

/** A count group: zero reads quiet, anything else stands out in a framed badge. */
function Counts({ heading, rows }: Readonly<{ heading: string; rows: Row[] }>): JSX.Element {
  return (
    <div className="v5-shift-group">
      <h3>{heading}</h3>
      <dl className="v5-shift-counts">
        {rows.map(([label, count]) => (
          <div key={label}>
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
