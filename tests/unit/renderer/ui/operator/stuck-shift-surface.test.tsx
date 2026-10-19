import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { StuckShiftSurface } from '../../../../../src/renderer/ui/operator/ForcedCloseSurface.js';
import type {
  OperatorBridgeAPI,
  ListStuckShiftsResponse,
  StuckShiftSummary,
} from '../../../../../src/shared/bridge-api.js';
import { STUCK_SHIFTS_COPY as COPY } from '../../../../../src/renderer/v5/manager/stuck-shifts/stuck-shifts-copy.js';
import { SHIFT_COPY } from '../../../../../src/renderer/v5/shift/shift-copy.js';

/**
 * 004-operator-session T090 — StuckShiftSurface orchestration tests.
 *
 * Verifies:
 *  - Loading state rendered while fetching.
 *  - Empty state shown when no stuck shifts.
 *  - Error state shown with retry when backend fails.
 *  - Card list rendered for stuck shifts; card-stack (div), no table.
 *  - null display_name falls back to "Cashier ···".
 *  - duration_minutes formatting: < 1 → "< 1 min"; < 60 → "X min"; ≥ 60 → "X h Y min".
 *  - Clicking a card opens the forced-close dialog.
 *  - Submitting form calls forceCloseShift with correct args.
 *  - On forced_closed: dialog closes and card removed from list.
 *  - On state_invalid: error message shown and list refetched.
 *  - FR-024 blind-close: no financial fields in DOM.
 *  - FR-013 minimum-disclosure: no identity/credential fields in DOM.
 *
 * RT-502 (VN-S10 S10-5): ported to the v5 screen. Same calls, refusal
 * branches and refetch counts; the copy is the frozen G-6 Arabic, each card
 * holds a real «إغلاق الوردية» button (it replaces the role="button" card),
 * and the dialog's commit and Cancel are «إغلاق الوردية» / «إلغاء».
 */

/** The «إغلاق الوردية» button inside a shift's card. */
function cardButton(shiftId: string): HTMLElement {
  return within(screen.getByTestId(`stuck-shift-card-${shiftId}`)).getByRole('button', {
    name: COPY.close,
  });
}

/** RT-554 (b): the manager's blind count, typed into the dialog's count field. */
async function enterCount(value = '500'): Promise<void> {
  await userEvent.type(screen.getByLabelText(SHIFT_COPY.countLabel), value);
}

/** A button of the dialog itself (the row buttons share the commit's name). */
function dialogButton(name: string): HTMLElement {
  return within(screen.getByRole('dialog')).getByRole('button', { name });
}

const SHIFT_0 = {
  shift_id: 'shift-111',
  cashier_display_name: 'Nour Al-Hassan',
  terminal_label: 'Terminal 3 — Pharmacy',
  opened_at: '2026-05-12T08:30:00.000Z',
  duration_minutes: 47,
};

const SHIFT_1 = {
  shift_id: 'shift-222',
  cashier_display_name: 'Ali Saad',
  terminal_label: 'Terminal 1',
  opened_at: '2026-05-12T07:00:00.000Z',
  duration_minutes: 90,
};

const SAMPLE_SHIFTS = [SHIFT_0, SHIFT_1];

function makeOperator(
  listResult: ListStuckShiftsResponse,
  forceResult: Awaited<ReturnType<OperatorBridgeAPI['forceCloseShift']>> = {
    kind: 'forced_closed',
    audit_event_id: 'evt-1',
    delivery: 'sent',
  },
): Pick<OperatorBridgeAPI, 'listStuckShifts' | 'forceCloseShift'> {
  return {
    listStuckShifts: vi.fn(() => Promise.resolve(listResult)),
    forceCloseShift: vi.fn(() => Promise.resolve(forceResult)),
  };
}

afterEach(() => {
  cleanup();
});

// ─── Loading state ────────────────────────────────────────────────────────────

describe('StuckShiftSurface — loading state', () => {
  it('renders a loading indicator while fetching', () => {
    let resolve!: (r: ListStuckShiftsResponse) => void;
    const pending = new Promise<ListStuckShiftsResponse>((res) => {
      resolve = res;
    });
    const op = {
      listStuckShifts: vi.fn(() => pending),
      forceCloseShift: vi.fn(),
    } as unknown as Pick<OperatorBridgeAPI, 'listStuckShifts' | 'forceCloseShift'>;

    render(<StuckShiftSurface operator={op} />);
    expect(screen.getByTestId('stuck-shift-surface-loading')).toBeInTheDocument();

    resolve({ kind: 'stuck_shifts', shifts: [] });
  });
});

