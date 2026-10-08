import path from 'path';
import pino, { type Logger } from 'pino';
import pinoRoll from 'pino-roll';

import { FORBIDDEN_PAYLOAD_KEYS } from '../../shared/audit/forbidden-keys.js';

/**
 * T060 — main-process logger.
 *
 * Wraps `pino` + `pino-roll` to produce JSON-per-line records under the
 * injected `logsDir`, rotated daily and retained for 14 days. Two
 * instances live in main: one tagged `process: 'main'` writing to
 * `main-YYYYMMDD.log`, one tagged `process: 'renderer'` writing to
 * `renderer-YYYYMMDD.log` (renderer logs flow over IPC; see
 * src/main/ipc/log.ts).
 *
 * SECURITY POLICY (Constitution VII + data-model.md § LogRecord):
 * Callers MUST NOT log secrets, tokens, plaintext credentials,
 * passwords, card data, PII, or any value retrieved from the
 * SecretStore. A redaction layer is deferred to a later feature; in
 * 001 enforcement is by code review.
 *
 * R9 mitigation: a `pinoRollFactory` is injectable so unit tests can
 * substitute a `PassThrough` stream and avoid touching the real
 * filesystem.
 *
 * R4 mitigation: if the rolling-stream factory throws (e.g.,
 * unwritable logs dir), we surface the error to console once and
 * return a degraded-but-functional pino instance writing to stderr,
 * so the app continues launching per spec.md:130.
 */

export type LogProcess = 'main' | 'renderer';

/**
 * Narrow surface of `pino-roll` we depend on. `pino-roll`'s default
 * export is async-factory: it returns a `WritableStream` (technically a
 * `SonicBoom` instance). The interface keeps tests free of the real lib.
 */
export type PinoRollFactory = (options: PinoRollFactoryOptions) => Promise<NodeJS.WritableStream>;

export interface PinoRollFactoryOptions {
  /** Filename prefix; pino-roll appends the date stamp + extension. */
  file: string;
  /** Rotation cadence. */
  frequency: 'daily';
  /** Date format for the rolled filename. */
  dateFormat: string;
  /** Filename extension. */
  extension: string;
  /** Retention policy. */
  limit: { count: number };
  /** Create the directory if it doesn't exist. */
  mkdir: boolean;
}

export interface CreateLoggerOptions {
  process: LogProcess;
  appVersion: string;
  /** Absolute path to the logs directory. Injected (R2 + R9). */
  logsDir: string;
  /**
   * Override the rolling-stream factory in tests. Defaults to the real
   * `pino-roll`.
   */
  pinoRollFactory?: PinoRollFactory;
}

const DEFAULT_LIMIT_DAYS = 14;
const DATE_FORMAT = 'yyyyMMdd';
const FILE_EXTENSION = '.log';

/**
 * 002-terminal-pairing T009a — base redaction list.
 *
 * Belt-and-braces scrubbing for known-secret field names that MUST never
 * appear in any log line, at any level, in any process (Constitution VII +
 * spec NFR-4 / FR-9 / FR-10). The schema-restricted `pairingLog` emitter
 * (US6, T058+) is the canonical path for pairing log records; this list
 * is the safety net for any non-pairing log line that happens to include
 * one of these key names.
 *
 * Coverage strategy: pino's `redact` supports `*` for exactly one path
 * segment, so we enumerate top-level + a small fixed depth of wildcard
 * segments. The cross-process redaction test (T062) is the load-bearing
 * guarantee — this list keeps the common case clean even if a future
 * contributor logs a request/response object directly.
 */
const PAIRING_REDACTED_KEYS = ['pairing_code', 'device_token'] as const;

/**
 * 004-operator-session T034 — operator-session redaction extensions.
 *
 * Belt-and-braces additions for the new operator-session credential
 * surface (PR-1 / FR-030). Cross-process redaction smoke (T025
 * extends 002's) is the load-bearing guarantee; this list keeps the
 * common case clean even if a future contributor logs a request /
 * response object directly.
 *
 * Coverage rationale: every key listed here MUST never appear in any
 * log line at any level in any process. The list grows as
 * later slices add more credential / token vocabulary (cashier PIN
 * material lands with S4; Clerk JWT and session-token keys are listed
 * already as defence-in-depth even though S1 does not log them).
 */
const OPERATOR_REDACTED_KEYS = [
  'password',
  'identifier',
  'pin',
  'jwt',
  'clerk_jwt',
  'clerk_session_token',
  'session_token',
  'authorization',
  'pin_hash',
  'pin_salt',
  // 016-operator-envelope-adoption (review MEDIUM) — the opaque pos_operator
  // ENVELOPE (#559) is an unstructured bearer secret held in the in-process
  // envelope holder and presented as `Authorization: Bearer <envelope>` on the
  // sale-sync POST. It is NEVER intentionally logged, but a future contributor
  // who logs a sign-in / takeover success object directly would otherwise emit
  // it cleartext. Scrub it at the logger layer for defence-in-depth (P7).
  'pos_operator_envelope',
] as const;

/**
 * 005-sales-cart T029 / NFR-006 — cart payload allowlist redaction.
 *
 * Defence-in-depth for cart payload fields that may carry free-text PII
 * (line `note`) or cashier-forbidden information (manager identity in
 * `attribution_operator_id`). The cart-bridge handlers and the audit
 * emitter are the load-bearing redaction layers; pino redaction is the
 * safety net for any future contributor logging a cart request/response
 * object directly.
 *
 * MUST NOT shrink. Adding a key here strictly tightens scrubbing.
 */
