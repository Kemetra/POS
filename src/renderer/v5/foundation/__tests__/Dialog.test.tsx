import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type JSX } from 'react';
import '@testing-library/jest-dom/vitest';

import { ScanGuardHost, resetScanGuardForTests, useScanOwner } from '../../../scan/ScanGuardHost';
import { SCAN_DIALOG_OPEN_MESSAGE } from '../../../scan/scan-messages';
import { ConfirmDialog } from '../ConfirmDialog';
import { Dialog, DialogHost } from '../Dialog';

/**
 * RT-241 (VNext W1-A) — the one v5 Dialog mechanism (freeze 15 §3.1–§3.3, §4).
 *
 * Modal: Tab and Shift+Tab stay inside; focus starts on the caller's safe
 * control; Esc cancels when cancelling is allowed and never leaks to the
 * screen behind (Checkout's Esc = Back); focus returns to the invoker; the
 * panel renders RTL Arabic inside the frame's host (so the lock's inert and
 * conceal rules cover it); and an open dialog suspends scanning (M-S6).
 */

interface HarnessProps {
  onCancel?: () => void;
  restoreFocus?: boolean;
}

function Harness({ onCancel, restoreFocus }: HarnessProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const safeRef = useRef<HTMLButtonElement>(null);
  return (
    <DialogHost>
      <div data-testid="app">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
        >
          فتح
        </button>
        {open && (
          <Dialog
            label="نافذة الاختبار"
            initialFocusRef={safeRef}
            {...(restoreFocus !== undefined ? { restoreFocus } : {})}
            {...(onCancel !== undefined
              ? {
                  onCancel: () => {
                    onCancel();
                    setOpen(false);
                  },
                }
              : {})}
          >
            <input aria-label="الحقل الأول" />
            <button ref={safeRef} type="button">
              رجوع
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
              }}
            >
              تأكيد
            </button>
          </Dialog>
        )}
      </div>
    </DialogHost>
  );
}

async function openDialog(props: HarnessProps = {}): Promise<HTMLElement> {
  render(<Harness {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'فتح' }));
  return screen.getByRole('dialog', { name: 'نافذة الاختبار' });
}

afterEach(cleanup);

describe('Dialog — modal semantics', () => {
  it('is a labelled modal dialog', async () => {
    const dialog = await openDialog();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('starts on the safe control the caller names, not the first field', async () => {
    await openDialog();
    expect(screen.getByRole('button', { name: 'رجوع' })).toHaveFocus();
  });

  it('Tab from the last control wraps to the first', async () => {
    await openDialog();
    screen.getByRole('button', { name: 'تأكيد' }).focus();
    await userEvent.tab();
    expect(screen.getByRole('textbox', { name: 'الحقل الأول' })).toHaveFocus();
  });

  it('Shift+Tab from the first control wraps to the last', async () => {
    await openDialog();
    screen.getByRole('textbox', { name: 'الحقل الأول' }).focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'تأكيد' })).toHaveFocus();
  });

  it('Tab inside the dialog never reaches the page behind it', async () => {
    await openDialog();
    for (let i = 0; i < 6; i += 1) {
      await userEvent.tab();
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('a press on the backdrop does not take focus out of the dialog', async () => {
    const dialog = await openDialog();
    const backdrop = dialog.parentElement as HTMLElement;
    const event = fireEvent.mouseDown(backdrop);
    expect(event).toBe(false); // default prevented: focus stays put
    expect(screen.getByRole('button', { name: 'رجوع' })).toHaveFocus();
  });
});

function RadioHarness({ checked }: { checked: string | null }): JSX.Element {
  const safeRef = useRef<HTMLButtonElement>(null);
  return (
    <DialogHost>
      <button type="button">خارج النافذة</button>
      <Dialog label="اختيار المدير" initialFocusRef={safeRef}>
        <fieldset>
          <legend>المدير</legend>
          {['أ', 'ب', 'ج'].map((name) => (
            <label key={name}>
              <input type="radio" name="manager" readOnly checked={checked === name} />
              {name}
            </label>
          ))}
        </fieldset>
        <button ref={safeRef} type="button">
          رجوع
        </button>
      </Dialog>
    </DialogHost>
  );
}

describe('Dialog — Tab trap with a radio group (one tab stop)', () => {
  it('Shift+Tab from the checked radio, not the first, wraps to the last control', async () => {
    render(<RadioHarness checked="ب" />);
    screen.getByRole('radio', { name: 'ب' }).focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'رجوع' })).toHaveFocus();
  });

  it('Tab from the last control wraps to the checked radio of the group', async () => {
    render(<RadioHarness checked="ج" />);
    screen.getByRole('button', { name: 'رجوع' }).focus();
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: 'ج' })).toHaveFocus();
  });

  it('with no radio checked, Shift+Tab from the first radio still wraps inside', async () => {
    render(<RadioHarness checked={null} />);
    screen.getByRole('radio', { name: 'أ' }).focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'رجوع' })).toHaveFocus();
  });
});

describe('Dialog — initial focus fallback (harden)', () => {
  it('a disabled safe control cannot take focus: focus lands on the panel, never outside the dialog', () => {
    function Disabled(): JSX.Element {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <DialogHost>
          <Dialog label="نافذة" initialFocusRef={ref}>
            <button ref={ref} type="button" disabled>
              رجوع
            </button>
          </Dialog>
        </DialogHost>
      );
    }
    render(<Disabled />);
    expect(screen.getByRole('dialog')).toHaveFocus();
  });
});

