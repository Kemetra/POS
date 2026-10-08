import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';

import { AuditPlaceholder } from '../AuditPlaceholder';

/**
 * POS v3.5 Slice 1 — thin "coming soon" placeholder for the Audit nav entry
 * (a later display slice). Same contract as the other placeholders (T037):
 * renders default state, no fetch/IPC/persistence on mount. (The Returns
 * placeholder was replaced by the RT-15 S3 return flow.)
 */

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

describe('AuditPlaceholder', () => {
  it('renders the Audit heading and coming-soon copy', () => {
    render(
      <MemoryRouter>
        <AuditPlaceholder />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /audit/i })).toBeInTheDocument();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('makes zero fetch calls on mount', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter>
        <AuditPlaceholder />
      </MemoryRouter>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
