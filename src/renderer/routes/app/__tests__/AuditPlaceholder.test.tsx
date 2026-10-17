import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { AuditPlaceholder } from '../AuditPlaceholder';
import { expectNoAxeViolations } from '../../../test-utils/axe-config';

/**
 * RT-503 (VN-S10 S10-6, G-6 state 10) — the Audit nav entry says, honestly and
 * in Arabic, that the audit log is not shown on this terminal. It implies no
 * log exists, and makes no fetch/IPC/persistence call.
 */

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

function renderAudit(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <AuditPlaceholder />
    </MemoryRouter>,
  );
}

describe('AuditPlaceholder', () => {
  it('titles the page «سجل المراجعة» with the honest neutral notice', () => {
    renderAudit();
    expect(screen.getByRole('heading', { level: 1, name: 'سجل المراجعة' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('سجل المراجعة لا يُعرض على هذا الجهاز.');
  });

  it('shows no English copy, no «Coming soon», and no link or button', () => {
    const { container } = renderAudit();
    expect(container.textContent).not.toMatch(/[A-Za-z]/);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('makes zero fetch calls on mount', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderAudit();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is axe-clean', async () => {
    const { container } = renderAudit();
    await expectNoAxeViolations(container);
  });
});