describe('Dialog — Esc', () => {
  let windowKeys: ReturnType<typeof vi.fn<(key: string) => void>>;
  const onWindowKey = (event: KeyboardEvent): void => {
    windowKeys(event.key);
  };
  beforeEach(() => {
    windowKeys = vi.fn<(key: string) => void>();
    window.addEventListener('keydown', onWindowKey);
  });
  afterEach(() => {
    window.removeEventListener('keydown', onWindowKey);
  });

  it('cancels when cancelling is allowed', async () => {
    const onCancel = vi.fn();
    await openDialog({ onCancel });
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never reaches a window listener behind the dialog (Checkout Esc = Back)', async () => {
    await openDialog({ onCancel: vi.fn() });
    await userEvent.keyboard('{Escape}');
    expect(windowKeys).not.toHaveBeenCalledWith('Escape');
  });

  it('keeps the dialog open when cancelling is not allowed, and still does not leak', async () => {
    await openDialog();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(windowKeys).not.toHaveBeenCalledWith('Escape');
  });
});

describe('Dialog — focus return', () => {
  it('returns focus to the invoker when it closes', async () => {
    await openDialog({ onCancel: vi.fn() });
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'فتح' })).toHaveFocus();
  });

  it('leaves focus alone when the caller routes it (restoreFocus=false)', async () => {
    await openDialog({ onCancel: vi.fn(), restoreFocus: false });
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'فتح' })).not.toHaveFocus();
  });
});

describe('Dialog — portal', () => {
  it('renders RTL Arabic', async () => {
    const dialog = await openDialog();
    const scope = dialog.closest('[dir]');
    expect(scope).toHaveAttribute('dir', 'rtl');
    expect(scope).toHaveAttribute('lang', 'ar');
  });

  it("renders inside the host's subtree, so the lock's inert and conceal rules cover it", async () => {
    const { container } = render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'فتح' }));
    expect(container).toContainElement(screen.getByRole('dialog'));
    // ...but outside the screen that opened it: the backdrop covers the nav too.
    expect(screen.getByTestId('app')).not.toContainElement(screen.getByRole('dialog'));
  });
});

function ScanOwner({ onScan }: { onScan: (code: string) => void }): null {
  useScanOwner(onScan);
  return null;
}

describe('Dialog — scanner', () => {
  beforeEach(() => {
    resetScanGuardForTests();
  });

  it('suspends scanning: a burst is refused visibly (M-S6) and never reaches the owner', async () => {
    const onScan = vi.fn();
    render(
      <>
        <ScanGuardHost />
        <ScanOwner onScan={onScan} />
        <Harness />
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'فتح' }));
    const focused = screen.getByRole('button', { name: 'رجوع' });
    act(() => {
      for (const key of '123456') fireEvent.keyDown(focused, { key });
      fireEvent.keyDown(focused, { key: 'Enter' });
    });
    expect(onScan).not.toHaveBeenCalled();
    expect(screen.getByTestId('scan-notice')).toHaveTextContent(SCAN_DIALOG_OPEN_MESSAGE);
  });
});

describe('ConfirmDialog', () => {
  function Confirm(props: {
    onConfirm: () => void;
    onCancel: () => void;
    busy?: boolean;
  }): JSX.Element {
    return (
      <DialogHost>
        <ConfirmDialog
          label="تأكيد إلغاء البيع"
          title="إلغاء البيع؟"
          body="سيتم إلغاء السلة الحالية."
          cancelLabel="العودة"
          confirmLabel="تأكيد الإلغاء"
          tone="danger"
          onCancel={props.onCancel}
          onConfirm={props.onConfirm}
          {...(props.busy !== undefined ? { busy: props.busy } : {})}
        />
      </DialogHost>
    );
  }

  it('starts on the safe option, so Enter never confirms a destructive action', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<Confirm onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: 'العودة' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirm runs the action; Esc cancels', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<Confirm onConfirm={onConfirm} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: 'تأكيد الإلغاء' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps stable action slots: cancel at inline-start, commit at inline-end (A2)', () => {
    render(<Confirm onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['العودة', 'تأكيد الإلغاء']);
  });

  it('names its content: title and body describe the dialog', () => {
    render(<Confirm onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'تأكيد إلغاء البيع' });
    expect(dialog).toHaveAccessibleDescription('سيتم إلغاء السلة الحالية.');
    expect(screen.getByRole('heading', { name: 'إلغاء البيع؟' })).toBeInTheDocument();
  });

  it('while busy, neither action can run twice', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<Confirm onConfirm={onConfirm} onCancel={onCancel} busy />);
    expect(screen.getByRole('button', { name: 'تأكيد الإلغاء' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'العودة' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a failed confirm says so inside the dialog, as an alert', () => {
    render(
      <DialogHost>
        <ConfirmDialog
          label="تأكيد"
          title="إلغاء البيع؟"
          cancelLabel="العودة"
          confirmLabel="تأكيد الإلغاء"
          error="تعذّر إلغاء البيع."
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </DialogHost>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('تعذّر إلغاء البيع.');
  });

  it('the default tone commits with the primary button; no body means no description', () => {
    render(
      <DialogHost>
        <ConfirmDialog
          label="تأكيد"
          title="متابعة؟"
          cancelLabel="رجوع"
          confirmLabel="متابعة"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </DialogHost>,
    );
    expect(screen.getByRole('button', { name: 'متابعة' })).toHaveClass('v5-live-btn--primary');
    expect(screen.getByRole('button', { name: 'متابعة' })).not.toHaveClass('v5-live-btn--danger');
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby');
  });
});
