import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { PairingForm } from '../PairingForm';
import {
  INVALID_CODE_MESSAGE,
  EXPIRED_CODE_MESSAGE,
  ALREADY_PAIRED_MESSAGE,
  BRANCH_MISMATCH_MESSAGE,
  RATE_LIMITED_MESSAGE,
  GENERIC_FAILURE_MESSAGE,
  NETWORK_ERROR_MESSAGE,
  UNKNOWN_ERROR_MESSAGE,
  EMPTY_INPUT_MESSAGE,
} from '../messages';
import type { PairingBridgeAPI } from '../../../../shared/bridge-api';
import type { PairingSubmitResult } from '../../../../shared/pairing-types';

/**
 * 002-terminal-pairing T027 + T028 + T034 — `PairingForm` tests.
 *
 * Coverage for the single-input form that drives the pairing submit
 * flow. The form:
 *   - autofocuses the input on mount,
 *   - reads the current input value via ref (not stale useState),
 *     because userEvent.keyboard('CODE{Enter}') and a real wedge
 *     scanner both fire keys synchronously and React 19 batching
 *     would otherwise produce a stale read,
 *   - calls bridge.pairing.submit(value.trim()) once on Enter or click,
 *   - disables submit while in flight; re-enables after the result,
 *   - on outcome === 'success' navigates to /paired (replace=true).
 *
 * No outcome-specific user-facing copy in US2 — that is T074 / Phase
 * Final. The form is correct-but-coarse on failure.
 */

const SUCCESS_RESULT: PairingSubmitResult = {
  outcome: 'success',
  tenant_id: 'tenant-A',
  branch_id: 'branch-B',
  terminal_id: 'terminal-C',
  terminal_label: 'Counter 1',
};

interface BridgeFixture {
  bridge: PairingBridgeAPI;
  submit: ReturnType<typeof vi.fn<(code: string) => Promise<PairingSubmitResult>>>;
}

function makeBridge(
  opts: {
    result?: PairingSubmitResult;
    submitImpl?: (code: string) => Promise<PairingSubmitResult>;
  } = {},
): BridgeFixture {
  const submit = vi.fn<(code: string) => Promise<PairingSubmitResult>>(
    opts.submitImpl ?? (() => Promise.resolve(opts.result ?? SUCCESS_RESULT)),
  );
  // getStatus is fixture-only: the form does not call it. Reject loudly
  // if the form ever touches it so a regression fails fast.
  const getStatus = vi.fn<PairingBridgeAPI['getStatus']>(() => {
    return Promise.reject(new Error('PairingForm must not call getStatus'));
  });
  return { bridge: { submit, getStatus }, submit };
}

/**
 * Render `PairingForm` inside a memory router so `useNavigate()` has a
 * router context, plus a `<LocationProbe>` route that records the
 * current pathname into a captured array. Tests assert the probe's
 * recorded paths to verify navigation.
 */
function renderInRouter(bridge: PairingBridgeAPI): { locations: string[] } {
  const locations: string[] = [];
  function LocationProbe(): null {
    const loc = useLocation();
    locations.push(loc.pathname);
    return null;
  }
  render(
    <MemoryRouter initialEntries={['/pairing']}>
      <Routes>
        <Route
          path="/pairing"
          element={
            <>
              <PairingForm pairing={bridge} />
              <LocationProbe />
            </>
          }
        />
        <Route path="/paired" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return { locations };
}

afterEach(() => {
  cleanup();
});

describe('PairingForm — manual entry (T027)', () => {
  it('typing a code and pressing Enter calls pairing.submit exactly once with the typed string', async () => {
    const user = userEvent.setup();
    const { bridge, submit } = makeBridge();
    renderInRouter(bridge);

    const input = screen.getByRole('textbox');
    await user.type(input, 'VALIDCODE{Enter}');

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(submit).toHaveBeenCalledWith('VALIDCODE');
  });

  it('clicking the submit button after typing also fires submit exactly once with the typed string', async () => {
    const user = userEvent.setup();
    const { bridge, submit } = makeBridge();
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CLICKED');
    await user.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(submit).toHaveBeenCalledWith('CLICKED');
  });

  it('disables the submit button while in flight and re-enables it after the result is in', async () => {
    const user = userEvent.setup();
    let resolveSubmit!: (v: PairingSubmitResult) => void;
    const pending = new Promise<PairingSubmitResult>((r) => {
      resolveSubmit = r;
    });
    const { bridge } = makeBridge({ submitImpl: () => pending });
    renderInRouter(bridge);

    const button = screen.getByRole('button');
    expect(button).not.toBeDisabled();

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    // After Enter fires, submit should be disabled while the bridge call
    // is in flight.
    await waitFor(() => {
      expect(button).toBeDisabled();
    });

    resolveSubmit({ outcome: 'unknown_error' }); // any non-success outcome
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
  });

  it('trims the input before sending (whitespace around the code is dropped)', async () => {
    const user = userEvent.setup();
    const { bridge, submit } = makeBridge();
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), '  PADDED-CODE  {Enter}');

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(submit).toHaveBeenCalledWith('PADDED-CODE');
  });
});

