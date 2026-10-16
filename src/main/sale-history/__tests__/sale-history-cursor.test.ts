/** RT-542 — the bridge cursor keeps one walk on one source. */
import { describe, expect, it } from 'vitest';

import { decodePosition, localCursor, serverCursor } from '../sale-history-cursor.js';

describe('RT-542 sale-history cursor', () => {
  it('starts a walk without a cursor', () => {
    expect(decodePosition(undefined)).toEqual({ kind: 'first' });
    expect(decodePosition(null)).toEqual({ kind: 'first' });
  });

  it('round-trips a server cursor and refuses one off the contract charset', () => {
    const cursor = serverCursor('abc_DEF-123');
    expect(cursor).toBe('s.abc_DEF-123');
    expect(decodePosition(cursor)).toEqual({ kind: 'server', cursor: 'abc_DEF-123' });
    expect(decodePosition('s.not a cursor!')).toBeNull();
    expect(serverCursor(null)).toBeNull();
  });

  it.each([
    ['no_connection', 'n.'],
    ['no_credential', 'c.'],
    ['server_unavailable', 'u.'],
  ] as const)('round-trips a local %s cursor under its own prefix', (reason, prefix) => {
    const cursor = localCursor(reason, 'local-1');
    expect(cursor).toBe(`${prefix}local-1`);
    expect(decodePosition(cursor)).toEqual({ kind: 'local', reason, cursor: 'local-1' });
    expect(localCursor(reason, null)).toBeNull();
  });

  it('refuses a non-string or unknown-prefix cursor', () => {
    expect(decodePosition(42)).toBeNull();
    expect(decodePosition({ cursor: 's.x' })).toBeNull();
    expect(decodePosition('x.abc')).toBeNull();
    expect(decodePosition('')).toBeNull();
  });
});
