import { describe, it, expect, afterEach } from 'vitest';

/**
 * T041 — useDevToggles: search-param parsing tests.
 *
 * Asserts:
 *  - ?state=loading  → 'loading'
 *  - ?state=empty    → 'empty'
 *  - ?state=error    → 'error'
 *  - missing param   → 'default'
 *  - unknown value   → 'default'
 *  - ?conn=degraded  → 'degraded'
 *  - missing ?conn   → 'online'
 *  - unknown ?conn   → 'online'
 *
 * Production-bundle assertion (T041 part 2) is deferred to T076 per the
 * task spec ("Acceptable to defer the build-output assertion to T076 if
 * `vite build` is too slow for a unit test").
 */

// Helper: set window.location.search before the module loads (or reset it).
// Uses a plain object override — sufficient for URLSearchParams reads in happy-dom.
function setSearch(search: string) {
  Object.defineProperty(window, 'location', {
    value: { href: '', pathname: '/', search, hash: '', host: '', hostname: '', origin: '' },
    writable: true,
    configurable: true,
  });
}

describe('useDevToggles — ?state= parsing (T041)', () => {
  afterEach(() => {
    setSearch('');
  });

  it.each([
    { name: 'returns "loading" for ?state=loading', search: '?state=loading', expected: 'loading' },
    { name: 'returns "empty" for ?state=empty', search: '?state=empty', expected: 'empty' },
    { name: 'returns "error" for ?state=error', search: '?state=error', expected: 'error' },
    { name: 'returns "default" when ?state is absent', search: '', expected: 'default' },
    {
      name: 'returns "default" for unknown ?state value',
      search: '?state=bogus',
      expected: 'default',
    },
  ])('$name', async ({ search, expected }) => {
    setSearch(search);
    const { getDevToggles } = await import('../useDevToggles');
    expect(getDevToggles().state).toBe(expected);
  });
});

describe('useDevToggles — hook delegates to getDevToggles (T041)', () => {
  afterEach(() => {
    setSearch('');
  });

  it('useDevToggles() returns the same result as getDevToggles()', async () => {
    setSearch('?state=empty&conn=offline');
    const { getDevToggles, useDevToggles } = await import('../useDevToggles');
    expect(useDevToggles()).toEqual(getDevToggles());
    expect(useDevToggles().state).toBe('empty');
    expect(useDevToggles().conn).toBe('offline');
  });
});

describe('useDevToggles — ?conn= parsing (T041)', () => {
  afterEach(() => {
    setSearch('');
  });

  it.each([
    {
      name: 'returns "degraded" for ?conn=degraded',
      search: '?conn=degraded',
      expected: 'degraded',
    },
    { name: 'returns "offline" for ?conn=offline', search: '?conn=offline', expected: 'offline' },
    { name: 'returns "syncing" for ?conn=syncing', search: '?conn=syncing', expected: 'syncing' },
    { name: 'returns "online" when ?conn is absent', search: '', expected: 'online' },
    {
      name: 'returns "online" for unknown ?conn value',
      search: '?conn=bogus',
      expected: 'online',
    },
  ])('$name', async ({ search, expected }) => {
    setSearch(search);
    const { getDevToggles } = await import('../useDevToggles');
    expect(getDevToggles().conn).toBe(expected);
  });
});
