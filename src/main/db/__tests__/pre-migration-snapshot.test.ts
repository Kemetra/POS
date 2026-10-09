import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
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
 * support-assisted recovery. One snapshot per target schema head: a retry of
 * the same upgrade keeps the original pre-upgrade copy. Uses a real temp dir;
 * the SQLite copy itself is a fake `vacuumInto` so no native binding loads in
 * Vitest (R1).
 */

let tmpRoot: string;
let backupsDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pos-snapshot-'));
  backupsDir = path.join(tmpRoot, 'backups');
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

function snap(head: string, stamp: string): string {
  return `${SNAPSHOT_FILE_PREFIX}${head}.${stamp}.db`;
}

function write(head: string, iso: string, written: string[] = [], retain?: number) {
  return writePreMigrationSnapshot({
    backupsDir,
    targetHead: head,
    vacuumInto: fakeVacuumInto(written),
    now: () => new Date(iso),
    ...(retain === undefined ? {} : { retain }),
  });
}

describe('writePreMigrationSnapshot', () => {
  it('creates the backups dir and names the copy after the target head and time', () => {
    const written: string[] = [];
    const result = write('0045_next', '2026-10-09T08:30:15.123Z', written);

    expect(result.created).toBe(true);
    // Copied to a temp name first, then published by rename.
    expect(written).toEqual([`${result.path}.partial`]);
    expect(path.dirname(result.path)).toBe(backupsDir);
    expect(path.basename(result.path)).toBe(snap('0045_next', '2026-10-09T08-30-15-123Z'));
    expect(existsSync(result.path)).toBe(true);
  });

  it('keeps the original snapshot when a retry targets the same head', () => {
    const written: string[] = [];
    const first = write('0045_next', '2026-10-09T08:00:00.000Z', written);
    // A later migration in the batch failed; every relaunch retries the upgrade.
    const second = write('0045_next', '2026-10-09T08:05:00.000Z', written);
    const third = write('0045_next', '2026-10-09T08:10:00.000Z', written);

    expect(written).toEqual([`${first.path}.partial`]);
    expect(second).toEqual({ path: first.path, created: false });
    expect(third).toEqual({ path: first.path, created: false });
    expect(snapshotsIn(backupsDir)).toEqual([snap('0045_next', '2026-10-09T08-00-00-000Z')]);
  });

  it('keeps only the snapshots for the newest heads up to the retention limit', () => {
    write('0041_a', '2026-01-01T00:00:00.000Z', [], 3);
    write('0042_b', '2026-02-01T00:00:00.000Z', [], 3);
    write('0043_c', '2026-03-01T00:00:00.000Z', [], 3);
    write('0044_d', '2026-04-01T00:00:00.000Z', [], 3);

    expect(snapshotsIn(backupsDir)).toEqual([
      snap('0042_b', '2026-02-01T00-00-00-000Z'),
      snap('0043_c', '2026-03-01T00-00-00-000Z'),
      snap('0044_d', '2026-04-01T00-00-00-000Z'),
    ]);
  });

  it('keeps the new snapshot when the clock has moved backward', () => {
    write('0041_a', '2027-06-01T00:00:00.000Z', [], 3);
    write('0042_b', '2027-07-01T00:00:00.000Z', [], 3);
    write('0043_c', '2027-08-01T00:00:00.000Z', [], 3);

    // Clock corrected back to 2026 before the next upgrade.
    const result = write('0044_d', '2026-01-01T00:00:00.000Z', [], 3);

    expect(existsSync(result.path)).toBe(true);
    expect(snapshotsIn(backupsDir)).toEqual([
      snap('0042_b', '2027-07-01T00-00-00-000Z'),
      snap('0043_c', '2027-08-01T00-00-00-000Z'),
      snap('0044_d', '2026-01-01T00-00-00-000Z'),
    ]);
  });

  it('never prunes the snapshot it just wrote', () => {
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(path.join(backupsDir, snap('0099_odd', '2026-01-01T00-00-00-000Z')), 'x');

    const result = write('0045_next', '2026-10-09T00:00:00.000Z', [], 1);

    expect(snapshotsIn(backupsDir)).toEqual([path.basename(result.path)]);
  });

  it('never prunes files it did not create', () => {
    write('0041_a', '2026-01-01T00:00:00.000Z');
    writeFileSync(path.join(backupsDir, 'support-export.db'), 'keep me');

    write('0042_b', '2026-02-01T00:00:00.000Z', [], 1);

    expect(readdirSync(backupsDir).sort()).toEqual([
      snap('0042_b', '2026-02-01T00-00-00-000Z'),
      'support-export.db',
    ]);
  });

  it('never leaves a partial copy that a later launch could mistake for a snapshot', () => {
    expect(() =>
      writePreMigrationSnapshot({
        backupsDir,
        targetHead: '0045_next',
        vacuumInto: (target) => {
          writeFileSync(target, 'half a database');
          throw new Error('SQLITE_FULL');
        },
        now: () => new Date('2026-10-09T08:00:00.000Z'),
      }),
    ).toThrow(/SQLITE_FULL/);
    expect(readdirSync(backupsDir)).toEqual([]);

    // The retry on the next launch must take a real snapshot, not reuse a stub.
    const written: string[] = [];
    const retry = write('0045_next', '2026-10-09T08:05:00.000Z', written);
    expect(retry.created).toBe(true);
    expect(written).toHaveLength(1);
  });

  it('clears a temp file left by a crash and still writes the snapshot', () => {
    mkdirSync(backupsDir, { recursive: true });
    const leftover = `${snap('0045_next', '2026-10-09T07-00-00-000Z')}.partial`;
    writeFileSync(path.join(backupsDir, leftover), 'power loss mid-copy');

    const result = write('0045_next', '2026-10-09T08:00:00.000Z');

    expect(result.created).toBe(true);
    expect(readdirSync(backupsDir)).toEqual([path.basename(result.path)]);
  });

  it('defaults to a small bounded retention', () => {
    expect(DEFAULT_SNAPSHOT_RETENTION).toBe(3);
  });

  it('propagates a failed copy so startup halts instead of migrating unprotected', () => {
    expect(() =>
      writePreMigrationSnapshot({
        backupsDir,
        targetHead: '0045_next',
        vacuumInto: () => {
          throw new Error('SQLITE_FULL');
        },
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).toThrow(/SQLITE_FULL/);
  });
});

function recordingHandle(): { handle: DatabaseHandle; prepared: string[]; runs: unknown[][] } {
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
  return { handle, prepared, runs };
}

describe('bindVacuumInto', () => {
  it('runs VACUUM INTO with the target path as a bound parameter', () => {
    const { handle, prepared, runs } = recordingHandle();
    const target = path.resolve(tmpRoot, "it's here.db");

    bindVacuumInto(handle)(target);

    expect(prepared).toEqual(['VACUUM INTO ?']);
    expect(runs).toEqual([[path.toNamespacedPath(target)]]);
  });

  // SQLite's Windows VFS rejects a path once `<path>-journal` would exceed
  // MAX_PATH (observed: 251 chars works, 252 fails with SQLITE_CANTOPEN). The
  // snapshot lives deeper than the live DB, so a long `userData` (redirected
  // profile, long user name) would fail only the snapshot and halt startup.
  it.runIf(process.platform === 'win32')(
    'passes Windows paths in long-path form so SQLite is not capped at MAX_PATH',
    () => {
      const { handle, runs } = recordingHandle();

      bindVacuumInto(handle)('C:\\Users\\u\\AppData\\Roaming\\pos-pulse\\backups\\a.db.partial');
      bindVacuumInto(handle)('\\\\fileserver\\profiles\\u\\pos-pulse\\backups\\a.db.partial');

      expect(runs).toEqual([
        ['\\\\?\\C:\\Users\\u\\AppData\\Roaming\\pos-pulse\\backups\\a.db.partial'],
        ['\\\\?\\UNC\\fileserver\\profiles\\u\\pos-pulse\\backups\\a.db.partial'],
      ]);
    },
  );
});
