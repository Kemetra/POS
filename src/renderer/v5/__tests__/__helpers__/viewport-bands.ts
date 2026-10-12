/**
 * RT-241 — a matchMedia stand-in with real boundary semantics for the tier
 * queries `useViewportTier` reads, driven by an effective CSS width and
 * (RT-313) height. Like a real MediaQueryList, `change` fires only for a query
 * whose match flips.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';

const QUERIES = [
  '(min-width: 1280px)',
  '(min-width: 1024px)',
  '(min-height: 768px)',
  '(min-height: 600px)',
] as const;

/** The full-reference height (RT-312 D1): the default, so width-only tests stay width-only. */
const DEFAULT_HEIGHT = 800;

let width = 1280;
let height = DEFAULT_HEIGHT;
const listeners = new Map<string, Array<() => void>>();

function matches(query: string, atWidth: number, atHeight: number): boolean {
  const minWidth = /min-width:\s*(\d+)px/.exec(query)?.[1];
  if (minWidth !== undefined) return atWidth >= Number(minWidth);
  const minHeight = /min-height:\s*(\d+)px/.exec(query)?.[1];
  if (minHeight !== undefined) return atHeight >= Number(minHeight);
  return false;
}

export function installViewport(initialWidth: number, initialHeight = DEFAULT_HEIGHT): void {
  width = initialWidth;
  height = initialHeight;
  listeners.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return matches(query, width, height);
    },
    media: query,
    onchange: null,
    addEventListener: (_event: string, cb: () => void) => {
      listeners.set(query, [...(listeners.get(query) ?? []), cb]);
    },
    removeEventListener: (_event: string, cb: () => void) => {
      listeners.set(
        query,
        (listeners.get(query) ?? []).filter((fn) => fn !== cb),
      );
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/**
 * Resize to `nextWidth` × `nextHeight` CSS px (height unchanged when omitted);
 * dispatches `change` only to queries that flip.
 */
export function resizeTo(nextWidth: number, nextHeight = height): void {
  const before = QUERIES.map((q) => matches(q, width, height));
  width = nextWidth;
  height = nextHeight;
  act(() => {
    QUERIES.forEach((q, i) => {
      if (matches(q, width, height) !== before[i]) {
        (listeners.get(q) ?? []).forEach((cb) => {
          cb();
        });
      }
    });
  });
}

/** The tier hook's debounce (100 ms) plus a margin, in real time. */
export async function settleTier(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}
