import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * 022 U0 — one-time v4.0 theme migration.
 *
 * THE DEFECT THIS FIXES (found on real hardware, not in CI):
 * U0 made light the v4.0 default, but `initTheme()` reads `localStorage`, and a
 * stored preference legitimately beats a default. Every terminal that ran v3.5
 * has `pos-pulse.theme: "dark"` persisted — so **no existing terminal would
 * ever see the v4.0 light default**. U0's headline change would have shipped
 * invisible in the field.
 *
 * Every automated test passed because jsdom starts with empty `localStorage`;
 * only a machine with real history exposed it. That is exactly why T002's
 * on-hardware launch is a gate and not a formality.
 *
 * THE FIX, and its boundary: a ONE-SHOT, guarded migration. On first v4.0 boot
 * the pre-v4 stored theme is dropped once so the new default applies, and a
 * marker is written. Afterwards the store behaves exactly as before — a theme
 * the operator chooses *after* v4.0 persists normally and is never touched
 * again. This is not "ignore the user's choice"; it is "retire a choice made
 * against a superseded design, once".
 */

const THEME_KEY = 'pos-pulse.theme';
const V4_KEY = 'pos-pulse.theme.v4-migrated';

/** Re-import the module fresh so boot-time state is re-evaluated per case. */
async function freshModule(): Promise<typeof import('../theme-store')> {
  vi.resetModules();
  return await import('../theme-store');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  localStorage.clear();
});

describe('022 U0 — one-time v4.0 theme migration', () => {
  it('drops a pre-v4 persisted "dark" so the v4.0 light default applies', async () => {
    // A terminal upgraded from v3.5: dark stored, no migration marker.
    localStorage.setItem(THEME_KEY, 'dark');

    const { initTheme } = await freshModule();
    const applied = initTheme();

    expect(applied).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(V4_KEY)).toBe('1');
  });

  it('runs ONCE — a dark choice made AFTER v4.0 is preserved on the next boot', async () => {
    localStorage.setItem(THEME_KEY, 'dark');
    const first = await freshModule();
    first.initTheme(); // migration consumes the v3.5 value

    // The operator now deliberately picks dark under v4.0.
    first.useThemeStore.getState().setTheme('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');

    // Next boot must RESPECT that choice — the migration is spent.
    const second = await freshModule();
    expect(second.initTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('preserves a pre-v4 "light" choice (nothing to migrate away from)', async () => {
    localStorage.setItem(THEME_KEY, 'light');
    const { initTheme } = await freshModule();
    expect(initTheme()).toBe('light');
    expect(localStorage.getItem(V4_KEY)).toBe('1');
  });

  it('is a no-op on a fresh install (no stored theme at all)', async () => {
    const { initTheme } = await freshModule();
    expect(initTheme()).toBe('light');
    expect(localStorage.getItem(V4_KEY)).toBe('1');
  });

  it('never resurrects a migrated value — a second init keeps the default', async () => {
    localStorage.setItem(THEME_KEY, 'dark');
    const first = await freshModule();
    expect(first.initTheme()).toBe('light');

    const second = await freshModule();
    expect(second.initTheme()).toBe('light');
  });

  it('degrades safely when localStorage throws (terminal must still launch)', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    try {
      const { initTheme } = await freshModule();
      expect(initTheme()).toBe('light');
    } finally {
      getItem.mockRestore();
    }
  });
});
