import { useState, type JSX } from 'react';

import { ReturnNotice } from './ReturnNotice';
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
  const input = useFocusOnMount<HTMLInputElement>();
  const busy = flow.busy === 'lookup';

  return (
    <section className="rt-returns__panel" aria-labelledby="rt-returns-lookup">
      <h2 id="rt-returns-lookup" className="rt-returns__heading">
        البحث عن بيع
      </h2>
      <form
        className="rt-returns__lookup"
        onSubmit={(e) => {
          e.preventDefault();
          void flow.lookup(value);
        }}
      >
        <label className="rt-returns__field">
          <span>رقم البيع</span>
          <input
            ref={input}
            value={value}
            dir="ltr"
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </label>
        <button type="submit" className="rt-btn rt-btn--primary" disabled={busy} aria-busy={busy}>
          بحث
        </button>
      </form>
      <ReturnNotice notice={notice} />
    </section>
  );
}
