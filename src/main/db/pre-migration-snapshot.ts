import { mkdirSync, readdirSync, rmSync } from 'fs';
import path from 'path';

import type { DatabaseHandle } from './client.js';

/**
 * RT-320 / ADR-0006 rule 4 — pre-migration snapshot.
 *
 * Before a new build applies its first pending migration, the live DB is
 * copied into `backupsDir` so support can recover the pre-upgrade state. The
 * copy is never restored automatically: a restore would discard business facts
 * captured after it.
 *
 * One snapshot per target schema head (the newest migration the build will
 * apply). If an upgrade fails part-way, every relaunch retries the same head;
 * the existing snapshot is kept rather than replaced by a copy of the
 * half-migrated DB, so the true pre-upgrade state survives retention.
 *
 * Retention keeps the snapshots for the newest `retain` heads. Names sort by
 * head first (migration names are monotonic), so pruning does not depend on
 * the wall clock; the snapshot just written is never pruned. Files this module
 * did not create are never touched.
 *
 * A failed copy throws. The caller (the migration runner's `onBeforeApply`)
 * then applies nothing, and startup halts rather than migrating unprotected.
 */

export const SNAPSHOT_FILE_PREFIX = 'pos-pulse-pre-migration-';
export const DEFAULT_SNAPSHOT_RETENTION = 3;

export interface PreMigrationSnapshotOptions {
  backupsDir: string;
  /** The newest migration name this build will apply (the upgrade's target). */
  targetHead: string;
  /** Write a consistent copy of the live DB to `targetPath`. */
  vacuumInto: (targetPath: string) => void;
  now: () => Date;
  retain?: number;
}

export interface PreMigrationSnapshotResult {
  path: string;
  /** False when a snapshot for this target head already existed and was kept. */
  created: boolean;
}

/** Write (or keep) the snapshot for `targetHead`, then prune older heads. */
export function writePreMigrationSnapshot(
  options: PreMigrationSnapshotOptions,
): PreMigrationSnapshotResult {
  const { backupsDir, targetHead, vacuumInto, now } = options;
  const retain = options.retain ?? DEFAULT_SNAPSHOT_RETENTION;

  mkdirSync(backupsDir, { recursive: true });
  const headPrefix = `${SNAPSHOT_FILE_PREFIX}${targetHead}.`;
  const existing = listSnapshots(backupsDir).find((name) => name.startsWith(headPrefix));
  if (existing !== undefined) return { path: path.join(backupsDir, existing), created: false };

  // ISO-8601 with ':' and '.' replaced keeps the name filesystem-safe.
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const fileName = `${headPrefix}${stamp}.db`;
  const target = path.join(backupsDir, fileName);
  vacuumInto(target);

  const others = listSnapshots(backupsDir).filter((name) => name !== fileName);
  for (const stale of others.slice(0, Math.max(0, others.length - (retain - 1)))) {
    rmSync(path.join(backupsDir, stale), { force: true });
  }
  return { path: target, created: true };
}

function listSnapshots(backupsDir: string): string[] {
  return readdirSync(backupsDir)
    .filter((name) => name.startsWith(SNAPSHOT_FILE_PREFIX) && name.endsWith('.db'))
    .sort();
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