// ─── Empty state ──────────────────────────────────────────────────────────────

describe('StuckShiftSurface — empty state', () => {
  it('renders empty state when no stuck shifts', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: [] });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => {
      expect(screen.getByTestId('stuck-shift-surface-empty')).toBeInTheDocument();
    });
  });
});

// ─── Error state ──────────────────────────────────────────────────────────────

describe('StuckShiftSurface — error state', () => {
  it('renders error state on no_connection', async () => {
    const op = makeOperator({ kind: 'refused', category: 'no_connection' });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => {
      expect(screen.getByTestId('stuck-shift-surface-error')).toBeInTheDocument();
    });
  });

  it('renders error state on refused/invalid_input', async () => {
    const op = makeOperator({ kind: 'refused', category: 'invalid_input' });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => {
      expect(screen.getByTestId('stuck-shift-surface-error')).toBeInTheDocument();
    });
  });

  it('retry button calls listStuckShifts again', async () => {
    const op = makeOperator({ kind: 'refused', category: 'no_connection' });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByTestId('stuck-shift-surface-error'));

    const retryBtn = screen.getByRole('button', { name: COPY.retry });
    await userEvent.click(retryBtn);

    expect(op.listStuckShifts).toHaveBeenCalledTimes(2);
  });
});

// ─── Card list ────────────────────────────────────────────────────────────────

describe('StuckShiftSurface — card list rendering', () => {
  it('renders a card for each stuck shift', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: SAMPLE_SHIFTS });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => {
      expect(screen.getByText('Nour Al-Hassan')).toBeInTheDocument();
      expect(screen.getByText('Ali Saad')).toBeInTheDocument();
    });
  });

  it('renders terminal labels', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: SAMPLE_SHIFTS });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => {
      expect(screen.getByText('Terminal 3 — Pharmacy')).toBeInTheDocument();
    });
  });

  it('uses div card-stack layout, not a table', async () => {
    const { container } = render(
      <StuckShiftSurface
        operator={makeOperator({ kind: 'stuck_shifts', shifts: SAMPLE_SHIFTS })}
      />,
    );

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('thead')).toBeNull();
    expect(container.querySelector('tbody')).toBeNull();
    expect(container.querySelector('tr')).toBeNull();
  });
});

// ─── Display name fallback ────────────────────────────────────────────────────

describe('StuckShiftSurface — null display_name fallback', () => {
  it('renders «كاشير بلا اسم» when display_name is null', async () => {
    const shifts = [
      {
        shift_id: 'shift-null',
        cashier_display_name: null as unknown as string,
        terminal_label: 'T1',
        opened_at: '2026-05-12T08:00:00.000Z',
        duration_minutes: 5,
      },
    ];
    const op = makeOperator({ kind: 'stuck_shifts', shifts });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => {
      expect(screen.getByText(COPY.unnamed)).toBeInTheDocument();
    });
  });

  it('renders «كاشير بلا اسم» when display_name is empty string', async () => {
    const shifts = [
      {
        shift_id: 'shift-empty',
        cashier_display_name: '',
        terminal_label: 'T1',
        opened_at: '2026-05-12T08:00:00.000Z',
        duration_minutes: 5,
      },
    ];
    const op = makeOperator({ kind: 'stuck_shifts', shifts });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => {
      expect(screen.getByText(COPY.unnamed)).toBeInTheDocument();
    });
  });
});

// ─── Duration formatting ──────────────────────────────────────────────────────

