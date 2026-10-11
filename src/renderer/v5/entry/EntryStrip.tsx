import { useEffect, useState, type JSX } from 'react';

import type { PairingBridgeAPI } from '../../../shared/bridge-api';
import { V5Icon } from '../foundation/V5Icon';
import { SIGN_IN_COPY } from './entry-copy';

/**
 * RT-244 (VNext W1-D) — the entry screens' context strip: the «POS Pulse»
 * wordmark (OD-5) and, when known, the terminal label.
 *
 * - The terminal label is admin free text, not an id, so it is isolated with
 *   `<bdi>` in the body font.
 * - No branch name: main exposes only `branch_id` to the renderer (RT-246
 *   decision, deferred to a bridge-field issue).
 * - No connection pill: there is no real signal for one (A4 / X-2).
 */
export function EntryStrip({ terminalLabel }: { terminalLabel?: string }): JSX.Element {
  return (
    <header className="v5-entry__bar" data-testid="entry-strip">
      <span className="v5-entry__brand">
        <span className="v5-entry__brand-mark" aria-hidden="true">
          <V5Icon name="cross" size={14} />
        </span>
        <span className="v5-ltr">POS Pulse</span>
      </span>
      {terminalLabel !== undefined && terminalLabel.length > 0 && (
        <>
          <span className="v5-entry__sep" aria-hidden="true" />
          <span className="v5-entry__context" data-testid="entry-terminal-label">
            {SIGN_IN_COPY.terminal}{' '}
            <b>
              <bdi>{terminalLabel}</bdi>
            </b>
          </span>
        </>
      )}
    </header>
  );
}

/**
 * Reads the paired terminal's label once. Best-effort: any failure, or an
 * unpaired terminal, leaves it undefined and the strip shows the wordmark only.
 */
export function useTerminalLabel(pairing: PairingBridgeAPI | undefined): string | undefined {
  const [label, setLabel] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (pairing === undefined) return;
    let cancelled = false;
    pairing
      .getStatus()
      .then((status) => {
        if (!cancelled && status.kind === 'paired') setLabel(status.terminal_label);
      })
      .catch(() => {
        // Decorative context only: a failed read must not block sign-in.
      });
    return () => {
      cancelled = true;
    };
  }, [pairing]);
  return label;
}
