import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron';
import * as Sentry from '@sentry/electron/main';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createSenderGuardedIpcMain } from './ipc/sender-guard.js';
import { createSessionLockGuardedIpcMain } from './ipc/session-lock-guard.js';
import { createSaleBoundaryIpcMain } from './ipc/sale-boundary-guard.js';
import { registerSessionLockHandlers } from './ipc/session-lock.js';
import { SessionUnlockHandler } from './operator/session-unlock-handler.js';
import { createLockStateReader, createSafePointProbe } from './operator/lock-state-reader.js';
import { wireSessionStatePush } from './operator/session-state-push.js';
import { wireSessionLockAudit } from './operator/session-lock-audit.js';
import { createSaleSyncTokenReader } from './operator/sale-sync-token.js';
import { SESSION_LOCK_IPC_CHANNELS } from '../shared/operator/channels.js';
import { registerPingHandler } from './ipc/ping.js';
import { registerAppVersionHandler } from './ipc/app-version.js';
import { registerLogHandler } from './ipc/log.js';
import { registerAppConfigHandler } from './ipc/app-config.js';
import { registerPairingHandlers } from './ipc/pairing.js';
import { registerOperatorHandlers } from './ipc/operator.js';
import { registerCartHandlers } from './ipc/cart.js';
import { createCartBridgeHandlers } from './cart/wire-cart-handlers.js';
// 009-product-search-and-barcode-lookup S4 (T043) — production R7 resolver.
import { createProductRepo } from './catalogue/product-repo.js';
import { createCatalogueResolver } from './catalogue/resolve-item-ref.js';
import { applyDevSeedCatalogueIfRequested } from './catalogue/dev-seed-catalogue.js';
// 010 read-down — catalogue bridge + freshness + driver wiring (#349 cleared:
// DP-2 backend contract deployed; T021 client + T039 driver now wired).
import { createCatalogueBridge } from './catalogue/catalogue-bridge.js';
import { createCatalogueSyncStateRepo } from './catalogue/catalogue-sync-state-repo.js';
import { createReadDownClient } from './catalogue/read-down/read-down-client.js';
import { createReadDownWriter } from './catalogue/read-down/read-down-writer.js';
import { createReadDownDriver } from './catalogue/read-down/read-down-driver.js';
import { registerCatalogueHandlers } from './ipc/catalogue.js';
import { registerPaymentsHandlers } from './ipc/payments.js';
import {
  bindAttemptHasLiveTender,
  bindCartPaymentStatus,
  bindPaymentAttemptsRepository,
} from './payments/repositories/payment-attempts.repository.js';
import { bindCartPaymentEligibility } from './payments/cart-payment-eligibility.js';
import { bindPaymentTenderLinesRepository } from './payments/repositories/payment-tender-lines.repository.js';
import { bindPaymentActionOutboxRepository } from './payments/repositories/payment-action-outbox.repository.js';
import { createPaymentAttemptFsm } from './payments/fsm/payment-attempt-fsm.js';
import { createTenderLineFsm } from './payments/fsm/tender-line-fsm.js';
import { createIdempotencyHelper } from './payments/idempotency.js';
import { createPaymentAuditEmitter, type PaymentAuditEvent } from './payments/audit-emitter.js';
import {
  bindCheckoutReturnAllowed,
  bindCheckoutReturnGuard,
} from './payments/checkout-return-guard.js';
import { createPaymentsStartHandler } from './payments/handlers/payments-start.js';
import { createPaymentsConfirmHandler } from './payments/handlers/payments-confirm.js';
import { createPaymentsCancelHandler } from './payments/handlers/payments-cancel.js';
import { createPaymentsForceFailHandler } from './payments/handlers/payments-force-fail.js';
import { createPaymentsSubscribeHandler } from './payments/handlers/payments-subscribe.js';
import { createPaymentsReadHandler } from './payments/handlers/payments-read.js';
import { createPaymentsDiscardOnSessionEndHandler } from './payments/handlers/payments-discard-on-session-end.js';
import { createStuckAttemptSweeper } from './payments/sweep-stuck-attempt.js';
import { createTenderApplyHandler } from './payments/handlers/tender-apply.js';
import { createTenderReverseHandler } from './payments/handlers/tender-reverse.js';
import { createTenderReadHandler } from './payments/handlers/tender-read.js';
import { createDeferredReversalResolver } from './payments/deferred-reversal-resolver.js';
import {
  reverseVoucher,
  type ReverseVoucherInput,
  type ReverseVoucherOutcome,
} from './payments/voucher-authority-client/reverse.js';
import type { ActionCategory as Audit004ActionCategory } from '../shared/audit/event-shape.js';
import type { OperatorSessionForPayments } from './payments/require-operator-session.js';
import { resolveSessionScope } from './operator/resolve-session-scope.js';
// 008-sale-finalization-and-receipts Slice 1c.3 (T094c) — AD-2 worker + sales.* bridge.
import { registerSalesHandlers } from './ipc/sales.js';
import { bindSalesRepository } from './sales/repositories/sales.repository.js';
import { bindPrintEventsRepository } from './sales/repositories/print-events.repository.js';
import { bindDrawerEventsRepository } from './sales/repositories/drawer-events.repository.js';
import { bindSaleSyncOutboxRepository } from './sync-outbox/sale-sync-outbox.repository.js';
// 011 sale-sync — S5 live HTTP client + engine + status IPC (#349 cleared).
import { createSaleSyncStateRepo } from './sales-sync/sale-sync-state-repo.js';
import {
  createSaleSyncEngine,
  logSaleSyncPauseTransition,
  SALE_SYNC_BACKOFF_POLICY,
} from './sales-sync/sale-sync-engine.js';
import { createSaleSyncStatusReader } from './sales-sync/sale-sync-status-reader.js';
import { createSellingUserIdResolver } from './sales-sync/selling-user-id.js';
import { createSaleSyncDeviceTokenReader } from './sales-sync/sale-sync-device-token.js';
import { createCurrentTerminalResolver } from './sales-sync/current-terminal.js';
import {
  createPairedWorkers,
  withPairedNotification,
  type PairedWorkers,
} from './app/paired-workers.js';
import { parseTendersSince } from './sales-sync/capture-payload.js';
import { createSaleSyncClient } from './sales-sync/create-sale-sync-client.js';
import { registerSalesSyncHandlers } from './ipc/sales-sync.js';
import { registerReturnsHandlers } from './ipc/returns.js';
import { composeReturns, scheduleReturnsResolver } from './returns/compose-returns.js';
import { bindSaleNumberAllocator } from './sales/sale-number-allocator.js';
import { createSaleAuditEmitter, type SaleAuditEvent } from './sales/audit-emitter.js';
import { bindFinalizeTransaction } from './sales/finalize-transaction.js';
import { buildFinalizeInput } from './sales/finalize-dispatch.js';
import { createFinalizeListener } from './sales/finalize-listener.js';
import { createSalesBridge, type OperatorSessionForSales } from './sales/sales-bridge.js';
import { bindBannerStateProjector } from './sales/banner-state-projector.js';
import { createReceiptsBridge } from './receipts/receipts-bridge.js';
import { registerReceiptsHandlers } from './ipc/receipts.js';
import { createPrintPipeline } from './receipts/print-pipeline.js';
import { createEscposAdapter } from './receipts/escpos-adapter.js';
import { createOsPrintAdapter } from './receipts/os-print-adapter.js';
import {
  createOsPrintTransport,
  createDefaultPrintWindow,
  type PrinterInfoLike,
} from './receipts/os-print-transport.js';
import { createPrintDispatcher } from './receipts/print-dispatcher.js';
import { dispatchFirstPrintOnFinalize } from './receipts/dispatch-first-print-on-finalize.js';
import { createDrawerKickDispatcher } from './drawer/drawer-kick.js';
import type { DrawerKickTransport } from './drawer/drawer-kick-transport.js';
import { randomUUID } from 'node:crypto';
import { createWorkerRegistry } from './app/bootstrap-workers.js';
import { createWindowFactory } from './app/bootstrap-window.js';
import { createDatabaseHolder } from './app/bootstrap-db.js';
import {
  assessCashierProfile,
  describeCashierProfileRefusal,
  parseFeatureFlags,
} from './app/feature-flags.js';
import { assessLaunchSwitches } from './app/launch-switch-guard.js';
import { isShippedApp } from './app/shipped-app.js';
import { acquireSingleInstance, restoreAndFocus } from './app/single-instance.js';
import { openDatabase } from './db/client.js';
import { bindMigrationsDb, readMigrationsFromDisk, runMigrations } from './db/migrate.js';
import { createSecretStore } from './secrets/index.js';
import { createLogger, waitForLogDrain } from './logging/logger.js';
import { initSentryMain } from './observability/sentry-main.js';
import { bindPairingStoreDb, createPairingStore } from './pairing/store.js';
import { applyDevSkipPairingIfRequested } from './pairing/dev-skip-pairing.js';
import { applyDevSkipOperatorSignInIfRequested } from './operator/dev-skip-operator-signin.js';
import { AuditEmitter } from './audit/audit-emitter.js';
import { bindAuditEventsStoreDb } from './audit/audit-events-store.js';
import { createNetwork } from './pairing/network.js';
import { createPairingService } from './pairing/service.js';
import { createPairingLog } from './pairing/log.js';
import {
  createClerkExchanger,
  decodeFrontendApiBaseUrl,
  type ClerkExchanger,
} from './operator/clerk-client.js';
import { createBackendClient } from './operator/backend-client.js';
import { SessionManager } from './operator/session-manager.js';
import { CashierSignInHandler, SignInHandler } from './operator/sign-in-handler.js';
import { SignOutHandler } from './operator/sign-out-handler.js';
import { createCashierAdmissionClient } from './operator/cashier-admission-client.js';
import {
  NOOP_OFFLINE_GRANT_SEAM,
  type CashierAdmissionDeps,
} from './operator/cashier-admission.js';
import { CashierAdmissionKeeper } from './operator/cashier-admission-keeper.js';
import { RosterHandler } from './operator/roster-handler.js';
import { InactivityMonitor } from './operator/inactivity-monitor.js';
import { LifecycleCascade } from './operator/lifecycle-cascade.js';
import { createJwtHolder } from './operator/jwt-holder.js';
import { ProtoSessionStore, TakeoverHandler } from './operator/takeover-handler.js';
import { PinManagementHandler } from './operator/pin-management.js';
import { ForcedCloseHandler } from './operator/forced-close-handler.js';
import { StuckShiftsHandler } from './operator/stuck-shifts-handler.js';
import { makeSecretKey } from '../shared/secret-store.js';
import type { AppConfig } from '../shared/app-config.js';