describe('StuckShiftSurface — duration formatting', () => {
  async function renderWithDuration(duration_minutes: number): Promise<void> {
    const shifts = [
      {
        shift_id: 'shift-dur',
        cashier_display_name: 'Test',
        terminal_label: 'T1',
        opened_at: '2026-05-12T08:00:00.000Z',
        duration_minutes,
      },
    ];
    render(<StuckShiftSurface operator={makeOperator({ kind: 'stuck_shifts', shifts })} />);
    await waitFor(() => screen.getByText('Test'));
  }

  it.each([
    { minutes: 0, label: 'أقل من دقيقة', text: 'مفتوحة منذ أقل من دقيقة' },
    { minutes: 47, label: '47 دقيقة', text: 'مفتوحة منذ 47 دقيقة' },
    { minutes: 60, label: 'ساعة', text: 'مفتوحة منذ ساعة' },
    { minutes: 90, label: 'ساعة و30 دقيقة', text: 'مفتوحة منذ ساعة و30 دقيقة' },
    { minutes: 125, label: 'ساعتين و5 دقائق', text: 'مفتوحة منذ ساعتين و5 دقائق' },
  ])('formats duration $minutes as «$label»', async ({ minutes, text }) => {
    await renderWithDuration(minutes);
    expect(screen.getByText(text)).toBeInTheDocument();
    cleanup();
  });
});

// ─── Dialog flow ──────────────────────────────────────────────────────────────

type Answer = Awaited<ReturnType<OperatorBridgeAPI['forceCloseShift']>>;

/** Opens `shiftId`'s dialog, picks a reason, types the blind count and commits. */
async function closeThroughDialog(shiftId: string): Promise<void> {
  await userEvent.click(cardButton(shiftId));
  await userEvent.click(screen.getByRole('radio', { name: COPY.reasons.cashier_no_show }));
  await enterCount();
  await userEvent.click(dialogButton(COPY.close));
}

/**
 * Renders the surface over `shifts`, force-closes SHIFT_0 with a count, and answers
 * with `answer` (RT-554). The one path every outcome test below takes.
 */
async function submitClose(
  answer: Answer,
  shifts: StuckShiftSummary[] = [SHIFT_0],
  op: Pick<OperatorBridgeAPI, 'listStuckShifts' | 'forceCloseShift'> = makeOperator(
    { kind: 'stuck_shifts', shifts },
    answer,
  ),
): Promise<Pick<OperatorBridgeAPI, 'listStuckShifts' | 'forceCloseShift'>> {
  render(<StuckShiftSurface operator={op} />);
  await waitFor(() => screen.getByText('Nour Al-Hassan'));
  await closeThroughDialog('shift-111');
  return op;
}

/**
 * The refusal outcome tests share one shape: its own copy, never another's, and
 * `reads` list reads in all (1 = no re-read; `state_invalid` and `not_closable_here`
 * re-read, the refusals that leave the shift where it was do not).
 */
async function expectRefusalCopy(input: {
  op: Awaited<ReturnType<typeof submitClose>>;
  copy: string;
  never: readonly string[];
  reads?: number;
}): Promise<void> {
  const error = await screen.findByTestId('stuck-shift-submit-error');
  expect(error).toHaveTextContent(input.copy);
  for (const other of input.never) {
    expect(error).not.toHaveTextContent(other);
  }
  // The shift is still stuck on the backend: the (re-read) list still shows its card.
  await waitFor(() => {
    expect(input.op.listStuckShifts).toHaveBeenCalledTimes(input.reads ?? 1);
  });
  expect(await screen.findByTestId('stuck-shift-card-shift-111')).toBeInTheDocument();
}

