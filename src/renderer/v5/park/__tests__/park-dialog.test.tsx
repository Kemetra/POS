import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import type { CartParkBridgeAPI, CartParkResponse } from '../../../../shared/cart/park-types';
import { ParkDialog, normaliseLabel } from '../ParkDialog';
import { PARK_COPY } from '../park-copy';

afterEach(cleanup);

function setup(answer: () => Promise<CartParkResponse>) {
  const park = vi.fn<CartParkBridgeAPI['park']>(answer);
  const bridge = {
    park,
    listParked: vi.fn(),
    previewResume: vi.fn(),
    resume: vi.fn(),
  } as unknown as CartParkBridgeAPI;
  const handlers = {
    onParked: vi.fn(),
    onClose: vi.fn(),
    onShowParked: vi.fn(),
    onRefused: vi.fn(),
  };
  render(
    <ParkDialog bridge={bridge} cartId="cart-1" lineCount={4} totalMinor={37_500} {...handlers} />,
  );
  return { park, ...handlers, user: userEvent.setup() };
}

const field = (): HTMLInputElement => screen.getByLabelText(PARK_COPY.labelField);
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: PARK_COPY.dialogTitle });
const submit = (): HTMLElement =>
  within(dialog()).getByRole('button', { name: PARK_COPY.parkAction });

describe('ParkDialog (PK3-ParkDialog … ParkLimit)', () => {
  it('opens on the optional label, with the summary and the personal-data warning', () => {
    setup(() => Promise.resolve({ kind: 'parked' }));
    expect(field()).toHaveFocus();
    expect(field()).toHaveAttribute('maxLength', '40');
    expect(dialog()).toHaveTextContent('4 أصناف');
    expect(dialog()).toHaveTextContent('375.00 EGP');
    expect(field()).toHaveAccessibleDescription(PARK_COPY.pii);
    // I-2: the close is «رجوع», never a cancel that reads like «إلغاء البيع».
    expect(within(dialog()).getByRole('button', { name: PARK_COPY.back })).toBeInTheDocument();
    expect(within(dialog()).queryByRole('button', { name: /إلغاء/ })).not.toBeInTheDocument();
  });

  it('OD-10: trims the label and sends an empty one as no label', async () => {
    expect(normaliseLabel('  ينتظر  ')).toBe('ينتظر');
    expect(normaliseLabel('   ')).toBeNull();
    const { park, onParked, user } = setup(() => Promise.resolve({ kind: 'parked' }));
    await user.type(field(), '   ');
    await user.click(submit());
    await waitFor(() => {
      expect(onParked).toHaveBeenCalledWith(null);
    });
    expect(park.mock.calls[0]?.[0]).not.toHaveProperty('label');
  });

  it('sends the trimmed label with a key, and reports it once main answers parked', async () => {
    const { park, onParked, user } = setup(() => Promise.resolve({ kind: 'parked' }));
    await user.type(field(), '  ينتظر المحفظة ');
    await user.click(submit());
    await waitFor(() => {
      expect(onParked).toHaveBeenCalledWith('ينتظر المحفظة');
    });
    const req = park.mock.calls[0]?.[0];
    expect(req).toMatchObject({ cart_id: 'cart-1', label: 'ينتظر المحفظة' });
    expect(req?.idempotency_key).toMatch(/\S/);
  });

  it('I-13: while saving the dialog stays, read only, and nothing is reported', async () => {
    const { onParked, onClose, user } = setup(() => new Promise<CartParkResponse>(() => undefined));
    await user.type(field(), 'ينتظر');
    await user.click(submit());
    expect(await within(dialog()).findByText(PARK_COPY.saving)).toBeInTheDocument();
    expect(field()).toHaveAttribute('readonly');
    expect(field()).toHaveFocus();
    expect(submit()).toBeDisabled();
    expect(within(dialog()).getByRole('button', { name: PARK_COPY.back })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(onParked).not.toHaveBeenCalled();
  });

  it('invalid_label: the drawn message, the field marked invalid, focus back on it', async () => {
    const { user } = setup(() => Promise.resolve({ kind: 'refused', reason: 'invalid_label' }));
    await user.type(field(), 'ينتظر');
    await user.click(submit());
    expect(await within(dialog()).findByText(PARK_COPY.invalidLabel)).toBeInTheDocument();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => {
      expect(field()).toHaveFocus();
    });
    // Editing the label clears the refusal.
    await user.type(field(), 'x');
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('park_limit_reached: the drawn refusal, park disabled, «عرض المبيعات المعلّقة» focused', async () => {
    const { onShowParked, user } = setup(() =>
      Promise.resolve({ kind: 'refused', reason: 'park_limit_reached' }),
    );
    await user.click(submit());
    expect(await within(dialog()).findByText(PARK_COPY.limit)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    const show = within(dialog()).getByRole('button', { name: PARK_COPY.showParked });
    await waitFor(() => {
      expect(show).toHaveFocus();
    });
    expect(dialog().textContent).not.toMatch(/من 5/);
    await user.click(show);
    expect(onShowParked).toHaveBeenCalledOnce();
  });

  it('OD-9: an undrawn refusal shows the generic line and asks for a re-read', async () => {
    const { onRefused, user } = setup(() =>
      Promise.resolve({ kind: 'refused', reason: 'not_parkable' }),
    );
    await user.click(submit());
    expect(await within(dialog()).findByText(PARK_COPY.generic)).toBeInTheDocument();
    expect(onRefused).toHaveBeenCalledOnce();
    expect(submit()).toBeEnabled();
  });

  it('a transport failure is the generic line, and a retry of the same label replays its key', async () => {
    let calls = 0;
    const { park, onParked, user } = setup(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('ipc')) : Promise.resolve({ kind: 'parked' });
    });
    await user.type(field(), 'ينتظر');
    await user.click(submit());
    expect(await within(dialog()).findByText(PARK_COPY.generic)).toBeInTheDocument();
    await user.click(submit());
    await waitFor(() => {
      expect(onParked).toHaveBeenCalledWith('ينتظر');
    });
    expect(park.mock.calls[1]?.[0].idempotency_key).toBe(park.mock.calls[0]?.[0].idempotency_key);
  });

  it('a different label is a new request with a new key', async () => {
    const { park, user } = setup(() => Promise.reject(new Error('ipc')));
    await user.type(field(), 'أ');
    await user.click(submit());
    await within(dialog()).findByText(PARK_COPY.generic);
    await user.type(field(), 'ب');
    await user.click(submit());
    await waitFor(() => {
      expect(park).toHaveBeenCalledTimes(2);
    });
    expect(park.mock.calls[1]?.[0].idempotency_key).not.toBe(
      park.mock.calls[0]?.[0].idempotency_key,
    );
  });

  it('session_locked says nothing (the lock screen covers it)', async () => {
    const { onRefused, user } = setup(() =>
      Promise.resolve({ kind: 'refused', reason: 'session_locked' }),
    );
    await user.click(submit());
    await waitFor(() => {
      expect(submit()).toBeEnabled();
    });
    expect(screen.queryByText(PARK_COPY.generic)).not.toBeInTheDocument();
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('«رجوع» and Esc close with nothing parked', async () => {
    const { park, onClose, user } = setup(() => Promise.resolve({ kind: 'parked' }));
    await user.click(within(dialog()).getByRole('button', { name: PARK_COPY.back }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(park).not.toHaveBeenCalled();
  });
});