/**
 * RT-203 — ONE POS process per terminal. Taken FIRST, before anything else in
 * main is built.
 *
 * A second launch does not get the lock: it quits right here and never opens
 * the database, runs migrations, starts a worker, registers IPC, builds the
 * printer/drawer ports or creates a window. The whole boot below is chained on
 * `singleInstanceReady`, which is `null` for that process.
 *
 * The process-local single-flight structures depend on this lock: sale sync,
 * the catalogue read-down, the finalize listener, the payments deferred-reversal
 * resolver, the returns resolver/dispatcher (and the returns payout), the drawer
 * double-kick guard and printer access. See `app/single-instance.ts` and
 * `docs/architecture/current.md` §3.
 *
 * On a second launch the running instance restores and focuses its cashier
 * window: the tracked `mainWindow`, never "any window" (the hidden offscreen
 * print window is a BrowserWindow too).
 */
let mainWindow: BrowserWindow | undefined;
const singleInstanceReady = acquireSingleInstance(app, () => {
  restoreAndFocus(mainWindow);
});

/**
 * 002-terminal-pairing US2: API base URL for the pair endpoint. Reads
 * `VITE_API_BASE_URL` from `process.env` (Vite does NOT prefix-filter
 * the main bundle — main is built with tsc, not Vite). Falls back to
 * a non-routable placeholder when unset.
 *
 * Public hardening: source must not publish live environment endpoints.
 * Configure the real Data-Pulse-2 host per environment via `VITE_API_BASE_URL`;
 * the default intentionally fails closed.
 */
const DEFAULT_API_BASE_URL = 'https://example.invalid';

function resolveApiBaseUrl(): string {
  const fromEnv = process.env['VITE_API_BASE_URL'];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv;
  return DEFAULT_API_BASE_URL;
}

/**
 * 002-terminal-pairing US1: SecretStore key under which the device
 * token is held. Single source of truth — re-used by the pairing store
 * here AND any future feature that reads the token to set
 * `X-Terminal-Token` on backend calls.
 */
const DEVICE_TOKEN_KEY = makeSecretKey('terminal.device-token');

/**
 * 004-operator-session — resolve the production `ClerkExchanger`.
 *
 * Decodes the Clerk Frontend API host from `CLERK_PUBLISHABLE_KEY`.
 * When unset or malformed, returns a stub that always refuses so the
 * app still launches in dev without a Clerk tenant configured (the
 * `/sign-in` route renders; submit fails with the generic
 * `invalid_input` refusal). CI / production builds set the key.
 *
 * The publishable key itself is NOT a secret — it identifies the
 * Clerk instance for client-side use.
 */
function resolveClerkExchanger(logger: {
  warn(payload: object, msg: string): void;
}): ClerkExchanger {
  const pk = process.env['CLERK_PUBLISHABLE_KEY'];
  if (typeof pk !== 'string' || pk.length === 0) {
    logger.warn(
      { event: 'operator.clerk.missing_publishable_key' },
      'CLERK_PUBLISHABLE_KEY unset; sign-in will refuse generically until configured.',
    );
    return { exchange: () => Promise.resolve({ kind: 'refused' as const }) };
  }
  const fapi = decodeFrontendApiBaseUrl(pk);
  if (fapi === null) {
    logger.warn(
      { event: 'operator.clerk.malformed_publishable_key' },
      'CLERK_PUBLISHABLE_KEY malformed; sign-in will refuse generically until corrected.',
    );
    return { exchange: () => Promise.resolve({ kind: 'refused' as const }) };
  }
  return createClerkExchanger({
    frontendApiBaseUrl: fapi,
    fetch: globalThis.fetch.bind(globalThis),
  });
}

// __dirname is a CJS global; ESM (NodeNext output) requires this polyfill.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env['NODE_ENV'] === 'development';

/**
 * RT-165 — the trusted shipped-app identity. Every dev/production security
 * decision below (dev bypasses, SecretStore refusal, migrations source) keys
 * on this, never on `app.isPackaged` alone: a renamed copy of the shipped exe
 * reports `isPackaged === false` but still runs the shipped `app.asar`.
 */
const shippedApp = isShippedApp({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
});

/** RT-164 — longest a refused launch waits for its log line to reach disk. */
const LAUNCH_REFUSAL_LOG_DRAIN_MS = 2000;

/**
 * The trusted renderer origin allow-list. Dev = the Vite server; prod = the
 * packaged renderer dir on disk (`pathToFileURL` → a normalized `file://` URL,
 * forward slashes on Windows). SINGLE SOURCE OF TRUTH (#370): consumed by BOTH
 * the `will-navigate` block in `createWindow` AND the IPC `createSenderGuardedIpcMain`
 * wiring in `whenReady`, so the navigation check and the IPC sender check can
 * never drift apart.
 */
function resolveRendererOrigin(): string {
  return isDev
    ? 'http://localhost:5173'
    : pathToFileURL(path.join(__dirname, '../renderer/')).toString();
}

/**
 * Window construction and the renderer trust boundary now live in
 * `app/bootstrap-window.ts` (021 S3). The security policy is unchanged — it
 * moved verbatim — but it is now independently testable without launching a
 * real BrowserWindow. `resolveRendererOrigin` is INJECTED rather than moved so
 * it stays the single source of truth (#370) shared with the IPC sender guard
 * wired in `whenReady`.
 */
const buildMainWindow = createWindowFactory({
  isDev,
  BrowserWindow,
  session,
  resolveRendererOrigin,
  preloadPath: path.join(__dirname, '../preload/index.js'),
  rendererFilePath: path.join(__dirname, '../renderer/index.html'),
  devServerUrl: 'http://localhost:5173',
});

/** Build the cashier window and track it as the RT-203 focus target. */
const createWindow = (): void => {
  mainWindow = buildMainWindow();
};

/**
 * Enumerate the system printers via a live window's webContents
 * (`getPrintersAsync` is a webContents method). Returns `[]` if no window is
 * available yet — the OS-print transport then resolves an empty device name and
 * Electron falls back to the system default printer. Wrapped so a discovery
 * failure never throws into the print path (the print still attempts the
 * default printer; a real fault surfaces as a recorded failure + banner).
 */
async function getCurrentPrinters(): Promise<PrinterInfoLike[]> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win === undefined) return [];
  try {
    const printers = await win.webContents.getPrintersAsync();
    // Electron 40's PrinterInfo carries no portable `isDefault` flag (the
    // default lives in platform-specific `options`). We do NOT try to infer it
    // here: when no device is configured, the transport resolves an empty
    // deviceName and Electron's silent-print path picks the system default
    // itself. The list is surfaced only so a CONFIGURED exact name can be
    // honored / logged.
    return printers.map((p) => ({ name: p.name, isDefault: false }));
  } catch {
    return [];
  }
}

/**
 * Resolve the directory where migration *.sql files live.
 *   - Dev (`npm run dev`): repo-root `./migrations` (cwd is the repo root).
 *   - Packaged: bundled into the app via electron-builder `files: [migrations/**]`,
 *     so they sit at `<app.getAppPath()>/migrations` (inside `app.asar`; the
 *     builder-patched `fs` reads them transparently). Using cwd here crashes the
 *     packaged exe (cwd is wherever the user launched it, not the repo).
 *   - RT-165: keyed on `shippedApp`, so a renamed shipped exe also reads the
 *     bundled migrations, never `*.sql` from whatever directory it ran in.
 */
function resolveMigrationsDir(): string {
  return shippedApp
    ? path.join(app.getAppPath(), 'migrations')
    : path.join(process.cwd(), 'migrations');
}

/**
 * 021 S2 — process-lifetime DB handle OWNERSHIP.
 *
 * Opened once in `app.whenReady()`, used by the migration runner and the
 * SecretStore, closed on app quit (R9). Accessed only from the main process —
 * never exposed to the renderer.
 *
 * The handle lives in a holder rather than a module-scope `let` so the
 * shutdown path (which runs outside `whenReady()`) can reach it while every
 * in-`whenReady()` consumer uses a plain local `const db`. Close ordering,
 * failure isolation, and idempotency are owned by the holder.
 */
const dbHolder = createDatabaseHolder({ logger: console });

/**
 * 021 S1 — process-lifetime background-worker teardown.
 *
 * Owns the stop callbacks for the 008 finalize listener, the 010 read-down
 * driver, and the 011 sale-sync interval: fixed stop ordering, failure
 * isolation, and idempotency all live in `app/bootstrap-workers.ts`.
 *
 * Construction stays below, inside the branches that gate each worker (the
 * `sale_finalization` flag; the paired-terminal branch), so a worker that is
 * never started is never registered and `stopAll()` has nothing to stop for it.
 * `closeDbHandle()` drains this registry BEFORE closing the DB handle, so a
 * mid-flight background tick can never run against a closed handle.
 */
const workerRegistry = createWorkerRegistry({ logger: console });

/**
 * RT-202 — once-latch for the paired-only workers (read-down driver, finalize
 * listener, sale-sync engine). Built inside `whenReady` (it needs the main
 * logger); held here so `closeDbHandle()` can refuse a late start — a pairing
 * that completes while the app is quitting must not build a worker against a DB
 * handle that is about to close.
 */
let pairedWorkers: PairedWorkers | undefined;

