import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { StuckShiftSurface } from '../../../../ui/operator/ForcedCloseSurface';
import type {
  ForceCloseShiftRequest,
  ForceCloseShiftResponse,
  ListStuckShiftsResponse,
  OperatorBridgeAPI,
  StuckShiftSummary,
} from '../../../../../shared/bridge-api';
import type { OperatorRefusal } from '../../../../../shared/audit/event-shape';
import { STUCK_SHIFTS_COPY as COPY } from '../stuck-shifts-copy';

/**
 * RT-502 (VN-S10 S10-5, G-6 Stuck*) — the stuck-shifts screen and the
 * forced-close dialog on the v5 primitives. Same bridge calls, payload and
 * refusal branches as before; Arabic copy; real row buttons; the v5 Dialog's
 * focus rules (first reason on open, Esc cancels, focus back to the row).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AHMED: StuckShiftSummary = {
  shift_id: 'shift-1',
  cashier_display_name: 'أحمد سمير',
  terminal_label: 'POS-01',
  opened_at: '2026-10-15T06:00:00Z',
  duration_minutes: 190,
};
const YASMIN: StuckShiftSummary = {
  shift_id: 'shift-2',
  cashier_display_name: 'ياسمين خالد',
  terminal_label: 'POS-03',
  opened_at: '2026-10-15T08:05:00Z',
  duration_minutes: 65,
};
const UNNAMED: StuckShiftSummary = {
  shift_id: 'shift-3',
  cashier_display_name: '',
  terminal_label: 'POS-02',
  opened_at: '2026-10-15T09:00:00Z',
  duration_minutes: 45,
};

type Answer = ForceCloseShiftResponse | OperatorRefusal;
type Bridge = Pick<OperatorBridgeAPI, 'listStuckShifts' | 'forceCloseShift' | 'reauthenticate'>;

function makeBridge(
  lists: ListStuckShiftsResponse[],
  answer: Answer | Promise<Answer> = { kind: 'forced_closed', audit_event_id: 'evt-1' },
) {
  const queue = [...lists];
  const last = lists[lists.length - 1];
  return {
    listStuckShifts: vi.fn(() => Promise.resolve(queue.shift() ?? last)),
    forceCloseShift: vi.fn<(req: ForceCloseShiftRequest) => Promise<Answer>>(() =>
      Promise.resolve(answer),
    ),
    reauthenticate: vi.fn(),
  };
}

const LIST = (...shifts: StuckShiftSummary[]): ListStuckShiftsResponse => ({
  kind: 'stuck_shifts',
  shifts,
});

async function renderList(bridge: ReturnType<typeof makeBridge>) {
  const user = userEvent.setup();
  render(<StuckShiftSurface operator={bridge as unknown as Bridge} />);
  await screen.findByTestId('stuck-shift-list');
  return user;
}

function rowOf(shiftId: string): HTMLElement {
  return screen.getByTestId(`stuck-shift-card-${shiftId}`);
}

function closeButtonOf(shiftId: string): HTMLElement {
  return within(rowOf(shiftId)).getByRole('button', { name: COPY.close });
}

async function openDialog(user: ReturnType<typeof userEvent.setup>, shiftId = 'shift-1') {
  await user.click(closeButtonOf(shiftId));
  return screen.getByRole('dialog');
}

function commitIn(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('button', { name: COPY.close });
}

afterEach(() => {
  cleanup();
});

describe('RT-502 stuck shifts — page states', () => {
  it('loading: the Arabic line, busy', () => {
    const bridge = {
      listStuckShifts: vi.fn(() => new Promise<ListStuckShiftsResponse>(() => undefined)),
      forceCloseShift: vi.fn(),
    };
    render(<StuckShiftSurface operator={bridge as unknown as Bridge} />);
    const loading = screen.getByTestId('stuck-shift-surface-loading');
    expect(loading).toHaveTextContent(COPY.loading);
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(COPY.subtitle)).toBeInTheDocument();
  });

  it('empty: «لا توجد ورديات عالقة.» and no list panel', async () => {
    render(<StuckShiftSurface operator={makeBridge([LIST()]) as unknown as Bridge} />);
    expect(await screen.findByTestId('stuck-shift-surface-empty')).toHaveTextContent(COPY.empty);
    expect(screen.queryByRole('heading', { name: COPY.listHeading })).toBeNull();
    expect(screen.getByText(COPY.subtitle)).toBeInTheDocument();
  });

  it.each(['no_connection', 'invalid_input', 'role_mismatch'] as const)(
    'unreachable (%s): the Arabic notice with «إعادة المحاولة», which reads again',
    async (category) => {
      const user = userEvent.setup();
      const bridge = makeBridge([{ kind: 'refused', category }, LIST(AHMED)]);
      render(<StuckShiftSurface operator={bridge as unknown as Bridge} />);

      const notice = await screen.findByTestId('stuck-shift-surface-error');
      expect(notice).toHaveTextContent(COPY.unreachable);
      expect(document.body.textContent).not.toMatch(/Unable|Retry|try again/);

      await user.click(within(notice).getByRole('button', { name: COPY.retry }));
      expect(await screen.findByTestId('stuck-shift-list')).toBeInTheDocument();
      expect(bridge.listStuckShifts).toHaveBeenCalledTimes(2);
    },
  );
});

describe('RT-502 stuck shifts — the list', () => {
  it('shows the sub-line, the «الورديات المفتوحة» panel and one row per shift', async () => {
    await renderList(makeBridge([LIST(AHMED, YASMIN)]));
    expect(screen.getByText(COPY.subtitle)).toBeInTheDocument();
    const list = screen.getByRole('list', { name: COPY.listHeading });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('heading', { level: 2, name: COPY.listHeading })).toBeInTheDocument();
  });

  it('a row: the name in <bdi>, the terminal as an LTR run, «مفتوحة منذ …» and a real button', async () => {
    await renderList(makeBridge([LIST(AHMED, YASMIN)]));
    const row = rowOf('shift-1');
    expect(row.tagName).toBe('LI');
    expect(row).not.toHaveAttribute('role');
    expect(row).not.toHaveAttribute('tabindex');

    const name = within(row).getByText('أحمد سمير');
    expect(name.tagName).toBe('BDI');
    expect(within(row).getByText('POS-01')).toHaveAttribute('dir', 'ltr');
    expect(within(row).getByText('مفتوحة منذ 3 ساعات و10 دقائق')).toBeInTheDocument();
    expect(within(rowOf('shift-2')).getByText('مفتوحة منذ ساعة و5 دقائق')).toBeInTheDocument();

    const button = closeButtonOf('shift-1');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    // The row's name describes its button, so «إغلاق الوردية» is never ambiguous.
    expect(button).toHaveAccessibleDescription('أحمد سمير');
    expect(screen.queryAllByRole('button', { name: /^$/ })).toHaveLength(0);
  });

  it('an empty name shows «كاشير بلا اسم», in the row and in the dialog title', async () => {
    const user = await renderList(makeBridge([LIST(UNNAMED)]));
    expect(within(rowOf('shift-3')).getByText(COPY.unnamed).tagName).toBe('BDI');
    expect(within(rowOf('shift-3')).getByText('مفتوحة منذ 45 دقيقة')).toBeInTheDocument();
    const dialog = await openDialog(user, 'shift-3');
    expect(dialog).toHaveAccessibleName(`${COPY.dialogTitle} ${COPY.unnamed}`);
  });

  it('a null name (the old contract allowed it) also shows the fallback', async () => {
    const shift = { ...UNNAMED, cashier_display_name: null as unknown as string };
    await renderList(makeBridge([LIST(shift)]));
    expect(within(rowOf('shift-3')).getByText(COPY.unnamed)).toBeInTheDocument();
  });
});

describe('RT-502 forced-close dialog — open, focus, cancel', () => {
  it('opens with the title, «السبب» and the five reasons; none chosen; commit disabled', async () => {
    const user = await renderList(makeBridge([LIST(AHMED)]));
    const dialog = await openDialog(user);

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('إغلاق وردية أحمد سمير');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent(
      'إغلاق وردية أحمد سمير',
    );
    const group = within(dialog).getByRole('group', { name: COPY.reasonLegend });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual([
      'takeover_supersession',
      'cashier_no_show',
      'cashier_illness',
      'terminal_failure',
      'other',
    ]);
    for (const [value, label] of Object.entries(COPY.reasons)) {
      expect(within(group).getByRole('radio', { name: label })).toHaveAttribute('value', value);
    }
    radios.forEach((r) => {
      expect(r).not.toBeChecked();
    });
    expect(commitIn(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('textbox', { name: COPY.note })).toHaveAttribute(
      'maxLength',
      '500',
    );
  });

  it('focus goes first to the first reason radio, never to the commit', async () => {
    const user = await renderList(makeBridge([LIST(AHMED)]));
    const dialog = await openDialog(user);
    expect(
      within(dialog).getByRole('radio', { name: COPY.reasons.takeover_supersession }),
    ).toHaveFocus();
  });

  it('choosing a reason enables «إغلاق الوردية»', async () => {
    const user = await renderList(makeBridge([LIST(AHMED)]));
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.cashier_illness }));
    expect(commitIn(dialog)).toBeEnabled();
  });

  it('«إلغاء» closes without a call and returns focus to the row button', async () => {
    const bridge = makeBridge([LIST(AHMED, YASMIN)]);
    const user = await renderList(bridge);
    const dialog = await openDialog(user, 'shift-2');
    await user.click(within(dialog).getByRole('button', { name: COPY.cancel }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bridge.forceCloseShift).not.toHaveBeenCalled();
    expect(closeButtonOf('shift-2')).toHaveFocus();
  });

  it('Esc cancels and returns focus to the row button', async () => {
    const bridge = makeBridge([LIST(AHMED)]);
    const user = await renderList(bridge);
    await openDialog(user);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bridge.forceCloseShift).not.toHaveBeenCalled();
    expect(closeButtonOf('shift-1')).toHaveFocus();
  });

  it('Enter and Space on a row button open the dialog; another key does not', async () => {
    const user = await renderList(makeBridge([LIST(AHMED)]));
    closeButtonOf('shift-1').focus();
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('dialog')).toBeNull();

    closeButtonOf('shift-1').focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.keyboard(' ');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('RT-502 forced-close dialog — the bridge call', () => {
  it('sends exactly { event_id, shift_id, reason } when the note is empty', async () => {
    const bridge = makeBridge([LIST(AHMED)]);
    const user = await renderList(bridge);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.cashier_no_show }));
    await user.click(commitIn(dialog));

    await waitFor(() => {
      expect(bridge.forceCloseShift).toHaveBeenCalledOnce();
    });
    const req = bridge.forceCloseShift.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(Object.keys(req).sort()).toEqual(['event_id', 'reason', 'shift_id']);
    expect(req).toEqual({
      event_id: expect.stringMatching(UUID) as string,
      shift_id: 'shift-1',
      reason: 'cashier_no_show',
    });
  });

  it('adds `annotation` only when the note is not empty', async () => {
    const bridge = makeBridge([LIST(AHMED)]);
    const user = await renderList(bridge);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.other }));
    await user.type(within(dialog).getByRole('textbox', { name: COPY.note }), 'غادر مبكرًا');
    await user.click(commitIn(dialog));

    await waitFor(() => {
      expect(bridge.forceCloseShift).toHaveBeenCalledOnce();
    });
    expect(bridge.forceCloseShift).toHaveBeenCalledWith({
      event_id: expect.stringMatching(UUID) as string,
      shift_id: 'shift-1',
      reason: 'other',
      annotation: 'غادر مبكرًا',
    });
  });

  it('a fresh event_id per submit', async () => {
    const bridge = makeBridge([LIST(AHMED)], { kind: 'refused', category: 'no_connection' });
    const user = await renderList(bridge);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.other }));
    await user.click(commitIn(dialog));
    await screen.findByTestId('stuck-shift-submit-error');
    await user.click(commitIn(dialog));
    await waitFor(() => {
      expect(bridge.forceCloseShift).toHaveBeenCalledTimes(2);
    });
    const [a, b] = bridge.forceCloseShift.mock.calls.map(([req]) => req.event_id);
    expect(a).not.toBe(b);
  });

  it('while the call is in flight both buttons are disabled', async () => {
    let settle!: (a: Answer) => void;
    const inflight = new Promise<Answer>((res) => {
      settle = res;
    });
    const bridge = makeBridge([LIST(AHMED)]);
    bridge.forceCloseShift.mockImplementation(() => inflight);
    const user = await renderList(bridge);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.other }));
    await user.click(commitIn(dialog));

    expect(commitIn(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: COPY.cancel })).toBeDisabled();
    settle({ kind: 'refused', category: 'no_connection' });
    await screen.findByTestId('stuck-shift-submit-error');
    expect(commitIn(dialog)).toBeEnabled();
  });
});

describe('RT-502 forced-close dialog — answers', () => {
  it('success: the dialog closes, the row leaves, no re-read, focus moves to the next row', async () => {
    const bridge = makeBridge([LIST(AHMED, YASMIN)]);
    const user = await renderList(bridge);
    const dialog = await openDialog(user, 'shift-1');
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.cashier_no_show }));
    await user.click(commitIn(dialog));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.queryByTestId('stuck-shift-card-shift-1')).toBeNull();
    expect(rowOf('shift-2')).toBeInTheDocument();
    expect(bridge.listStuckShifts).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(closeButtonOf('shift-2')).toHaveFocus();
    });
  });

  it('success on the final row of a longer list: focus lands on the list heading, never on another shift’s close button', async () => {
    const bridge = makeBridge([LIST(AHMED, YASMIN)]);
    const user = await renderList(bridge);
    const dialog = await openDialog(user, 'shift-2');
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.other }));
    await user.click(commitIn(dialog));

    await waitFor(() => {
      expect(screen.queryByTestId('stuck-shift-card-shift-2')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: COPY.listHeading })).toHaveFocus();
    });
    expect(closeButtonOf('shift-1')).not.toHaveFocus();
  });

  it('success on the last shift: the empty state', async () => {
    const user = await renderList(makeBridge([LIST(AHMED)]));
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.other }));
    await user.click(commitIn(dialog));
    expect(await screen.findByTestId('stuck-shift-surface-empty')).toHaveTextContent(COPY.empty);
  });

  it('state_invalid: the dialog stays, «تغيّرت حالة…», the list is read again once, focus on «إلغاء»', async () => {
    const bridge = makeBridge([LIST(AHMED, YASMIN), LIST(AHMED, YASMIN)], {
      kind: 'refused',
      category: 'state_invalid',
    });
    const user = await renderList(bridge);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.terminal_failure }));
    await user.click(commitIn(dialog));

    const error = await screen.findByTestId('stuck-shift-submit-error');
    expect(error).toHaveTextContent(COPY.changed);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => {
      expect(bridge.listStuckShifts).toHaveBeenCalledTimes(2);
    });
    await screen.findByTestId('stuck-shift-list');
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: COPY.cancel }),
    ).toHaveFocus();
    expect(document.body.textContent).not.toContain(COPY.failed);
  });

  it('state_invalid, then «إلغاء»: focus lands on the same shift’s new row button', async () => {
    const bridge = makeBridge([LIST(AHMED, YASMIN), LIST(AHMED, YASMIN)], {
      kind: 'refused',
      category: 'state_invalid',
    });
    const user = await renderList(bridge);
    const dialog = await openDialog(user, 'shift-2');
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.other }));
    await user.click(commitIn(dialog));
    await screen.findByTestId('stuck-shift-submit-error');
    await waitFor(() => {
      expect(bridge.listStuckShifts).toHaveBeenCalledTimes(2);
    });
    await screen.findByTestId('stuck-shift-list');

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: COPY.cancel }));
    await waitFor(() => {
      expect(closeButtonOf('shift-2')).toHaveFocus();
    });
  });

  it('state_invalid where the shift is gone, then Esc: focus lands on the list heading', async () => {
    const bridge = makeBridge([LIST(AHMED, YASMIN), LIST(YASMIN)], {
      kind: 'refused',
      category: 'state_invalid',
    });
    const user = await renderList(bridge);
    const dialog = await openDialog(user, 'shift-1');
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.other }));
    await user.click(commitIn(dialog));
    await screen.findByTestId('stuck-shift-submit-error');
    await waitFor(() => {
      expect(screen.queryByTestId('stuck-shift-card-shift-1')).toBeNull();
    });
    await screen.findByTestId('stuck-shift-list');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2, name: COPY.listHeading })).toHaveFocus();
    });
  });

  it.each(['no_connection', 'invalid_input', 'role_mismatch', 'reauth_required'] as const)(
    'any other refusal (%s): the dialog stays, «تعذّر إغلاق…», NO re-read, focus on «إلغاء»',
    async (category) => {
      const bridge = makeBridge([LIST(AHMED)], { kind: 'refused', category });
      const user = await renderList(bridge);
      const dialog = await openDialog(user);
      await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.other }));
      await user.click(commitIn(dialog));

      const error = await screen.findByTestId('stuck-shift-submit-error');
      expect(error).toHaveTextContent(COPY.failed);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(bridge.listStuckShifts).toHaveBeenCalledTimes(1);
      expect(within(dialog).getByRole('button', { name: COPY.cancel })).toHaveFocus();
      expect(screen.queryByTestId('reauth-required')).toBeNull();
      expect(document.body.textContent).not.toContain(COPY.changed);
    },
  );

  it('the refusal message sits in a polite live slot inside the form', async () => {
    const bridge = makeBridge([LIST(AHMED)], { kind: 'refused', category: 'no_connection' });
    const user = await renderList(bridge);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: COPY.reasons.other }));
    await user.click(commitIn(dialog));
    const error = await screen.findByTestId('stuck-shift-submit-error');
    const slot = error.parentElement;
    expect(slot).toHaveAttribute('role', 'status');
    expect(slot).toHaveAttribute('aria-live', 'polite');
    expect(
      within(screen.getByTestId('forced-close-form')).getByTestId('stuck-shift-submit-error'),
    ).toBe(error);
  });
});

describe('RT-502 — FR-024 blind close and FR-013 minimum disclosure', () => {
  it('no amount, no id and no English anywhere, list and dialog open', async () => {
    const user = await renderList(makeBridge([LIST(AHMED, YASMIN)]));
    await openDialog(user);
    const text = document.body.textContent;
    expect(text).not.toMatch(/drawer|variance|shortage|overage|balance|expected|total|cash/i);
    expect(text).not.toMatch(/مبلغ|جنيه|ج\.م|المتوقع|الفرق|العجز|الزيادة/);
    expect(text).not.toMatch(/shift-1|shift-2|tenant|branch_id|terminal_id/);
    expect(text).not.toMatch(/takeover_supersession|cashier_no_show|Cancel|Confirm|Reason/);
  });
});
