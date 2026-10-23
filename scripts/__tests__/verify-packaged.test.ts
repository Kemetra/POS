import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  compareFuses,
  configKey,
  parseElectronFuses,
  runtimeMismatches,
} from '../verify-packaged.js';

const ENABLE = 49;
const DISABLE = 48;

const yaml = `productName: POS Pulse
# comment
electronFuses:
  # ELECTRON_RUN_AS_NODE=1 would turn POS Pulse.exe into a plain Node runtime.
  runAsNode: false
  onlyLoadAppFromAsar: true # inline comment
  grantFileProtocolExtraPrivileges: true
  # enableCookieEncryption
files:
  - dist/**
`;

// Stock Electron 44 wire: index 8 is newer than @electron/fuses 1.8.0 knows.
const stock = {
  version: '1',
  0: ENABLE,
  1: DISABLE,
  2: ENABLE,
  3: ENABLE,
  4: DISABLE,
  5: DISABLE,
  6: DISABLE,
  7: ENABLE,
  8: ENABLE,
};

describe('parseElectronFuses', () => {
  it('reads only the electronFuses block and ignores comments', () => {
    expect(parseElectronFuses(yaml)).toEqual({
      runAsNode: false,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: true,
    });
  });

  it('does not end the block at a column-0 comment between entries', () => {
    const text =
      'electronFuses:\n  runAsNode: false\n# a note\n  onlyLoadAppFromAsar: true\nfiles:\n  - x\n';
    expect(parseElectronFuses(text)).toEqual({ runAsNode: false, onlyLoadAppFromAsar: true });
  });

  it('fails closed on a value it does not understand', () => {
    expect(() => parseElectronFuses('electronFuses:\n  runAsNode: no\n')).toThrow(/unparseable/);
    expect(() => parseElectronFuses('productName: x\n')).toThrow(/no top-level electronFuses/);
    expect(() =>
      parseElectronFuses('electronFuses:\n  runAsNode: false\n  runAsNode: true\n'),
    ).toThrow(/duplicate/);
  });

  it('parses the real electron-builder.yml', () => {
    const fuses = parseElectronFuses(
      readFileSync(path.resolve(__dirname, '../../electron-builder.yml'), 'utf8'),
    );
    expect(fuses.runAsNode).toBe(false);
    expect(fuses.onlyLoadAppFromAsar).toBe(true);
  });
});

describe('configKey', () => {
  it('maps FuseV1Options names to electron-builder keys', () => {
    expect(configKey('RunAsNode')).toBe('runAsNode');
    expect(configKey('EnableEmbeddedAsarIntegrityValidation')).toBe(
      'enableEmbeddedAsarIntegrityValidation',
    );
  });
});

describe('compareFuses', () => {
  const declared = parseElectronFuses(yaml);
  const matching = { ...stock, 0: DISABLE, 5: ENABLE };

  it('passes when declared fuses are flipped and the rest keep stock values', () => {
    const { rows, problems } = compareFuses({ declared, packaged: matching, stock });
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(9);
    expect(rows.find((r) => r.name === 'runAsNode')).toMatchObject({
      source: 'declared',
      ok: true,
    });
    expect(rows.find((r) => r.name === 'fuse#8')).toMatchObject({
      source: 'stock default',
      ok: true,
    });
  });

  it.each([
    {
      case: 'a declared fuse that was not flipped',
      index: 0,
      problem: 'runAsNode: packaged enabled, expected disabled (declared in electron-builder.yml)',
    },
    {
      case: 'an undeclared fuse that drifted from the stock default',
      index: 1,
      problem:
        'enableCookieEncryption: packaged enabled, expected disabled (stock Electron default)',
    },
  ])('names $case', ({ index, problem }) => {
    const { problems } = compareFuses({
      declared,
      packaged: { ...matching, [index]: ENABLE },
      stock,
    });
    expect(problems).toEqual([problem]);
  });

  it('flags a fuse missing from the packaged wire and a declared key the wire lacks', () => {
    const withoutSeven: Record<string, unknown> = { ...matching };
    delete withoutSeven[7];
    const { problems } = compareFuses({
      declared: { ...declared, madeUpFuse: true },
      packaged: withoutSeven,
      stock,
    });
    expect(problems).toContain(
      'grantFileProtocolExtraPrivileges: missing from the packaged fuse wire',
    );
    expect(problems).toContain(
      'madeUpFuse: declared in electron-builder.yml but not in the packaged fuse wire',
    );
  });

  it('flags an extra packaged fuse the stock wire does not have', () => {
    const { problems } = compareFuses({
      declared,
      packaged: { ...matching, 9: ENABLE },
      stock,
    });
    expect(problems).toEqual(['fuse#9: not in the stock Electron wire and not declared']);
  });
});

describe('runtimeMismatches', () => {
  it('reports differing and missing runtime files', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rt830-'));
    try {
      const app = path.join(root, 'app');
      const dist = path.join(root, 'dist');
      for (const d of [app, dist]) {
        mkdirSync(d);
        writeFileSync(path.join(d, 'same.bin'), 'x');
      }
      writeFileSync(path.join(app, 'diff.bin'), 'a');
      writeFileSync(path.join(dist, 'diff.bin'), 'b');
      writeFileSync(path.join(dist, 'gone.bin'), 'c');
      expect(
        runtimeMismatches({
          appDir: app,
          electronDistDir: dist,
          files: ['same.bin', 'diff.bin', 'gone.bin'],
        }),
      ).toEqual(['diff.bin', 'gone.bin']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
