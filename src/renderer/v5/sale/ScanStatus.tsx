import type { JSX } from 'react';
import { useModalDialogOpen } from '../../scan/useModalDialogOpen';
import { V5Icon } from '../foundation/V5Icon';

/**
 * RT-239 (VNext A2, rule 7) — the visible scan-owner status (15 §5 M-S1).
 * Text plus an icon, never colour alone.
 *
 * Three states, all of them true to what the scan guard does:
 *   ready       — a burst is routed to this screen;
 *   dialog      — a modal dialog is open, so a burst is refused (M-S6);
 *   unavailable — this screen has no catalogue to resolve a scan against.
 *
 * M-S1 also lists «المسح متوقف — البحث مفتوح». It is deliberately NOT shown:
 * §3.1 rule 4 routes a burst typed into the search field as a scan, so scanning
 * is not paused while search is open and saying so would be false.
 */
export type ScanStatusKind = 'ready' | 'dialog' | 'unavailable';

const COPY: Readonly<Record<ScanStatusKind, string>> = {
  ready: 'جاهز للمسح',
  dialog: 'المسح متوقف — نافذة مفتوحة',
  unavailable: 'المسح غير متاح',
};

export function ScanStatus(props: { available: boolean }): JSX.Element {
  const dialogOpen = useModalDialogOpen();
  let kind: ScanStatusKind = 'ready';
  if (!props.available) kind = 'unavailable';
  else if (dialogOpen) kind = 'dialog';
  return (
    <p className="v5-live-scan-status" role="status" data-state={kind} data-testid="scan-status">
      <span aria-hidden="true" className="v5-live-scan-status-icon">
        <V5Icon name="scan" />
      </span>
      <span>{COPY[kind]}</span>
    </p>
  );
}
