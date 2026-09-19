import { create } from 'zustand';

/**
 * POS v3.5 Phase 1 — terminal theme store (ADR-0004, default superseded by 022).
 *
 * Two themes only: `light` (the v4.0 default — spec 022 is light-first) and
 * `dark` (retained as a token-only override, retuned to the v4.0 teal
 * identity). Switching themes flips CSS custom-property VALUES on the
 * document root (`<html data-theme="…">`) — no component is forked, no class
 * family is added. Hand-written component CSS and Tailwind
 * `var(--color-*)`-backed utilities both re-theme through the same custom
 * properties.
 *
 * The selection persists in `localStorage` so a paired terminal keeps the
 * operator's choice across launches. `light` is the default whenever no valid
 * value is stored (022 owner decision A: a light, clinical pharmacy terminal).
 *
 * State management mirrors the repo idiom (`feature-flags-store.ts`):
 * a plain Zustand `create` store, no middleware. Persistence is explicit
 * and side-effect-isolated in `applyTheme` so it is trivially testable.
 */

export type Theme = 'dark' | 'light';

/** Default theme when nothing valid is persisted. */
export const DEFAULT_THEME: Theme = 'light';

/** localStorage key for the persisted theme selection. */
export const THEME_STORAGE_KEY = 'pos-pulse.theme';

/**
 * 022 U0 — marker proving the one-time v4.0 theme migration has run on this
 * terminal. Its presence is what makes the migration a ONE-SHOT rather than a
 * recurring override of the operator's choice.
 */
export const THEME_V4_MIGRATION_KEY = 'pos-pulse.theme.v4-migrated';

/** The DOM attribute the dark register is keyed on (`<html data-theme>`). */
export const THEME_ATTRIBUTE = 'data-theme';

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}

/**
 * Read the persisted theme, falling back to {@link DEFAULT_THEME}.
 * A missing / corrupt / unavailable `localStorage` is non-fatal: the
 * terminal must launch regardless, so any failure degrades to the default.
 */
export function readPersistedTheme(): Theme {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_THEME;
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Apply a theme to the document root and persist it. Centralised so both
 * boot init and the toggle take the exact same code path. All DOM /
 * storage access is guarded so the function is safe under jsdom and in a
 * headless context.
 */
export function applyTheme(theme: Theme): void {
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
    }
  } catch {
    // No DOM (non-render context) — nothing to apply.
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // Storage unavailable / quota — selection stays in-memory only.
  }
}

export interface ThemeStore {
  theme: Theme;
  /** Switch to an explicit theme (persists + applies to the root). */
  setTheme: (theme: Theme) => void;
  /** Flip dark ⇄ light (persists + applies to the root). */
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: readPersistedTheme(),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    set({ theme: next });
  },
}));

/**
 * 022 U0 — one-time v4.0 theme migration.
 *
 * U0 made LIGHT the v4.0 default, but a persisted preference legitimately
 * beats a default — and every terminal that ran v3.5 has `"dark"` stored. Left
 * alone, no existing terminal would ever see the v4.0 light default: the
 * headline change would ship invisible in the field. (Automated tests all
 * passed, because jsdom starts with empty storage; only a real machine with
 * history exposed this.)
 *
 * So on the FIRST v4.0 boot we retire the pre-v4 stored value once and record a
 * marker. This is deliberately narrow:
 *   - it runs exactly once per terminal;
 *   - a theme the operator chooses AFTER v4.0 persists normally and is never
 *     touched again (asserted in theme-v4-migration.test.ts);
 *   - it is not "ignore the user" — it retires a choice made against a design
 *     that no longer exists.
 *
 * Storage failure is non-fatal: the terminal must launch regardless, so any
 * throw degrades to "migration not performed" and the default applies anyway.
 */
function migrateLegacyThemeOnce(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem(THEME_V4_MIGRATION_KEY) !== null) return;
    localStorage.removeItem(THEME_STORAGE_KEY);
    localStorage.setItem(THEME_V4_MIGRATION_KEY, '1');
  } catch {
    // Storage unavailable — fall through; the v4.0 default still applies.
  }
}

/**
 * Boot-time initialiser — called once from `main.tsx` before React mounts.
 * Runs the one-time v4.0 migration, then reconciles the store + DOM with the
 * persisted value. The static `data-theme="light"` baked into `index.html`
 * covers the v4.0 default with no flash; this call only re-paints to `dark`
 * for operators who chose it under v4.0.
 */
export function initTheme(): Theme {
  migrateLegacyThemeOnce();
  const theme = readPersistedTheme();
  applyTheme(theme);
  useThemeStore.setState({ theme });
  return theme;
}
