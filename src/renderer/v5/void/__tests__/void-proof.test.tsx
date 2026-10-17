/**
 * RT-654 — the DEV-only void harness (`#/dev/void-proof`). It must reach every
 * VD-Void state with the real screen; these tests drive it the way the capture
 * script does. Presentation scaffolding only, not evidence about main.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import {
  VOID_PROOF_STATES,
  VoidProof,
  readVoidProofEntry,
  readVoidProofState,
} from '../dev/VoidProof';
import { VOID_COPY, voidRefusalMessage } from '../void-copy';

function at(state: string): void {
  window.location.hash = `#/dev/void-proof?state=${state}`;
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
  useFeatureFlagsStore.getState().reset();
  useOperatorSessionStore.getState().reset();
  delete (window as unknown as { api?: unknown }).api;
});

const SALE = 'TERM-01-2026-10-17-000051';

async function search(user: ReturnType<typeof userEvent.setup>, value = SALE): Promise<void> {
  await user.type(await screen.findByLabelText(VOID_COPY.numberLabel), value);
  await user.click(screen.getByRole('button', { name: VOID_COPY.search }));
}

async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await search(user);
  await user.click(await screen.findByRole('button', { name: VOID_COPY.voidAction }));
  return screen.findByRole('dialog');
}

async function confirm(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(await within(dialog).findByLabelText('خالد منصور'));
  await user.type(within(dialog).getByLabelText(VOID_COPY.pinLabel), '135790');
  await user.click(within(dialog).getByRole('button', { name: VOID_COPY.approve }));
}

describe('readVoidProofState', () => {
  it('reads one of the 12 states, else Lookup', () => {
    expect(VOID_PROOF_STATES).toHaveLength(12);
    at('RefServer');
    expect(readVoidProofState()).toBe('RefServer');
    at('nope');
    expect(readVoidProofState()).toBe('Lookup');
  });
});

describe('readVoidProofEntry', () => {
  it('starts on the void screen, or on the dashboard with from=dashboard', () => {
    at('RefServer');
    expect(readVoidProofEntry()).toBe('/app/void');
    window.location.hash = '#/dev/void-proof?state=RefServer&from=dashboard';
    expect(readVoidProofEntry()).toBe('/app/dashboard');
    window.location.hash = '#/dev/void-proof?from=elsewhere';
    expect(readVoidProofEntry()).toBe('/app/void');
  });
});

describe('VoidProof', () => {
  it('RefServer from=dashboard: the frame shows the void attention banner (RT-670)', async () => {
    window.location.hash = '#/dev/void-proof?state=RefServer&from=dashboard';
    render(<VoidProof />);
    const banner = await screen.findByTestId('void-attention-banner');
    expect(
      within(banner).getByRole('link', { name: VOID_COPY.attentionAction }),
    ).toBeInTheDocument();
  });

  it('Lookup: the void screen in the frame, with an empty journal', async () => {
    at('Lookup');
    render(<VoidProof />);
    expect(await screen.findByText(VOID_COPY.noHistory)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: VOID_COPY.title })).toBeInTheDocument();
  });

  it('Journal: the four drawn voids', async () => {
    at('Journal');
    render(<VoidProof />);
    expect(await screen.findAllByTestId('void-row')).toHaveLength(4);
  });

  it('RefServer: a refused void first, with «تم الاطلاع»', async () => {
    at('RefServer');
    render(<VoidProof />);
    const [first] = await screen.findAllByTestId('void-row');
    expect(first).toHaveAttribute('data-attention', 'true');
    expect(
      within(first as HTMLElement).getByRole('button', { name: VOID_COPY.acknowledge }),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: VOID_COPY.acknowledge }));
  });

  it('RefJournal: the journal cannot be read', async () => {
    at('RefJournal');
    render(<VoidProof />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      voidRefusalMessage('void_unavailable'),
    );
  });

  it('Found: the drawn sale can be voided', async () => {
    at('Found');
    render(<VoidProof />);
    await search(userEvent.setup());
    expect(await screen.findByTestId('void-sale')).toHaveTextContent(SALE);
  });

  it('RefNotFound and RefIneligible answer as drawn', async () => {
    at('RefNotFound');
    render(<VoidProof />);
    await search(userEvent.setup(), 'TERM-01-2026-10-17-000999');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      voidRefusalMessage('sale_not_found'),
    );
    cleanup();
    at('RefIneligible');
    render(<VoidProof />);
    await search(userEvent.setup(), 'TERM-01-2026-10-16-000118');
    expect(await screen.findByRole('alert')).toHaveTextContent(voidRefusalMessage('not_same_day'));
  });

  it('Requested: the confirm journals the void, first in the list', async () => {
    at('Requested');
    render(<VoidProof />);
    const user = userEvent.setup();
    await confirm(user, await openDialog(user));
    expect(await screen.findByTestId('void-requested')).toBeInTheDocument();
    const [first] = await screen.findAllByTestId('void-row');
    expect(first).toHaveTextContent(SALE);
  });

  it('DialogRefused: the approval is refused inside the dialog', async () => {
    at('DialogRefused');
    render(<VoidProof />);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await confirm(user, dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      voidRefusalMessage('approval_unavailable'),
    );
  });

  it('DialogNoManagers: no manager to choose', async () => {
    at('DialogNoManagers');
    render(<VoidProof />);
    const dialog = await openDialog(userEvent.setup());
    expect(await within(dialog).findByText(VOID_COPY.noManagers)).toBeInTheDocument();
  });
});