describe('PairingForm — wedge scanner (T028)', () => {
  it('userEvent.keyboard("VALIDCODE{Enter}") against the autofocused input fires submit once', async () => {
    const user = userEvent.setup();
    const { bridge, submit } = makeBridge();
    renderInRouter(bridge);

    // The input must already have focus on mount (autofocus). The
    // wedge scanner emits its keystrokes wherever focus is.
    const input = screen.getByRole('textbox');
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    // Drive without first calling user.click — that is the wedge sim.
    await user.keyboard('VALIDCODE{Enter}');

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    expect(submit).toHaveBeenCalledWith('VALIDCODE');
  });

  it('does NOT submit on focus alone (no extra submit on autofocus)', async () => {
    const { bridge, submit } = makeBridge();
    renderInRouter(bridge);

    const input = screen.getByRole('textbox');
    await waitFor(() => {
      expect(input).toHaveFocus();
    });

    // Wait a tick to be sure no spurious submit fires from the focus
    // event — autofocus must not trigger a submit.
    await Promise.resolve();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    // no {Enter}
    { name: 'does NOT submit on partial input (no Enter, just keystrokes)', keys: 'PARTIAL' },
    // empty input
    { name: 'empty Enter is a no-op (no bridge call)', keys: '{Enter}' },
    // whitespace then enter
    { name: 'whitespace-only Enter is a no-op (trimmed to empty)', keys: '   {Enter}' },
  ])('$name', async ({ keys }) => {
    const user = userEvent.setup();
    const { bridge, submit } = makeBridge();
    renderInRouter(bridge);

    await user.keyboard(keys);
    expect(submit).not.toHaveBeenCalled();
  });

  it('two consecutive Enters fire submit at most twice (no extra phantom submits)', async () => {
    // Edge: if the user double-taps Enter (or the wedge appends two
    // CRs), we accept up to two submits — but never more, and never
    // fewer than zero. The in-flight disable should suppress the
    // second one when the first has not yet resolved.
    const user = userEvent.setup();
    const resolves: Array<(v: PairingSubmitResult) => void> = [];
    const { bridge, submit } = makeBridge({
      submitImpl: () =>
        new Promise<PairingSubmitResult>((r) => {
          resolves.push(r);
        }),
    });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE');
    await user.keyboard('{Enter}{Enter}');

    // The second Enter happens while submit is in flight (first not
    // resolved). The form's in-flight guard should prevent a second
    // call.
    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    // Resolve so we can clean up; assert no further calls.
    resolves[0]?.({ outcome: 'unknown_error' });
    await Promise.resolve();
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('PairingForm — production fallback to window.api', () => {
  it('reads bridge from window.api when no `pairing` prop is provided', async () => {
    // Production wire-up path: PairingForm mounts inside the renderer
    // app where window.api is exposed by the preload script. We
    // simulate that here by setting window.api before mount.
    const user = userEvent.setup();
    const submit = vi.fn(() => Promise.resolve(SUCCESS_RESULT));
    const fakeApi = {
      ping: vi.fn(),
      appVersion: vi.fn(),
      log: vi.fn(),
      appConfig: vi.fn(),
      pairing: {
        getStatus: vi.fn(),
        submit,
      },
    };
    const original = (window as unknown as { api?: unknown }).api;
    (window as unknown as { api: typeof fakeApi }).api = fakeApi;
    try {
      render(
        <MemoryRouter initialEntries={['/pairing']}>
          {/* No `pairing` prop — must fall through to window.api */}
          <PairingForm />
        </MemoryRouter>,
      );
      await user.type(screen.getByRole('textbox'), 'CODE{Enter}');
      await waitFor(() => {
        expect(submit).toHaveBeenCalledWith('CODE');
      });
    } finally {
      if (original === undefined) delete (window as unknown as { api?: unknown }).api;
      else (window as unknown as { api?: unknown }).api = original;
    }
  });

  it('throws a clear error when no `pairing` prop AND window.api is missing', () => {
    const original = (window as unknown as { api?: unknown }).api;
    delete (window as unknown as { api?: unknown }).api;
    try {
      // happy-dom hides React's error boundary output; we catch via
      // try/render. React 19 surfaces hook-throw errors during render.
      expect(() => {
        render(
          <MemoryRouter initialEntries={['/pairing']}>
            <PairingForm />
          </MemoryRouter>,
        );
      }).toThrow(/window\.api missing/);
    } finally {
      if (original !== undefined) (window as unknown as { api?: unknown }).api = original;
    }
  });
});

describe('PairingForm — navigation on success (T034)', () => {
  it('on outcome=success: navigates to /paired exactly once', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: SUCCESS_RESULT });
    const { locations } = renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'GOOD{Enter}');

    await waitFor(() => {
      expect(locations).toContain('/paired');
    });
    // /pairing -> /paired; the probe records both. /paired must appear
    // exactly once (replace:true means no extra hops).
    expect(locations.filter((p) => p === '/paired')).toHaveLength(1);
  });

  it('on outcome=network_error: stays on /pairing (does NOT navigate)', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'network_error' } });
    const { locations } = renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    // Wait for the submit to settle (button re-enables).
    await waitFor(() => {
      expect(screen.getByRole('button')).not.toBeDisabled();
    });
    expect(locations).not.toContain('/paired');
  });

  it('on outcome=unknown_error: stays on /pairing and re-enables the form', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'unknown_error' } });
    const { locations } = renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('button')).not.toBeDisabled();
    });
    expect(locations).not.toContain('/paired');
    // Form is editable again.
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('does NOT echo the pairing_code into the rendered tree on any outcome', async () => {
    // Defensive: the React state is allowed to hold the code for retry,
    // but the rendered DOM tree MUST NOT contain it as text.
    const user = userEvent.setup();
    const sentinel = 'TOP-SECRET-PAIR-CODE';
    const { bridge } = makeBridge({ result: { outcome: 'unknown_error' } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), `${sentinel}{Enter}`);
    await waitFor(() => {
      expect(screen.getByRole('button')).not.toBeDisabled();
    });

    // The input is type="text" — its value attribute carries the code
    // for retry, which is expected. Assertion: no other DOM text node
    // contains the sentinel.
    // happy-dom always provides document.body; the closest('form') chain
    // is guaranteed by the test setup. We assert the form's container.
    const form = screen.getByRole('textbox').closest('form');
    if (!form) throw new Error('form not found in test DOM');
    const allText = (form.parentElement ?? form).textContent;
    expect(allText).not.toContain(sentinel);
  });
});

