import { mkdirSync, readdirSync, rmSync } from 'fs';
import path from 'path';

import type { DatabaseHandle } from './client.js';

/**
 * RT-320 / ADR-0006 rule 4 — pre-migration snapshot.
 *
 * Before a new build applies its first pending migration, the live DB is
 * copied into `backupsDir` so support can recover the pre-upgrade state. The
 * copy is never restored automatically: a restore would discard business facts
 * captured after it. Only the newest `retain` snapshots this module wrote are
 * kept; other files in the directory are never touched.
 *
 * A failed copy throws. The caller (the migration runner's `onBeforeApply`)
 * then applies nothing, and startup halts rather than migrating unprotected.
 */

export const SNAPSHOT_FILE_PREFIX = 'pos-pulse-pre-migration-';
export const DEFAULT_SNAPSHOT_RETENTION = 3;

export interface PreMigrationSnapshotOptions {
  backupsDir: string;
  /** Write a consistent copy of the live DB to `targetPath`. */
  vacuumInto: (targetPath: string) => void;
  now: () => Date;
  retain?: number;
}

/** Write one snapshot, prune older ones, and return the snapshot's path. */
export function writePreMigrationSnapshot(options: PreMigrationSnapshotOptions): string {
  const { backupsDir, vacuumInto, now } = options;
  const retain = options.retain ?? DEFAULT_SNAPSHOT_RETENTION;

  mkdirSync(backupsDir, { recursive: true });
  // ISO-8601 with ':' and '.' replaced keeps names filesystem-safe AND
  // lexicographically ordered by time, which the pruning below relies on.
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupsDir, `${SNAPSHOT_FILE_PREFIX}${stamp}.db`);
  vacuumInto(target);

  const snapshots = readdirSync(backupsDir)
    .filter((name) => name.startsWith(SNAPSHOT_FILE_PREFIX) && name.endsWith('.db'))
    .sort();
  for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - retain))) {
    rmSync(path.join(backupsDir, stale), { force: true });
  }
  return target;
}

/**
 * Bind `vacuumInto` to a better-sqlite3 handle. `VACUUM INTO` writes a
 * transactionally consistent copy (WAL content included) without blocking
 * readers; the path is a bound parameter, so quotes in it are safe.
 */
export function bindVacuumInto(handle: DatabaseHandle): (targetPath: string) => void {
  return (targetPath) => {
    const stmt = handle.prepare('VACUUM INTO ?') as { run(...params: unknown[]): unknown };
    stmt.run(targetPath);
  };
}
