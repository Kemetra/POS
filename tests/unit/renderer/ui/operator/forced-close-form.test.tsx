import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { ForcedCloseForm } from '../../../../../src/renderer/ui/operator/ForcedCloseSurface.js';
import {
  FORCED_CLOSE_REASONS,
  type ForcedCloseReason,
} from '../../../../../src/shared/audit/payload-schemas.js';
import { STUCK_SHIFTS_COPY } from '../../../../../src/renderer/v5/manager/stuck-shifts/stuck-shifts-copy.js';

/**
 * 004-operator-session T084 — ForcedCloseForm reason picker tests.
 *
 * Verifies:
 *   - Submit is disabled until a reason radio is selected.
 *   - Exactly the five enumerated FORCED_CLOSE_REASONS values are present.
 *   - No reason outside the enum is rendered.
 *   - Selecting each reason enables submit.
 *   - Free-text annotation is captured in payload.annotation.
 *   - payload.forced_close_reason contains only the ForcedCloseReason value,
 *     never the annotation text.
 *   - No financial fields are present in the submit payload.
 *   - No financial or PII fields are rendered.
 *
 * RT-502 (VN-S10 S10-5): the form is the v5 dialog's Arabic form, re-exported
 * from `ui/operator`. The commit is «إغلاق الوردية»; each reason is labelled
 * in Arabic while its radio value stays the enum member.
 */

const COMMIT = { name: STUCK_SHIFTS_COPY.close };

afterEach(() => {
  cleanup();
});

function setup(
  onSubmit?: (payload: { forced_close_reason: ForcedCloseReason; annotation?: string }) => void,
) {
  const handler = onSubmit ?? vi.fn();
  render(<ForcedCloseForm onSubmit={handler} onCancel={vi.fn()} />);
  return { onSubmit: handler };
}

describe('ForcedCloseForm — initial state', () => {
  it('submit button is disabled before any reason is selected', () => {
    setup();
    const btn = screen.getByRole('button', COMMIT);
    expect(btn).toBeDisabled();
  });

  it('renders exactly five reason radios', () => {
    setup();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(5);
  });

  it('renders all five FORCED_CLOSE_REASONS values', () => {
    setup();
    for (const reason of FORCED_CLOSE_REASONS) {
      expect(screen.getByDisplayValue(reason)).toBeInTheDocument();
    }
  });

  it('labels each reason in Arabic; the radio value stays the enum member', () => {
    setup();
    for (const reason of FORCED_CLOSE_REASONS) {
      expect(
        screen.getByRole('radio', { name: STUCK_SHIFTS_COPY.reasons[reason] }),
      ).toHaveAttribute('value', reason);
    }
  });

  it('no radio is checked initially', () => {
    setup();
    const radios = screen.getAllByRole('radio');
    for (const radio of radios) {
      expect(radio).not.toBeChecked();
    }
  });
});

describe('ForcedCloseForm — reason selection enables submit', () => {
  for (const reason of FORCED_CLOSE_REASONS) {
    it(`selecting "${reason}" enables submit`, async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.click(screen.getByDisplayValue(reason));
      const btn = screen.getByRole('button', COMMIT);
      expect(btn).toBeEnabled();
    });
  }
});

describe('ForcedCloseForm — submit payload correctness', () => {
  it('payload.forced_close_reason equals the selected reason', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSubmit } = setup(vi.fn());
    await user.click(screen.getByDisplayValue('cashier_no_show'));
    await user.click(screen.getByRole('button', COMMIT));
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = (onSubmit as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      forced_close_reason: ForcedCloseReason;
      annotation?: string;
    };
    expect(payload.forced_close_reason).toBe('cashier_no_show');
  });

  it('annotation text appears in payload.annotation, not in forced_close_reason', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSubmit } = setup(vi.fn());
    await user.click(screen.getByDisplayValue('other'));
    const annotationInput = screen.getByRole('textbox');
    await user.type(annotationInput, 'Cashier left early without notice');
    await user.click(screen.getByRole('button', COMMIT));
    expect(onSubmit).toHaveBeenCalledOnce();
    const payload = (onSubmit as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      forced_close_reason: ForcedCloseReason;
      annotation?: string;
    };
    expect(payload.forced_close_reason).toBe('other');
    expect(payload.annotation).toBe('Cashier left early without notice');
    expect(payload.forced_close_reason).not.toContain('Cashier left early');
  });

  it('payload without annotation omits annotation key or sets it undefined', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSubmit } = setup(vi.fn());
    await user.click(screen.getByDisplayValue('terminal_failure'));
    await user.click(screen.getByRole('button', COMMIT));
    const payload = (onSubmit as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      forced_close_reason: ForcedCloseReason;
      annotation?: string;
    };
    expect(payload.forced_close_reason).toBe('terminal_failure');
    expect(payload.annotation == null || payload.annotation === '').toBe(true);
  });

  it('payload does not include any financial or PII fields', async () => {
    const user = userEvent.setup({ delay: null });
    const { onSubmit } = setup(vi.fn());
    await user.click(screen.getByDisplayValue('cashier_illness'));
    await user.click(screen.getByRole('button', COMMIT));
    const payload = (onSubmit as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    const forbidden = [
      'drawer_count',
      'expected_total',
      'variance',
      'shortage',
      'overage',
      'cash_in',
      'cash_out',
      'declared_count',
      'balance',
      'shift_total',
      'cashier_id',
      'operator_id',
      'user_id',
      'device_id',
      'tenant_id',
      'branch_id',
      'terminal_id',
      'email',
      'pin',
    ];
    for (const key of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(payload, key)).toBe(false);
    }
  });
});

describe('ForcedCloseForm — forbidden rendered content', () => {
  const FINANCIAL_FORBIDDEN = [
    /drawer/i,
    /expected.?total/i,
    /variance/i,
    /shortage/i,
    /overage/i,
    /cash.?count/i,
    /reconcil/i,
    /balance/i,
  ];

  FINANCIAL_FORBIDDEN.forEach((pattern) => {
    it(`does not render financial label matching ${String(pattern)}`, () => {
      const { container } = render(<ForcedCloseForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
      expect(container.textContent).not.toMatch(pattern);
    });
  });
});
