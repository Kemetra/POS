import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  createScanGuard,
  type GuardKeyEvent,
  type RefuseSurface,
  type ScanGuard,
} from '../scan-guard.js';
import {
  SCAN_DIALOG_OPEN_MESSAGE,
  SCAN_REFUSED_MESSAGE,
  SCAN_UNAVAILABLE_MESSAGE,
} from '../scan-messages.js';

interface FakeEvent extends GuardKeyEvent {
  preventDefault: Mock<() => void>;
  stopImmediatePropagation: Mock<() => void>;
}

function ev(key: string, timeStamp: number, over: Partial<GuardKeyEvent> = {}): FakeEvent {
  return {
    key,
    timeStamp,
    repeat: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...over,
    preventDefault: vi.fn<() => void>(),
    stopImmediatePropagation: vi.fn<() => void>(),
  };
}

/** Type `code` into the active element at `gap` ms spacing, then press Enter. Returns the Enter event. */
function scan(
  guard: ScanGuard,
  code: string,
  opts: { gap?: number; start?: number } = {},
): FakeEvent {
  const gap = opts.gap ?? 5;
  let t = opts.start ?? 1000;
  for (const ch of code) {
    guard.handleKeyDown(ev(ch, t));
    typeInto(document.activeElement, ch);
    t += gap;
  }
  const enter = ev('Enter', t);
  guard.handleKeyDown(enter);
  return enter;
}

/** What the browser does after the guard saw the keydown: the character lands in a text field. */
function typeInto(el: Element | null, ch: string): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.value += ch;
  }
}

let notices: string[];
let dialogOpen: boolean;
let owner: Mock<(code: string) => void>;
let guard: ScanGuard;

beforeEach(() => {
  notices = [];
  dialogOpen = false;
  owner = vi.fn<(code: string) => void>();
  guard = createScanGuard({
    activeElement: () => document.activeElement,
    hasOpenDialog: () => dialogOpen,
    notify: (m) => notices.push(m),
  });
  guard.setOwner(owner);
});

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): void {
  document.body.innerHTML = html;
}

function focus(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`no element ${selector}`);
  el.focus();
  return el;
}

