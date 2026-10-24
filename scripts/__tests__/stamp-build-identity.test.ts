import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildIdentityStamp,
  stampStillTrue,
  writeBuildIdentityStamp,
} from '../stamp-build-identity.js';

/**
 * RT-719 — the build-time stamp that gives the running POS its commit and its
 * Backend-Core contract pin. It is written only when both facts are honest: a
 * clean tracked tree at a real commit. Anything else writes no file (and
 * removes a stale one), so the POS reports "unknown" instead of a false build.
 */

const HEAD = 'c'.repeat(39) + '3';
const PIN_COMMIT = 'd'.repeat(39) + '4';
const PIN_TEXT = `# header\nrepo: Kemetra/Backend-Core\ncommit: ${PIN_COMMIT}\nsource: packages/contracts/openapi\n`;

describe('buildIdentityStamp', () => {
  it('stamps the commit and the pinned Backend-Core commit', () => {
    expect(buildIdentityStamp({ head: HEAD, dirty: false, pinText: PIN_TEXT })).toEqual({
      commit: HEAD,
      contractPin: PIN_COMMIT,
    });
  });

  it('stamps nothing for a dirty tracked tree: the build is not that commit', () => {
    expect(buildIdentityStamp({ head: HEAD, dirty: true, pinText: PIN_TEXT })).toBeNull();
  });

  it.each([null, '', 'HEAD', 'C'.repeat(40), 'c'.repeat(39), 'c'.repeat(41)])(
    'stamps nothing for the git head %j',
    (head) => {
      expect(buildIdentityStamp({ head, dirty: false, pinText: PIN_TEXT })).toBeNull();
    },
  );

  it('omits the pin (never guesses it) when the PIN file is missing or unreadable', () => {
    expect(buildIdentityStamp({ head: HEAD, dirty: false, pinText: null })).toEqual({
      commit: HEAD,
    });
    expect(buildIdentityStamp({ head: HEAD, dirty: false, pinText: 'garbage' })).toEqual({
      commit: HEAD,
    });
  });
});

describe('writeBuildIdentityStamp', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'rt719-stamp-'));
    file = path.join(dir, 'dist', 'build-identity.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the stamp as JSON, creating dist/', () => {
    writeBuildIdentityStamp(file, { commit: HEAD, contractPin: PIN_COMMIT });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      commit: HEAD,
      contractPin: PIN_COMMIT,
    });
  });

  it('removes a stale stamp when there is nothing honest to write', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"commit":"x"}');
    writeBuildIdentityStamp(file, null);
    expect(existsSync(file)).toBe(false);
  });

  it('is a no-op for null when no stamp exists', () => {
    expect(() => {
      writeBuildIdentityStamp(file, null);
    }).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});

describe('stampStillTrue (the check run before packaging)', () => {
  const stamp = { commit: HEAD, contractPin: PIN_COMMIT };

  it('keeps a stamp written for this very commit on a clean tree', () => {
    expect(stampStillTrue(stamp, { head: HEAD, dirty: false })).toBe(true);
  });

  it('drops it when HEAD moved since the build: the packaged output is from another commit', () => {
    expect(stampStillTrue(stamp, { head: 'e'.repeat(40), dirty: false })).toBe(false);
  });

  it('drops it when the tree is dirty, or git cannot say', () => {
    expect(stampStillTrue(stamp, { head: HEAD, dirty: true })).toBe(false);
    expect(stampStillTrue(stamp, { head: null, dirty: false })).toBe(false);
  });

  it('has nothing to keep without a stamp', () => {
    expect(stampStillTrue(null, { head: HEAD, dirty: false })).toBe(false);
  });
});