/* ------------------------- T042 ------------------------- */

describe('PairingForm — recoverable failure messages (T042)', () => {
  // The three US3 outcomes each surface a distinct user-visible message.
  // Form remains editable; no navigation; the input value is preserved
  // so the operator can correct and retry. No outcome-specific copy
  // for branch_mismatch (US4), rate_limited (US5), or the generic
  // network_error / unknown_error categories (T074 / Phase Final).

  it.each([
    {
      name: 'on outcome=invalid_code: renders the INVALID_CODE message via role="status"',
      outcome: 'invalid_code' as const,
      code: 'BADCODE',
      message: INVALID_CODE_MESSAGE,
    },
    {
      name: 'on outcome=expired_code: renders the EXPIRED_CODE message',
      outcome: 'expired_code' as const,
      code: 'OLDCODE',
      message: EXPIRED_CODE_MESSAGE,
    },
    {
      name: 'on outcome=already_paired: renders the ALREADY_PAIRED message',
      outcome: 'already_paired' as const,
      code: 'USEDCODE',
      message: ALREADY_PAIRED_MESSAGE,
    },
  ])('$name', async ({ outcome, code, message }) => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), `${code}{Enter}`);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(message);
    });
  });

  it('the three US3 messages are pairwise distinct', () => {
    // Pin the "distinct messages" requirement at the dictionary level so
    // a future copy edit cannot accidentally collapse two outcomes onto
    // the same string.
    const set = new Set([INVALID_CODE_MESSAGE, EXPIRED_CODE_MESSAGE, ALREADY_PAIRED_MESSAGE]);
    expect(set.size).toBe(3);
  });

  it('the three US3 messages are also distinct from the generic failure fallback', () => {
    // The generic fallback (used for unknown_error / network_error /
    // any future-unrecognised outcome until T074 lands per-category copy)
    // MUST NOT collide with any US3-owned message.
    const set = new Set([
      INVALID_CODE_MESSAGE,
      EXPIRED_CODE_MESSAGE,
      ALREADY_PAIRED_MESSAGE,
      GENERIC_FAILURE_MESSAGE,
    ]);
    expect(set.size).toBe(4);
  });

  it('on a US3 failure: form remains editable (input + button enabled)', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'invalid_code' } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('button')).not.toBeDisabled();
    });
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('on a US3 failure: does NOT navigate away from /pairing', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'expired_code' } });
    const { locations } = renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    expect(locations).not.toContain('/paired');
  });

  it('preserves the input value across a US3 failure (operator can retry)', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'invalid_code' } });
    renderInRouter(bridge);

    const input = screen.getByRole<HTMLInputElement>('textbox');
    await user.type(input, 'TYPED-VALUE{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    // The value the operator typed must still be in the input so they
    // can correct one character rather than retype the whole code.
    expect(input.value).toBe('TYPED-VALUE');
  });

  it('clears the failure message when the operator submits again successfully', async () => {
    // After a failed submit, the message persists in the DOM until the
    // next submit. On a successful subsequent submit (which navigates),
    // the form unmounts, so we just assert the message disappears
    // before navigation by using a re-emitting bridge.
    const user = userEvent.setup();
    let nextResult: PairingSubmitResult = { outcome: 'invalid_code' };
    const submit = vi.fn(() => Promise.resolve(nextResult));
    const bridge: PairingBridgeAPI = {
      submit,
      getStatus: vi.fn(() => Promise.reject(new Error('not used'))),
    };
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(INVALID_CODE_MESSAGE);
    });

    // Switch to a different failure outcome and submit again — the
    // message must update, not stack.
    nextResult = { outcome: 'expired_code' };
    await user.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(EXPIRED_CODE_MESSAGE);
    });
    expect(screen.queryByText(INVALID_CODE_MESSAGE)).not.toBeInTheDocument();
  });

  it('T074 — on outcome=network_error: shows NETWORK_ERROR_MESSAGE (not generic fallback)', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'network_error' } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(NETWORK_ERROR_MESSAGE);
    });
    expect(screen.queryByText(GENERIC_FAILURE_MESSAGE)).not.toBeInTheDocument();
  });

  it('T074 — on outcome=unknown_error: shows UNKNOWN_ERROR_MESSAGE', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'unknown_error' } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(UNKNOWN_ERROR_MESSAGE);
    });
  });

  it('does NOT echo the pairing_code into the rendered message tree', async () => {
    // The status region renders a fixed message string; the operator's
    // typed code MUST NOT appear in the message body even on failure.
    const user = userEvent.setup();
    const sentinel = 'TOP-SECRET-PAIR-CODE-9876';
    const { bridge } = makeBridge({ result: { outcome: 'invalid_code' } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), `${sentinel}{Enter}`);

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    // The status region's text MUST NOT contain the sentinel — only the
    // input element holds the value (for retry).
    expect(screen.getByRole('status').textContent).not.toContain(sentinel);
  });

  it('does NOT render any device_token field name (PairingSubmitResult omits it by type)', async () => {
    // Belt-and-braces: even if a future force-cast bridge surfaced
    // device_token in the result, the form must not place it in the DOM.
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'invalid_code' } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');
    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain('device_token');
  });
});

