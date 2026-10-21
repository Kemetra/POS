import type { SafePointGate } from './safe-point-gate.js';
import { VERIFIER_UNAVAILABLE_MARKER } from './signature-verifier.js';
import type { VerifyUpdateCodeSignature } from './signature-verifier.js';
import type { SafePointVerdict, UpdateChannel, UpdateState, UpdateStatus } from './update-types.js';

/**
 * RT-772 slice 2 — the POS UpdateService (ADR-0006; design §4-§6, §8.1, §9).
 *
 *   - Packaged-only and initialised once: a dev or unpackaged build never
 *     contacts the origin.
 *   - Fail closed. No publisher pin means `verify_unavailable` (the library skips
 *     verification entirely when none is baked, so it never starts without one).
 *     The library's own Windows verifier also resolves "valid" when its PowerShell
 *     check cannot run, so we install our own (`verifier`, see signature-verifier.ts),
 *     read it back, and refuse to start if the updater did not keep it. A failure is
 *     `verify_failed`; an inability to verify is `verify_unavailable`; neither installs.
 *   - Roll-forward only: `allowDowngrade` is forced false AFTER the channel is set
 *     (the channel setter can flip it), and install-on-quit is off.
 *   - It installs only at a safe point, via the one `SafePointGate` predicate, at
 *     two triggers: app start before sign-in, and shift close. The shift-close
 *     evaluation is deferred past the close's own delivery and reply, and re-reads
 *     the gate when it fires.
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
  /** Present on the NSIS updater; read back after assignment to prove it was kept. */
  verifyUpdateCodeSignature?: VerifyUpdateCodeSignature | undefined;
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
  /** The fail-closed signature verifier installed on the updater. */
  verifier: VerifyUpdateCodeSignature;
  checkIntervalMs?: number;
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
  /**
   * How long after a committed shift close the install is evaluated. It must outlast the close's
   * own work (a forced close drains the shift outbox and answers its caller afterwards).
   */
  afterShiftCloseDelayMs?: number;
  /** One-shot timer for that evaluation. */
  defer?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface UpdateService {
  start(): void;
  stop(): void;
  getStatus(): UpdateStatus;
  /** Calls `listener` after every status change; returns the unsubscribe. */
  onStatusChange(listener: (status: UpdateStatus) => void): () => void;
  /** Shift close committed: re-evaluate the install predicate. */
  notifyShiftClosed(): void;
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_AFTER_SHIFT_CLOSE_DELAY_MS = 30_000;

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

function defaultDefer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return {
    cancel: () => {
      clearTimeout(handle);
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
  // electron-updater wraps any non-null verifier result as "not signed by the application
  // owner", so our own "could not verify" marker is checked first.
  if (message.includes(VERIFIER_UNAVAILABLE_MARKER)) {
    return { state: 'verify_unavailable', detail };
  }
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
  const listeners = new Set<(status: UpdateStatus) => void>();
  let started = false;
  let installing = false;
  let updater: UpdaterLike | null = null;
  let timer: { cancel(): void } | null = null;
  let shiftCloseTimer: { cancel(): void } | null = null;

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
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // A listener must never break the updater.
      }
    }
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

  function holdPending(verdict: SafePointVerdict, trigger: string): void {
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
    holdPending(verdict, trigger);
  }

  /** A verified update is downloaded and waiting for a safe point. */
  function isWaiting(): boolean {
    return status.state === 'update_pending' || status.state === 'downloaded';
  }

  function check(): void {
    const target = updater;
    if (target === null) return;
    // `checkForUpdates()` is still called synchronously (the first `await` comes after it);
    // a synchronous throw and a rejection both end up in `onError`.
    void (async () => {
      try {
        await target.checkForUpdates();
      } catch (error) {
        onError(error);
      }
    })();
  }

  /** Installs the fail-closed verifier and proves the updater kept it (read back). */
  function installVerifier(target: UpdaterLike): boolean {
    target.verifyUpdateCodeSignature = deps.verifier;
    return target.verifyUpdateCodeSignature === deps.verifier;
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
      if (!installVerifier(target)) {
        fail('verify_unavailable', 'verifier_not_installed');
        return;
      }
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
      shiftCloseTimer?.cancel();
      shiftCloseTimer = null;
    },

    getStatus: () => status,

    onStatusChange(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Called by each close path once its own work is done (the forced close after its delivery,
     * see ForcedCloseHandler.onCloseDelivered). It still never evaluates inside that call: an
     * install quits the app, so the evaluation runs after a short margin for the answer to reach
     * the renderer, coalesced, and re-reads the gate when it fires (a shift opened meanwhile
     * keeps the update pending).
     */
    notifyShiftClosed(): void {
      if (!isWaiting() || shiftCloseTimer !== null) return;
      const delay = deps.afterShiftCloseDelayMs ?? DEFAULT_AFTER_SHIFT_CLOSE_DELAY_MS;
      shiftCloseTimer = (deps.defer ?? defaultDefer)(() => {
        shiftCloseTimer = null;
        if (isWaiting()) evaluate('shift_close');
      }, delay);
    },
  };
}
