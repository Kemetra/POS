import type { JSX } from 'react';

import type { ReturnsBridgeAPI } from '../../shared/returns/types.js';
import type { SessionEvents } from './returns-bridge.js';
import { LinePicker } from './LinePicker';
import { RefundSummary } from './RefundSummary';
import { ReturnOutcome, type PayoutDeps } from './ReturnOutcome';
import { ReturnsHistory } from './ReturnsHistory';
import { SaleLookup } from './SaleLookup';
import type { Outcome } from './return-flow-state.js';
import { useReturnFlow, type ReturnFlow } from './useReturnFlow.js';
import { useHistoryReprint } from './useHistoryReprint.js';
import { useReturnHistory } from './useReturnHistory.js';

/**
 * RT-15 S3 — the return flow (one step at a time) above this terminal's
 * return journal. RT-15 S4: a confirmed outcome carries its payout; the
 * journal offers pay out / complete / reprint per row.
 */
export interface ReturnsScreenProps {
  readonly bridge: ReturnsBridgeAPI;
  /** Unlock re-reads the journal (H4); null when no push is available. */
  readonly sessionEvents: SessionEvents | null;
}

function outcomeKey(outcome: Outcome): string {
  if (outcome.kind === 'failed') return 'failed';
  return outcome.ret?.returnId ?? 'none';
}

function FlowStep({
  flow,
  payout,
}: {
  readonly flow: ReturnFlow;
  readonly payout: PayoutDeps;
}): JSX.Element {
  const { state } = flow;
  switch (state.step) {
    case 'lookup':
      return <SaleLookup flow={flow} notice={state.notice} />;
    case 'select':
      return <LinePicker flow={flow} state={state} />;
    case 'summary':
      return <RefundSummary flow={flow} state={state} />;
    case 'outcome':
      // Keyed by the return: opening another return's payout starts afresh.
      return (
        <ReturnOutcome
          key={outcomeKey(state.outcome)}
          flow={flow}
          outcome={state.outcome}
          payout={payout}
        />
      );
  }
}

export function ReturnsScreen({ bridge, sessionEvents }: ReturnsScreenProps): JSX.Element {
  const history = useReturnHistory(bridge, sessionEvents);
  const flow = useReturnFlow(bridge, history.reload);
  const reprint = useHistoryReprint(bridge);
  return (
    <>
      <FlowStep flow={flow} payout={{ bridge, reload: history.reload }} />
      <ReturnsHistory history={history} actions={{ pay: flow.openPayout, reprint }} />
    </>
  );
}
