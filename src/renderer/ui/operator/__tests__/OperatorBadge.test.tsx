import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { OperatorBadge } from '../OperatorBadge.js';

/**
 * 004-operator-session T020 — OperatorBadge renders display name +
 * role for each role variant (FR-002 / FR-020).
 */

afterEach(() => {
  cleanup();
});

describe('OperatorBadge (T020)', () => {
  it.each([
    // RT-240: Arabic only, the same words as the v5 navigation.
    ['cashier', 'كاشير'],
    ['manager', 'مدير'],
    ['admin', 'مسؤول النظام'],
  ] as const)('renders role=%s as business-name "%s"', (role, expected) => {
    render(<OperatorBadge display_name="Sample Name" role={role} />);
    const badge = screen.getByTestId('operator-badge');
    expect(badge).toHaveTextContent('Sample Name');
    expect(badge).toHaveTextContent(expected);
    expect(badge.querySelector('[data-role]')?.textContent).not.toMatch(/[A-Za-z]/);
    expect(badge.querySelector('[data-role]')).toHaveAttribute('data-role', role);
  });

  it('does not surface tokens, JWTs, or operator ids', () => {
    render(<OperatorBadge display_name="Sample Name" role="manager" />);
    const html = screen.getByTestId('operator-badge').innerHTML;
    expect(html).not.toMatch(/jwt/i);
    expect(html).not.toMatch(/token/i);
    expect(html).not.toMatch(/operator_id/i);
  });
});
