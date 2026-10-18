/**
 * T521 [§A5] — Runtime redaction assertion.
 *
 * This is NOT another scrubber unit test (those live in
 * `*-audit-redaction.test.ts` and assert "given a forbidden key, the scrubber
 * strips it"). T521 is a **runtime tripwire**: it drives the REAL 008 print +
 * drawer dispatchers through a REAL pino logger (captured via a PassThrough
 * factory) plus a `console` spy, then asserts that NOTHING the actual code
 * paths emit carries a forbidden field — at any nesting depth, by value OR by
 * key name.
 *
 * Why it exists (data-model.md §"Forbidden fields"; T521 task text): a static
 * source grep cannot catch a contributor who one day logs a raw object whose
 * shape the pino `redact` paths miss, or who `console.error(err)`s an error
 * whose message embeds a forbidden value. This test goes RED the moment that
 * happens. That the suite is GREEN today is the correct result — the guard is a
 * regression tripwire, not a transformation proof.
 *
 * Capture surfaces (the complete 008 runtime sink map; see coordination.md
 * §T521):
 *   1. pino — the real `createLogger` instance, injected into both dispatchers,
 *      writing to a captured PassThrough (exercises the real `REDACTION_PATHS`).
 *      THIS is the load-bearing surface this test drives and asserts on.
 *   2. console — `finalize-listener.ts:284` `console.error(err)` is the ONE
 *      sink that bypasses pino entirely. A console spy is installed (so a future
 *      contributor who adds a `console.*` in the driven dispatchers is caught),
 *      but NOTE: this test does NOT drive the finalize-listener tick-failure path
 *      that fires that line — so the console surface is *instrumented, not
 *      exercised*. Residual risk is low: `runTickOnce` operates on
 *      already-persisted `sales` rows whose forbidden fields were refused at
 *      finalize-time (`finalize-transaction.ts findForbiddenKey`), so the error
 *      it could surface is structurally constrained. Recorded honestly in
 *      coordination.md §T521 as a not-yet-driven path, not as coverage.
 *   (audit_events is covered by the emitter's own refusal unit tests; Sentry has
 *    no direct 008 call-site — see coordination.md §T521 sink map.)
 *
 * SCOPE (deliberate, per T521 = key-name/value audit): this asserts forbidden
 * KEY NAMES never appear as object keys and known sentinel VALUES never survive.
 * The real-flow tests rely on the KEY-NAME walk (they pass an empty sentinel
 * set); the value scan is exercised by the positive control. It does NOT scan
 * for forbidden cleartext under innocently-named keys — beyond what T521
 * specifies and beyond what this harness can validate (coordination.md §T521).
 *
 * NOTE on the key-name walk: pino redaction KEEPS the key and masks the VALUE
 * (`{pan:"[Redacted]"}`). The key-name scanner is therefore intentionally
 * STRICTER than "a value leaked" — the mere PRESENCE of a forbidden key name in
 * a log record (even correctly value-masked, even shallow) is treated as a
 * finding. 008 emits no such key today. If this ever goes RED on a
 * correctly-masked key, the fix is still in the SOURCE (don't log that key at
 * all) — never loosen this test.
 *
 * If any assertion fails, tighten the SOURCE — never the test.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, type PinoRollFactory } from '../../../src/main/logging/logger.js';
import { createPrintDispatcher } from '../../../src/main/receipts/print-dispatcher.js';
import { createPrintPipeline } from '../../../src/main/receipts/print-pipeline.js';
import { createDrawerKickDispatcher } from '../../../src/main/drawer/drawer-kick.js';
import { bindPrintEventsRepository } from '../../../src/main/sales/repositories/print-events.repository.js';
import { bindDrawerEventsRepository } from '../../../src/main/sales/repositories/drawer-events.repository.js';
import { createSaleAuditEmitter } from '../../../src/main/sales/audit-emitter.js';
import type { SaleAuditEvent } from '../../../src/main/sales/audit-emitter.js';
import { makeSqlJsHandle } from '../../unit/main/cart/__helpers__/sql-js-handle.js';
import { FORBIDDEN_PAYLOAD_KEYS } from '../../../src/shared/audit/forbidden-keys.js';
import type { ReceiptPayload } from '../../../src/shared/receipts/types.js';
import type { SaleId, SaleNumber } from '../../../src/shared/sales/types.js';

const __dirnameForFile = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameForFile, '..', '..', '..');
const MIGRATIONS = [
  '0004_audit_events.sql',
  '0020_create_sales.sql',
  '0021_sales_append_only_trigger.sql',
  '0022_create_print_events.sql',
  '0023_create_drawer_events.sql',
].map((f) => readFileSync(path.join(REPO_ROOT, 'migrations', f), 'utf8'));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

// ── Capture helpers ────────────────────────────────────────────────────

function makeCapturingFactory(): { factory: PinoRollFactory; read: () => string } {
  const stream = new PassThrough();
  const buf: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => buf.push(chunk));
  const factory: PinoRollFactory = () => Promise.resolve(stream);
  return { factory, read: () => Buffer.concat(buf).toString('utf8') };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function makeRealLogger(): Promise<{
  logger: Awaited<ReturnType<typeof createLogger>>;
  read: () => string;
}> {
  const { factory, read } = makeCapturingFactory();
  const logger = await createLogger({
    process: 'main',
    appVersion: '0.1.0-t521',
    logsDir: '/tmp/t521',
    pinoRollFactory: factory,
  });
  return { logger, read };
}

/**
 * Walk a parsed JSON value and collect every object KEY (case-insensitive,
 * any depth). The key-name half of the audit — catches a key sitting deeper
 * than pino's 4-level `*.*.*.key` redact paths.
 */