const CART_REDACTED_KEYS = ['note', 'attribution_operator_id', 'payload_json'] as const;

/**
 * 008-sale-finalization-and-receipts T093 / NFR — sale-event log redaction.
 *
 * The card-terminal `external_reference` is a legitimate audit-payload field
 * (substituted to `*****` in the audit row by `createSaleAuditEmitter`), but
 * a contributor who logs a `payment.settled` envelope or a request/response
 * object directly may inadvertently emit the cleartext to a pino sink. This
 * tuple scrubs it at the logger layer for defence-in-depth (Constitution
 * §P11 / §VII).
 *
 * MUST NOT shrink.
 */
const SALES_REDACTED_KEYS = ['external_reference'] as const;

/**
 * 004-operator-session T050 — audit-event payload defence-in-depth keys.
 *
 * The `FORBIDDEN_PAYLOAD_KEYS` list (from `shared/audit/forbidden-keys.ts`)
 * is the canonical name set the audit emitter refuses at insertion time
 * (FR-027 / PR-1). Mirroring it into the pino redaction list is defence
 * in depth: even if a future contributor logs a request / response object
 * containing one of these names somewhere outside the audit emitter
 * (e.g., a debug trace, a raw error body), the value is scrubbed.
 *
 * The merge below dedupes against the operator/pairing sets so we don't
 * generate duplicate path entries for keys that overlap (`pin`,
 * `password`, `clerk_jwt`, `clerk_session_token`, `pin_hash`,
 * `device_token`, `pairing_code`).
 */
const PRIOR_REDACTED_KEYS_SET = new Set<string>([
  ...PAIRING_REDACTED_KEYS,
  ...OPERATOR_REDACTED_KEYS,
  ...CART_REDACTED_KEYS,
  ...SALES_REDACTED_KEYS,
]);
const AUDIT_REDACTED_KEYS = FORBIDDEN_PAYLOAD_KEYS.filter(
  (key) => !PRIOR_REDACTED_KEYS_SET.has(key),
);

const ALL_REDACTED_KEYS = [
  ...PAIRING_REDACTED_KEYS,
  ...OPERATOR_REDACTED_KEYS,
  ...CART_REDACTED_KEYS,
  ...SALES_REDACTED_KEYS,
  ...AUDIT_REDACTED_KEYS,
] as const;
const REDACTION_PATHS: string[] = ALL_REDACTED_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `*.*.*.${key}`,
]);

/**
 * Create a structured logger writing JSON-per-line records to a
 * daily-rotating file under `opts.logsDir`. On stream-creation failure
 * (R4), returns a console-fallback logger so the app still launches.
 */
export async function createLogger(opts: CreateLoggerOptions): Promise<Logger> {
  // The default-factory branch fires only in production — tests inject
  // pinoRollFactory (R9). v8-ignore the right side of the nullish
  // coalesce to keep coverage honest about what's actually exercised.
  /* v8 ignore next */
  const factory = opts.pinoRollFactory ?? defaultPinoRollFactory;
  const filePrefix = path.join(opts.logsDir, `${opts.process}-`);

  const baseOptions: pino.LoggerOptions = {
    base: { process: opts.process, app_version: opts.appVersion },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Emit `"level":"warn"` instead of pino's default `"level":40`. Keeps
      // the on-disk shape readable without a translation table downstream.
      level(label) {
        return { level: label };
      },
    },
    level: 'info',
    // 002-terminal-pairing T009a: scrub known-secret keys at every reachable
    // depth in any structured payload. See PAIRING_REDACTED_KEYS above.
    redact: { paths: REDACTION_PATHS },
  };

  let stream: NodeJS.WritableStream;
  try {
    stream = await factory({
      file: filePrefix,
      frequency: 'daily',
      dateFormat: DATE_FORMAT,
      extension: FILE_EXTENSION,
      limit: { count: DEFAULT_LIMIT_DAYS },
      mkdir: true,
    });
  } catch (err) {
    // R4: log to console once, then return a stderr-backed pino. The
    // returned logger remains fully functional; the only loss is the
    // rotated file. We deliberately do NOT include the logsDir in
    // detail — paths are unlikely to leak secrets, but keeping error
    // text minimal aligns with the "stable error message" pattern from
    // Phase 5/7.
    console.error('[pos-pulse] logger: rolling-stream init failed; falling back to stderr.', err);
    return pino(baseOptions);
  }

  return pino(baseOptions, stream);
}

/**
 * RT-164 — wait until the logger's stream has written everything pending,
 * bounded by `timeoutMs`. Use before an immediate `app.exit()` that must not
 * lose its last line: the production stream (pino-roll → SonicBoom,
 * minLength 0) writes asynchronously, and `logger.flush(cb)` calls back at
 * once in that mode. SonicBoom emits `'drain'` when the pending writes finish.
 * Never rejects; resolves on drain or timeout, whichever comes first.
 */
export function waitForLogDrain(logger: Logger, timeoutMs: number): Promise<void> {
  const stream = (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] as
    | NodeJS.EventEmitter
    | undefined;
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      stream?.removeListener('drain', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    stream?.once('drain', done);
  });
}

/**
 * Default factory: the real `pino-roll`. Tests always inject a fake
 * factory (R9), so the body of this arrow is unreachable from unit
 * tests and is excluded from v8 coverage. Production correctness is
 * proven by the manual Electron smoke (T063): observing log files
 * appear at `app.getPath('logs')` after `npm run dev`.
 */
/* v8 ignore next 2 */
const defaultPinoRollFactory: PinoRollFactory = (opts) => pinoRoll(opts);