/* ------------------------- T044 ------------------------- */

describe('PairingForm — empty / whitespace validation (T044)', () => {
  it('empty Enter performs no bridge call AND surfaces a visible validation message', async () => {
    const user = userEvent.setup();
    const { bridge, submit } = makeBridge();
    renderInRouter(bridge);

    await user.keyboard('{Enter}');

    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(EMPTY_INPUT_MESSAGE);
  });

  it('whitespace-only Enter performs no bridge call AND surfaces the validation message', async () => {
    const user = userEvent.setup();
    const { bridge, submit } = makeBridge();
    renderInRouter(bridge);

    await user.keyboard('    {Enter}');

    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(EMPTY_INPUT_MESSAGE);
  });

  it('whitespace-only click on submit performs no bridge call AND surfaces the validation message', async () => {
    const user = userEvent.setup();
    const { bridge, submit } = makeBridge();
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), '   ');
    await user.click(screen.getByRole('button'));

    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(EMPTY_INPUT_MESSAGE);
  });

  it('client-side validation message is distinct from the three US3 failure messages', () => {
    const set = new Set([
      EMPTY_INPUT_MESSAGE,
      INVALID_CODE_MESSAGE,
      EXPIRED_CODE_MESSAGE,
      ALREADY_PAIRED_MESSAGE,
    ]);
    expect(set.size).toBe(4);
  });

  it('clears the validation message once the operator types and submits non-empty content', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'invalid_code' } });
    renderInRouter(bridge);

    // First: empty Enter -> validation message visible.
    await user.keyboard('{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent(EMPTY_INPUT_MESSAGE);

    // Now: type a code and submit — the validation message must be
    // replaced (not stacked) by whatever the bridge returns.
    await user.type(screen.getByRole('textbox'), 'GOODCODE{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(INVALID_CODE_MESSAGE);
    });
    expect(screen.queryByText(EMPTY_INPUT_MESSAGE)).not.toBeInTheDocument();
  });
});

