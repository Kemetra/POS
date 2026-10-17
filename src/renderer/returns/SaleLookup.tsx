import { useId, useState, type JSX } from 'react';

import { ReturnNotice } from './ReturnNotice';
import { ReturnsPanel } from './ReturnsPanel';
import type { FlowNotice } from './return-flow-state.js';
import { useFocusOnMount } from './useFocusOnMount.js';
import type { ReturnFlow } from './useReturnFlow.js';

/**
 * RT-15 S3 — step 1: find the original sale by its local sale number (D-d).
 * Enter submits the lookup (a read, not a financial confirmation).
 */
export interface SaleLookupProps {
  readonly flow: ReturnFlow;
  readonly notice: FlowNotice | null;
}

export function SaleLookup({ flow, notice }: SaleLookupProps): JSX.Element {
  const [value, setValue] = useState('');
  const inputId = useId();
  const input = useFocusOnMount<HTMLInputElement>();
  const busy = flow.busy === 'lookup';

  return (
    <ReturnsPanel id="v5-returns-lookup" title="البحث عن بيع">
      <div className="v5-manager-panel__body">
        <form
          className="v5-returns-lookup"
          onSubmit={(e) => {
            e.preventDefault();
            void flow.lookup(value);
          }}
        >
          <div className="v5-manager-field">
            <label htmlFor={inputId}>رقم البيع</label>
            <input
              id={inputId}
              ref={input}
              className="v5-manager-input v5-manager-input--code"
              value={value}
              dir="ltr"
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setValue(e.target.value);
              }}
            />
          </div>
          <button
            type="submit"
            className="v5-manager-btn v5-manager-btn--primary"
            disabled={busy}
            aria-busy={busy}
          >
            بحث
          </button>
        </form>
        <ReturnNotice notice={notice} />
      </div>
    </ReturnsPanel>
  );
}
