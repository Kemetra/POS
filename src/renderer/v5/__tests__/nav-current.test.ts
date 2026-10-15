/**
 * RT-498 (VN-S10 S10-1, owner decision D-10-5) — which nav entry is current.
 * The manager sub-screens reached from the dashboard (`/app/manager/*`, the
 * shift status at `/app/shift/manager`) mark «لوحة المتابعة» current; the
 * catalogue diagnostics under `/app/inventory` keep «المخزون» current. The
 * cashier's own shift screen is not a manager sub-screen.
 */
import { describe, expect, it } from 'vitest';
import { isNavEntryCurrent, v5NavEntries, type V5NavEntry } from '../frame/nav-model';

function entry(id: V5NavEntry['id']): V5NavEntry {
  const found = v5NavEntries.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no nav entry ${id}`);
  return found;
}

function currentIds(pathname: string): string[] {
  return v5NavEntries.filter((e) => isNavEntryCurrent(e, pathname)).map((e) => e.id);
}

describe('isNavEntryCurrent — manager sub-screens (D-10-5)', () => {
  it.each([
    '/app/manager/cashiers',
    '/app/manager/recovery',
    '/app/manager/stuck-shifts',
    '/app/manager/force-fail',
    '/app/shift/manager',
  ])('%s marks only the dashboard entry current', (pathname) => {
    expect(currentIds(pathname)).toEqual(['dashboard']);
  });

  it('the dashboard itself stays current', () => {
    expect(isNavEntryCurrent(entry('dashboard'), '/app/dashboard')).toBe(true);
  });

  it('catalogue diagnostics keep the inventory entry current', () => {
    expect(currentIds('/app/inventory/diagnostics')).toEqual(['inventory']);
  });

  it("the cashier's own shift screen is not a manager sub-screen", () => {
    expect(currentIds('/app/shift')).toEqual([]);
  });

  it('a path that only shares a prefix is not a sub-screen', () => {
    expect(isNavEntryCurrent(entry('dashboard'), '/app/managers')).toBe(false);
    expect(isNavEntryCurrent(entry('dashboard'), '/app/shift/managerial')).toBe(false);
  });

  it('the sale loop is unchanged: cart and checkout mark the Sale entry', () => {
    expect(currentIds('/app/cart')).toEqual(['cart']);
    expect(currentIds('/app/checkout')).toEqual(['cart']);
  });
});
