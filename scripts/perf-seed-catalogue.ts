/**
 * 009 T054 — perf bring-up seed + p95 harness.
 *
 * Stands up a REAL on-disk SQLite catalogue at >= 50k rows through the
 * PRODUCTION seams (openDatabase -> migration runner -> createProductRepo),
 * then optionally times the repo queries that NFR-1 / NFR-2 bound. This is the
 * runnable companion to `specs/009-product-search-and-barcode-lookup/perf-bringup.md`
 * — it makes T054 "run + record" instead of "design + measure".
 *
 * WHY THIS IS NOT THE CI PERF TESTS (perf.exact / perf.search):
 *   Those assert correctness on sql.js under the parallel Vitest runner — by
 *   design, NO timing. The NFR-1/NFR-2 budgets are a property of the production
 *   better-sqlite3 binding on the target Windows terminal. This script uses that
 *   binding against an on-disk file so the numbers are meaningful. See §0 of the
 *   bring-up doc.
 *
 * ABI NOTE (load-bearing): better-sqlite3's native binary is rebuilt by
 * postinstall for ELECTRON's Node ABI (see src/main/db/client.ts R1). A plain
 * `tsx`/node run uses SYSTEM Node and may fail to load it with
 * NODE_MODULE_VERSION mismatch. If that happens, run against system Node's ABI:
 *     npx @electron/rebuild -f -w better-sqlite3   # for Electron (default state)
 *     npm rebuild better-sqlite3                   # to retarget system Node
 * ...or run the seed from inside an Electron main-process context. The script
 * catches the load failure and prints this guidance rather than crashing raw.
 *
 * USAGE (from repo root):
 *   npx tsx scripts/perf-seed-catalogue.ts --rows 50000 --out ./perf-catalogue.db
 *   npx tsx scripts/perf-seed-catalogue.ts --rows 50000 --measure --samples 1000
 *   npx tsx scripts/perf-seed-catalogue.ts --rows 50000 --read-down --measure   # 010 T054
 *
 * FLAGS:
 *   --rows N           row count to seed (default 50000; NFR floor is 50k)
 *   --out PATH         on-disk db path (default ./perf-catalogue.db); deleted+recreated
 *   --measure          after seeding, run the p95 timing harness (009 §4/§5 of the doc)
 *   --samples N        timed iterations per scenario (default 1000); >=1000 recommended
 *   --warmup N         discarded warm-up iterations per scenario (default 50)
 *   --keep             do not delete an existing --out before seeding (resume/inspect)
 *   --read-down        (010 T054) time the PRODUCTION read-down writer's full run()
 *                      span — the main-thread block a mid-read-down scan inherits (SC-8).
 *                      Runs BEFORE --measure so the NFR-1/NFR-2 lookups then run against
 *                      a writer-promoted (read-down-populated) catalogue.
 *   --read-down-runs N timed full-replace read-down runs (default 10)
 *
 * The repo-level scenarios ONLY measure the prepared-statement exec + row mapping
 * (NOT render / NOT IPC — separate budgets). The --read-down scenario measures the
 * whole synchronous writer.run() span (stage + promote), which IS the worst-case
 * main-thread block in production (single shared synchronous connection; no worker
 * threads → no in-process WAL reader/writer concurrency to measure). Numbers are
 * PRINTED, never written into the doc: the owner transcribes them into the §5/§6
 * tables and decides the verdict.
 */

import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import type { DatabaseHandle } from '../src/main/db/client.js';
import { openDatabase } from '../src/main/db/client.js';
import { bindMigrationsDb, readMigrationsFromDisk, runMigrations } from '../src/main/db/migrate.js';
import { createProductRepo, type ProductRepo } from '../src/main/catalogue/product-repo.js';
import { normalize } from '../src/main/catalogue/normalize.js';
// 010 T054 — read-down completion + promote-window bring-up (SC-8). Times the
// PRODUCTION writer path (createReadDownWriter) so the numbers reflect the real
// main-thread block a barcode scan inherits if it lands during a read-down.
import { createReadDownWriter } from '../src/main/catalogue/read-down/read-down-writer.js';
import { createCatalogueSyncStateRepo } from '../src/main/catalogue/catalogue-sync-state-repo.js';
import type { SellableCatalogRow } from '../src/main/catalogue/read-down/map-sellable-row.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

