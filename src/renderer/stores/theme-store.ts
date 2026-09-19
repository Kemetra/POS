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
 * Boot-time initialiser — called once from `main.tsx` before React mounts.
 * Reconciles the store + DOM with the persisted value. The static
 * `data-theme="dark"` baked into `index.html` covers dark users with no
 * flash; this call only re-paints to `light` for operators who chose it.
 */
export function initTheme(): Theme {
  const theme = readPersistedTheme();
  applyTheme(theme);
  useThemeStore.setState({ theme });
  return theme;
}
