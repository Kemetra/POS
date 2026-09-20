/**
 * T045 — <ExternalCardTerminalEntry> reference-field validation test.
 *
 * Asserts:
 *   - the optional reference field applies the ^[A-Z0-9]{0,6}$ regex
 *     client-side;
 *   - rejects long input (>6 chars), lowercase, and special characters with
 *     generic `invalid_input` copy (cashier-facing wording remains generic;
 *     the structured token must NOT appear in the DOM);
 *   - a valid reference reaches onConfirm; an empty reference is null.
 *
 * References: FR-009, visual-direction §State 3.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';

afterEach(cleanup);

import { ExternalCardTerminalEntry } from '../../../../src/renderer/ui/payments/ExternalCardTerminalEntry.js';

function setup(props: Partial<ComponentProps<typeof ExternalCardTerminalEntry>> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const view = render(
    <ExternalCardTerminalEntry
      remainingBalanceMinor={props.remainingBalanceMinor ?? 12550}
      onConfirm={onConfirm}
    />,
  );
  const refInput = screen.getByTestId('external-card-reference-input');
  const confirm = screen.getByTestId('external-card-confirm');
  return { ...view, onConfirm, refInput, confirm };
}

describe('<ExternalCardTerminalEntry> — reference field accepts valid input', () => {
  it('accepts the empty string (optional field, no error)', () => {
    const { refInput } = setup();
    expect(refInput.value).toBe('');
    expect(screen.queryByTestId('external-card-reference-error')).toBeNull();
  });

  it('accepts a valid 6-char alphanumeric uppercase reference', () => {
    const { refInput } = setup();
    fireEvent.change(refInput, { target: { value: 'T1A2B3' } });
    expect(refInput.value).toBe('T1A2B3');
    expect(screen.queryByTestId('external-card-reference-error')).toBeNull();
  });

  it('passes the reference through to onConfirm', () => {
    const onConfirm = vi.fn();
    const { refInput, confirm } = setup({ remainingBalanceMinor: 12550, onConfirm });
    fireEvent.change(refInput, { target: { value: 'AB1234' } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({
      amountAppliedMinor: 12550,
      externalReference: 'AB1234',
    });
  });

  it('passes externalReference=null when the field is left empty', () => {
    const onConfirm = vi.fn();
    const { confirm } = setup({ remainingBalanceMinor: 12550, onConfirm });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({
      amountAppliedMinor: 12550,
      externalReference: null,
    });
  });
});

describe('<ExternalCardTerminalEntry> — reference field rejects invalid input', () => {
  it('rejects 7+ characters (length cap is 6)', () => {
    const { refInput, confirm } = setup();
    fireEvent.change(refInput, { target: { value: 'ABCDEFG' } });
    expect(screen.getByTestId('external-card-reference-error')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
  });

  it('rejects lowercase input', () => {
    const { refInput, confirm } = setup();
    fireEvent.change(refInput, { target: { value: 'abc' } });
    expect(screen.getByTestId('external-card-reference-error')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
  });

  it('rejects special characters', () => {
    const { refInput, confirm } = setup();
    fireEvent.change(refInput, { target: { value: 'AB-CD' } });
    expect(screen.getByTestId('external-card-reference-error')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
  });

  it('rejects whitespace', () => {
    const { refInput, confirm } = setup();
    fireEvent.change(refInput, { target: { value: 'AB CD' } });
    expect(screen.getByTestId('external-card-reference-error')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
  });

  it('rejects a PAN-shaped value (16 digits)', () => {
    const { refInput, confirm } = setup();
    fireEvent.change(refInput, { target: { value: '4111111111111111' } });
    expect(screen.getByTestId('external-card-reference-error')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
  });

  it('shows generic invalid_input copy, never the structured token in the DOM', () => {
    const { refInput } = setup();
    fireEvent.change(refInput, { target: { value: 'ABCDEFG' } });
    const err = screen.getByTestId('external-card-reference-error');
    expect(err).toHaveTextContent(/غير صحيحة|صيغة/);
    expect(document.body.innerHTML).not.toContain('invalid_input');
  });

  it('clears the error once the reference becomes valid again', () => {
    const { refInput } = setup();
    fireEvent.change(refInput, { target: { value: 'abc' } });
    expect(screen.queryByTestId('external-card-reference-error')).not.toBeNull();
    fireEvent.change(refInput, { target: { value: 'ABC' } });
    expect(screen.queryByTestId('external-card-reference-error')).toBeNull();
  });

  it('does not call onConfirm while reference is invalid', () => {
    const onConfirm = vi.fn();
    const { refInput, confirm } = setup({ remainingBalanceMinor: 12550, onConfirm });
    fireEvent.change(refInput, { target: { value: 'abc' } });
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