describe('burst on a non-text control (F-01)', () => {
  it.each(['button', 'body'])(
    'a burst while focus is on %s is claimed and routed, never activating the control',
    (where) => {
      mount('<button id="del">حذف</button>');
      if (where === 'button') focus('#del');
      const enter = scan(guard, '6221000000011');
      expect(enter.preventDefault).toHaveBeenCalled();
      expect(enter.stopImmediatePropagation).toHaveBeenCalled();
      expect(owner).toHaveBeenCalledWith('6221000000011');
      expect(notices).toEqual([]);
    },
  );

  it('Enter pressed by a person on a focused button is left alone', () => {
    mount('<button id="del">حذف</button>');
    focus('#del');
    const enter = ev('Enter', 5000);
    guard.handleKeyDown(enter);
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(enter.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(owner).not.toHaveBeenCalled();
  });
});

describe('code shapes (timing, not length)', () => {
  it.each(['X', 'AB-12', '6221000000011'])('%s resolves through the scan path', (code) => {
    mount('<button id="b">x</button>');
    focus('#b');
    scan(guard, code);
    expect(owner).toHaveBeenCalledWith(code);
  });

  it('Shift keydowns for an upper-case code do not break the run', () => {
    mount('<button id="b">x</button>');
    focus('#b');
    let t = 1000;
    for (const ch of 'AB') {
      guard.handleKeyDown(ev('Shift', t));
      t += 3;
      guard.handleKeyDown(ev(ch, t));
      t += 3;
    }
    guard.handleKeyDown(ev('Enter', t));
    expect(owner).toHaveBeenCalledWith('AB');
  });

  it('a held key (auto-repeat) followed by Enter is not a burst', () => {
    mount('<button id="b">x</button>');
    focus('#b');
    guard.handleKeyDown(ev('a', 1000, { repeat: true }));
    guard.handleKeyDown(ev('a', 1033, { repeat: true }));
    const enter = ev('Enter', 1066);
    guard.handleKeyDown(enter);
    expect(owner).not.toHaveBeenCalled();
    expect(enter.preventDefault).not.toHaveBeenCalled();
  });

  it('a non-printable key (Tab, Backspace) breaks the run', () => {
    mount('<button id="b">x</button>');
    focus('#b');
    guard.handleKeyDown(ev('1', 1000));
    guard.handleKeyDown(ev('Backspace', 1005));
    guard.handleKeyDown(ev('Enter', 1010));
    expect(owner).not.toHaveBeenCalled();
  });
});

describe('money, PIN and card-reference fields reject bursts (M-S5)', () => {
  it('cash amount field: previous value restored, amount notice, nothing routed', () => {
    mount('<input id="amt" inputmode="numeric" value="" />');
    focus('#amt');
    const enter = scan(guard, '6221000000011');
    expect((document.querySelector('#amt') as HTMLInputElement).value).toBe('');
    expect(notices).toEqual([SCAN_REFUSED_MESSAGE.amount]);
    expect(owner).not.toHaveBeenCalled();
    expect(enter.preventDefault).toHaveBeenCalled();
  });

  it('keeps what the cashier had already typed in an amount field', () => {
    mount('<input id="amt" inputmode="decimal" value="20.00" />');
    focus('#amt');
    scan(guard, '999999');
    expect((document.querySelector('#amt') as HTMLInputElement).value).toBe('20.00');
  });

  it('a password field is a PIN field', () => {
    mount('<input id="pin" type="password" value="12" />');
    focus('#pin');
    scan(guard, '6221000000011');
    expect((document.querySelector('#pin') as HTMLInputElement).value).toBe('12');
    expect(notices).toEqual([SCAN_REFUSED_MESSAGE.pin]);
  });

  it('a plain-text field declares itself a card reference', () => {
    mount('<input id="ref" type="text" data-scan-refuse="reference" value="" />');
    focus('#ref');
    scan(guard, 'ABC123');
    expect((document.querySelector('#ref') as HTMLInputElement).value).toBe('');
    expect(notices).toEqual([SCAN_REFUSED_MESSAGE.reference]);
    expect(owner).not.toHaveBeenCalled();
  });

  it('an explicit declaration wins over inference', () => {
    mount('<input id="f" inputmode="numeric" data-scan-refuse="reference" />');
    focus('#f');
    scan(guard, '123');
    expect(notices).toEqual([SCAN_REFUSED_MESSAGE.reference]);
  });

  it('a surface with no input (the PIN pad) is restored and refused', () => {
    let pin = '12';
    const surface: RefuseSurface = {
      snapshot: () => pin,
      restore: (v) => {
        pin = v;
      },
    };
    guard.registerSurface('pin', surface);
    mount('<div></div>');
    // The PIN pad listens on window and appends each digit itself.
    let t = 1000;
    for (const ch of '6221') {
      guard.handleKeyDown(ev(ch, t));
      pin += ch;
      t += 5;
    }
    const enter = ev('Enter', t);
    guard.handleKeyDown(enter);
    expect(pin).toBe('12');
    expect(notices).toEqual([SCAN_REFUSED_MESSAGE.pin]);
    expect(enter.stopImmediatePropagation).toHaveBeenCalled();
    expect(owner).not.toHaveBeenCalled();
  });

  it('an unregistered surface no longer refuses', () => {
    const off = guard.registerSurface('pin', { snapshot: () => '', restore: vi.fn() });
    off();
    mount('<div></div>');
    scan(guard, '123');
    expect(owner).toHaveBeenCalledWith('123');
  });
});

describe('search field, other text fields and dialogs', () => {
  it('a burst typed into the search field is a scan and the field is cleared', () => {
    mount('<input id="s" type="search" data-scan-target="search" value="" />');
    focus('#s');
    scan(guard, '6221000000011');
    expect((document.querySelector('#s') as HTMLInputElement).value).toBe('');
    expect(owner).toHaveBeenCalledWith('6221000000011');
  });

  it('a note field gets its previous text back and the scan is routed', () => {
    mount('<textarea id="n" data-scan-target="note">باركود</textarea>');
    focus('#n');
    scan(guard, '123456');
    expect((document.querySelector('#n') as HTMLTextAreaElement).value).toBe('باركود');
    expect(owner).toHaveBeenCalledWith('123456');
  });

  it('a burst during a dialog is refused with M-S6 and nothing is added', () => {
    dialogOpen = true;
    mount('<button id="b">x</button>');
    focus('#b');
    const enter = scan(guard, '123456');
    expect(notices).toEqual([SCAN_DIALOG_OPEN_MESSAGE]);
    expect(owner).not.toHaveBeenCalled();
    expect(enter.stopImmediatePropagation).toHaveBeenCalled();
  });

  it('a protected field inside a dialog says the field message, not the dialog one', () => {
    dialogOpen = true;
    mount('<input id="pin" type="password" />');
    focus('#pin');
    scan(guard, '123456');
    expect(notices).toEqual([SCAN_REFUSED_MESSAGE.pin]);
  });

  it('with no scan owner the cashier is told scanning is unavailable', () => {
    const bare = createScanGuard({
      activeElement: () => document.activeElement,
      hasOpenDialog: () => false,
      notify: (m) => notices.push(m),
    });
    mount('<button id="b">x</button>');
    focus('#b');
    scan(bare, '123');
    expect(notices).toEqual([SCAN_UNAVAILABLE_MESSAGE]);
  });
});

describe('scan owner registration', () => {
  it('the unregister of a replaced owner leaves the current owner in place', () => {
    const second = vi.fn<(code: string) => void>();
    const offFirst = guard.setOwner(owner);
    guard.setOwner(second);
    offFirst();
    mount('<button id="b">x</button>');
    focus('#b');
    scan(guard, '77');
    expect(second).toHaveBeenCalledWith('77');
    expect(owner).not.toHaveBeenCalled();
  });

  it('unregistering the current owner leaves scanning unavailable', () => {
    const off = guard.setOwner(owner);
    off();
    mount('<button id="b">x</button>');
    focus('#b');
    scan(guard, '77');
    expect(notices).toEqual([SCAN_UNAVAILABLE_MESSAGE]);
  });
});

describe('other text fields are not the guard business (behaviour preserved)', () => {
  it.each([
    ['a sale-number lookup', '<input id="f" type="text" />'],
    ['a search box that is not the sale search', '<input id="f" type="search" />'],
    ['the pairing code', '<input id="f" type="text" autocomplete="off" />'],
  ])('%s: a burst and its Enter reach the field untouched', (_label, html) => {
    mount(html);
    focus('#f');
    const enter = scan(guard, 'RT-0042');
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(enter.stopImmediatePropagation).not.toHaveBeenCalled();
    expect((document.querySelector('#f') as HTMLInputElement).value).toBe('RT-0042');
    expect(owner).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('the same field inside a modal dialog is refused: dialogs suspend scanning', () => {
    dialogOpen = true;
    mount('<input id="f" type="text" />');
    focus('#f');
    scan(guard, 'RT-0042');
    expect((document.querySelector('#f') as HTMLInputElement).value).toBe('');
    expect(notices).toEqual([SCAN_DIALOG_OPEN_MESSAGE]);
  });
});

describe('human typing is never claimed', () => {
  it('typing into the search field with human gaps then Enter passes through', () => {
    mount('<input id="s" type="search" data-scan-target="search" />');
    focus('#s');
    const enter = scan(guard, 'panadol', { gap: 120 });
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect((document.querySelector('#s') as HTMLInputElement).value).toBe('panadol');
    expect(owner).not.toHaveBeenCalled();
  });

  it('typing an amount with human gaps is accepted', () => {
    mount('<input id="amt" inputmode="numeric" />');
    focus('#amt');
    const enter = scan(guard, '20.00', { gap: 150 });
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect((document.querySelector('#amt') as HTMLInputElement).value).toBe('20.00');
    expect(notices).toEqual([]);
  });
});