const TENANT = 'tenant-1';

interface Args {
  rows: number;
  out: string;
  measure: boolean;
  samples: number;
  warmup: number;
  keep: boolean;
  /** 010 T054 — time the read-down writer (staging + promote windows). */
  readDown: boolean;
  /** Timed read-down runs (each is a FULL replace of all `rows`). Default 10. */
  readDownRuns: number;
}

/** Integer-valued flags → the `Args` field each one sets. */
const INT_FLAGS = {
  '--rows': 'rows',
  '--samples': 'samples',
  '--warmup': 'warmup',
  '--read-down-runs': 'readDownRuns',
} as const;

/** Boolean switches → the `Args` field each one turns on. */
const SWITCH_FLAGS = {
  '--measure': 'measure',
  '--keep': 'keep',
  '--read-down': 'readDown',
} as const;

function assertInteger(flag: string, value: number, min: 0 | 1): void {
  if (Number.isInteger(value) && value >= min) return;
  throw new Error(`${flag} must be a ${min === 1 ? 'positive' : 'non-negative'} integer`);
}

function assertValidArgs(a: Args): void {
  assertInteger('--rows', a.rows, 1);
  assertInteger('--samples', a.samples, 1);
  assertInteger('--warmup', a.warmup, 0);
  assertInteger('--read-down-runs', a.readDownRuns, 1);
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    rows: 50_000,
    out: path.join(REPO_ROOT, 'perf-catalogue.db'),
    measure: false,
    samples: 1000,
    warmup: 50,
    keep: false,
    readDown: false,
    readDownRuns: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';

    // npm's `--` separator forwarding is inconsistent across platforms/npm
    // versions — a bare `--` sometimes survives into argv. Skip it so
    // `npm run perf:seed -- --rows 50000` works regardless. (See the project
    // memory note: npm `--` is unreliable on this machine.)
    if (token === '--') continue;

    // Accept both `--rows 50000` (space form) and `--rows=50000` (equals form);
    // the equals form is robust to any npm reordering of forwarded args.
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    const next = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${flag} needs a value`);
      return v;
    };

    if (flag === '--out') a.out = path.resolve(next());
    else if (Object.hasOwn(INT_FLAGS, flag))
      a[INT_FLAGS[flag as keyof typeof INT_FLAGS]] = Number.parseInt(next(), 10);
    else if (Object.hasOwn(SWITCH_FLAGS, flag))
      a[SWITCH_FLAGS[flag as keyof typeof SWITCH_FLAGS]] = true;
    // Hard error on a genuinely unknown flag. Do NOT silently ignore: a typo'd
    // flag silently falling back to the default (e.g. 50k rows when you meant
    // something else) would corrupt the perf evidence without warning.
    else throw new Error(`unknown flag: ${token}`);
  }
  assertValidArgs(a);
  return a;
}

/** Targets we know exist in the seeded set, for the timing scenarios. */
interface SeedTargets {
  /** A mid-set barcode (not first/last row — avoids a fortunate cache position). */
  midBarcode: string;
  /** The matching mid-set SKU. */
  midSku: string;
  /** A token most rows share -> broad search hits the 20-cap + truncated. */
  broadToken: string;
  /** A query that matches the single uniquely-named row. */
  uniqueQuery: string;
  /** A token present in no row -> not_found. */
  absentToken: string;
}

/**
 * Bulk-seed `rows` active products + one barcode each in ONE transaction, via
 * the real better-sqlite3 handle. Mirrors `seedLargeCatalogue` in the CI perf
 * tests: most rows share a common token (capped/truncated search), one
 * uniquely-named row (single-match search), mid-set exact target. `*_norm` /
 * `*_fold` are derived with the REAL normalize() — never hand-typed.
 */
function seedLargeCatalogue(db: DatabaseHandle, rows: number): SeedTargets {
  const insertProduct = db.prepare(`
    INSERT INTO products
      (product_id, tenant_id, branch_id, sku, sku_norm, name_ar, name_en, name_fold,
       aliases_json, alias_fold, price_minor, tax_category, unit_pack_label, active,
       controlled_substance, prescription_required, row_version, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `) as { run(...p: unknown[]): unknown };
  const insertBarcode = db.prepare(`
    INSERT INTO product_barcodes
      (barcode_id, product_id, tenant_id, barcode, barcode_norm, barcode_kind, created_at)
    VALUES (?,?,?,?,?,?,?)
  `) as { run(...p: unknown[]): unknown };

  const ts = '2026-05-31T00:00:00.000Z';
  const uniqueIdx = Math.floor(rows / 2);

  const seed = db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const id = String(i);
      const isUnique = i === uniqueIdx;
      const nameAr = isUnique ? 'زنكتابليت فريد' : `منتج ${id}`;
      const nameEn = isUnique ? 'Zinctablet Unique' : `Product ${id}`;
      const sku = `SKU-${id}`;
      const code = `62210${id.padStart(8, '0')}`;
      insertProduct.run(
        `p-${id}`,
        TENANT,
        null,
        sku,
        normalize(sku),
        nameAr,
        nameEn,
        normalize(`${nameAr} ${nameEn}`),
        null,
        null,
        100 + (i % 1000),
        'standard',
        null,
        1,
        0,
        0,
        'v1',
        ts,
        ts,
      );
      insertBarcode.run(`bc-${id}`, `p-${id}`, TENANT, code, normalize(code), 'unit', ts);
    }
  });
  seed();

  const mid = String(uniqueIdx);
  return {
    midBarcode: `62210${mid.padStart(8, '0')}`,
    midSku: `SKU-${mid}`,
    broadToken: 'product',
    uniqueQuery: 'zinctablet',
    absentToken: 'zzzznomatchanywhere',
  };
}

interface Stats {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

function stats(samplesMs: number[]): Stats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  if (sorted.length === 0) return { min: 0, p50: 0, p95: 0, max: 0 };
  const at = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx] ?? 0;
  };
  return { min: sorted[0] ?? 0, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
}

/** Time one repo call `fn` over warmup (discarded) + samples (recorded) runs. */
function timeScenario(fn: () => void, warmup: number, samples: number): Stats {
  for (let i = 0; i < warmup; i++) fn();
  const ms: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    fn();
    ms.push(performance.now() - t0);
  }
  return stats(ms);
}

function fmt(s: Stats): string {
  const r = (n: number): string => n.toFixed(3).padStart(8);
  return `min ${r(s.min)} | p50 ${r(s.p50)} | p95 ${r(s.p95)} | max ${r(s.max)}  (ms)`;
}

function measure(repo: ProductRepo, t: SeedTargets, warmup: number, samples: number): void {
  console.log(
    `\n=== p95 harness — ${String(samples)} samples / scenario, ${String(warmup)} warm-up discarded ===`,
  );
  console.log(
    '=== repo-level query only (NOT render / NOT IPC). Budgets: NFR-1 <=50ms, NFR-2 <=150ms p95 ===\n',
  );

  console.log('--- NFR-1 exact lookup (budget <=50ms p95) ---');
  console.log(
    'lookupByBarcode mid-set : ' +
      fmt(timeScenario(() => repo.lookupByBarcode(TENANT, t.midBarcode), warmup, samples)),
  );
  console.log(
    'lookupBySku     mid-set : ' +
      fmt(timeScenario(() => repo.lookupBySku(TENANT, t.midSku), warmup, samples)),
  );
  console.log(
    'lookupByBarcode absent  : ' +
      fmt(timeScenario(() => repo.lookupByBarcode(TENANT, 'no-such-barcode'), warmup, samples)),
  );

  console.log('\n--- NFR-2 partial search (budget <=150ms p95) — decision-critical ---');
  console.log(
    'broad -> 20-cap+trunc   : ' +
      fmt(timeScenario(() => repo.search(TENANT, t.broadToken), warmup, samples)),
  );
  console.log(
    'narrow -> single match  : ' +
      fmt(timeScenario(() => repo.search(TENANT, t.uniqueQuery), warmup, samples)),
  );
  console.log(
    'absent -> not_found     : ' +
      fmt(timeScenario(() => repo.search(TENANT, t.absentToken), warmup, samples)),
  );

  console.log("\nTranscribe these into perf-bringup.md §5. Verdict is the owner's call.");
  console.log('If any NFR-2 p95 > 150ms -> open R-RISK-1 / FTS5-fallback review.');
}

/**
 * 010 T054 — build `n` valid `SellableCatalogRow`s (the backend snapshot shape).
 * One barcode (alias) each, exact-decimal price string, opaque row_cursor. These
 * all PASS map + validate so the writer stages + promotes the full set (the
 * realistic full-snapshot-replace path, FR-7). NOT the 009 seed shape — this is
 * the wire shape the writer consumes before folding.
 */
function buildSnapshotRows(n: number): SellableCatalogRow[] {
  const rows: SellableCatalogRow[] = [];
  for (let i = 0; i < n; i++) {
    const id = String(i);
    rows.push({
      product_id: `p-${id}`,
      sku: `SKU-${id}`,
      name: `منتج ${id} Product ${id}`,
      aliases: [`62210${id.padStart(8, '0')}`],
      price: { amount: (1 + (i % 1000) / 100).toFixed(2), currency_code: 'EGP' },
      tax_category: 'standard',
      active: true,
      row_cursor: `rc-${id}`,
    });
  }
  return rows;
}

/**
 * 010 T054 — time the PRODUCTION read-down writer's full `run()` span over
 * `runs` iterations, each a full-snapshot replace of all `rows` rows.
 *
 * WHY `writer.run()` TOTAL IS THE DECISION-CRITICAL NUMBER (SC-8): production
 * shares ONE synchronous better-sqlite3 connection on the Electron main thread
 * (one `openDatabase`, no worker threads — verified at the composition root).
 * The promote is `db.transaction()`, which holds the thread BEGIN→COMMIT; the
 * staging loop runs before it. So a barcode-lookup IPC that arrives mid-read-down
 * does NOT race the writer under WAL — it QUEUES behind the writer's synchronous
 * span and runs after. The worst-case latency that span adds to a scan IS the
 * full `writer.run()` duration. There is no in-process WAL reader-vs-writer
 * concurrency to measure; the thread-block span is the honest SC-8 number.
 *
 * The seed already populated `rows` live rows, so the FIRST run replaces a full
 * catalogue (DELETE live + INSERT…SELECT staging) — the realistic steady-state
 * cost, not an empty-table first-fill.
 */
function measureReadDown(db: DatabaseHandle, rows: number, runs: number): void {
  const syncStateRepo = createCatalogueSyncStateRepo(db);
  const writer = createReadDownWriter({ db, syncStateRepo });
  const snapshot = buildSnapshotRows(rows);

  console.log(
    `\n=== read-down completion window — ${String(runs)} full-replace runs @ ${String(rows)} rows ===`,
  );
  console.log(
    '=== PRODUCTION writer.run() span = the main-thread BLOCK a mid-read-down scan inherits (SC-8) ===',
  );
  console.log(
    '=== single shared synchronous connection: no in-process WAL reader/writer race; the block IS the cost ===\n',
  );

  const samplesMs: number[] = [];
  let lastWritten = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const result = writer.run({
      tenantId: TENANT,
      branchId: 'branch-1',
      sourceSnapshotId: `snap-${String(i)}`,
      now: '2026-06-15T00:00:00.000Z',
      rows: snapshot,
    });
    samplesMs.push(performance.now() - t0);
    lastWritten = result.productsWritten;
    if (result.outcome === 'failed')
      throw new Error(`read-down run ${String(i)} FAILED: ${String(result.failureCategory)}`);
  }

  const s = stats(samplesMs);
  console.log(`products written / run : ${String(lastWritten)} (expected ${String(rows)})`);
  console.log(`read-down full run()   : ${fmt(s)}`);
  console.log('\nThis is the worst-case main-thread block. A barcode scan arriving during a');
  console.log('read-down waits at most ~this long before its lookup runs (then its own');
  console.log('NFR-1 budget applies). Transcribe p50/p95/max into perf-bringup.md §6.');
  console.log('If the block is material vs the cashier-tolerable scan latency → consider chunked');
  console.log('staging / smaller promote (plan §R-RISK-2 mitigation).');
}

function openWithAbiGuard(dbPath: string): DatabaseHandle {
  try {
    return openDatabase(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/NODE_MODULE_VERSION|was compiled against a different Node|invalid ELF|\.node/.test(msg)) {
      console.error('\n[ABI] better-sqlite3 failed to load — native binding ABI mismatch.');
      console.error(
        '[ABI] It is built for ELECTRON by postinstall; a plain tsx/node run uses system Node.',
      );
      console.error(
        '[ABI] Fix: `npm rebuild better-sqlite3` (system Node), then re-run this script;',
      );
      console.error(
        '[ABI] afterwards `npx @electron/rebuild -f -w better-sqlite3` to restore the Electron build.',
      );
      console.error(`[ABI] underlying error: ${msg}\n`);
    }
    throw err;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (existsSync(args.out) && !args.keep) {
    rmSync(args.out, { force: true });
    // WAL sidecars from a prior run.
    rmSync(`${args.out}-wal`, { force: true });
    rmSync(`${args.out}-shm`, { force: true });
  }

  console.log(`[seed] opening on-disk db: ${args.out}`);
  const db = openWithAbiGuard(args.out);

  try {
    // Pragmas applied by openDatabase: journal_mode=WAL, foreign_keys=ON
    // (matches production). Record what is actually in effect for the doc §3/§5.
    const journal = db.pragma('journal_mode', { simple: true });
    const synchronous = db.pragma('synchronous', { simple: true });
    console.log(
      `[seed] pragmas in effect: journal_mode=${String(journal)} synchronous=${String(synchronous)}`,
    );

    console.log('[seed] applying migrations through the production runner...');
    const files = readMigrationsFromDisk(MIGRATIONS_DIR);
    runMigrations({ db: bindMigrationsDb(db), files });
    console.log(`[seed] migrations applied: ${String(files.length)} files`);

    // Confirm the NFR-relied-on indexes exist on THIS db (doc §3 step 2).
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('products','product_barcodes')`,
    ) as {
      all(): Array<{ name: string }>;
    };
    const idxNames = idx.all().map((r) => r.name);
    console.log(`[seed] indexes present: ${idxNames.join(', ') || '(none)'}`);

    console.log(
      `[seed] seeding ${String(args.rows)} products + barcodes (real normalize() folds)...`,
    );
    const t0 = performance.now();
    const targets = seedLargeCatalogue(db, args.rows);
    console.log(
      `[seed] seeded ${String(args.rows)} rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
    );

    // 010 T054 — read-down completion window FIRST (before --measure), so the
    // NFR-1/NFR-2 lookups below run against a catalogue the PRODUCTION WRITER
    // promoted (a read-down-populated catalogue, exactly what §A5 asks), not just
    // the raw seed. Each read-down run is a full replace of all `rows` rows.
    if (args.readDown) {
      measureReadDown(db, args.rows, args.readDownRuns);
    }

    if (args.measure) {
      const repo = createProductRepo(db);
      measure(repo, targets, args.warmup, args.samples);
    } else if (!args.readDown) {
      console.log(
        '\n[seed] done. Re-run with --measure to time NFR-1/NFR-2, --read-down for the' +
          ' read-down completion window, or open the db with the repo.',
      );
    }
  } finally {
    db.close();
  }
}

main();
