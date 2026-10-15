import { describe, it, expect, afterEach } from 'vitest';

/**
 * T041 — dev toggles: search-param parsing.
 *
 * `?state=` reads loading | empty | error and falls back to 'default';
 * `?conn=` reads degraded | offline | syncing and falls back to 'online'.
 * Moved here from `shell/dev` with the shell's retirement (RT-504).
 *
 * Production-bundle assertion (T041 part 2) is deferred to T076 per the
 * task spec ("Acceptable to defer the build-output assertion to T076 if
 * `vite build` is too slow for a unit test").
 */

// Set window.location.search before the module reads it (or reset it).
// A plain object override is enough for URLSearchParams reads in happy-dom.
function setSearch(search: string) {
  Object.defineProperty(window, 'location', {
    value: { href: '', pathname: '/', search, hash: '', host: '', hostname: '', origin: '' },
    writable: true,
    configurable: true,
  });
}

async function togglesFor(search: string) {
  setSearch(search);
  const { getDevToggles } = await import('../dev-toggles');
  return getDevToggles();
}

afterEach(() => {
  setSearch('');
});

describe('dev-toggles — ?state= parsing (T041)', () => {
  it.each([
    ['?state=loading', 'loading'],
    ['?state=empty', 'empty'],
    ['?state=error', 'error'],
    ['', 'default'],
    ['?state=bogus', 'default'],
  ])('%j → %s', async (search, expected) => {
    expect((await togglesFor(search)).state).toBe(expected);
  });
});

describe('dev-toggles — ?conn= parsing (T041)', () => {
  it.each([
    ['?conn=degraded', 'degraded'],
    ['?conn=offline', 'offline'],
    ['?conn=syncing', 'syncing'],
    ['', 'online'],
    ['?conn=bogus', 'online'],
  ])('%j → %s', async (search, expected) => {
    expect((await togglesFor(search)).conn).toBe(expected);
  });
});

describe('dev-toggles — hook delegates to getDevToggles (T041)', () => {
  it('useDevToggles() returns the same result as getDevToggles()', async () => {
    setSearch('?state=empty&conn=offline');
    const { getDevToggles, useDevToggles } = await import('../dev-toggles');
    expect(useDevToggles()).toEqual(getDevToggles());
    expect(useDevToggles().state).toBe('empty');
    expect(useDevToggles().conn).toBe('offline');
  });
});
