/**
 * RT-445 — the DEV-only park / resume harness (`#/dev/park-proof`). It must
 * reach every PK-3 state with the real screens; these tests drive it the way
 * the capture script does. Presentation scaffolding only, not evidence about
 * main.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { resetScanGuardForTests } from '../../../scan/ScanGuardHost';
import { useCartStore } from '../../../stores/cart-store';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { PARK_PROOF_STATES, ParkProof, readParkProofState } from '../dev/ParkProof';
import { PARK_COPY } from '../park-copy';

function at(state: string): void {
  window.location.hash = `#/dev/park-proof?state=${state}`;
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useCartStore.getState().reset();
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  resetScanGuardForTests();
  delete (window as unknown as { api?: unknown }).api;
});

describe('readParkProofState', () => {
  it('reads one of the 21 states, else SaleReady', () => {
    expect(PARK_PROOF_STATES).toHaveLength(21);
    at('ListStale');
    expect(readParkProofState()).toBe('ListStale');
    at('nope');
    expect(readParkProofState()).toBe('SaleReady');
  });
});

async function resumeFirst(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const [first] = await screen.findAllByRole('button', { name: PARK_COPY.resume });
  if (first === undefined) throw new Error('no resume button');
  await user.click(first);
}

describe('ParkProof', () => {
  it.each(['SaleReady', 'Parked', 'ParkLimit', 'ParkInvalid', 'ParkSaving'] as const)(
    '%s: the live Sale with the drawn cart, and the park dialog answers as drawn',
    async (state) => {
      at(state);
      render(<ParkProof />);
      const user = userEvent.setup();
      const park = await screen.findByRole('button', { name: PARK_COPY.parkAction });
      await waitFor(() => {
        expect(park).toBeEnabled();
      });
      await user.click(park);
      await user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: PARK_COPY.parkAction }),
      );
      if (state === 'Parked') expect(await screen.findByText('عُلِّق البيع.')).toBeInTheDocument();
      if (state === 'ParkLimit') expect(await screen.findByText(PARK_COPY.limit)).toBeVisible();
      if (state === 'ParkInvalid')
        expect(await screen.findByText(PARK_COPY.invalidLabel)).toBeVisible();
      if (state === 'ParkSaving') expect(await screen.findByText(PARK_COPY.saving)).toBeVisible();
    },
  );

  it('SaleEmpty: no current cart, park disabled', async () => {
    at('SaleEmpty');
    render(<ParkProof />);
    expect(await screen.findByRole('button', { name: PARK_COPY.parkAction })).toBeDisabled();
  });

  it.each([
    ['ListEmpty', 0],
    ['ListOne', 1],
    ['ListFive', 5],
    ['ListStale', 3],
  ] as const)('%s lists %i sales', async (state, n) => {
    at(state);
    render(<ParkProof />);
    if (n === 0) expect(await screen.findByText(PARK_COPY.listEmpty)).toBeInTheDocument();
    else expect(await screen.findAllByRole('button', { name: PARK_COPY.resume })).toHaveLength(n);
  });

  it.each([
    ['ReviewPrice', PARK_COPY.acceptChanges],
    ['ReviewRemoved', PARK_COPY.acceptRemoval],
    ['ReviewMixed', PARK_COPY.acceptChanges],
    ['ConflictClean', PARK_COPY.swap],
    ['ConflictChanges', PARK_COPY.swapWithChanges],
  ] as const)('%s reaches its review', async (state, action) => {
    at(state);
    render(<ParkProof />);
    await resumeFirst(userEvent.setup());
    expect(await screen.findByRole('button', { name: action })).toBeInTheDocument();
  });

  it.each([
    ['RefCatalogue', PARK_COPY.catalogueUnavailable],
    ['RefCheckout', PARK_COPY.checkoutInProgress],
  ] as const)('%s reaches its refusal', async (state, line) => {
    at(state);
    render(<ParkProof />);
    await resumeFirst(userEvent.setup());
    expect(await screen.findByText(line)).toBeInTheDocument();
  });

  it('RefChanged answers the first accept with price_changes_unaccepted', async () => {
    at('RefChanged');
    render(<ParkProof />);
    const user = userEvent.setup();
    await resumeFirst(user);
    await user.click(await screen.findByRole('button', { name: PARK_COPY.acceptChanges }));
    expect(await screen.findByText(PARK_COPY.pricesChanged)).toBeInTheDocument();
  });

  it('ShiftClose: the close is refused with three parked sales', async () => {
    at('ShiftClose');
    render(<ParkProof />);
    const user = userEvent.setup();
    const panel = await screen.findByTestId('shift-close-panel');
    await user.type(within(panel).getByRole('textbox'), '2450');
    await user.click(within(panel).getByRole('button', { name: 'تسجيل العدّ وإغلاق الوردية' }));
    expect(await screen.findByTestId('shift-parked-block')).toHaveTextContent(
      '3 مبيعات معلّقة على هذا الجهاز',
    );
  });
});

describe('the routes (`/app/cart` ⇄ `/app/cart/parked`)', () => {
  it('«المبيعات المعلّقة» opens the list; «رجوع إلى البيع» returns to the Sale', async () => {
    at('SaleReady');
    render(<ParkProof />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /المبيعات المعلّقة/ }));
    expect(
      await screen.findByRole('heading', { level: 1, name: PARK_COPY.listTitle }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: PARK_COPY.backToSale }));
    expect(await screen.findByRole('button', { name: PARK_COPY.parkAction })).toBeInTheDocument();
  });

  it('an accepted resume lands on the Sale with the resumed cart as the active one', async () => {
    at('ReviewPrice');
    render(<ParkProof />);
    const user = userEvent.setup();
    await resumeFirst(user);
    await user.click(await screen.findByRole('button', { name: PARK_COPY.acceptChanges }));
    expect(await screen.findByRole('button', { name: PARK_COPY.parkAction })).toBeInTheDocument();
    expect(useCartStore.getState().activeCart?.cart_id).toBe('p2');
  });
});
