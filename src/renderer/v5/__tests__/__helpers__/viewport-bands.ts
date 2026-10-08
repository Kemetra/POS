/**
 * RT-241 — a matchMedia stand-in with real boundary semantics for the two tier
 * queries `useViewportTier` reads, driven by an effective CSS width. Like a
 * real MediaQueryList, `change` fires only for a query whose match flips.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';

const QUERIES = ['(min-width: 1280px)', '(min-width: 1024px)'] as const;

let width = 1280;
const listeners = new Map<string, Array<() => void>>();

function matches(query: string, at: number): boolean {
  const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? '0');
  return at >= min;
}

export function installViewport(initialWidth: number): void {
  width = initialWidth;
  listeners.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return matches(query, width);
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

/** Resize to `next` CSS px; dispatches `change` only to queries that flip. */
export function resizeTo(next: number): void {
  const before = QUERIES.map((q) => matches(q, width));
  width = next;
  act(() => {
    QUERIES.forEach((q, i) => {
      if (matches(q, width) !== before[i]) {
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
