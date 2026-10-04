import type { JSX } from 'react';

import type { ReturnsBridgeAPI } from '../../shared/returns/types.js';
import type { SessionEvents } from './returns-bridge.js';
import { LinePicker } from './LinePicker';
import { RefundSummary } from './RefundSummary';
import { ReturnOutcome } from './ReturnOutcome';
import { ReturnsHistory } from './ReturnsHistory';
import { SaleLookup } from './SaleLookup';
import { useReturnFlow, type ReturnFlow } from './useReturnFlow.js';
import { useReturnHistory } from './useReturnHistory.js';

/**
 * RT-15 S3 — the return flow (one step at a time) above this terminal's
 * return journal. No payout, drawer or slip control lives here (S4).
 */
export interface ReturnsScreenProps {
  readonly bridge: ReturnsBridgeAPI;
  /** Unlock re-reads the journal (H4); null when no push is available. */
  readonly sessionEvents: SessionEvents | null;
}

function FlowStep({ flow }: { readonly flow: ReturnFlow }): JSX.Element {
  const { state } = flow;
  switch (state.step) {
    case 'lookup':
      return <SaleLookup flow={flow} notice={state.notice} />;
    case 'select':
      return <LinePicker flow={flow} state={state} />;
    case 'summary':
      return <RefundSummary flow={flow} state={state} />;
    case 'outcome':
      return <ReturnOutcome flow={flow} outcome={state.outcome} />;
  }
}

export function ReturnsScreen({ bridge, sessionEvents }: ReturnsScreenProps): JSX.Element {
  const history = useReturnHistory(bridge, sessionEvents);
  const flow = useReturnFlow(bridge, history.reload);
  return (
    <>
      <FlowStep flow={flow} />
      <ReturnsHistory history={history} />
    </>
  );
}
