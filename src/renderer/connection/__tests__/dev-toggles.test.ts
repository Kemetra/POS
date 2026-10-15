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

describe('dev-toggles — ?state= parsing (T041)', () => {
  afterEach(() => {
    setSearch('');
  });

  it('returns "loading" for ?state=loading', async () => {
    setSearch('?state=loading');
    const { getDevToggles } = await import('../dev-toggles');
    expect(getDevToggles().state).toBe('loading');
  });

  it('returns "empty" for ?state=empty', async () => {
    setSearch('?state=empty');
    const { getDevToggles } = await import('../dev-toggles');
    expect(getDevToggles().state).toBe('empty');
  });

  it('returns "error" for ?state=error', async () => {
    setSearch('?state=error');
    const { getDevToggles } = await import('../dev-toggles');
    expect(getDevToggles().state).toBe('error');
  });

  it('returns "default" when ?state is absent', async () => {
    setSearch('');
    const { getDevToggles } = await import('../dev-toggles');
    expect(getDevToggles().state).toBe('default');
  });

  it('returns "default" for unknown ?state value', async () => {
    setSearch('?state=bogus');
    const { getDevToggles } = await import('../dev-toggles');
    expect(getDevToggles().state).toBe('default');
  });
});

describe('dev-toggles — hook delegates to getDevToggles (T041)', () => {
  afterEach(() => {
    setSearch('');
  });

  it('useDevToggles() returns the same result as getDevToggles()', async () => {
    setSearch('?state=empty&conn=offline');
    const { getDevToggles, useDevToggles } = await import('../dev-toggles');
    expect(useDevToggles()).toEqual(getDevToggles());
    expect(useDevToggles().state).toBe('empty');
    expect(useDevToggles().conn).toBe('offline');
  });
});

describe('dev-toggles — ?conn= parsing (T041)', () => {
  afterEach(() => {
    setSearch('');
  });

  it('returns "degraded" for ?conn=degraded', async () => {
    setSearch('?conn=degraded');
    const { getDevToggles } = await import('../dev-toggles');
    expect(getDevToggles().conn).toBe('degraded');
  });

  it('returns "offline" for ?conn=offline', async () => {
    setSearch('?conn=offline');
    const { getDevToggles } = await import('../dev-toggles');
    expect(getDevToggles().conn).toBe('offline');
  });

  it('returns "syncing" for ?conn=syncing', async () => {
    setSearch('?conn=syncing');
    const { getDevToggles } = await import('../dev-toggles');
    expect(getDevToggles().conn).toBe('syncing');
  });

  it('returns "online" when ?conn is absent', async () => {
    setSearch('');
    const { getDevToggles } = await import('../dev-toggles');
    expect(getDevToggles().conn).toBe('online');
  });

  it('returns "online" for unknown ?conn value', async () => {
    setSearch('?conn=bogus');
    const { getDevToggles } = await import('../dev-toggles');
    expect(getDevToggles().conn).toBe('online');
  });
});