describe('StuckShiftSurface — dialog flow', () => {
  it('clicking a card opens the forced-close dialog', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: [SHIFT_0] });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    await userEvent.click(cardButton('shift-111'));

    expect(screen.getByTestId('forced-close-form')).toBeInTheDocument();
  });

  it('dialog cancel button closes dialog without calling forceCloseShift', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: [SHIFT_0] });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    await userEvent.click(cardButton('shift-111'));
    expect(screen.getByTestId('forced-close-form')).toBeInTheDocument();

    await userEvent.click(dialogButton(COPY.cancel));

    expect(screen.queryByTestId('forced-close-form')).toBeNull();
    expect(op.forceCloseShift).not.toHaveBeenCalled();
  });

  it('submitting form calls forceCloseShift with shift_id and reason', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: [SHIFT_0] });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    await userEvent.click(cardButton('shift-111'));

    // Select a reason
    const radioInput = screen.getByRole('radio', { name: COPY.reasons.takeover_supersession });
    await userEvent.click(radioInput);
    await enterCount();

    // Submit
    await userEvent.click(dialogButton(COPY.close));

    await waitFor(() => {
      expect(op.forceCloseShift).toHaveBeenCalledOnce();
    });

    expect(vi.mocked(op.forceCloseShift)).toHaveBeenCalledWith(
      expect.objectContaining({
        shift_id: 'shift-111',
        reason: 'takeover_supersession',
        counted_cash_minor: 50_000,
        event_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        ) as string,
      }),
    );
  });

  it('on forced_closed: dialog closes and card removed from list', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: SAMPLE_SHIFTS });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    await userEvent.click(cardButton('shift-111'));
    await userEvent.click(screen.getByRole('radio', { name: COPY.reasons.cashier_no_show }));
    await enterCount();
    await userEvent.click(dialogButton(COPY.close));

    await waitFor(() => {
      // Dialog gone
      expect(screen.queryByTestId('forced-close-form')).toBeNull();
      // Card for shift-111 removed, shift-222 still present
      expect(screen.queryByTestId('stuck-shift-card-shift-111')).toBeNull();
      expect(screen.getByTestId('stuck-shift-card-shift-222')).toBeInTheDocument();
    });
  });

  it('on state_invalid refusal: shows error message and refetches', async () => {
    const op = makeOperator(
      { kind: 'stuck_shifts', shifts: [SHIFT_0] },
      { kind: 'refused', category: 'state_invalid' },
    );
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    await userEvent.click(cardButton('shift-111'));
    await userEvent.click(screen.getByRole('radio', { name: COPY.reasons.takeover_supersession }));
    await enterCount();
    await userEvent.click(dialogButton(COPY.close));

    await waitFor(() => {
      expect(screen.getByTestId('stuck-shift-submit-error')).toHaveTextContent(COPY.changed);
    });
    // Refetch should have been called (initial + refetch = 2)
    expect(op.listStuckShifts).toHaveBeenCalledTimes(2);
  });

  // Local absence cannot prove the backend shift is still open (the opening terminal
  // may have closed it since the list loaded), so the list is re-read, as for state_invalid.
  it('RT-554: not_closable_here shows the clear «cannot close from this device» copy, re-reads the list, never «state changed»', async () => {
    const op = await submitClose({ kind: 'refused', category: 'not_closable_here' });

    await expectRefusalCopy({
      op,
      copy: COPY.notClosableHere,
      never: [COPY.changed, COPY.failed],
      reads: 2,
    });
  });

  it('RT-554: a shift closed meanwhile on its opening terminal leaves the list on the re-read', async () => {
    const op = {
      listStuckShifts: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'stuck_shifts', shifts: [SHIFT_0] })
        .mockResolvedValueOnce({ kind: 'stuck_shifts', shifts: [] }),
      forceCloseShift: vi.fn(() =>
        Promise.resolve({ kind: 'refused', category: 'not_closable_here' }),
      ),
    } as unknown as Pick<OperatorBridgeAPI, 'listStuckShifts' | 'forceCloseShift'>;

    await submitClose({ kind: 'refused', category: 'not_closable_here' }, [SHIFT_0], op);

    await waitFor(() => {
      expect(screen.queryByTestId('stuck-shift-card-shift-111')).toBeNull();
    });
    expect(op.listStuckShifts).toHaveBeenCalledTimes(2);
  });

  it('on generic refusal (non-state_invalid): shows submit error but does NOT refetch', async () => {
    const op = makeOperator(
      { kind: 'stuck_shifts', shifts: [SHIFT_0] },
      { kind: 'refused', category: 'no_connection' },
    );
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    await userEvent.click(cardButton('shift-111'));
    await userEvent.click(screen.getByRole('radio', { name: COPY.reasons.takeover_supersession }));
    await enterCount();
    await userEvent.click(dialogButton(COPY.close));

    await waitFor(() => {
      expect(screen.getByTestId('stuck-shift-submit-error')).toHaveTextContent(COPY.failed);
    });
    // Generic refusal must NOT trigger a refetch — only state_invalid does
    expect(op.listStuckShifts).toHaveBeenCalledTimes(1);
  });
});

// ─── Keyboard navigation ──────────────────────────────────────────────────────

