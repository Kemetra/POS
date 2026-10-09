import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import type { AppliedRow, MigrationFile, MigrationsDb } from '../../db/migrate.js';
import { SNAPSHOT_FILE_PREFIX } from '../../db/pre-migration-snapshot.js';
import { runStartupMigrations } from '../startup-migrations.js';

/**
 * RT-320 — startup seam between the composition root and the migration runner:
 * a DB ahead of the build becomes an operator refusal, and a DB with pending
 * migrations is snapshotted to `<userData>/backups/` first.
 */

function fakeDb(appliedNames: string[]): { db: MigrationsDb; applied: AppliedRow[] } {
  const applied: AppliedRow[] = appliedNames.map((name) => ({
    name,
    applied_at: '2026-01-01T00:00:00.000Z',
    checksum: 'x',
  }));
  return {
    applied,
    db: {
      exec: () => undefined,
      listAppliedNames: () => applied.map((r) => r.name),
      recordApplied: (row) => {
        applied.push(row);
      },
      transaction: (fn) => fn(),
    },
  };
}

const file = (name: string): MigrationFile => ({ name, sql: `-- ${name}` });
const logger = () => ({ info: vi.fn(), error: vi.fn() });

let userDataDir: string;
beforeEach(() => {
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'pos-startup-mig-'));
});
afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe('runStartupMigrations', () => {
  it('returns a refusal and logs it when the DB is ahead of the build', () => {
    const { db, applied } = fakeDb(['0001_a', '0002_b']);
    const log = logger();

    const result = runStartupMigrations({
      db,
      files: [file('0001_a')],
      vacuumInto: vi.fn(),
      userDataDir,
      now: () => new Date('2026-10-09T00:00:00.000Z'),
      logger: log,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.body).toContain('0002_b');
    expect(log.error).toHaveBeenCalledWith(
      { unknownMigrations: ['0002_b'] },
      'db:schema_ahead_refused',
    );
    expect(applied.map((r) => r.name)).toEqual(['0001_a', '0002_b']);
  });

  it('snapshots into <userData>/backups before applying pending migrations', () => {
    const { db, applied } = fakeDb(['0001_a']);
    const log = logger();
    const vacuumInto = vi.fn((target: string) => {
      // The copy must exist before the pending migration is recorded.
      expect(applied.map((r) => r.name)).toEqual(['0001_a']);
      writeFileSync(target, 'copy');
    });

    const result = runStartupMigrations({
      db,
      files: [file('0001_a'), file('0002_b')],
      vacuumInto,
      userDataDir,
      now: () => new Date('2026-10-09T00:00:00.000Z'),
      logger: log,
    });

    expect(result).toEqual({ ok: true, applied: 1 });
    expect(readdirSync(path.join(userDataDir, 'backups'))).toEqual([
      `${SNAPSHOT_FILE_PREFIX}2026-10-09T00-00-00-000Z.db`,
    ]);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ pending: ['0002_b'] }),
      'db:pre-migration-snapshot',
    );
    expect(applied.map((r) => r.name)).toEqual(['0001_a', '0002_b']);
  });

  it('rethrows any other migration failure for the fatal-startup path', () => {
    const { db } = fakeDb(['0001_a']);
    expect(() =>
      runStartupMigrations({
        db,
        files: [file('0001_a'), file('0002_b')],
        vacuumInto: () => {
          throw new Error('SQLITE_FULL');
        },
        userDataDir,
        now: () => new Date(),
        logger: logger(),
      }),
    ).toThrow(/SQLITE_FULL/);
  });
});
