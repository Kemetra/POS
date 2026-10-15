import { useId, type JSX, type ReactNode } from 'react';

import { formatHumanCount } from '../../../ui/format/human-format';
import { DIAGNOSTICS_COPY } from './diagnostics-copy';
import {
  formatSyncTime,
  freshnessText,
  freshnessView,
  refreshMessage,
  type FreshnessView,
} from './diagnostics-model';
import type {
  CatalogueCountsResponse,
  CatalogueFreshnessResponse,
  CatalogueRefreshResponse,
} from '../../../../shared/bridge-api';
import '../manager.css';

/**
 * RT-503 (VN-S10 S10-6) — the four read-only panels of the diagnostics page
 * (G-6 state 12). Presentation only: the screen owns every bridge call. No
 * token or secret is a prop here, so none can reach the DOM.
 */

function Panel(props: { heading: string; testId: string; children: ReactNode }): JSX.Element {
  const headingId = useId();
  return (
    <section className="v5-manager-panel" aria-labelledby={headingId} data-testid={props.testId}>
      <div className="v5-manager-panel__head">
        <h2 id={headingId}>{props.heading}</h2>
      </div>
      <div className="v5-manager-panel__body">{props.children}</div>
    </section>
  );
}

/** A count with Western digits, isolated left-to-right. */
function Num({ children }: { children: ReactNode }): JSX.Element {
  return <span className="v5-manager-num">{children}</span>;
}

/** Digits inside an Arabic sentence get the same isolated, monospaced treatment. */
function withNumbers(text: string): ReactNode[] {
  return text
    .split(/(\d[\d,]*)/)
    .map((part, i) => (/^\d/.test(part) ? <Num key={i}>{part}</Num> : part));
}

export interface DevicePanelProps {
  paired: {
    tenant_id: string;
    branch_id: string;
    terminal_id: string;
    terminal_label: string;
  } | null;
}

export function DevicePanel({ paired }: DevicePanelProps): JSX.Element {
  const copy = DIAGNOSTICS_COPY.device;
  return (
    <Panel heading={copy.heading} testId="diagnostics-pairing">
      {paired === null ? (
        <p>{copy.notPaired}</p>
      ) : (
        <dl className="v5-manager-facts">
          <dt>{copy.tenant}</dt>
          <dd className="v5-manager-id">{paired.tenant_id}</dd>
          <dt>{copy.branch}</dt>
          <dd className="v5-manager-id">{paired.branch_id}</dd>
          <dt>{copy.terminal}</dt>
          <dd className="v5-manager-id">{paired.terminal_id}</dd>
          <dt>{copy.label}</dt>
          <dd>
            <bdi className="v5-manager-ltr">{paired.terminal_label}</bdi>
          </dd>
        </dl>
      )}
    </Panel>
  );
}

function SyncState({ view }: { view: FreshnessView }): JSX.Element {
  const text = freshnessText(view);
  const at = view.kind === 'synced' || view.kind === 'empty' ? view.at : null;
  return (
    <span data-testid="diagnostics-sync-state">
      {text}
      {text !== null && at !== null ? ' ' : null}
      {at !== null && <time dateTime={at}>{formatSyncTime(at)}</time>}
    </span>
  );
}

export interface SyncPanelProps {
  freshness: CatalogueFreshnessResponse | null;
  refreshKind: CatalogueRefreshResponse['kind'] | null;
  onRefresh: () => void;
}

export function SyncPanel(props: SyncPanelProps): JSX.Element {
  const copy = DIAGNOSTICS_COPY.sync;
  return (
    <Panel heading={copy.heading} testId="diagnostics-sync">
      <dl className="v5-manager-facts">
        <dt>{copy.lastUpdated}</dt>
        <dd>
          <SyncState view={freshnessView(props.freshness)} />
        </dd>
      </dl>
      <div>
        <button
          type="button"
          className="v5-manager-btn"
          data-testid="diagnostics-refresh"
          onClick={props.onRefresh}
        >
          {copy.refresh}
        </button>
      </div>
      <output data-testid="diagnostics-refresh-status">
        {props.refreshKind === null ? '' : refreshMessage(props.refreshKind)}
      </output>
    </Panel>
  );
}

export function CountsPanel({ counts }: { counts: CatalogueCountsResponse | null }): JSX.Element {
  const copy = DIAGNOSTICS_COPY.counts;
  let body: JSX.Element;
  if (counts === null) {
    body = <p>{DIAGNOSTICS_COPY.loading}</p>;
  } else if (counts.kind === 'refused') {
    body = <p>{DIAGNOSTICS_COPY.unavailable}</p>;
  } else {
    body = (
      <dl className="v5-manager-facts">
        <dt>{copy.products}</dt>
        <dd className="v5-manager-num">{formatHumanCount(counts.products)}</dd>
        <dt>{copy.barcodes}</dt>
        <dd className="v5-manager-num">{formatHumanCount(counts.barcodes)}</dd>
      </dl>
    );
  }
  return (
    <Panel heading={copy.heading} testId="diagnostics-counts">
      {body}
    </Panel>
  );
}

export interface SearchPanelProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** The Arabic result line, or null before a search was made. */
  message: string | null;
}

export function SearchPanel(props: SearchPanelProps): JSX.Element {
  const inputId = useId();
  const copy = DIAGNOSTICS_COPY.search;
  return (
    <Panel heading={copy.heading} testId="diagnostics-search">
      <div className="v5-manager-field">
        <label htmlFor={inputId}>{copy.label}</label>
        <input
          id={inputId}
          className="v5-manager-input"
          type="search"
          autoComplete="off"
          value={props.query}
          onChange={(e) => {
            props.onQueryChange(e.target.value);
          }}
        />
      </div>
      <output data-testid="diagnostics-search-results">
        {props.message === null ? '' : withNumbers(props.message)}
      </output>
    </Panel>
  );
}