describe('StuckShiftSurface — keyboard navigation on cards (a real button)', () => {
  it('pressing Enter on a card opens the forced-close dialog', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: [SHIFT_0] });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    cardButton('shift-111').focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByTestId('forced-close-form')).toBeInTheDocument();
  });

  it('pressing Space on a card opens the forced-close dialog', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: [SHIFT_0] });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    cardButton('shift-111').focus();
    await userEvent.keyboard(' ');

    expect(screen.getByTestId('forced-close-form')).toBeInTheDocument();
  });

  it('pressing another key on a card does not open the dialog', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: [SHIFT_0] });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    cardButton('shift-111').focus();
    await userEvent.keyboard('{Tab}');

    expect(screen.queryByTestId('forced-close-form')).toBeNull();
  });
});

// ─── FR-024 blind-close discipline ───────────────────────────────────────────

describe('StuckShiftSurface — FR-024 blind-close (no financial fields)', () => {
  const FINANCIAL_FORBIDDEN = [
    /drawer/i,
    /declared/i,
    /variance/i,
    /shortage/i,
    /overage/i,
    /change fund/i,
    /cash in/i,
    /cash out/i,
    /expected total/i,
    /float/i,
    /balance/i,
    /revenue/i,
    /sales/i,
    /reconcil/i,
  ];

  FINANCIAL_FORBIDDEN.forEach((pattern) => {
    it(`does not render financial field matching ${String(pattern)}`, async () => {
      const op = makeOperator({ kind: 'stuck_shifts', shifts: SAMPLE_SHIFTS });
      const { container } = render(<StuckShiftSurface operator={op} />);
      await waitFor(() => screen.getByText('Nour Al-Hassan'));
      expect(container.textContent).not.toMatch(pattern);
    });
  });
});

// ─── FR-013 minimum-disclosure ────────────────────────────────────────────────

describe('StuckShiftSurface — FR-013 minimum-disclosure (no identity fields)', () => {
  const IDENTITY_FORBIDDEN = [
    /user_[0-9a-f-]{8,}/i,
    /usr_[0-9a-z]{10,}/i,
    /dev_[0-9a-z]{10,}/i,
    /device_id/i,
    /device_token/i,
    /tenant_id/i,
    /branch_id/i,
    /terminal_id/i,
    /@[a-z0-9.-]+\.[a-z]{2,}/i,
    /credential/i,
    /clerk/i,
  ];

  IDENTITY_FORBIDDEN.forEach((pattern) => {
    it(`does not render identity field matching ${String(pattern)}`, async () => {
      const op = makeOperator({ kind: 'stuck_shifts', shifts: SAMPLE_SHIFTS });
      const { container } = render(<StuckShiftSurface operator={op} />);
      await waitFor(() => screen.getByText('Nour Al-Hassan'));
      expect(container.textContent).not.toMatch(pattern);
    });
  });
});

// ─── maxLength on annotation ──────────────────────────────────────────────────

describe('ForcedCloseForm — annotation maxLength', () => {
  it('textarea has maxLength of 500', async () => {
    const op = makeOperator({ kind: 'stuck_shifts', shifts: [SHIFT_0] });
    render(<StuckShiftSurface operator={op} />);

    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    await userEvent.click(cardButton('shift-111'));

    const textarea = screen.getByRole('textbox', { name: COPY.note });
    expect(textarea).toHaveAttribute('maxLength', '500');
  });
});

// ─── RT-554 (b): the manager's blind count ───────────────────────────────────