/* ------------------------- T050 ------------------------- */

describe('PairingForm — BRANCH_MISMATCH outcome (T050)', () => {
  // US4: a BRANCH_MISMATCH outcome surfaces a distinct user-visible
  // message, the form remains editable, no navigation occurs, and the
  // input value is preserved so the operator can hand off to the
  // admin-driven recovery flow without retyping. The message MUST be
  // distinct from the three US3 messages and from the generic failure
  // fallback (regression guard at the dictionary level).

  it('on outcome=branch_mismatch: renders the BRANCH_MISMATCH message via role="status"', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'branch_mismatch' } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'OTHER-BRANCH-CODE{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(BRANCH_MISMATCH_MESSAGE);
    });
  });

  it('the BRANCH_MISMATCH message is distinct from the three US3 messages', () => {
    const set = new Set([
      INVALID_CODE_MESSAGE,
      EXPIRED_CODE_MESSAGE,
      ALREADY_PAIRED_MESSAGE,
      BRANCH_MISMATCH_MESSAGE,
    ]);
    expect(set.size).toBe(4);
  });

  it('the BRANCH_MISMATCH message is distinct from the generic failure fallback', () => {
    // The generic fallback is still used for unknown_error /
    // network_error / rate_limited until US5 / T074 land their copy.
    // BRANCH_MISMATCH MUST NOT collapse onto it — operators need a
    // distinct hint to escalate to admin.
    const set = new Set([BRANCH_MISMATCH_MESSAGE, GENERIC_FAILURE_MESSAGE]);
    expect(set.size).toBe(2);
  });

  it('BRANCH_MISMATCH copy mentions admin / different branch (operator action hint)', () => {
    // Pin the action-oriented shape of the copy at the dictionary level
    // so a future copy edit does not accidentally drop the admin hint.
    expect(BRANCH_MISMATCH_MESSAGE).toMatch(/لفرع آخر/);
    expect(BRANCH_MISMATCH_MESSAGE).toMatch(/المشرف/);
  });

  it('on outcome=branch_mismatch: form remains editable (input + button enabled)', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'branch_mismatch' } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('button')).not.toBeDisabled();
    });
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  it('on outcome=branch_mismatch: does NOT navigate away from /pairing', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'branch_mismatch' } });
    const { locations } = renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    expect(locations).not.toContain('/paired');
  });

  it('preserves the input value across a BRANCH_MISMATCH failure (operator can retry)', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'branch_mismatch' } });
    renderInRouter(bridge);

    const input = screen.getByRole<HTMLInputElement>('textbox');
    await user.type(input, 'TYPED-MISMATCH-VALUE{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    expect(input.value).toBe('TYPED-MISMATCH-VALUE');
  });

  it('does NOT echo the pairing_code into the BRANCH_MISMATCH message', async () => {
    const user = userEvent.setup();
    const sentinel = 'TOP-SECRET-MISMATCH-CODE-2024';
    const { bridge } = makeBridge({ result: { outcome: 'branch_mismatch' } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), `${sentinel}{Enter}`);

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    // The status region's text MUST NOT contain the sentinel — only
    // the input element holds the value (for retry).
    expect(screen.getByRole('status').textContent).not.toContain(sentinel);
  });

  it('does NOT render any device_token field name on BRANCH_MISMATCH', async () => {
    // Belt-and-braces: even if a future force-cast bridge surfaced
    // device_token in the result, the form must not place it in the
    // DOM on this failure path.
    const user = userEvent.setup();
    const { bridge } = makeBridge({ result: { outcome: 'branch_mismatch' } });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');
    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain('device_token');
  });
});