function collectKeys(value: unknown, acc: Set<string>): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, acc);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    acc.add(k.toLowerCase());
    collectKeys(v, acc);
  }
}

/** Parse each NDJSON line emitted by pino into objects (skips blanks). */
function parseRecords(text: string): unknown[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

const FORBIDDEN_LOWER = new Set(FORBIDDEN_PAYLOAD_KEYS.map((k) => k.toLowerCase()));

/**
 * Assert no forbidden field appears in the captured pino output, by both
 * measures: (a) no sentinel VALUE survives, (b) no FORBIDDEN_PAYLOAD_KEYS entry
 * appears as a parsed object key at any depth.
 */
function assertPinoClean(text: string, sentinels: readonly string[], label: string): void {
  for (const s of sentinels) {
    expect(text, `${label}: sentinel value leaked: ${s}`).not.toContain(s);
  }
  const keys = new Set<string>();
  for (const rec of parseRecords(text)) collectKeys(rec, keys);
  for (const forbidden of FORBIDDEN_LOWER) {
    expect(keys.has(forbidden), `${label}: forbidden key present in log record: ${forbidden}`).toBe(
      false,
    );
  }
}

// ── Fixtures: real receipt payload (NO forbidden field — mirrors as-built) ──

function payload(over: Partial<ReceiptPayload> = {}): ReceiptPayload {
  return {
    variant: 'first_print',
    sale_id: 'sale-t521' as SaleId,
    sale_number: 'TERM-01-2026-05-30-000001' as SaleNumber,
    receipt_number: 'TERM-01-2026-05-30-000001',
    tenant_tax_registration_id: 'TRN-100',
    branch_name: 'Maadi Branch',
    branch_address: '12 Road 9',
    terminal_label: 'TERM-01',
    selling_operator_display_name: 'Mohamed Ahmed',
    subtotal_minor: 5500,
    total_tax_minor: 0,
    total_change_due_minor: 0,
    lines: [
      {
        item_ref: 'SKU-001',
        display_name: 'Paracetamol 500mg',
        quantity: 1,
        unit_price_minor: 5500,
        line_subtotal_minor: 5500,
        note: null,
      },
    ],
    tender_lines_summary: [
      { tender_type: 'cash', amount_applied_minor: 5500, change_due_minor: 0 },
    ],
    settled_at: '2026-05-30T10:00:05.000Z',
    finalized_at: '2026-05-30T10:00:06.000Z',
    local_calendar_day: '2026-05-30',
    ...over,
  };
}

const CTX = {
  sale_id: 'sale-t521',
  tenant_id: 'tenant-1',
  branch_id: 'branch-1',
  terminal_id: 'terminal-1',
  session_id: 'sess-1',
  attribution_operator_id: 'op-clerk-1',
};

function freshDb(): SqlJsDatabase {
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

function makePrintDispatcher(
  db: SqlJsDatabase,
  events: SaleAuditEvent[],
  logger: PrintDispatcherLoggerArg,
  escposOk = true,
  printOk = true,
) {
  const handle = makeSqlJsHandle(db);
  const printEventsRepo = bindPrintEventsRepository(handle);
  const auditEmitter = createSaleAuditEmitter({ sink: { write: (e) => events.push(e) } });
  const pipeline = createPrintPipeline({
    escposAdapter: {
      render_path: 'escpos_direct',
      print: vi.fn(() =>
        printOk
          ? Promise.resolve({ ok: true as const, render_path: 'escpos_direct' as const })
          : Promise.resolve({
              ok: false as const,
              render_path: 'escpos_direct' as const,
              failure_reason: 'escpos_write_failure' as const,
            }),
      ),
    },
    osPrintAdapter: {
      render_path: 'os_print',
      print: vi.fn(() =>
        printOk
          ? Promise.resolve({ ok: true as const, render_path: 'os_print' as const })
          : Promise.resolve({
              ok: false as const,
              render_path: 'os_print' as const,
              failure_reason: 'os_print_error' as const,
            }),
      ),
    },
    probeEscposSupport: () => Promise.resolve(escposOk),
  });
  let seq = 0;
  return createPrintDispatcher({
    pipeline,
    printEventsRepo,
    auditEmitter,
    logger,
    now: () => '2026-05-30T10:00:07.000Z',
    newPrintEventId: () => `pe-${String(++seq)}`,
  });
}

type PrintDispatcherLoggerArg = Parameters<typeof createPrintDispatcher>[0]['logger'];

describe('T521 — runtime redaction tripwire (real dispatchers, real pino, console spy)', () => {
  const consoleCalls: unknown[][] = [];

  beforeEach(() => {
    consoleCalls.length = 0;
    const capture = (...args: unknown[]): void => {
      consoleCalls.push(args);
    };
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stringifyArg(a: unknown): string {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }

  function consoleText(): string {
    return consoleCalls.map((args) => args.map(stringifyArg).join(' ')).join('\n');
  }

  it('first-print SUCCESS path emits no forbidden field to pino', async () => {
    const { logger, read } = await makeRealLogger();
    const db = freshDb();
    const events: SaleAuditEvent[] = [];
    const dispatcher = makePrintDispatcher(db, events, logger);
    await dispatcher.dispatchFirstPrint(payload(), CTX);
    await flush();
    const text = read();
    // Non-vacuity guard: the real dispatcher MUST have logged through the
    // captured stream (else "clean" is meaningless). The success path logs
    // `sale.receipt.printed` with sale_id + print_event_id.
    expect(text, 'dispatcher emitted nothing to captured pino — test would be vacuous').toContain(
      'sale.receipt.printed',
    );
    expect(text).toContain('sale-t521'); // loggable sale_id is preserved (not over-redacted)
    assertPinoClean(text, [], 'first-print-success');
    // The driven dispatchers emit nothing to console, so consoleText() is empty
    // here — asserting on it would be vacuous (see docstring: the console
    // bypass path is instrumented, not exercised). The spy exists to catch a
    // future `console.*` added INSIDE the driven dispatchers; if one appears,
    // assert it here.
    expect(consoleText()).toBe('');
  });

  it('print FAILURE path emits no forbidden field to pino', async () => {
    const { logger, read } = await makeRealLogger();
    const db = freshDb();
    const events: SaleAuditEvent[] = [];
    const dispatcher = makePrintDispatcher(db, events, logger, true, /* printOk */ false);
    await dispatcher.dispatchFirstPrint(payload(), CTX);
    await flush();
    assertPinoClean(read(), [], 'print-failure');
  });

  it('drawer opened / suppressed / failed paths emit no forbidden field to pino', async () => {
    const { logger, read } = await makeRealLogger();
    const db = freshDb();
    const events: SaleAuditEvent[] = [];
    // Seed a print_events row so drawer_events FK (triggering_print_event_id) holds.
    const printDispatcher = makePrintDispatcher(db, events, logger);
    await printDispatcher.dispatchFirstPrint(payload(), CTX);

    const drawerRepo = bindDrawerEventsRepository(makeSqlJsHandle(db));
    const auditEmitter = createSaleAuditEmitter({ sink: { write: (e) => events.push(e) } });

    // opened: cash tender + a kick that succeeds.
    const openedDispatcher = createDrawerKickDispatcher({
      drawerEventsRepo: drawerRepo,
      transport: { kick: () => Promise.resolve({ ok: true as const }) },
      auditEmitter,
      logger,
      now: () => '2026-05-30T10:00:08.000Z',
      newDrawerEventId: () => 'de-opened',
    });
    await openedDispatcher.dispatchOnFirstPrintSuccess({
      ...CTX,
      tender_lines_summary_json: JSON.stringify([
        { tender_type: 'cash', amount_applied_minor: 5500 },
      ]),
      triggering_print_event_id: 'pe-1',
    });

    // suppressed: cashless tender mix (card only) → no kick.
    const suppressedDispatcher = createDrawerKickDispatcher({
      drawerEventsRepo: drawerRepo,
      transport: { kick: () => Promise.resolve({ ok: true as const }) },
      auditEmitter,
      logger,
      now: () => '2026-05-30T10:00:09.000Z',
      newDrawerEventId: () => 'de-suppressed',
    });
    await suppressedDispatcher.dispatchOnFirstPrintSuccess({
      ...CTX,
      sale_id: 'sale-t521-b',
      tender_lines_summary_json: JSON.stringify([
        { tender_type: 'external_card_terminal', amount_applied_minor: 5500 },
      ]),
      triggering_print_event_id: 'pe-1',
    });

    // failed: cash tender + a kick that reports a hardware failure.
    const failedDispatcher = createDrawerKickDispatcher({
      drawerEventsRepo: drawerRepo,
      transport: {
        kick: () =>
          Promise.resolve({ ok: false as const, failure_reason: 'printer_dk_failure' as const }),
      },
      auditEmitter,
      logger,
      now: () => '2026-05-30T10:00:10.000Z',
      newDrawerEventId: () => 'de-failed',
    });
    await failedDispatcher.dispatchOnFirstPrintSuccess({
      ...CTX,
      sale_id: 'sale-t521-c',
      tender_lines_summary_json: JSON.stringify([
        { tender_type: 'cash', amount_applied_minor: 5500 },
      ]),
      triggering_print_event_id: 'pe-1',
    });

    await flush();
    const text = read();
    // Non-vacuity: all three drawer outcomes logged through the captured stream.
    expect(text).toContain('sale.drawer.opened');
    expect(text).toContain('sale.drawer.suppressed');
    expect(text).toContain('sale.drawer.failed');
    assertPinoClean(text, [], 'drawer-paths');
  });

  // ── Positive control — proves the harness would CATCH a leak ──────────

  it('POSITIVE CONTROL: an injected forbidden key IS caught by the scanner', async () => {
    const { logger, read } = await makeRealLogger();
    const sentinel = 'LEAK-T521-POSITIVE-CONTROL-pan-value';
    // Simulate the failure T521 guards against: a contributor logs a raw
    // object carrying a forbidden field DEEPER than pino's redact paths reach
    // (depth 5 > the enumerated `*.*.*.key`), so the value survives the redact
    // pass and the scanner MUST flag it.
    logger.info({ a: { b: { c: { d: { pan: sentinel } } } } }, 't521:positive-control');
    await flush();
    const text = read();

    // The scanner must detect BOTH the surviving value AND the forbidden key.
    expect(text).toContain(sentinel); // confirms the leak genuinely survived redact at this depth
    const keys = new Set<string>();
    for (const rec of parseRecords(text)) collectKeys(rec, keys);
    expect(keys.has('pan')).toBe(true); // confirms the key-name scanner sees it

    // ...and assertPinoClean MUST throw on this input (the tripwire fires).
    expect(() => {
      assertPinoClean(text, [sentinel], 'positive-control');
    }).toThrow();
  });
});
