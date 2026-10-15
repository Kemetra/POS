import type { JSX } from 'react';

interface IdentityStripProps {
  tenantId: string;
  branchId: string;
  terminalLabel: string;
}

export function IdentityStrip({
  tenantId,
  branchId,
  terminalLabel,
}: Readonly<IdentityStripProps>): JSX.Element {
  const tenant = tenantId || '—';
  const branch = branchId || '—';
  const label = terminalLabel || '—';

  return (
    <div className="identity-strip">
      <span className="identity-strip__tenant">{tenant}</span>
      <span aria-hidden="true" className="identity-strip__sep">
        ·
      </span>
      <span className="identity-strip__branch">{branch}</span>
      <span aria-hidden="true" className="identity-strip__sep">
        ·
      </span>
      <span className="identity-strip__terminal">{label}</span>
    </div>
  );
}