/* ------------------------- T056 ------------------------- */

describe('PairingForm — RATE_LIMITED outcome (T056, US5)', () => {
  // US5: a rate_limited outcome disables submit for the indicated
  // retry_after_s seconds, then re-enables. The form input remains
  // editable throughout (only the button gates). The visible message
  // is distinct from all other failure messages and matches a stable
  // /too many attempts/i family copy.
  //
  // Strategy: drive the form via fireEvent (synchronous, no microtask
  // pumping needed) so we can mix real and fake timers cleanly.
  // userEvent + fake timers in Vitest 4 has a known-tricky interaction
  // (microtask vs setTimeout patching) that fireEvent sidesteps.

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Synchronously set the input value and submit the form. Avoids
   * userEvent's internal delays so fake-timer tests don't have to
   * coordinate microtask pumping. Returns the form element for any
   * further direct dispatch.
   */
  function submitWithCode(code: string): HTMLFormElement {
    const input = screen.getByRole<HTMLInputElement>('textbox');
    fireEvent.change(input, { target: { value: code } });
    const form = input.closest('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);
    return form;
  }

  it('on rate_limited: disables submit immediately and re-enables exactly after retry_after_s', async () => {
    // Fake timers MUST be active BEFORE mount so the form's useEffect
    // schedules its setTimeout under fake-timer control. waitFor uses
    // setTimeout internally and would hang under fake timers, so we
    // flush microtasks manually via async-act instead — that pumps
    // the bridge's promise resolve and React's setState commits.
    vi.useFakeTimers();
    const { bridge } = makeBridge({ result: { outcome: 'rate_limited', retry_after_s: 5 } });
    renderInRouter(bridge);

    await act(async () => {
      submitWithCode('CODE');
      await Promise.resolve();
    });

    expect(screen.getByRole('button')).toBeDisabled();

    // 4_999 ms in: still disabled.
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(screen.getByRole('button')).toBeDisabled();

    // Cross the 5_000 ms boundary: re-enables. Async-act flushes the
    // setState commit from the timer callback through React 19's
    // microtask scheduling.
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('on rate_limited: shows RATE_LIMITED_MESSAGE in the «محاولات كثيرة» family', async () => {
    const { bridge } = makeBridge({ result: { outcome: 'rate_limited', retry_after_s: 3 } });
    renderInRouter(bridge);

    submitWithCode('CODE');

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(RATE_LIMITED_MESSAGE);
    });
    expect(screen.getByRole('status')).toHaveTextContent(/^محاولات كثيرة/);
  });

  it('the rate_limited message is distinct from every other US3/US4 message and the generic fallback', () => {
    const set = new Set([
      INVALID_CODE_MESSAGE,
      EXPIRED_CODE_MESSAGE,
      ALREADY_PAIRED_MESSAGE,
      BRANCH_MISMATCH_MESSAGE,
      RATE_LIMITED_MESSAGE,
      GENERIC_FAILURE_MESSAGE,
    ]);
    expect(set.size).toBe(6);
  });

  it('while disabled: a second Enter / click does NOT call bridge.submit again', async () => {
    const { bridge, submit } = makeBridge({
      result: { outcome: 'rate_limited', retry_after_s: 10 },
    });
    renderInRouter(bridge);

    const form = submitWithCode('CODE');

    // Wait for the settled rate-limited state (status message) rather than
    // the transient in-flight `submitting` disable, so the second submit
    // below is genuinely tested against the `isRateLimited` guard — not a
    // still-pending first call.
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(RATE_LIMITED_MESSAGE);
    });
    expect(screen.getByRole('button')).toBeDisabled();
    expect(submit).toHaveBeenCalledTimes(1);

    // Try to submit again while disabled. The form's isRateLimited
    // guard MUST suppress the call.
    fireEvent.submit(form);
    expect(submit).toHaveBeenCalledTimes(1);

    // Click attempts on disabled buttons are dropped by the runtime,
    // but assert the call count anyway as a regression guard.
    fireEvent.click(screen.getByRole('button'));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('while disabled: the input remains editable (not disabled by isRateLimited)', async () => {
    const { bridge } = makeBridge({ result: { outcome: 'rate_limited', retry_after_s: 10 } });
    renderInRouter(bridge);

    submitWithCode('CODE');

    // Wait for the SETTLED rate-limited state, not the transient in-flight
    // one. `button toBeDisabled` is satisfied while `submitting` is still
    // true (the button gates on `submitting || isRateLimited`) — and at that
    // instant the INPUT is also disabled (`disabled={submitting}`), so an
    // input-enabled assertion races the promise resolution and flakes under
    // CI load. The rate-limit `role="status"` message is set in the same
    // commit as `setDisabledUntil`, AFTER the await resolves and
    // `submitting` has flipped back to false — so waiting on it guarantees
    // only `isRateLimited` gates the button.
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(RATE_LIMITED_MESSAGE);
    });
    expect(screen.getByRole('button')).toBeDisabled();

    // The input MUST remain enabled — operators may correct a typo
    // while waiting for the timer. Only the submit BUTTON gates.
    const input = screen.getByRole<HTMLInputElement>('textbox');
    expect(input).toBeEnabled();

    // Operator can still edit the input value while the button is
    // disabled.
    fireEvent.change(input, { target: { value: 'CODEX' } });
    expect(input.value).toBe('CODEX');
  });

  it('on rate_limited: does NOT navigate away from /pairing', async () => {
    const { bridge } = makeBridge({ result: { outcome: 'rate_limited', retry_after_s: 5 } });
    const { locations } = renderInRouter(bridge);

    submitWithCode('CODE');

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    expect(locations).not.toContain('/paired');
  });

  it('preserves the input value across a rate_limited failure (operator can retry after timer)', async () => {
    const { bridge } = makeBridge({ result: { outcome: 'rate_limited', retry_after_s: 5 } });
    renderInRouter(bridge);

    submitWithCode('TYPED-RATE-VALUE');

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('TYPED-RATE-VALUE');
  });

  it('does NOT echo the pairing_code into the rate_limited message region', async () => {
    const sentinel = 'TOP-SECRET-RATE-CODE-2024';
    const { bridge } = makeBridge({ result: { outcome: 'rate_limited', retry_after_s: 5 } });
    renderInRouter(bridge);

    submitWithCode(sentinel);

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    expect(screen.getByRole('status').textContent).not.toContain(sentinel);
  });

  it('does NOT render any device_token field name on rate_limited', async () => {
    const { bridge } = makeBridge({ result: { outcome: 'rate_limited', retry_after_s: 5 } });
    renderInRouter(bridge);

    submitWithCode('CODE');
    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toBeInTheDocument();
    });
    expect(document.body.textContent).not.toContain('device_token');
  });

  it('boundary: retry_after_s = 1 second disables submit for ~1s and re-enables', async () => {
    vi.useFakeTimers();
    const { bridge } = makeBridge({ result: { outcome: 'rate_limited', retry_after_s: 1 } });
    renderInRouter(bridge);

    await act(async () => {
      submitWithCode('CODE');
      await Promise.resolve();
    });
    expect(screen.getByRole('button')).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByRole('button')).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('boundary: retry_after_s = 300 (max) disables submit for the full 5 minutes', async () => {
    vi.useFakeTimers();
    const { bridge } = makeBridge({ result: { outcome: 'rate_limited', retry_after_s: 300 } });
    renderInRouter(bridge);

    await act(async () => {
      submitWithCode('CODE');
      await Promise.resolve();
    });
    expect(screen.getByRole('button')).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(299_999);
    });
    expect(screen.getByRole('button')).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('after the timer expires: a fresh submit IS allowed (form recovers)', async () => {
    vi.useFakeTimers();
    let nextResult: PairingSubmitResult = { outcome: 'rate_limited', retry_after_s: 2 };
    const submit = vi.fn(() => Promise.resolve(nextResult));
    const bridge: PairingBridgeAPI = {
      submit,
      getStatus: vi.fn(() => Promise.reject(new Error('not used'))),
    };
    renderInRouter(bridge);

    await act(async () => {
      submitWithCode('CODE');
      await Promise.resolve();
    });
    expect(screen.getByRole('button')).toBeDisabled();
    expect(submit).toHaveBeenCalledTimes(1);

    // Advance past the timer.
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(screen.getByRole('button')).not.toBeDisabled();

    // Switch the bridge to a different outcome and retry. The second
    // submit goes through fireEvent.click; async-act flushes its
    // promise resolve.
    nextResult = { outcome: 'invalid_code' };
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
      await Promise.resolve();
    });
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------- T075 ------------------------- */

describe('PairingForm — empty-Enter-on-focus regression (T075)', () => {
  /**
   * FR-13 / Constitution Principle IV — keyboard-wedge safety.
   *
   * When the input receives browser autofocus and the operator (or a
   * wedge scanner) fires Enter before typing any content, the form MUST:
   *   - make zero bridge calls, and
   *   - surface EMPTY_INPUT_MESSAGE so the operator knows why nothing
   *     happened (not a silent no-op).
   *
   * This is the T075 regression guard: a future refactor that removes
   * the `code.length === 0` guard in `PairingForm` MUST break this test.
   */

  it('immediate Enter on autofocused input makes no bridge call', async () => {
    const user = userEvent.setup();
    const { bridge, submit } = makeBridge();
    renderInRouter(bridge);

    // Wait for autofocus to land, then press Enter with no content typed.
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
    await user.keyboard('{Enter}');

    expect(submit).not.toHaveBeenCalled();
  });

  it('immediate Enter on autofocused input surfaces EMPTY_INPUT_MESSAGE', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge();
    renderInRouter(bridge);

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
    await user.keyboard('{Enter}');

    expect(screen.getByRole('status')).toHaveTextContent(EMPTY_INPUT_MESSAGE);
  });

  it('immediate Enter does not trigger navigation (stays on /pairing)', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge();
    const { locations } = renderInRouter(bridge);

    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
    await user.keyboard('{Enter}');

    expect(locations).not.toContain('/paired');
  });
});

