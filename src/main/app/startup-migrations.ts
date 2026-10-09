import path from 'path';

import { SchemaAheadError, runMigrations } from '../db/migrate.js';
import type { MigrationFile, MigrationsDb } from '../db/migrate.js';
import { writePreMigrationSnapshot } from '../db/pre-migration-snapshot.js';
import { describeSchemaAheadRefusal } from './schema-ahead-refusal.js';
import type { SchemaAheadRefusal } from './schema-ahead-refusal.js';

/**
 * RT-320 — startup migration seam (ADR-0006 rules 2 and 4).
 *
 * Runs the migration runner with the two roll-forward safeguards wired in:
 *   - a DB ahead of this build becomes a typed refusal the composition root
 *     shows to the operator before exiting (fail closed);
 *   - a DB with pending migrations is snapshotted to `<userData>/backups/`
 *     before the first one applies.
 * Any other failure is rethrown into the existing fatal-startup path.
 */

export interface StartupMigrationsLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface StartupMigrationsDeps {
  db: MigrationsDb;
  files: MigrationFile[];
  vacuumInto: (targetPath: string) => void;
  userDataDir: string;
  now: () => Date;
  logger: StartupMigrationsLogger;
}

export type StartupMigrationsResult = { ok: true } | { ok: false; refusal: SchemaAheadRefusal };

export function runStartupMigrations(deps: StartupMigrationsDeps): StartupMigrationsResult {
  const { db, files, vacuumInto, userDataDir, now, logger } = deps;
  try {
    runMigrations({
      db,
      files,
      onBeforeApply: (pending) => {
        const snapshotPath = writePreMigrationSnapshot({
          backupsDir: path.join(userDataDir, 'backups'),
          vacuumInto,
          now,
        });
        logger.info({ snapshotPath, pending }, 'db:pre-migration-snapshot');
      },
    });
  } catch (err) {
    if (!(err instanceof SchemaAheadError)) throw err;
    logger.error({ unknownMigrations: err.unknownMigrations }, 'db:schema_ahead_refused');
    return { ok: false, refusal: describeSchemaAheadRefusal(err.unknownMigrations) };
  }
  return { ok: true };
}
