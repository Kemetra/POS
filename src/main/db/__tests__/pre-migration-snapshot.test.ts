import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import type { DatabaseHandle } from '../client.js';
import {
  DEFAULT_SNAPSHOT_RETENTION,
  SNAPSHOT_FILE_PREFIX,
  bindVacuumInto,
  writePreMigrationSnapshot,
} from '../pre-migration-snapshot.js';

/**
 * RT-320 — pre-migration snapshot (ADR-0006 rule 4). Before a new build applies
 * its first pending migration, the DB is copied to `userData/backups/` for
 * support-assisted recovery. Uses a real temp dir; the SQLite copy itself is a
 * fake `vacuumInto` so no native binding loads in Vitest (R1).
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pos-snapshot-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeVacuumInto(written: string[]): (target: string) => void {
  return (target) => {
    writeFileSync(target, 'sqlite-copy');
    written.push(target);
  };
}

function snapshotsIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith(SNAPSHOT_FILE_PREFIX))
    .sort();
}

describe('writePreMigrationSnapshot', () => {
  it('creates the backups dir and copies the DB into it', () => {
    const backupsDir = path.join(tmpRoot, 'backups');
    const written: string[] = [];

    const target = writePreMigrationSnapshot({
      backupsDir,
      vacuumInto: fakeVacuumInto(written),
      now: () => new Date('2026-10-09T08:30:15.123Z'),
    });

    expect(written).toEqual([target]);
    expect(path.dirname(target)).toBe(backupsDir);
    expect(path.basename(target)).toBe(`${SNAPSHOT_FILE_PREFIX}2026-10-09T08-30-15-123Z.db`);
    expect(existsSync(target)).toBe(true);
  });

  it('keeps only the newest snapshots up to the retention limit', () => {
    const backupsDir = path.join(tmpRoot, 'backups');
    const written: string[] = [];
    const stamps = [
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ];
    for (const stamp of stamps) {
      writePreMigrationSnapshot({
        backupsDir,
        vacuumInto: fakeVacuumInto(written),
        now: () => new Date(stamp),
        retain: 3,
      });
    }

    expect(snapshotsIn(backupsDir)).toEqual([
      `${SNAPSHOT_FILE_PREFIX}2026-02-01T00-00-00-000Z.db`,
      `${SNAPSHOT_FILE_PREFIX}2026-03-01T00-00-00-000Z.db`,
      `${SNAPSHOT_FILE_PREFIX}2026-04-01T00-00-00-000Z.db`,
    ]);
  });

  it('never prunes files it did not create', () => {
    const backupsDir = path.join(tmpRoot, 'backups');
    writePreMigrationSnapshot({
      backupsDir,
      vacuumInto: fakeVacuumInto([]),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    writeFileSync(path.join(backupsDir, 'support-export.db'), 'keep me');

    writePreMigrationSnapshot({
      backupsDir,
      vacuumInto: fakeVacuumInto([]),
      now: () => new Date('2026-02-01T00:00:00.000Z'),
      retain: 1,
    });

    expect(readdirSync(backupsDir).sort()).toEqual([
      `${SNAPSHOT_FILE_PREFIX}2026-02-01T00-00-00-000Z.db`,
      'support-export.db',
    ]);
  });

  it('defaults to a small bounded retention', () => {
    expect(DEFAULT_SNAPSHOT_RETENTION).toBe(3);
  });

  it('propagates a failed copy so startup halts instead of migrating unprotected', () => {
    const backupsDir = path.join(tmpRoot, 'backups');
    expect(() =>
      writePreMigrationSnapshot({
        backupsDir,
        vacuumInto: () => {
          throw new Error('SQLITE_FULL');
        },
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).toThrow(/SQLITE_FULL/);
  });
});

describe('bindVacuumInto', () => {
  it('runs VACUUM INTO with the target path as a bound parameter', () => {
    const runs: unknown[][] = [];
    const prepared: string[] = [];
    const handle = {
      prepare(sql: string) {
        prepared.push(sql);
        return {
          run: (...params: unknown[]) => {
            runs.push(params);
          },
        };
      },
    } as unknown as DatabaseHandle;

    bindVacuumInto(handle)("C:\\data\\it's here.db");

    expect(prepared).toEqual(['VACUUM INTO ?']);
    expect(runs).toEqual([["C:\\data\\it's here.db"]]);
  });
});
