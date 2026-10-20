import type { SafePointGate } from './safe-point-gate.js';
import type { SafePointVerdict, UpdateChannel, UpdateState, UpdateStatus } from './update-types.js';

/**
 * RT-772 slice 2 — the POS UpdateService (ADR-0006; design §4-§6, §8.1, §9).
 *
 *   - Packaged-only and initialised once: a dev or unpackaged build never
 *     contacts the origin.
 *   - Fail closed: no publisher pin means `verify_unavailable`; the library's own
 *     default is to SKIP verification when no pin exists, so we never let it
 *     start without one. A verification failure is `verify_failed`, never an install.
 *   - Roll-forward only: `allowDowngrade` is forced false AFTER the channel is set
 *     (the channel setter can flip it), and install-on-quit is off.
 *   - It installs only at a safe point, via the one `SafePointGate` predicate, at
 *     two triggers: app start before sign-in, and shift close.
 *
 * This slice exposes no renderer surface and no install trigger from the UI.
 */

/** The slice of electron-updater's `AppUpdater` this service drives. */
export interface UpdaterLike {
  channel: string | null;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: 'generic'; url: string; channel: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface UpdateLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface UpdateServiceDeps {
  /** `isShippedApp(...)`: the trusted "this is the packaged app" predicate (RT-165). */
  isShippedApp: boolean;
  origin: string | undefined;
  /** `null` = the configured channel is not a known one. */
  channel: UpdateChannel | null;
  /** The publisher names baked into `app-update.yml`; empty when none is pinned. */
  readPublisherPins: () => readonly string[];
  /** Lazy: electron-updater's singleton must not be touched unless every guard holds. */
  getUpdater: () => UpdaterLike;
  gate: SafePointGate;
  /** True while no operator session exists (the app-start-before-sign-in trigger). */
  isBeforeSignIn: () => boolean;
  logger: UpdateLogger;
  checkIntervalMs?: number;
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface UpdateService {
  start(): void;
  stop(): void;
  getStatus(): UpdateStatus;
  /** Shift close committed: re-evaluate the install predicate. */
  notifyShiftClosed(): void;
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** States in which a scheduled check must not start another one. */
const BUSY_STATES: ReadonlySet<UpdateState> = new Set([
  'downloading',
  'downloaded',
  'update_pending',
  'installing',
]);

const VERIFY_FAILED = /not signed by the application owner|sha512|checksum/i;
const VERIFY_UNAVAILABLE = /powershell|get-authenticodesignature|convertto-json/i;

function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const handle = setInterval(fn, ms);
  handle.unref();
  return {
    cancel: () => {
      clearInterval(handle);
    },
  };
}

function isHttps(origin: string): boolean {
  try {
    return new URL(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

function describeError(error: unknown): { code: string | undefined; message: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === 'string' ? code : undefined, message: error.message };
  }
  return { code: undefined, message: String(error) };
}

function classify(error: unknown): { state: UpdateState; detail: string } {
  const { code, message } = describeError(error);
  const detail = message.slice(0, 200);
  if (/SIGNATURE|CHECKSUM/i.test(code ?? '') || VERIFY_FAILED.test(message)) {
    return { state: 'verify_failed', detail };
  }
  if (VERIFY_UNAVAILABLE.test(message)) return { state: 'verify_unavailable', detail };
  return { state: 'error', detail };
}

type Preflight =
  | { kind: 'disabled'; reason: 'not_shipped' | 'no_origin' }
  | { kind: 'refused'; state: UpdateState; detail: string }
  | { kind: 'ready'; origin: string; channel: UpdateChannel; pinned: number };

function pinnedPublishers(deps: UpdateServiceDeps): number {
  try {
    return deps.readPublisherPins().length;
  } catch {
    return 0;
  }
}

/** Every guard that must hold before the updater is touched, in order. Pure: no side effects. */
function preflight(deps: UpdateServiceDeps): Preflight {
  const { origin, channel } = deps;
  if (!deps.isShippedApp) return { kind: 'disabled', reason: 'not_shipped' };
  if (origin === undefined || origin === '') return { kind: 'disabled', reason: 'no_origin' };
  if (channel === null) return { kind: 'refused', state: 'error', detail: 'channel_invalid' };
  if (!isHttps(origin)) return { kind: 'refused', state: 'error', detail: 'origin_not_https' };
  const pinned = pinnedPublishers(deps);
  if (pinned === 0) {
    return { kind: 'refused', state: 'verify_unavailable', detail: 'publisher_not_pinned' };
  }
  return { kind: 'ready', origin, channel, pinned };
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const { gate, logger } = deps;
  let status: UpdateStatus = { state: 'idle' };
  let started = false;
  let installing = false;
  let updater: UpdaterLike | null = null;
  let timer: { cancel(): void } | null = null;

  function setStatus(next: UpdateStatus): void {
    logger.info(
      {
        from: status.state,
        to: next.state,
        ...(next.detail === undefined ? {} : { detail: next.detail }),
        ...(next.availableVersion === undefined ? {} : { version: next.availableVersion }),
        ...(next.blockers === undefined ? {} : { blockers: next.blockers }),
      },
      'update:state',
    );
    status = next;
  }

  function fail(state: UpdateState, detail: string): void {
    logger.warn({ state, detail }, 'update:refused');
    setStatus({ state, detail });
  }

  function onError(error: unknown): void {
    const { state, detail } = classify(error);
    const { code } = describeError(error);
    logger.warn({ state, detail, ...(code === undefined ? {} : { code }) }, 'update:error');
    setStatus({ state, detail });
  }

  function install(trigger: string): void {
    if (updater === null) return;
    installing = true;
    setStatus({ state: 'installing', detail: trigger, ...versionOf(status) });
    try {
      updater.quitAndInstall(true, true);
    } catch (error) {
      installing = false;
      onError(error);
    }
  }

  function versionOf(from: UpdateStatus): { availableVersion?: string } {
    return from.availableVersion === undefined ? {} : { availableVersion: from.availableVersion };
  }

  function defer(verdict: SafePointVerdict, trigger: string): void {
    logger.info(
      { trigger, ...(verdict.safe ? {} : { blockers: verdict.blockers }) },
      'update:install_deferred',
    );
    setStatus({
      state: 'update_pending',
      ...versionOf(status),
      ...(verdict.safe ? {} : { blockers: verdict.blockers }),
    });
  }

  /** The one place the install decision is made, for both triggers. */
  function evaluate(trigger: 'app_start' | 'shift_close'): void {
    if (installing || updater === null) return;
    const verdict = gate.isSafeToInstall();
    const triggerAllows = trigger === 'shift_close' || deps.isBeforeSignIn();
    if (verdict.safe && triggerAllows) {
      install(trigger);
      return;
    }
    defer(verdict, trigger);
  }

  function check(): void {
    if (updater === null) return;
    try {
      void updater.checkForUpdates().catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  function configure(target: UpdaterLike, origin: string, channel: UpdateChannel): void {
    target.setFeedURL({ provider: 'generic', url: origin, channel });
    // Order matters: electron-updater's `channel` setter can also flip
    // `allowDowngrade` to true, so roll-forward is forced AFTER it.
    target.channel = channel;
    target.allowDowngrade = false;
    target.allowPrerelease = false;
    target.autoInstallOnAppQuit = false;
    target.autoDownload = true;
  }

  function listen(target: UpdaterLike): void {
    const version = (info: unknown): { availableVersion?: string } => {
      const v = (info as { version?: unknown } | undefined)?.version;
      return typeof v === 'string' ? { availableVersion: v } : {};
    };
    target.on('checking-for-update', () => {
      setStatus({ state: 'checking' });
    });
    target.on('update-available', (info) => {
      setStatus({ state: 'downloading', ...version(info) });
    });
    target.on('download-progress', () => {
      if (status.state !== 'downloading') {
        setStatus({ state: 'downloading', ...versionOf(status) });
      }
    });
    target.on('update-not-available', () => {
      if (!BUSY_STATES.has(status.state)) setStatus({ state: 'idle' });
    });
    target.on('update-downloaded', (info) => {
      setStatus({ state: 'downloaded', ...version(info) });
      evaluate('app_start');
    });
    target.on('error', onError);
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      const plan = preflight(deps);
      if (plan.kind === 'disabled') {
        logger.info({ reason: plan.reason }, 'update:disabled');
        return;
      }
      if (plan.kind === 'refused') {
        fail(plan.state, plan.detail);
        return;
      }

      const target = deps.getUpdater();
      updater = target;
      configure(target, plan.origin, plan.channel);
      listen(target);
      logger.info({ channel: plan.channel, pinned: plan.pinned }, 'update:enabled');
      check();
      timer = (deps.schedule ?? defaultSchedule)(() => {
        if (!BUSY_STATES.has(status.state)) check();
      }, deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
    },

    stop(): void {
      timer?.cancel();
      timer = null;
    },

    getStatus: () => status,

    notifyShiftClosed(): void {
      if (status.state === 'update_pending' || status.state === 'downloaded') {
        evaluate('shift_close');
      }
    },
  };
}
