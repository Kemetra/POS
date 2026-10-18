import type { ElectronMainOptions, ErrorEvent, EventHint, IPCMode } from '@sentry/electron/main';

import { resolveObservabilityConfig } from './config.js';
import { scrubSentryEvent, type ObservabilityStamp, type SentryEventLike } from './scrub.js';

/**
 * Phase 9 / US7, reworked by RT-634 (OBS-5) — main-process Sentry init.
 *
 * Conforms to the OBS-1 observability contract (Confluence, RT-629):
 * errors only, default-inert, allowlisted fields only, never blocking.
 *
 *   - DSN / env / release come from `resolveObservabilityConfig` (runtime env
 *     of the launched exe, main only). No valid DSN → no `sentryInit` call
 *     and no egress (AC1).
 *   - `defaultIntegrations: false` + an explicit, reviewed list. NOTE:
 *     `integrations: []` alone does NOT disable the SDK defaults — the SDK
 *     merges `[...defaults, ...integrations]`, which would turn on native
 *     minidumps (raw process memory), main-process sessions, Electron/net/
 *     console breadcrumbs, local variables, context lines and screenshots.
 *     Minidumps and sessions are sent as their own envelopes and never pass
 *     through `beforeSend`, so they cannot be scrubbed: they stay off. A
 *     "crash" here is a JavaScript exception, not a native dump.
 *   - `ipcMode: Classic`. Main init runs inside `whenReady` (it needs the
 *     logger), and the SDK's default Protocol mode throws once the app is
 *     ready — it previously left a half-initialised client behind a
 *     swallowed warning. Classic registers listeners only; nothing in the
 *     preload exposes them, so the renderer reaches Sentry solely through the
 *     typed `app:report-error` bridge channel (see `renderer-error-report.ts`).
 *   - `maxBreadcrumbs: 0`, `sendDefaultPii: false`, no `tracesSampleRate`
 *     (contract §4: errors only), no client reports.
 *   - Offline (contract §5): the SDK's default Electron transport persists an
 *     envelope that fails to send and retries it later. The queue is bounded
 *     (`maxQueueSize` envelopes, `maxAgeDays`). `beforeSend` runs BEFORE the
 *     transport, so only allowlisted fields ever reach that disk queue.
 *     Capture is fire-and-forget: nothing on the sale path awaits Sentry.
 *
 * R9 DI seam: `sentryInit` and `integrations` are injected so tests never
 * touch the real SDK. R4: a throwing init logs one stable warning (never the
 * error text, which can echo the DSN) and the app continues.
 */

/** Contract §5 offline buffer bounds. */
export const OFFLINE_MAX_QUEUE_SIZE = 30;
export const OFFLINE_MAX_AGE_DAYS = 7;

/** The SDK's integration type (not exported by name from `@sentry/electron/main`). */
export type Integration = Extract<ElectronMainOptions['integrations'], unknown[]>[number];

/** `IPCMode.Classic`. The enum's runtime module loads `electron`, so it is typed only. */
const IPC_MODE_CLASSIC = 1 as IPCMode;

export type SentryInitFn = (options: ElectronMainOptions) => void;

export interface InitSentryMainLogger {
  warn(fields: Record<string, unknown>, msg: string): void;
}

/** The SDK integration factories the reviewed list is built from. */
export interface MainIntegrationFactories {
  onUncaughtExceptionIntegration(): Integration;
  onUnhandledRejectionIntegration(options: { mode: 'warn' }): Integration;
  linkedErrorsIntegration(): Integration;
  dedupeIntegration(): Integration;
}

export interface InitSentryMainOptions {
  /** R9 DI seam — `Sentry.init` in production. */
  sentryInit: SentryInitFn;
  /** The reviewed integration list; production passes `() => mainIntegrations(Sentry)`. */
  integrations: () => Integration[];
  /** Main-process logger; only `warn` is used. */
  logger: InitSentryMainLogger;
  /** `process.env` in production, a plain object in tests. */
  env: Record<string, string | undefined>;
}

export type SentryMainResult =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'initialized'; readonly stamp: ObservabilityStamp };

/**
 * The ONLY integrations main runs: capture of uncaught exceptions and
 * unhandled rejections (Electron's default behaviour is kept: a dialog for an
 * uncaught exception, a console warning for a rejection), cause chains, and
 * duplicate suppression. None of them reads requests, the DOM or the console.
 */
export function mainIntegrations(factories: MainIntegrationFactories): Integration[] {
  return [
    factories.onUncaughtExceptionIntegration(),
    factories.onUnhandledRejectionIntegration({ mode: 'warn' }),
    factories.linkedErrorsIntegration(),
    factories.dedupeIntegration(),
  ];
}

/** Initialise main-process Sentry. Never throws; never blocks boot. */
export function initSentryMain(opts: InitSentryMainOptions): SentryMainResult {
  const config = resolveObservabilityConfig(opts.env);
  if (config.kind === 'disabled') {
    if (config.reason !== 'unset') {
      opts.logger.warn({ reason: config.reason }, 'sentry:disabled');
    }
    return { kind: 'disabled' };
  }
  if (config.warnings.length > 0) {
    opts.logger.warn({ warnings: config.warnings }, 'sentry:stamp-defaulted');
  }

  const { stamp } = config;
  try {
    opts.sentryInit({
      dsn: config.dsn,
      environment: stamp.environment,
      release: stamp.release,
      // Deprecated in @sentry/electron 7.20 in favour of dataCollection, but
      // still the shipped, honoured setting.
      sendDefaultPii: false,
      defaultIntegrations: false,
      integrations: opts.integrations(),
      ipcMode: IPC_MODE_CLASSIC,
      maxBreadcrumbs: 0,
      sendClientReports: false,
      transportOptions: { maxQueueSize: OFFLINE_MAX_QUEUE_SIZE, maxAgeDays: OFFLINE_MAX_AGE_DAYS },
      beforeSend: (event) =>
        scrubSentryEvent(event as unknown as SentryEventLike, stamp) as ErrorEvent | null,
    });
  } catch {
    // Deliberately do NOT pass the underlying error to the logger — its
    // message can echo the DSN, which would land in the on-disk log.
    opts.logger.warn({ reason: 'init-threw' }, 'sentry:init-failed');
    return { kind: 'failed' };
  }
  return { kind: 'initialized', stamp };
}

/**
 * The allowlist scrubber without a release stamp (no tags leave the
 * process). Kept for the cross-process redaction suites; production's
 * `beforeSend` is the stamped closure inside `initSentryMain`.
 */
export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  void _hint;
  return scrubSentryEvent(event as unknown as SentryEventLike) as ErrorEvent | null;
}
