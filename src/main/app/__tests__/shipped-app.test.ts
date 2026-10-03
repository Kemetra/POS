import { describe, it, expect } from 'vitest';

import { isShippedApp } from '../shipped-app.js';

/**
 * RT-165 — the trusted "shipped app" identity for security-sensitive runtime
 * decisions (dev bypasses, SecretStore refusal, migrations source).
 *
 * Electron derives `app.isPackaged` from the exe FILE NAME, so a renamed copy
 * of the shipped exe reports `false` (RT-164 probe). The shipped exe loads
 * only `resources/app.asar` (fuse `onlyLoadAppFromAsar`), and a rename cannot
 * change that, so an `.asar` app path also counts as shipped.
 */

const ASAR = 'C:\\Program Files\\POS Pulse\\resources\\app.asar';
const REPO = 'C:\\Users\\dev\\POS';

describe('isShippedApp', () => {
  it('is true for the shipped exe under its own name', () => {
    expect(isShippedApp({ isPackaged: true, appPath: ASAR })).toBe(true);
  });

  it.each([ASAR, 'C:\\copy\\resources\\APP.ASAR', 'D:\\x\\resources\\app.asar'])(
    'is true for a renamed copy of the shipped exe running %j (isPackaged false)',
    (appPath) => {
      expect(isShippedApp({ isPackaged: false, appPath })).toBe(true);
    },
  );

  it('is false for an unpackaged dev/lab build (`electron .`)', () => {
    expect(isShippedApp({ isPackaged: false, appPath: REPO })).toBe(false);
  });

  it('does not treat a directory merely containing "asar" as shipped', () => {
    expect(isShippedApp({ isPackaged: false, appPath: 'C:\\asar-lab\\POS' })).toBe(false);
    expect(isShippedApp({ isPackaged: false, appPath: 'C:\\lab\\app.asar.unpacked' })).toBe(false);
  });
});