describe('PairingForm — focus after a refused code (RT-244 PR2)', () => {
  // The field is disabled while a submit is in flight, and a disabled field
  // drops focus to <body>. A scanner operator must be able to scan the next
  // code without reaching for the mouse, so focus returns to the field.
  it('returns focus to the code field when the submit is refused', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({
      // Chromium blurs a field the moment it is disabled; happy-dom does not,
      // so the in-flight submit does it here.
      submitImpl: () => {
        screen.getByRole('textbox').blur();
        return Promise.resolve({ outcome: 'invalid_code' });
      },
    });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'BADCODE{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(INVALID_CODE_MESSAGE);
    });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
  });

  it('a submit that throws shows the "other" copy and returns focus to the field', async () => {
    const user = userEvent.setup();
    const { bridge } = makeBridge({
      submitImpl: () => {
        screen.getByRole('textbox').blur();
        return Promise.reject(new Error('ipc handler threw'));
      },
    });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toHaveTextContent(UNKNOWN_ERROR_MESSAGE);
    });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
  });

  it('leaves focus where the operator moved it while the submit ran', async () => {
    const user = userEvent.setup();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    const { bridge } = makeBridge({
      submitImpl: () => {
        elsewhere.focus();
        return Promise.resolve({ outcome: 'invalid_code' });
      },
    });
    renderInRouter(bridge);

    await user.type(screen.getByRole('textbox'), 'CODE{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId('pairing-message')).toHaveTextContent(INVALID_CODE_MESSAGE);
    });
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });
});