singleInstanceReady
  ?.then(async () => {
    // T062 — initialize loggers FIRST inside whenReady, before any
    // other subsystem. `app.getPath('logs')` is only available after
    // `whenReady` fires, so this is the earliest possible site.
    // Two pino instances: one tagged `process: 'main'` writes to
    // main-YYYYMMDD.log; one tagged `process: 'renderer'` writes to
    // renderer-YYYYMMDD.log (records arrive via the app:log IPC).
    const logsDir = app.getPath('logs');
    const appVersion = app.getVersion();
    const mainLogger = await createLogger({
      process: 'main',
      appVersion,
      logsDir,
    });
    const rendererLogger = await createLogger({
      process: 'renderer',
      appVersion,
      logsDir,
    });
    mainLogger.info({ logsDir, appVersion }, 'app:logger-ready');

    // RT-164 — a PACKAGED build refuses debugging switches (`--remote-debugging-*`
    // has no Electron fuse; `--inspect*` is refused here as well as by the fuse).
    // Checked as early as logging allows: before Sentry, the DB, any IPC
    // handler or any window. Only switch NAMES are logged, never their values.
    // pino-roll writes asynchronously and `flush()` does not wait for it, so the
    // exit waits for the stream to drain (bounded) or the line is lost.
    const launchSwitches = assessLaunchSwitches({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      argv: process.argv,
      hasSwitch: (name) => app.commandLine.hasSwitch(name),
    });
    if (!launchSwitches.ok) {
      mainLogger.error(
        { reason: launchSwitches.reason, switches: launchSwitches.switches },
        'app:debug_switch_refused',
      );
      await waitForLogDrain(mainLogger, LAUNCH_REFUSAL_LOG_DRAIN_MS);
      app.exit(1);
      return;
    }

    // T068 — initialise Sentry AFTER the main logger is up but BEFORE
    // migrations / window creation. Sentry's `init` is wrapped in
    // try/catch inside `initSentryMain`; a thrown init logs one warn
    // line via `mainLogger` and the app continues. With `SENTRY_DSN`
    // unset (the default in `.env.example`), Sentry stays inert — no
    // network calls, no crashes (AS-8).
    initSentryMain({
      sentryInit: Sentry.init,
      logger: mainLogger,
      env: process.env,
      appVersion,
    });

    // RT-162 (RT-160 FU-1 / owner decision D-1) — fail-closed cashier profile.
    // PAYMENTS on with SALE_FINALIZATION off would settle money with no Sale
    // row, receipt, outbox entry or Backend-Core capture, so it is refused HERE,
    // in trusted main, before the DB opens, before any payment IPC is
    // registered and before the window exists. The dialog is the ASYNC
    // showMessageBox, not showErrorBox: the synchronous one blocks the event
    // loop, and the packaged build showed the async pino write of this log line
    // stalling behind it. We exit explicitly once the dialog closes: without a
    // window, `window-all-closed` never fires and the process would linger.
    const startupFeatureFlags = parseFeatureFlags(process.env);
    const cashierProfile = assessCashierProfile(startupFeatureFlags);
    if (!cashierProfile.ok) {
      mainLogger.error(
        { reason: cashierProfile.reason, features: startupFeatureFlags },
        'app:cashier_profile_refused',
      );
      const refusal = describeCashierProfileRefusal(cashierProfile.reason);
      const exitRefused = (): void => {
        app.exit(1);
      };
      void dialog
        .showMessageBox({ type: 'error', title: refusal.title, message: refusal.body })
        .then(exitRefused, exitRefused);
      return;
    }

    // T040 + R9 — open ONE shared DB handle, run migrations, then keep
    // the handle alive for the SecretStore. Failure during migrations
    // rethrows into the .catch below, which calls app.exit(1).
    const dbPath = path.join(app.getPath('userData'), 'pos-pulse.db');
    const db = openDatabase(dbPath);
    dbHolder.set(db);
    mainLogger.info({ dbPath }, 'db:opened');

    const files = readMigrationsFromDisk(resolveMigrationsDir());
    runMigrations({ db: bindMigrationsDb(db), files });
    mainLogger.info({ count: files.length }, 'db:migrations-applied');

    // 009 T049b — dev-only catalogue fixture seed. Fail-closed: no-op in the
    // shipped app (the env var is never consulted there; RT-165) and unless
    // POS_PULSE_DEV_SEED_CATALOGUE is truthy. Lets the live T049a surface +
    // S5 review tasks exercise real rows. Meant to run alongside the
    // POS_PULSE_DEV_SKIP_* flags (same dev-tenant).
    applyDevSeedCatalogueIfRequested({
      isPackaged: shippedApp,
      env: process.env,
      db: db,
      logger: mainLogger,
    });

    // T048 wire-in: construct the SecretStore on the same long-lived
    // handle to validate factory wiring (production refusal will throw
    // into .catch below per R8). 002 US1 retains the reference because
    // the pairing store now consumes it.
    const secretStore = createSecretStore({
      handle: db,
      safeStorage,
      isPackaged: shippedApp,
    });
    // Note (Phase 5 R8): SecretStore still uses console.warn/error
    // placeholders. Swap to mainLogger is a deferred follow-up — out
    // of Phase 8 scope.

    // 002-terminal-pairing T011/T013 — construct the pairing store on
    // the shared DB handle + SecretStore. The store is the only module
    // that touches both halves of pairing state.
    const pairingStore = createPairingStore({
      secretStore,
      db: bindPairingStoreDb(db),
      deviceTokenKey: DEVICE_TOKEN_KEY,
    });

    // 002-terminal-pairing dev bypass — seeds fixture pairing state so the
    // renderer routes past /pairing in unpackaged dev builds.
    // SECURITY: the shipped-app guard is inside applyDevSkipPairingIfRequested;
    // this call is a no-op in the shipped app (renamed exe included, RT-165)
    // regardless of env vars.
    await applyDevSkipPairingIfRequested({
      isPackaged: shippedApp,
      env: process.env,
      pairingStore,
      logger: mainLogger,
    });

    // 002-terminal-pairing T021/T023/T025 — construct the pairing
    // service. The service composes network.pair() + pairingStore.persist()
    // + a schema-restricted pairingLog. Resolve-on-reachable, reject-only-
    // on-transport network contract is locked from PR #17. The IPC
    // handler below routes `pairing:submit` here.
    const pairingNetwork = createNetwork({
      fetch: globalThis.fetch.bind(globalThis),
      baseUrl: resolveApiBaseUrl(),
    });
    // RT-202 — pairing happens in the renderer WITHOUT a process relaunch, so the
    // paired-only workers cannot be bound only at boot. They register a starter
    // with this latch (at the sites below); it fires at boot when already paired
    // and, for a first-run terminal, right after the pairing is persisted.
    const pairedWorkersLatch = createPairedWorkers({ logger: mainLogger });
    pairedWorkers = pairedWorkersLatch;
    // Re-read the scope from the pairing store (not from the submit result) so the
    // workers bind the SAME terminal_id payments writes (#380 / F-007 lockstep).
    const notifyPairedFromStore = async (): Promise<void> => {
      try {
        const status = await pairingStore.getStatus();
        if (status.kind !== 'paired') return;
        pairedWorkersLatch.notifyPaired({
          tenant_id: status.tenant_id,
          branch_id: status.branch_id,
          terminal_id: status.terminal_id,
        });
      } catch (err) {
        mainLogger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'paired_workers:notify_failed',
        );
      }
    };
    // The ONLY pairing service handed to the IPC handler is the wrapped one, so a
    // successful in-process pairing always notifies the latch. `src/main/pairing/`
    // itself is unchanged.
    const pairingService = withPairedNotification(
      createPairingService({
        store: pairingStore,
        network: pairingNetwork,
        pairingLog: createPairingLog(mainLogger),
        clock: () => new Date(),
      }),
      notifyPairedFromStore,
    );

    // #370 (LOW hardening) — wrap ipcMain ONCE so every handler is sender-origin
    // guarded (defense-in-depth on the renderer→main trust boundary). Uses the
    // SAME `resolveRendererOrigin()` the `will-navigate` allow-list uses, so the
    // navigation check and the IPC check cannot drift. Every `register…` below
    // receives the guarded instance — zero registrar edits (they take IpcMain).
    // RT-117 (RT-116 §2.5) — wrap ONCE more so every handler is refused while
    // the operator session is LOCKED unless its channel is on the allowlist.
    // The session manager is built below; bind the probe to it there.
    const sessionLockProbe: { isLocked: () => boolean } = { isLocked: () => false };
    // RT-113 P2 — after EVERY cart/payments/tender call, re-check whether a
    // session that lost its authority has reached its safe point (one choke
    // point; bound to the keeper once it is built below).
    const saleBoundaryProbe: { recheck: () => void } = { recheck: () => undefined };
    const guardedIpcMain = createSaleBoundaryIpcMain(
      createSessionLockGuardedIpcMain(
        createSenderGuardedIpcMain(ipcMain, resolveRendererOrigin()),
        () => sessionLockProbe.isLocked(),
      ),
      () => {
        saleBoundaryProbe.recheck();
      },
    );

    // Register IPC handlers BEFORE the first window loads so the renderer's
    // first call cannot race the registration.
    registerPingHandler(guardedIpcMain);
    registerAppVersionHandler(guardedIpcMain);
    registerLogHandler(guardedIpcMain, rendererLogger);
    // T067 + D3 — renderer pulls its DSN over the bridge; never via
    // `import.meta.env.VITE_*` (which would inline it into the
    // renderer bundle at build time). The closure resolves the DSN
    // per-call, so a future restart-free DSN rotation works without
    // re-architecting the handler.
    const getAppConfig = (): AppConfig => {
      const cfg: AppConfig = {};
      const dsn = process.env['SENTRY_DSN'];
      if (typeof dsn === 'string' && dsn.trim().length > 0) {
        cfg.sentryDsn = dsn;
      }
      // 005 cart / 006 payments / 008 saleFinalization / 009 productSearch /
      // RT-103 voucherTender / RT-15 returns — all six flags default false (fail-closed).
      // RT-162: parsing lives in `app/feature-flags.ts` (one truthy parser,
      // unchanged semantics). Re-parsed per call, as before; the PAYMENTS-
      // without-SALE_FINALIZATION profile never reaches here (refused at startup).
      cfg.features = parseFeatureFlags(process.env);
      return cfg;
    };
    registerAppConfigHandler(guardedIpcMain, getAppConfig);

    // 002-terminal-pairing T013 + T025 — wire BOTH pairing channels.
    // T025 lands `pairing:submit`; the SUBMIT handler validates the
    // argument shape and forwards the service result unchanged.
    registerPairingHandlers(guardedIpcMain, { store: pairingStore, service: pairingService });

    // 004-operator-session — wire `operator.*` IPC.
    //
    // Clerk credential exchange happens HERE in the main process; the
    // password NEVER reaches Data-Pulse-2 (Wave 1 path b / AD-2 /
    // Constitution v1.5.1). The Clerk Frontend API host is decoded
    // from the publishable key (`CLERK_PUBLISHABLE_KEY` env var). If
    // the key is unset or malformed in dev, we wire a stub exchanger
    // that always refuses — the app still launches and `/sign-in` is
    // reachable, but submit fails with the generic refusal copy. CI
    // and production builds set the key; the stub is dev-only.
    const operatorJwtHolder = createJwtHolder();
    // 016 (review HIGH) — the SECOND credential seam. DP-2 splits POS auth:
    //   • operatorJwtHolder holds the provider JWT (`operator-identity`) for
    //     sign-out + stuck-shifts + the takeover/confirm CALL (028 §6 CM-1).
    //   • operatorEnvelopeHolder holds the opaque pos_operator ENVELOPE (#559,
    //     `operatorAuthorization`) read ONLY by the sale-sync getOperatorToken
    //     closures. Keyed on backend_session_id, in-process only, never bridged.
    const operatorEnvelopeHolder = createJwtHolder();
    const operatorSessionManager = new SessionManager();
    sessionLockProbe.isLocked = () => operatorSessionManager.isLocked();
    const apiBaseUrl = resolveApiBaseUrl();
    const operatorBackend = createBackendClient({
      baseUrl: apiBaseUrl,
      fetch: globalThis.fetch.bind(globalThis),
    });
    const operatorProtoStore = new ProtoSessionStore();
    const clerkExchanger = resolveClerkExchanger(mainLogger);
    const deviceTokenAttestation = async (): Promise<string> => {
      const status = await pairingStore.getStatus();
      if (status.kind !== 'paired') return '';
      const token = await secretStore.get(DEVICE_TOKEN_KEY);
      return token ?? '';
    };
    const operatorSignInHandler = new SignInHandler({
      clerk: clerkExchanger,
      backend: operatorBackend,
      sessionManager: operatorSessionManager,
      // 016 (review HIGH): JWT → operator-identity holder; envelope → sale-sync holder.
      jwtHolder: operatorJwtHolder,
      envelopeHolder: operatorEnvelopeHolder,
      protoStore: operatorProtoStore,
      // Wave 1: device-token attestation = the device token itself
      // (read from SecretStore via the pairingStore). The backend
      // verifies it server-side. The token is NEVER logged.
      deviceTokenAttestation,
      logger: mainLogger,
    });
    // T051b + T051d — lifecycle cascade for terminal-revocation (FR-014) and
    // account-disabled-mid-session. RT-113 P2 wires one caller: a device 401 on
    // a cashier sign-in or takeover (RT-138 L6 / 10763 D8; a no-op without a
    // session). The heartbeat ends at the safe point instead (review F1). It is
    // NOT exposed to the renderer bridge.
    const operatorLifecycleCascade = new LifecycleCascade({
      sessionManager: operatorSessionManager,
      logger: mainLogger,
    });

    // RT-113 P2 (10763 D2/D11, owner decision 10844; fixes RT-182) — the
    // cashier path's server authority: the device-authenticated Backend-Core
    // cashier-admissions resource. Device token as the bearer, read in-process
    // per call; never logged, never bridged. No Clerk-gated call remains on
    // the cashier path.
    const cashierAdmissionClient = createCashierAdmissionClient({
      baseUrl: apiBaseUrl,
      fetch: globalThis.fetch.bind(globalThis),
      getDeviceToken: async () => {
        const status = await pairingStore.getStatus();
        if (status.kind !== 'paired') return null;
        return (await secretStore.get(DEVICE_TOKEN_KEY)) ?? null;
      },
    });
    const cashierAdmission: CashierAdmissionDeps = {
      client: cashierAdmissionClient,
      // P1 SEAM — RT113-P1 replaces this with the sealed offline grant store.
      grantSeam: NOOP_OFFLINE_GRANT_SEAM,
      onDeviceRevoked: () => {
        operatorLifecycleCascade.notifyTerminalRevoked();
      },
    };
    const operatorCashierSignInHandler = new CashierSignInHandler({
      db: db,
      safeStorage,
      sessionManager: operatorSessionManager,
      admission: cashierAdmission,
      pairingStore,
      protoStore: operatorProtoStore,
      secretStore,
      logger: mainLogger,
    });
    const operatorSignOutHandler = new SignOutHandler({
      backend: operatorBackend,
      sessionManager: operatorSessionManager,
      // 016 (review HIGH): sign-out is an `operator-identity` route — present the
      // provider JWT from the JWT holder, NOT the sale-sync envelope.
      jwtFor: (sessionId) => operatorJwtHolder.get(sessionId),
      // Sign-out teardown clears BOTH credential seams for the ended session so
      // neither the JWT nor the envelope lingers in main-process memory (P7).
      clearJwt: (sessionId) => {
        operatorJwtHolder.clear(sessionId);
        operatorEnvelopeHolder.clear(sessionId);
      },
      logger: mainLogger,
    });
    const operatorRosterHandler = new RosterHandler({
      cashierAdmissions: cashierAdmissionClient,
      logger: mainLogger,
    });
    const operatorInactivityMonitor = new InactivityMonitor({
      sessionManager: operatorSessionManager,
      // RT-117 — a lock leaves a log line (RT-112: a timeout left none).
      logger: mainLogger,
    });
    operatorInactivityMonitor.start();

    // T048 — construct the audit-events outbox chain on the shared DB handle.
    // Lazy statement preparation in bindAuditEventsStoreDb ensures migration
    // T045 has already run before the first emit call.
    const auditEventsStore = bindAuditEventsStoreDb(db);
    const auditEmitter = new AuditEmitter(auditEventsStore);

    // RT-117 (RT-116 S1) — inactivity LOCK of the existing session.
    //   • push: main tells the renderer the moment the session locks/unlocks/
    //     ends (state only — no ids, names or credentials);
    //   • audit: operator.session.locked / operator.session.unlocked;
    //   • IPC: same-operator unlock + the lock-screen totals read (both on the
    //     locked-session allowlist).
    wireSessionStatePush({
      sessionManager: operatorSessionManager,
      send: (event) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(SESSION_LOCK_IPC_CHANNELS.SESSION_STATE, event);
        }
      },
      logError: (err) => {
        mainLogger.error({ err }, 'operator.session_state_push:failed');
      },
    });
    wireSessionLockAudit({
      sessionManager: operatorSessionManager,
      auditEmitter,
      resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
      uuid: () => randomUUID(),
      logError: (err) => {
        mainLogger.error({ err }, 'operator.session_lock_audit:failed');
      },
    });
    const getOperatorLockState = createLockStateReader({
      db,
      sessionManager: operatorSessionManager,
      resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
    });
    registerSessionLockHandlers(guardedIpcMain, {
      unlockHandler: new SessionUnlockHandler({
        sessionManager: operatorSessionManager,
        verifyCashierPin: (operator_id, pin) =>
          operatorCashierSignInHandler.verifyPin(operator_id, pin),
        clerk: clerkExchanger,
        logger: mainLogger,
      }),
      getLockState: getOperatorLockState,
    });

    // RT-113 P2 — keep the online cashier admission live (heartbeat at ≤ TTL/2
    // with a fresh key) and end it on sign-out / session end (best-effort).
    // Lost authority (taken over elsewhere, 403, two consecutive device 401s)
    // latches the session (cart.create, and an add to an empty cart, refuse
    // `authority_conflict`) and ends
    // it at its first safe point: no open sale with lines (the RT-117 lock
    // summary is null) and no live tender on ANY cart of the session
    // (`createSafePointProbe`, review of 024f07c items 2 and 5).
    // Re-checked after every sale IPC call (sale-boundary-guard), on lock
    // changes and by a backstop poll. Stopped on quit with the other workers (RT-198
    // latch: nothing runs after stop).
    const isCashierAtSafePoint = createSafePointProbe({
      db,
      sessionManager: operatorSessionManager,
      resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
    });
    const cashierAdmissionKeeper = new CashierAdmissionKeeper({
      sessionManager: operatorSessionManager,
      admission: cashierAdmission,
      isAtSafePoint: isCashierAtSafePoint,
      logger: mainLogger,
    });
    saleBoundaryProbe.recheck = () => {
      cashierAdmissionKeeper.recheckSafePoint();
    };
    workerRegistry.register('cashier admission heartbeat', () => {
      cashierAdmissionKeeper.stop();
    });

    const operatorTakeoverHandler = new TakeoverHandler({
      protoStore: operatorProtoStore,
      sessionManager: operatorSessionManager,
      backend: operatorBackend,
      // 016 (review HIGH): the confirm CALL uses proto.jwt; jwtHolder keeps the
      // new operator's JWT (operator-identity); envelopeHolder gets the sale-sync envelope.
      jwtHolder: operatorJwtHolder,
      envelopeHolder: operatorEnvelopeHolder,
      auditEmitter,
      pairingStore,
      deviceTokenAttestation,
      // RT-113 P2 — the cashier takeover is an admission with takeover:true.
      cashierAdmission,
      logger: mainLogger,
    });

    const operatorPinManagementHandler = new PinManagementHandler({
      db: db,
      safeStorage,
      sessionManager: operatorSessionManager,
      pairingStore,
      auditEmitter,
      // 019 — roster source for the provision path; resolves the neutral
      // target_user_id → the cashier's roster entry (clerk id + user_id presence).
      backend: operatorBackend,
      // RT-214 — the roster is operator-identity + manager gated: present the
      // signed-in manager's JWT from the same holder sign-out/stuck-shifts use.
      jwtHolder: operatorJwtHolder,
      logger: mainLogger,
    });

    // 004-operator-session dev bypass — seeds a fixture manager session so
    // the renderer routes past /sign-in in unpackaged dev builds.
    // SECURITY: the shipped-app guard is inside applyDevSkipOperatorSignInIfRequested;
    // this call is a no-op in the shipped app (renamed exe included, RT-165)
    // regardless of env vars.
    // Independent from POS_PULSE_DEV_SKIP_PAIRING; both may be set together.
    applyDevSkipOperatorSignInIfRequested({
      isPackaged: shippedApp,
      env: process.env,
      sessionManager: operatorSessionManager,
      logger: mainLogger,
    });

    registerOperatorHandlers(guardedIpcMain, {
      signInHandler: operatorSignInHandler,
      cashierSignInHandler: operatorCashierSignInHandler,
      signOutHandler: operatorSignOutHandler,
      rosterHandler: operatorRosterHandler,
      sessionManager: operatorSessionManager,
      inactivityMonitor: operatorInactivityMonitor,
      auditEmitter,
      pairingStore,
      takeoverHandler: operatorTakeoverHandler,
      pinManagementHandler: operatorPinManagementHandler,
      forcedCloseHandler: new ForcedCloseHandler({
        db: db,
        sessionManager: operatorSessionManager,
        pairingStore,
        auditEmitter,
      }),
      stuckShiftsHandler: new StuckShiftsHandler({
        sessionManager: operatorSessionManager,
        backendClient: operatorBackend,
        jwtHolder: operatorJwtHolder,
      }),
    });

    // 009-product-search-and-barcode-lookup S4 (T043) — the production R7
    // resolver. 005 left `cart.resolveItemRef` unwired (refusing stub); 009
    // wires a real read-model-backed resolver behind the SAME §A1 seam. It
    // re-reads name/price authoritatively from the catalogue (the renderer
    // supplies only `{ item_ref }`), tenant-scoped to the live session (P17).
    // The dev fixture still wins in an unpackaged build with the fixture flag
    // set (see wire-cart-handlers.ts precedence); this is the production path.
    const catalogueResolver = createCatalogueResolver({
      repo: createProductRepo(db),
      // `linesAdd` gates `no_session` before the resolver runs, so a null
      // session never reaches here; coalesce defensively so the closure's
      // `string` return is total and never throws.
      getTenantId: () => operatorSessionManager.getCurrent()?.tenant_id ?? '',
    });

    // 006-payments-tender Slice 3 (T142 + F-002/F-003/F-004) — wire the
    // payments.* + tender.* bridge surface. The 8 handler factories share
    // the three S3a repositories, both FSMs, and a single idempotency
    // helper + audit-emitter pair. payments.discardOnSessionEnd is
    // instantiated but NOT registered on ipcMain — it's an internal
    // handler called by the operator-session-end signal.
    const paymentsAttemptsRepo = bindPaymentAttemptsRepository(db);
    const paymentsLinesRepo = bindPaymentTenderLinesRepository(db);
    const paymentsOutboxRepo = bindPaymentActionOutboxRepository(db);

    const paymentAttemptFsm = createPaymentAttemptFsm({
      db: db,
      attempts: paymentsAttemptsRepo,
      lines: paymentsLinesRepo,
      outbox: paymentsOutboxRepo,
    });
    const tenderLineFsm = createTenderLineFsm({
      db: db,
      attempts: paymentsAttemptsRepo,
      lines: paymentsLinesRepo,
      outbox: paymentsOutboxRepo,
    });

    const paymentsIdempotency = createIdempotencyHelper({ outbox: paymentsOutboxRepo });

    // Adapter — the payments and sales emitters write their own event shapes;
    // both forward to 004's `audit_events` table via the shared
    // `AuditEventsStore.insertIgnore` with the same field mapping. F-006:
    // 004's `ActionCategory` union does not yet include the 7 payment
    // categories at the TypeScript level (migration 0017 extends the SQL
    // CHECK only). The cast lives at this single seam and is bounded by the
    // migration's CHECK; a future PR by 004's owner should extend
    // `AUDIT_ACTION_CATEGORIES`.
    const forwardAuditEvent = (evt: PaymentAuditEvent | SaleAuditEvent): void => {
      auditEventsStore.insertIgnore({
        event_id: randomUUID(),
        tenant_id: evt.tenant_id,
        branch_id: evt.branch_id,
        originating_terminal_id: evt.originating_terminal_id,
        acting_operator_id: evt.attribution_operator_id,
        session_id: evt.session_id,
        shift_id: null,
        action_category: evt.action_category as unknown as Audit004ActionCategory,
        created_at: evt.created_at,
        approving_supervisor_id: null,
        payload: evt.payload,
      });
    };
    const paymentAuditEmitter = createPaymentAuditEmitter({
      sink: { write: forwardAuditEvent },
    });

    // RT-26 — Checkout Back: the payments record decides whether a handed-off
    // cart may return to the Sale (no tender, no settled / force-failed payment)
    // and cancels a zero-funds started attempt inside the cart transaction.
    const releaseCheckoutPayment = bindCheckoutReturnGuard({
      db,
      paymentAttemptFsm,
      auditEmitter: paymentAuditEmitter,
    });

    // 005-sales-cart S2 — register `cart:*` IPC with DB-backed CartStore.
    const cartBridgeHandlers = createCartBridgeHandlers({
      dbHandle: db,
      getCurrentSession: () => operatorSessionManager.getCurrent(),
      // #380 (F-007) — stamp cart rows with the real terminal_id, not branch_id.
      getTerminalId: () => pairingStore.getCurrentTerminalId(),
      logger: mainLogger,
      auditEmitter,
      isPackaged: shippedApp,
      productionResolver: catalogueResolver,
      // Post-handoff cancel and the snapshot "paid" flag read the payments record.
      cartPaymentStatus: bindCartPaymentStatus(db),
      releaseCheckoutPayment,
      // RT-26 — read-only twin for Checkout's Back eligibility (no writes).
      checkoutReturnAllowed: bindCheckoutReturnAllowed(db),
    });
    registerCartHandlers(guardedIpcMain, { handlers: cartBridgeHandlers });

    // 009 + 010 — wire the `catalogue.*` IPC surface. Registered unconditionally
    // (same as cart): the handlers are session-gated and refuse with no session,
    // and an unmounted renderer (productSearch flag off) never invokes them, so
    // there is nothing to gate. 009 shipped the bridge factory + preload but
    // never registered the channels with ipcMain, so the whole surface was inert
    // until now; this makes 009's read handlers + 010's `freshness` reachable.
    // 010 T021/T039 (#349 cleared) — the live read-down HTTP client + driver are
    // now wired when the terminal is paired. The driver carries the device-principal
    // scope (tenant/branch) from `pairingStore` (Constitution VIII — NOT the operator
    // session), authenticates with the device token (`Authorization: Bearer`), and
    // runs a background snapshot pull on an interval. When paired, `refresh` admits
    // a real tick; when unpaired, the driver is omitted and `refresh` still refuses
    // (never a fake "started"). The freshness reads below are independent of all this.
    const catalogueRepo = createProductRepo(db);
    const catalogueSyncStateRepo = createCatalogueSyncStateRepo(db);

    const catalogueApiBaseUrl = resolveApiBaseUrl();
    // Pairing state at boot. A terminal already paired notifies the latch NOW, so
    // every paired-only starter registered below runs immediately in its original
    // position (RT-202: unchanged paired-boot behaviour). An unpaired terminal
    // leaves them held until the in-process pairing completes.
    const bootPairing = await pairingStore.getStatus();
    if (bootPairing.kind === 'paired') {
      pairedWorkersLatch.notifyPaired({
        tenant_id: bootPairing.tenant_id,
        branch_id: bootPairing.branch_id,
        terminal_id: bootPairing.terminal_id,
      });
    }
    // Created by the paired-only starter below (boot or in-process pairing); the
    // catalogue bridge resolves it lazily so `refresh` works after in-process
    // pairing and still refuses while there is no driver.
    let readDownDriver: ReturnType<typeof createReadDownDriver> | undefined;

    const catalogueBridge = createCatalogueBridge({
      // Adapt the operator session to the catalogue projection: the gate needs
      // `operator_session_id`, which the record carries as `id`.
      getCurrentSession: () => {
        const sess = operatorSessionManager.getCurrent();
        if (sess === null) return null;
        return {
          role: sess.role,
          operator_id: sess.operator_id,
          operator_session_id: sess.id,
          tenant_id: sess.tenant_id,
          branch_id: sess.branch_id,
        };
      },
      productRepo: catalogueRepo,
      // 010 freshness source: the per-tenant sync-state row + a tenant-scoped
      // live-product count (is_empty). Both reads are tenant-scoped (P17) and
      // secret-free. NOT #349-blocked — neither touches the HTTP client.
      freshness: {
        readSyncState: (tenantId) => catalogueSyncStateRepo.read(tenantId),
        countProducts: (tenantId) => catalogueRepo.countByTenant(tenantId),
        // 010 diagnostics — tenant-scoped barcode-alias count for catalogue:counts.
        countBarcodes: (tenantId) => catalogueRepo.countBarcodesByTenant(tenantId),
      },
      // 010 T039 — the live read-down driver (paired terminals only), resolved at
      // call time (RT-202): `undefined` while unpaired, so `refresh` still refuses
      // cleanly. The bridge only ever calls `runTickOnce` (admit); start/stop are
      // owned here at the root.
      getReadDownDriver: () => readDownDriver,
    });
    registerCatalogueHandlers(guardedIpcMain, { bridge: catalogueBridge });

    // Start the background snapshot pull (paired terminals only). `start()` also
    // admits one immediate initial tick (RT-41) so a freshly paired/restarted
    // terminal does not wait a full interval for its catalogue. The driver's
    // setInterval is stopped on quit via `closeDbHandle()` so it never outlives
    // the process or runs against a closed DB handle.
    pairedWorkersLatch.register('read-down driver', (terminal) => {
      const readDownClient = createReadDownClient({
        baseUrl: catalogueApiBaseUrl,
        fetch: globalThis.fetch.bind(globalThis),
        // Device token (the paired-terminal credential) read in-process; never
        // logged, never bridged. Sole credential for the non-session-gated driver.
        getDeviceToken: async () => {
          const token = await secretStore.get(DEVICE_TOKEN_KEY);
          return token ?? null;
        },
      });
      const driver = createReadDownDriver({
        client: readDownClient,
        writer: createReadDownWriter({ db: db, syncStateRepo: catalogueSyncStateRepo }),
        tenantId: terminal.tenant_id,
        branchId: terminal.branch_id,
        now: () => new Date().toISOString(),
        // Background pull cadence: hourly. Bounded [1s, 24h] by the driver.
        tickIntervalMs: 60 * 60 * 1_000,
      });
      readDownDriver = driver;
      driver.start();
      workerRegistry.register('read-down driver', () => {
        driver.stop();
      });
      mainLogger.info({ tenant_id: terminal.tenant_id }, 'read_down_driver:started');
    });
    if (bootPairing.kind !== 'paired') {
      // Boot-time fact only: the starter above runs when the pairing completes.
      mainLogger.info('read_down_driver:skipped_unpaired');
    }

    const paymentsSessionAdapter = (): OperatorSessionForPayments | null =>
      // #380 (F-007 FIXED) — stamp the REAL terminal_id from the pairing store,
      // NOT session.branch_id (the retired shortcut that collapsed every
      // terminal at a branch into one payment scope so one stuck attempt
      // bricked them all). resolveSessionScope is the extracted, unit-tested
      // seam shared with the sales adapter; returns null on no-session OR
      // unpaired. display_name flows through for 008 T094b's settled audit.
      resolveSessionScope(operatorSessionManager.getCurrent(), pairingStore.getCurrentTerminalId());

    const paymentsClock = (): Date => new Date();
    const paymentsUuid = (): string => randomUUID();

    // Shared dependency bundles for the payments/tender handler factories —
    // each factory destructures only the keys it declares.
    const paymentsReadDeps = {
      getCurrentSession: paymentsSessionAdapter,
      attemptsRepo: paymentsAttemptsRepo,
      linesRepo: paymentsLinesRepo,
    };
    const paymentsWriteDeps = {
      ...paymentsReadDeps,
      idempotency: paymentsIdempotency,
      auditEmitter: paymentAuditEmitter,
      clock: paymentsClock,
    };

    const paymentsStart = createPaymentsStartHandler({
      ...paymentsWriteDeps,
      paymentAttemptFsm,
      uuid: paymentsUuid,
      // §A4: main decides whether the named cart may be paid (handed off, in
      // scope, envelope matches, not already paid).
      checkCartForPayment: bindCartPaymentEligibility(db),
      // §A4: never discard another cart's attempt while it holds tender.
      attemptHasLiveTender: bindAttemptHasLiveTender(db),
    });
    const paymentsConfirm = createPaymentsConfirmHandler({
      ...paymentsWriteDeps,
      paymentAttemptFsm,
    });
    const paymentsCancel = createPaymentsCancelHandler({
      ...paymentsWriteDeps,
      paymentAttemptFsm,
    });
    const paymentsSubscribe = createPaymentsSubscribeHandler(paymentsReadDeps);
    const paymentsRead = createPaymentsReadHandler(paymentsReadDeps);
    const tenderApply = createTenderApplyHandler({
      ...paymentsWriteDeps,
      tenderLineFsm,
      uuid: paymentsUuid,
    });
    const tenderReverse = createTenderReverseHandler({
      ...paymentsWriteDeps,
      tenderLineFsm,
    });
    const tenderRead = createTenderReadHandler(paymentsReadDeps);
    const paymentsForceFail = createPaymentsForceFailHandler({
      ...paymentsWriteDeps,
      paymentAttemptFsm,
    });

    registerPaymentsHandlers(guardedIpcMain, {
      paymentsStart,
      paymentsConfirm,
      paymentsCancel,
      paymentsSubscribe,
      paymentsRead,
      tenderApply,
      tenderReverse,
      tenderRead,
      paymentsForceFail,
    });

    // #380 (F-007 part b) — orphan-attempt recovery. A stuck `started` payment
    // attempt blocks every future sale on the terminal. The discard handler
    // (LIFO-reverse + fail + audit) existed but was never wired to any signal.
    // Wire it to the session lifecycle: clean session-END discards a live
    // orphan; sign-in (session-START) recovers the CRASH case where end() never
    // ran. Both resolve the REAL terminal_id (F-007 part a) and reuse the same
    // idempotent discard. Fired role-agnostically — the brick is terminal-
    // scoped and blocks every operator at the terminal.
    const paymentsDiscardOnSessionEnd = createPaymentsDiscardOnSessionEndHandler({
      attemptsRepo: paymentsAttemptsRepo,
      linesRepo: paymentsLinesRepo,
      paymentAttemptFsm,
      tenderLineFsm,
      auditEmitter: paymentAuditEmitter,
      uuid: paymentsUuid,
      clock: paymentsClock,
    });
    const sweepStuckAttempt = createStuckAttemptSweeper({
      attemptsRepo: paymentsAttemptsRepo,
      discard: paymentsDiscardOnSessionEnd,
      resolveTerminalId: () => pairingStore.getCurrentTerminalId(),
      // RT-117 — never auto-reverse an attempt that holds live tender.
      attemptHasLiveTender: bindAttemptHasLiveTender(db),
      logError: (err, ctx) => {
        mainLogger.error({ err, ...ctx }, 'stuck_attempt_sweep:failed');
      },
    });
    // Sync lifecycle hooks → fire-and-forget the async sweep. The SessionManager
    // wrappers swallow subscriber throws, so the sweeper logs its own failures.
    operatorSessionManager.onEnded(() => {
      void sweepStuckAttempt();
    });
    operatorSessionManager.onStarted(() => {
      void sweepStuckAttempt();
    });

    // 006 T271 — deferred-reversal resolver bootstrap.
    //
    // The resolver scans `payment_tender_lines` for `reversal_pending`
    // voucher lines and retries `vouchers.reverse` against V-A. It runs
    // on (a) app start, (b) future 003 network-restore signal, (c)
    // explicit cashier retry (no bridge surface yet).
    //
    // **Production wiring (PR #222 fixup — CR-1).** The V-A reverse
    // client is wired here using the same `apiBaseUrl` + `fetch` seam
    // the operator backend already uses. The resolver supplies the
    // per-line `idempotencyKey` (derived from `tender_line_id`); the
    // closure bakes in baseUrl / fetch / logger.
    //
    // The 003 network-restore signal is still TBD (no network module
    // yet); the resolver runs without it via (a) app-start and (c)
    // the manual-retry entry point.
    const reverseVoucherForResolver = async (
      input: ReverseVoucherInput,
      options: { idempotencyKey: string },
    ): Promise<ReverseVoucherOutcome> => {
      return await reverseVoucher(input, {
        baseUrl: apiBaseUrl,
        fetch: globalThis.fetch.bind(globalThis),
        logger: {
          info: (payload, msg): void => {
            mainLogger.info(payload, msg);
          },
          warn: (payload, msg): void => {
            mainLogger.warn(payload, msg);
          },
          error: (payload, msg): void => {
            mainLogger.error(payload, msg);
          },
        },
        idempotencyKey: options.idempotencyKey,
      });
    };
    const deferredReversalResolver = createDeferredReversalResolver({
      linesRepo: paymentsLinesRepo,
      attemptsRepo: paymentsAttemptsRepo,
      tenderLineFsm,
      auditEmitter: paymentAuditEmitter,
      reverseVoucher: reverseVoucherForResolver,
      logger: {
        info: (payload, msg): void => {
          mainLogger.info(payload, msg);
        },
        warn: (payload, msg): void => {
          mainLogger.warn(payload, msg);
        },
        error: (payload, msg): void => {
          mainLogger.error(payload, msg);
        },
      },
      clock: paymentsClock,
    });
    void deferredReversalResolver.start().catch((err: unknown) => {
      mainLogger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'deferred_reversal_resolver:start_failed',
      );
    });

    // ── Shared receipt printer + drawer ports (RT-15 S4: hoisted out of the
    // 008 branch below so the return payout reuses the same instances) ──────
    //
    // 008 §A3 print transports.
    //
    // OS-print path (T200): the REAL `webContents.print` transport is wired —
    // an actual 008 receipt prints through the Windows OS print path on a
    // physically attached printer (e.g. the BIXOLON SRP-330 II from the §A5
    // bench). The slip is rendered to 80 mm continuous-roll width to match the
    // recorded browser/HTML render-quality smoke. `getPrintersAsync` enumerates
    // the system printers; an unconfigured `deviceName` targets the system
    // default. (Mapping a SPECIFIC queue to the paired terminal is a follow-up:
    // pairing/T094a carries USB vendor/product/com-port ids, NOT the Windows
    // print-queue name.) Verified on the bench by T301; the pure parts are
    // unit-tested in os-print-transport.test.ts.
    //
    // ESC/POS-direct path: still an honest STUB reporting `offline` — that path
    // (node-thermal-printer ↔ printer status byte) remains unverified (a5
    // findings) and is NOT selected. We route to OS-print via
    // `probeEscposSupport: false`, the proven path.
    const printPipeline = createPrintPipeline({
      escposAdapter: createEscposAdapter({
        transport: {
          write: () => Promise.resolve(),
          pollStatus: () => Promise.resolve('offline' as const),
        },
        statusTimeoutMs: 3000,
      }),
      osPrintAdapter: createOsPrintAdapter({
        print: createOsPrintTransport({
          createPrintWindow: createDefaultPrintWindow,
          listPrinters: () => getCurrentPrinters(),
          logger: mainLogger,
        }),
      }),
      // Route to the OS-print path: it is the proven transport (the ESC/POS
      // direct path is unverified). The cashier never sees which path ran
      // unless the print fails (path is for audit only — T212).
      probeEscposSupport: () => Promise.resolve(false),
    });
    // 008 Slice 4 drawer port, hoisted (RT-15 S4) so the sale drawer-kick
    // dispatcher and the return payout share ONE drawer transport. The real
    // DK1/DK2 transport is the §A3 hardware bring-up (T200), deferred: until
    // then this honest STUB reports `no_drawer_configured` — a cash sale
    // records a `failed` drawer row, and a return payout answers
    // `drawer_failed` (nothing paid is recorded; the manager may then attest a
    // manual payout). Never a faked "opened" (PRODUCT.md Principle 3).
    const drawerKickTransport: DrawerKickTransport = {
      kick: () => Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' }),
    };

    // ── 008-sale-finalization-and-receipts Slice 1c.3 (T094c) ──────────────
    //
    // Wire the AD-2 finalize worker + read-only `sales.*` bridge behind the
    // `sale_finalization` feature flag (fail-closed default off). When the
    // flag is off no Sale rows are written. RT-162 / D-1: that is only a valid
    // profile with payments OFF too — PAYMENTS on + SALE_FINALIZATION off is
    // refused at startup (see runbook 008 T525).
    //
    // The worker is terminal-scoped: it only fires for the paired terminal.
    // We read the scope from the pairing status; an unpaired terminal cannot
    // reach a POS surface at all (the renderer is walled at /pairing), so a
    // non-paired status here means "nothing to finalize" and we skip start.
    if (getAppConfig().features?.saleFinalization === true) {
      const salesRepo = bindSalesRepository(db);
      const printEventsRepo = bindPrintEventsRepository(db);
      const drawerEventsRepo = bindDrawerEventsRepository(db);

      // Read-only `sales.*` + `receipts.preview` bridges for the renderer.
      // Registered UNCONDITIONALLY whenever the flag is on — NOT gated on
      // pairing status. Pairing happens in-renderer (PairingForm navigates
      // to /paired without a process relaunch), so a terminal that boots
      // unpaired and pairs later in the same process must still have these
      // handlers; otherwise the renderer's reads reject at the IPC layer. Both
      // bridges gate on the live session at call time, so they are inert until
      // an operator signs in regardless of pairing timing.
      // #380 (F-007 FIXED) — same extracted seam as the payments adapter; the
      // returned payments-shaped scope is a structural superset of
      // OperatorSessionForSales. Real terminal_id from the pairing store; null
      // on no-session or unpaired.
      const getCurrentSalesSession = (): OperatorSessionForSales | null =>
        resolveSessionScope(
          operatorSessionManager.getCurrent(),
          pairingStore.getCurrentTerminalId(),
        );
      const salesBridge = createSalesBridge({
        getCurrentSession: getCurrentSalesSession,
        salesRepo,
        printEventsRepo,
        drawerEventsRepo,
        // Snapshot-subscribe projector (008 follow-up): sales.subscribe returns
        // the current banner_state / recent projection; the renderer polls it.
        bannerStateProjector: bindBannerStateProjector(db),
        newSubscriptionToken: () => randomUUID(),
      });
      registerSalesHandlers(guardedIpcMain, { salesBridge });

      // 008 Slice 3 — print dispatcher (used by both the auto-fire finalize
      // seam AND the renderer-callable receipts.retryPrint handler). Built
      // here (not inside the paired branch) so the receipts bridge can be
      // registered UNCONDITIONALLY — the T094c lesson: IPC handlers must be
      // present regardless of pairing, since pairing is in-renderer with no
      // relaunch. The dispatcher needs only the DB + repos + audit sink, none
      // of which are pairing-specific; the paired branch reuses it for the
      // finalize-listener wiring.
      const saleAuditEmitter = createSaleAuditEmitter({
        sink: { write: forwardAuditEvent },
      });
      // Shared clock for the print dispatcher + receipts bridge so a reprint's
      // rendered slip time (bridge) matches the print_events.printed_at the
      // dispatcher writes for the same logical event (one clock read per event).
      const receiptsClock = (): string => new Date().toISOString();
      const printDispatcher = createPrintDispatcher({
        pipeline: printPipeline,
        printEventsRepo,
        auditEmitter: saleAuditEmitter,
        now: receiptsClock,
        newPrintEventId: () => randomUUID(),
        logger: mainLogger,
      });

      // 008 Slice 4 — drawer-kick dispatcher (AD-8 separate command). Chains
      // after a successful first print for cash-inclusive sales. The real
      // DK1/DK2 transport (node-thermal-printer `openCashDrawer` ↔ the Epson's
      // DRAWER port driving the APG VBS320) is the §A3 HARDWARE bring-up (T200),
      // deferred — same posture as the print transport above. Until then an
      // honest STUB reports `no_drawer_configured`, so a cash sale records a
      // clean `failed` drawer row + raises the drawer-failure banner while the
      // Sale stays durable — no fake "opened" is recorded (PRODUCT.md
      // Principle 3). T200 swaps the shared `drawerKickTransport` (hoisted above,
      // also used by the RT-15 S4 return payout) for the real one; nothing else
      // changes.
      const drawerKickDispatcher = createDrawerKickDispatcher({
        drawerEventsRepo,
        transport: drawerKickTransport,
        auditEmitter: saleAuditEmitter,
        now: () => new Date().toISOString(),
        newDrawerEventId: () => randomUUID(),
        logger: mainLogger,
      });

      // 008 Slice 2 + 3 — receipts.preview (read-only render) + retryPrint
      // (mutating; gated server-side). Registered unconditionally (T094c).
      const receiptsBridge = createReceiptsBridge({
        getCurrentSession: getCurrentSalesSession,
        salesRepo,
        printEventsRepo,
        printDispatcher,
        // S4: a retry-success runs drawer gating (FR-052 — retry-success is the
        // canonical first print). Same STUB transport as the auto-fired path
        // until the T200 hardware bring-up.
        drawerKickDispatcher,
        // S5: same clock as printDispatcher so the reprint slip time matches the
        // print_events.printed_at row.
        now: receiptsClock,
        // S6 manualOverride: writes the override print_events row directly +
        // emits sale.receipt.manual_override (no slip rendered → no dispatcher).
        auditEmitter: saleAuditEmitter,
        newPrintEventId: () => randomUUID(),
      });
      registerReceiptsHandlers(guardedIpcMain, { receiptsBridge });

      // The AD-2 finalize WORKER, by contrast, IS terminal-scoped and only
      // starts for a paired terminal — it needs the pairing row's scope to
      // filter the scan. RT-202: a terminal that pairs mid-process starts the
      // worker (and the sale-sync engine) right after the pairing is persisted,
      // through the same starter a paired boot runs immediately — never only on
      // the next launch. The startup recovery scan below runs on either path.
      pairedWorkersLatch.register('finalize listener + sale-sync engine', (pairingStatus) => {
        const outboxRepo = bindSaleSyncOutboxRepository(db);
        const allocator = bindSaleNumberAllocator(db);
        // saleAuditEmitter + printPipeline + printDispatcher are hoisted above
        // the receipts-bridge registration (T094c — unconditional handlers);
        // the paired branch reuses them for the finalize-listener wiring.
        const finalizeTransaction = bindFinalizeTransaction({
          db: db,
          salesRepo,
          outboxRepo,
          allocator,
          auditEmitter: saleAuditEmitter,
          now: () => new Date().toISOString(),
          saleIdGenerator: () => randomUUID(),
          outboxRowIdGenerator: () => randomUUID(),
        });

        // The AD-2 dispatch closure: project the settled payment into a
        // FinalizeInput (T094b), then run the atomic finalize (T091). A
        // projection refusal is logged and skipped — the worker re-scans
        // the same row on the next tick (idempotent NOT EXISTS clause).
        // After a FRESH finalize commits, fire the first print asynchronously
        // (T273) — NOT part of the atomic transaction; the Sale is already
        // durable. Idempotent replays do NOT re-print (extracted + unit-tested
        // in dispatch-first-print-on-finalize.ts).
        const finalizeDb = db;
        const dispatch = (handoff_action_id: string): void => {
          const projected = buildFinalizeInput({ db: finalizeDb, handoff_action_id });
          if (projected.kind === 'refused') {
            mainLogger.warn(
              { handoff_action_id, reason: projected.reason },
              'finalize_dispatch:projection_refused',
            );
            return;
          }
          const result = finalizeTransaction.finalize(projected.input);
          mainLogger.info({ handoff_action_id, kind: result.kind }, 'finalize_dispatch:finalized');
          void dispatchFirstPrintOnFinalize(result, {
            salesRepo,
            printDispatcher,
            drawerKickDispatcher,
            logError: (err: unknown) => {
              mainLogger.error({ handoff_action_id, err }, 'finalize_dispatch:print_seam_infra');
            },
          }).catch((err: unknown) => {
            mainLogger.error({ handoff_action_id, err }, 'finalize_dispatch:print_seam_unexpected');
          });
        };

        // #380 (F-007 FIXED) — the AD-2 scan filters `audit_events` by
        // `originating_terminal_id`, which 006 writes as the payment attempt's
        // `terminal_id`. Post-#380 that value comes from
        // `paymentsSessionAdapter`, which now sources the REAL terminal_id from
        // `pairingStore.getCurrentTerminalId()` (= `pairingStatus.terminal_id`
        // here). The scan MUST bind the SAME value 006 wrote, or it matches
        // zero settled rows and finalizes nothing. This is the lockstep half of
        // the adapter flip — pinned by finalize-listener.f007-scope.test.ts.
        const payments006TerminalId = pairingStatus.terminal_id;
        const finalizeListener = createFinalizeListener({
          db: db,
          tenant_id: pairingStatus.tenant_id,
          branch_id: pairingStatus.branch_id,
          terminal_id: payments006TerminalId,
          dispatch,
          // Print recovery (T273): a sale that crashed before a successful
          // first print is re-attempted via the SAME print dispatcher. Reuses
          // the finalize→print seam by synthesising a `finalized` result for
          // the recovered sale_id (the seam reads the row + derives the
          // payload). The drawer-kick dispatcher is wired here too, so a
          // recovered print success chains its drawer decision exactly like a
          // live finalize (the dispatcher's readBySale guard makes it
          // idempotent — a sale that already has a drawer row is a no-op).
          dispatchPrintRecovery: (sale_id: string): void => {
            void dispatchFirstPrintOnFinalize(
              { kind: 'finalized', sale_id, sale_number: '', receipt_number: '', finalized_at: '' },
              { salesRepo, printDispatcher, drawerKickDispatcher },
            ).catch((err: unknown) => {
              mainLogger.error({ sale_id, err }, 'finalize_recovery:print_recovery_unexpected');
            });
          },
          // Drawer recovery sub-scan #2 (T092): a cash-inclusive sale whose
          // print already succeeded but whose drawer never got a row (crashed
          // between print success and kick). The forward drawer-kick dispatcher
          // now exists, but driving it from recovery needs the sale-row read +
          // successful-print lookup that lives in finalize-listener territory
          // (`src/main/sales/**`, out of this S4a wave's allow-list). Tracked as
          // a follow-up; until then this logs (the sale + receipt are durable,
          // only the drawer pop is missed on the crash-recovery path).
          dispatchDrawerRecovery: (sale_id: string): void => {
            mainLogger.warn({ sale_id }, 'finalize_recovery:drawer_recovery_stub');
          },
          tickIntervalMs: 200,
          now: () => new Date().toISOString(),
        });

        // Recovery scan first (re-fires any settled-but-unfinalized rows from
        // a prior crash), then install the steady-state tick driver.
        finalizeListener.runStartupRecovery();
        finalizeListener.start();
        workerRegistry.register('finalize listener', () => {
          finalizeListener.stop();
        });
        mainLogger.info({ terminal_id: pairingStatus.terminal_id }, 'finalize_listener:started');

        // 011 S5 (T061/T062, #349 cleared) — wire the live sale-sync engine. It
        // drains the (008-owned) outbox UP to DP2 captureSale on an interval,
        // authenticating per-POST with the operator session JWT (read in-process;
        // never bridged). The engine pauses when no operator session is present and
        // resumes on the next tick once a session returns. Idempotency, retry/
        // backoff, and dead-letter are owned by the engine + state repo (unchanged);
        // the live client only transforms the payload + maps HTTP outcomes.
        const saleSyncStateRepo = createSaleSyncStateRepo(db);
        // 016 (D5/D7 + review HIGH): the sale-sync POST authenticates with the
        // opaque pos_operator ENVELOPE only (`operatorAuthorization` scheme) — read
        // in-process per POST through the SEPARATE envelope holder. This is the only
        // pair of call sites that read the envelope; sign-out / stuck-shifts / the
        // takeover-confirm CALL all read the JWT holder (`operator-identity`). 016
        // (D7): X-Device-Attestation is retired from the sale wire (#559), so the
        // client takes no getDeviceAttestation dep. The device token keeps its proper
        // roles (read-down Bearer + sign-in attestation body) elsewhere — untouched.
        // RT-224 step 2 (Option B, Backend-Core #709) — device-path sale capture.
        // A sale whose own `payment.settled` payload carries the cashier's
        // `selling_user_id` is sent with the DEVICE bearer + that id
        // (`operatorUserId`); any other sale keeps the envelope path. The device
        // token is read in-process per POST, only while paired; never logged,
        // never bridged. RT-215 (POS #546): once it merges, this reader becomes its
        // `createSendableDeviceTokenReader` (whichever PR merges second switches).
        // A device-path 401 is logged once per episode and the sale stays queued:
        // revocation is RT-215's detector's call, not the drain's.
        // Codex P2 (#547): a secret-store failure reads as "no device credential"
        // (logged once per episode) — it never aborts the drain or rejects a POST.
        const readSaleSyncDeviceToken = createSaleSyncDeviceTokenReader({
          isPaired: async () => (await pairingStore.getStatus()).kind === 'paired',
          readToken: () => secretStore.get(DEVICE_TOKEN_KEY),
          onReadFailure: () => {
            mainLogger.warn('sale_sync:device_token_unreadable');
          },
        });
        const saleSyncDevicePath = {
          hasDeviceCredential: async (): Promise<boolean> =>
            (await readSaleSyncDeviceToken()) !== null,
          sellingUsers: createSellingUserIdResolver({
            db,
            onUnresolved: ({ saleId, reason }) => {
              mainLogger.warn({ sale_id: saleId, reason }, 'sale_sync:selling_user_unresolved');
            },
          }),
          onDeviceUnauthorized: () => {
            mainLogger.warn('sale_sync:device_unauthorized');
          },
        };
        const saleSyncClient = createSaleSyncClient({
          baseUrl: resolveApiBaseUrl(),
          fetch: globalThis.fetch.bind(globalThis),
          getOperatorToken: createSaleSyncTokenReader(
            operatorSessionManager,
            operatorEnvelopeHolder,
          ),
          getDeviceToken: readSaleSyncDeviceToken,
          // RT-15 S1: a 200/201 without a usable saleRef — the sale is captured but
          // the till cannot return it. Logs the opaque externalId + a closed-set
          // reason only (never the body or the rejected value; P7).
          onSaleRefUnavailable: ({ externalId, reason }) => {
            mainLogger.warn({ external_id: externalId, reason }, 'sale_sync:sale_ref_unavailable');
          },
        });
        // RT-79 rollout gate: unset = never send tenders (default). Only sales finalized
        // at/after this explicit-zone ISO instant carry `tenders`. Ops MUST choose a
        // FUTURE instant, later than BOTH the Backend-Core tender switch going ON and
        // the restart that loads it here: then no sale at/after the cutoff can have
        // been sent without tenders by an earlier process (its retry body stays
        // identical). A past cutoff re-opens that window. Unparseable = off + warning.
        const tendersSinceRaw = process.env['POS_PULSE_FEATURE_SALE_TENDERS_SINCE'];
        const tendersSince = parseTendersSince(tendersSinceRaw);
        if (
          tendersSinceRaw !== undefined &&
          tendersSinceRaw.trim() !== '' &&
          tendersSince === null
        ) {
          mainLogger.warn('sale_sync:tenders_since_unparseable_tenders_off');
        }
        // RT-221: the drain (and the pending / held counts) is scoped to the
        // CURRENT pairing's terminal_id, read live from the pairing status each
        // tick. After a re-pair, the earlier pairing's queued sales are held —
        // never replayed under the new device identity (RT-138 L6). Unpaired /
        // invalid → nothing is eligible.
        const resolveSaleSyncTerminalId = createCurrentTerminalResolver(() =>
          pairingStore.getStatus(),
        );
        const saleSyncEngine = createSaleSyncEngine({
          client: saleSyncClient,
          tendersSince,
          stateRepo: saleSyncStateRepo,
          salesRepo,
          tenantId: pairingStatus.tenant_id,
          branchId: pairingStatus.branch_id,
          resolveTerminalId: resolveSaleSyncTerminalId,
          getOperatorToken: createSaleSyncTokenReader(
            operatorSessionManager,
            operatorEnvelopeHolder,
          ),
          ...saleSyncDevicePath,
          now: () => new Date().toISOString(),
          // Exponential backoff: 1s base, capped at 5 min.
          backoff: { ...SALE_SYNC_BACKOFF_POLICY },
          onDeadLetter: (saleId: string, reason?: string) => {
            mainLogger.warn({ sale_id: saleId, reason }, 'sale_sync:dead_letter');
          },
          // RT-15 S1: a capture answer's saleRef differed from the stored one; the
          // stored one is kept. Only the opaque externalId is logged (P7).
          onSaleRefMismatch: ({ externalId }) => {
            mainLogger.warn({ external_id: externalId }, 'sale_sync:sale_ref_mismatch');
          },
          // RT-190: a capture 409 — the server holds a different sale for this
          // provenance. Dead-lettered (`payload_divergence`), never retried. Only
          // the opaque externalId + the closed-set error code are logged (P7).
          onPayloadDivergence: ({ externalId, errorCode }) => {
            mainLogger.warn(
              { external_id: externalId, error_code: errorCode },
              'sale_sync:payload_divergence',
            );
          },
          // RT-224: the drain pauses while it holds no sale credential at all (no
          // envelope AND no device credential, e.g. unpaired). Log it once per transition — the
          // closed-set `sale_sync:paused_no_operator_credential` and its resume
          // line — with { reason, pending } only (P7).
          onPauseTransition: (event) => {
            logSaleSyncPauseTransition(mainLogger, event);
          },
        });

        // Read-only status surface for the renderer (counts + last-success + the
        // RT-224 closed-set paused reason; no token/PII/raw body crosses the
        // bridge). No write/trigger handler.
        registerSalesSyncHandlers(guardedIpcMain, {
          readStatus: createSaleSyncStatusReader({
            stateRepo: saleSyncStateRepo,
            tenantId: pairingStatus.tenant_id,
            branchId: pairingStatus.branch_id,
            resolveTerminalId: resolveSaleSyncTerminalId,
            pausedReason: () => saleSyncEngine.pausedReason(),
          }),
        });

        // Background drain on an interval. Single-flight in the engine coalesces
        // overlapping ticks; the interval is cleared on quit (closeDbHandle).
        const SALE_SYNC_INTERVAL_MS = 5_000;
        const saleSyncInterval = setInterval(() => {
          const admission = saleSyncEngine.runTickOnce();
          if (admission.kind === 'started') {
            admission.completed.catch((err: unknown) => {
              mainLogger.error({ err }, 'sale_sync:tick_unexpected');
            });
          }
        }, SALE_SYNC_INTERVAL_MS);
        workerRegistry.register('sale-sync interval', () => {
          clearInterval(saleSyncInterval);
        });
        mainLogger.info({ terminal_id: pairingStatus.terminal_id }, 'sale_sync_engine:started');
      });
      if (bootPairing.kind !== 'paired') {
        // Boot-time fact only: the starter above runs when the pairing completes.
        mainLogger.info('finalize_listener:skipped_unpaired');
      }
    }

    // ── RT-15 S2 — cashier returns (main-process domain; no renderer UI yet) ──
    //
    // The `returns:*` handlers are registered UNCONDITIONALLY (T094c lesson: the
    // renderer gets a typed `feature_disabled` refusal, never "no handler"). The
    // service re-reads `POS_PULSE_FEATURE_RETURNS` per call (default off, AC1),
    // requires a manager/admin operator session (D-b), and talks only to
    // Backend-Core `/api/pos/v1/sales/...` (AC7) with the operator envelope of
    // the admitted authorization snapshot (RT-197 A5). The background resolver
    // (startup + interval) re-sends `pending` / `unknown` returns with the
    // identical request; it is scheduled with the flag on and resolves pairing +
    // operator live on every tick.
    const returnsDomain = composeReturns({
      db,
      http: {
        baseUrl: resolveApiBaseUrl(),
        fetch: globalThis.fetch.bind(globalThis),
      },
      // RT-197 A5: read only into the authorization snapshot (and at a
      // recheck); every send carries the snapshot's envelope explicitly.
      getOperatorEnvelope: createSaleSyncTokenReader(
        operatorSessionManager,
        operatorEnvelopeHolder,
      ),
      isEnabled: () => parseFeatureFlags(process.env).returns,
      getSession: () =>
        resolveSessionScope(
          operatorSessionManager.getCurrent(),
          pairingStore.getCurrentTerminalId(),
        ),
      isSessionLocked: () => operatorSessionManager.getCurrent()?.lock_state === 'locked',
      auditSink: auditEmitter,
      logger: mainLogger,
      now: () => new Date().toISOString(),
      // RT-15 S4: the SAME drawer port and print pipeline as sales (no new
      // hardware path): the payout kicks the drawer, the slip prints through
      // the receipt pipeline's path selection.
      drawer: drawerKickTransport,
      printer: printPipeline,
    });
    registerReturnsHandlers(guardedIpcMain, { service: returnsDomain.service });
    if (parseFeatureFlags(process.env).returns) {
      // Scheduled regardless of pairing: each tick resolves the paired terminal
      // and an eligible (unlocked manager/admin) operator live, so in-process
      // pairing needs no restart; until then every tick is a no-op.
      const RETURNS_RESOLVER_INTERVAL_MS = 30_000;
      // = the returns client's request timeout.
      const RETURNS_DRAIN_TIMEOUT_MS = 15_000;
      const stopReturnsResolver = scheduleReturnsResolver({
        resolver: returnsDomain.resolver,
        stopDomain: returnsDomain.stop,
        intervalMs: RETURNS_RESOLVER_INTERVAL_MS,
        drainTimeoutMs: RETURNS_DRAIN_TIMEOUT_MS,
        logger: mainLogger,
      });
      // Synchronous like every worker stop: latches the domain stopped (no
      // send starts; an in-flight send writes nothing when it settles), so the
      // DB may close right after. The drain promise is not awaited here.
      workerRegistry.register('returns resolver', () => {
        void stopReturnsResolver();
      });
    }

    createWindow();
    mainLogger.info('app:ready');
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((err: unknown) => {
    // R3 + R4: any failure here (logger init, migrations, or
    // SecretStore production refusal) halts launch. We deliberately
    // keep `console.error` here rather than the logger because the
    // logger itself may have failed to initialize.
    console.error('[pos-pulse] fatal startup error:', err);
    closeDbHandle();
    app.exit(1);
  });

function closeDbHandle(): void {
  // 008 (T094c) / 021 S1 — stop the AD-2 finalize worker, 010 read-down driver,
  // and 011 sale-sync interval BEFORE closing the DB so a mid-flight background
  // tick cannot run against a closed handle. Stop ordering, failure isolation,
  // and idempotency are owned by the worker registry; this function preserves
  // the sequencing (drain, then close).
  pairedWorkers?.close();
  workerRegistry.stopAll();
  dbHolder.close();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    closeDbHandle();
    app.quit();
  }
});

// Defensive cleanup on quit for the macOS path (no-op on Windows but
// keeps invariants symmetric: handle never outlives the app process).
app.on('quit', () => {
  closeDbHandle();
});