describe('StuckShiftSurface — the forced close takes the manager’s blind count', () => {
  async function openDialog(op = makeOperator({ kind: 'stuck_shifts', shifts: [SHIFT_0] })) {
    render(<StuckShiftSurface operator={op} />);
    await waitFor(() => screen.getByText('Nour Al-Hassan'));
    await userEvent.click(cardButton('shift-111'));
    await userEvent.click(screen.getByRole('radio', { name: COPY.reasons.cashier_no_show }));
    return op;
  }

  it('shows the count field and no number at all: a blind count has nothing to read', async () => {
    await openDialog();

    expect(screen.getByLabelText(SHIFT_COPY.countLabel)).toBeInTheDocument();
    // No expected cash and no variance can be on screen if no digit is.
    expect(screen.getByRole('dialog').textContent).not.toMatch(/[0-9٠-٩۰-۹]/);
  });

  it.each([
    ['not a number', 'abc'],
    ['three decimals', '5.123'],
    ['empty', ''],
  ])(
    'does not call the bridge for a count that is %s, and says so under the field',
    async (_name, text) => {
      const op = await openDialog();
      if (text !== '') await enterCount(text);

      await userEvent.click(dialogButton(COPY.close));

      expect(op.forceCloseShift).not.toHaveBeenCalled();
      expect(await screen.findByText(SHIFT_COPY.invalidAmount)).toBeInTheDocument();
    },
  );

  it('does not send a count above the cap (RT-278 S1), and says so', async () => {
    const op = await openDialog();
    await enterCount('2000000');

    await userEvent.click(dialogButton(COPY.close));

    expect(op.forceCloseShift).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('أكبر من الحد المسموح');
  });

  it('sends the count in integer minor units (Arabic digits accepted)', async () => {
    const op = await openDialog();
    await enterCount('١٢٣.٤٥');

    await userEvent.click(dialogButton(COPY.close));

    await waitFor(() => {
      expect(op.forceCloseShift).toHaveBeenCalledWith(
        expect.objectContaining({ counted_cash_minor: 12_345 }),
      );
    });
  });
});

describe('StuckShiftSurface — RT-554 (b) outcomes', () => {
  it('close_blocked shows its own copy, keeps the card, and does not re-read the list', async () => {
    const op = await submitClose({ kind: 'refused', category: 'close_blocked' });

    await expectRefusalCopy({
      op,
      copy: COPY.closeBlocked,
      never: [COPY.changed, COPY.failed, COPY.notClosableHere],
    });
  });

  it('closed_here_unsent shows the «not at the server yet» copy, keeps the card, no re-read', async () => {
    const op = await submitClose({ kind: 'refused', category: 'closed_here_unsent' });

    await expectRefusalCopy({
      op,
      copy: COPY.queuedNotice,
      never: [COPY.changed, COPY.failed, COPY.notClosableHere, COPY.closeBlocked],
    });
  });

  it('delivery queued: the card goes, and an honest notice says it is waiting to be sent', async () => {
    await submitClose({ kind: 'forced_closed', audit_event_id: 'evt-q', delivery: 'queued' }, [
      SHIFT_0,
      SHIFT_1,
    ]);

    expect(await screen.findByTestId('stuck-shift-queued-notice')).toHaveTextContent(
      COPY.queuedNotice,
    );
    expect(screen.queryByTestId('stuck-shift-card-shift-111')).toBeNull();
    expect(screen.getByTestId('stuck-shift-card-shift-222')).toBeInTheDocument();
  });

  // The drain is in causal order, so a later `sent` means everything before it was
  // sent too: the «not at the server yet» notice follows the LATEST delivery.
  it('a later close that is sent clears the «not at the server yet» notice', async () => {
    const op = {
      listStuckShifts: vi.fn(() =>
        Promise.resolve({ kind: 'stuck_shifts', shifts: [SHIFT_0, SHIFT_1] }),
      ),
      forceCloseShift: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'forced_closed',
          audit_event_id: 'evt-1',
          delivery: 'queued',
        })
        .mockResolvedValueOnce({
          kind: 'forced_closed',
          audit_event_id: 'evt-2',
          delivery: 'sent',
        }),
    } as unknown as Pick<OperatorBridgeAPI, 'listStuckShifts' | 'forceCloseShift'>;
    render(<StuckShiftSurface operator={op} />);
    await waitFor(() => screen.getByText('Nour Al-Hassan'));

    await closeThroughDialog('shift-111');
    expect(await screen.findByTestId('stuck-shift-queued-notice')).toBeInTheDocument();
    await closeThroughDialog('shift-222');

    await waitFor(() => {
      expect(screen.queryByTestId('stuck-shift-queued-notice')).toBeNull();
    });
  });

  it('delivery sent: no notice', async () => {
    await submitClose({ kind: 'forced_closed', audit_event_id: 'evt-s', delivery: 'sent' }, [
      SHIFT_0,
      SHIFT_1,
    ]);

    await waitFor(() => {
      expect(screen.queryByTestId('stuck-shift-card-shift-111')).toBeNull();
    });
    expect(screen.queryByTestId('stuck-shift-queued-notice')).toBeNull();
  });
});
