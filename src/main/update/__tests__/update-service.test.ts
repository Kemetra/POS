import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { VERIFIER_UNAVAILABLE_MARKER } from '../signature-verifier.js';
import type { VerifyUpdateCodeSignature } from '../signature-verifier.js';
import { createUpdateService } from '../update-service.js';
import type { UpdateServiceDeps } from '../update-service.js';
import type { SafePointVerdict } from '../update-types.js';

/**
 * RT-772 slice 2 — UpdateService. Packaged-only, fail-closed, roll-forward, and
 * it installs only at a safe point (ADR-0006 P-3, P-4; constitution v1.6.0).
 * The updater is a fake that reproduces the one library behaviour the design
 * calls out: setting `channel` also flips `allowDowngrade` to true.
 */

class FakeUpdater extends EventEmitter {
  allowDowngrade = false;
  allowPrerelease = false;
  autoDownload = false;
  autoInstallOnAppQuit = true;
  feed: unknown = null;
  // An accessor pair, like electron-updater's NSIS updater (a class field would shadow a subclass's).
  private verifierValue: VerifyUpdateCodeSignature | undefined;
  get verifyUpdateCodeSignature(): VerifyUpdateCodeSignature | undefined {
    return this.verifierValue;
  }
  set verifyUpdateCodeSignature(value: VerifyUpdateCodeSignature | undefined) {
    this.verifierValue = value;
  }
  private channelValue: string | null = null;
  get channel(): string | null {
    return this.channelValue;
  }
  set channel(value: string | null) {
    this.channelValue = value;
    this.allowDowngrade = true; // electron-updater side effect (re-check per pinned version)
  }
  setFeedURL = vi.fn((options: unknown) => {
    this.feed = options;
  });
  checkForUpdates = vi.fn(() => Promise.resolve(null));
  quitAndInstall = vi.fn();
}

/** An updater whose `verifyUpdateCodeSignature` setter does nothing (a library that dropped it). */
class IgnoringUpdater extends FakeUpdater {
  override get verifyUpdateCodeSignature(): VerifyUpdateCodeSignature | undefined {
    return undefined;
  }
  override set verifyUpdateCodeSignature(_value: VerifyUpdateCodeSignature | undefined) {
    // ignored on purpose
  }
}

const SAFE: SafePointVerdict = { safe: true };
const PIN = ['Kemetra POS LAB TEST - NOT FOR PRODUCTION'];

function build(
  overrides: Partial<UpdateServiceDeps> = {},
  updater: FakeUpdater = new FakeUpdater(),
) {
  const verifier = vi.fn<VerifyUpdateCodeSignature>(() => Promise.resolve(null));
  const deferred: Array<() => void> = [];
  const cancelDefer = vi.fn();
  const defer = vi.fn((fn: () => void) => {
    deferred.push(fn);
    return { cancel: cancelDefer };
  });
  const getUpdater = vi.fn(() => updater);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const gate = { isSafeToInstall: vi.fn<() => SafePointVerdict>(() => SAFE) };
  const ticks: Array<() => void> = [];
  const cancel = vi.fn();
  const schedule = vi.fn((fn: () => void) => {
    ticks.push(fn);
    return { cancel };
  });
  let beforeSignIn = true;
  const deps: UpdateServiceDeps = {
    isShippedApp: true,
    origin: 'https://updates.example/lab',
    channel: 'lab',
    readPublisherPins: () => PIN,
    getUpdater,
    gate,
    isBeforeSignIn: () => beforeSignIn,
    logger,
    schedule,
    checkIntervalMs: 1000,
    verifier,
    defer,
    afterShiftCloseDelayMs: 5000,
    ...overrides,
  };
  const service = createUpdateService(deps);
  return {
    service,
    updater,
    verifier,
    deferred,
    cancelDefer,
    defer,
    getUpdater,
    logger,
    gate,
    ticks,
    cancel,
    schedule,
    setBeforeSignIn: (v: boolean) => {
      beforeSignIn = v;
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('UpdateService start: it never contacts the origin unless every guard holds', () => {
  it('does nothing in a build that is not the shipped app', () => {
    const t = build({ isShippedApp: false });
    t.service.start();
    expect(t.getUpdater).not.toHaveBeenCalled();
    expect(t.service.getStatus().state).toBe('idle');
    expect(t.schedule).not.toHaveBeenCalled();
  });

  it('is disabled, not failing, when no origin is configured (dir pilots)', () => {
    const t = build({ origin: undefined });
    t.service.start();
    expect(t.getUpdater).not.toHaveBeenCalled();
    expect(t.service.getStatus().state).toBe('idle');
    expect(t.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no_origin' }),
      'update:disabled',
    );
  });

  it('refuses a non-https origin (TLS is mandatory) and reports an error', () => {
    const t = build({ origin: 'http://updates.example/lab' });
    t.service.start();
    expect(t.getUpdater).not.toHaveBeenCalled();
    expect(t.service.getStatus()).toMatchObject({ state: 'error', detail: 'origin_not_https' });
  });

  it('refuses an origin that is not a URL', () => {
    const t = build({ origin: 'not a url' });
    t.service.start();
    expect(t.service.getStatus()).toMatchObject({ state: 'error', detail: 'origin_not_https' });
  });

  it('reports an error for an unknown channel instead of guessing one', () => {
    const t = build({ channel: null });
    t.service.start();
    expect(t.getUpdater).not.toHaveBeenCalled();
    expect(t.service.getStatus()).toMatchObject({ state: 'error', detail: 'channel_invalid' });
  });

  it('fails closed with verify_unavailable when no publisher is pinned', () => {
    const t = build({ readPublisherPins: () => [] });
    t.service.start();
    expect(t.getUpdater).not.toHaveBeenCalled();
    expect(t.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(t.service.getStatus()).toMatchObject({
      state: 'verify_unavailable',
      detail: 'publisher_not_pinned',
    });
  });

  it('fails closed with verify_unavailable when the pin cannot be read', () => {
    const t = build({
      readPublisherPins: () => {
        throw new Error('EACCES');
      },
    });
    t.service.start();
    expect(t.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(t.service.getStatus().state).toBe('verify_unavailable');
  });

  it('initialises only once', () => {
    const t = build();
    t.service.start();
    t.service.start();
    expect(t.updater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateService configuration: roll-forward only', () => {
  it('points the generic provider at the origin and channel', () => {
    const t = build();
    t.service.start();
    expect(t.updater.feed).toEqual({
      provider: 'generic',
      url: 'https://updates.example/lab',
      channel: 'lab',
    });
  });

  it('forces allowDowngrade=false AFTER the channel is set (the channel setter flips it)', () => {
    const t = build();
    t.service.start();
    expect(t.updater.channel).toBe('lab');
    expect(t.updater.allowDowngrade).toBe(false);
  });

  it('never installs on quit, never takes prereleases, and downloads in the background', () => {
    const t = build();
    t.service.start();
    expect(t.updater.autoInstallOnAppQuit).toBe(false);
    expect(t.updater.allowPrerelease).toBe(false);
    expect(t.updater.autoDownload).toBe(true);
  });

  it('checks once at start and then on a schedule', () => {
    const t = build();
    t.service.start();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(t.schedule).toHaveBeenCalledWith(expect.any(Function), 1000);
    t.ticks[0]?.();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('does not re-check while a download is running', () => {
    const t = build();
    t.service.start();
    t.updater.emit('update-available', { version: '0.1.1' });
    t.ticks[0]?.();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('does not re-check while an install is pending on a safe point', () => {
    const t = build();
    t.setBeforeSignIn(false);
    t.service.start();
    t.updater.emit('update-downloaded', { version: '0.1.1' });
    t.ticks[0]?.();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('does not re-check once the install has started', () => {
    const t = build();
    t.service.start();
    t.updater.emit('update-downloaded', { version: '0.1.1' });
    t.ticks[0]?.();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('installs the fail-closed verifier on the updater before it checks', () => {
    const t = build();
    t.service.start();
    expect(t.updater.verifyUpdateCodeSignature).toBe(t.verifier);
  });

  it('refuses to start, and never checks, if the updater does not keep the verifier', () => {
    const t = build({}, new IgnoringUpdater());
    t.service.start();
    expect(t.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(t.updater.setFeedURL).not.toHaveBeenCalled();
    expect(t.service.getStatus()).toMatchObject({
      state: 'verify_unavailable',
      detail: 'verifier_not_installed',
    });
  });

  it('cancels the schedule on stop()', () => {
    const t = build();
    t.service.start();
    t.service.stop();
    expect(t.cancel).toHaveBeenCalledTimes(1);
  });

  it('records a failed check as an error and does not throw', async () => {
    const t = build();
    t.updater.checkForUpdates.mockRejectedValueOnce(new Error('ENOTFOUND updates.example'));
    t.service.start();
    await flush();
    expect(t.service.getStatus()).toMatchObject({ state: 'error' });
  });

  it('records a synchronous throw from the check as an error and does not throw', async () => {
    const t = build();
    t.updater.checkForUpdates.mockImplementationOnce(() => {
      throw new Error('sync boom');
    });
    expect(() => {
      t.service.start();
    }).not.toThrow();
    await flush();
    expect(t.service.getStatus()).toMatchObject({ state: 'error', detail: 'sync boom' });
  });
});

describe('UpdateService states follow the updater events', () => {
  it('walks checking -> downloading while an update is fetched', () => {
    const t = build();
    t.service.start();
    t.updater.emit('checking-for-update');
    expect(t.service.getStatus().state).toBe('checking');
    t.updater.emit('update-available', { version: '0.1.1' });
    expect(t.service.getStatus()).toMatchObject({
      state: 'downloading',
      availableVersion: '0.1.1',
    });
    t.updater.emit('download-progress', { percent: 50 });
    expect(t.service.getStatus()).toMatchObject({
      state: 'downloading',
      availableVersion: '0.1.1',
    });
  });

  it('tells a status listener about each change until it unsubscribes (RT-322)', () => {
    const t = build();
    const seen: string[] = [];
    const stop = t.service.onStatusChange((s) => seen.push(s.state));
    t.service.start();
    t.updater.emit('checking-for-update');
    t.updater.emit('update-available', { version: '0.1.1' });
    stop();
    t.updater.emit('update-not-available');
    expect(seen).toEqual(['checking', 'downloading']);
  });

  it('keeps going when a status listener throws (RT-322)', () => {
    const t = build();
    t.service.onStatusChange(() => {
      throw new Error('window gone');
    });
    t.service.start();
    expect(() => t.updater.emit('checking-for-update')).not.toThrow();
    expect(t.service.getStatus().state).toBe('checking');
  });

  it('returns to idle when a check finds nothing newer', () => {
    const t = build();
    t.service.start();
    t.updater.emit('checking-for-update');
    t.updater.emit('update-not-available', { version: '0.1.0' });
    expect(t.service.getStatus().state).toBe('idle');
  });

  it('never drops a download or a pending install on a stray not-available event', () => {
    const t = build();
    t.service.start();
    t.updater.emit('update-available', { version: '0.1.1' });
    t.updater.emit('update-not-available', { version: '0.1.0' });
    expect(t.service.getStatus().state).toBe('downloading');
  });

  it('resumes the downloading state if progress arrives without an available event', () => {
    const t = build();
    t.service.start();
    t.updater.emit('download-progress', { percent: 10 });
    expect(t.service.getStatus().state).toBe('downloading');
  });
});

describe('UpdateService install gating (the same predicate at both triggers)', () => {
  it('installs a verified update before sign-in when the gate is clear', () => {
    const t = build();
    t.service.start();
    t.updater.emit('update-downloaded', { version: '0.1.1' });
    expect(t.gate.isSafeToInstall).toHaveBeenCalledTimes(1);
    expect(t.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(t.updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(t.service.getStatus()).toMatchObject({ state: 'installing', availableVersion: '0.1.1' });
  });

  it('waits (update_pending) when the gate is blocked, and names why', () => {
    const t = build();
    t.gate.isSafeToInstall.mockReturnValue({ safe: false, blockers: ['open_shift', 'open_cart'] });
    t.service.start();
    t.updater.emit('update-downloaded', { version: '0.1.1' });
    expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(t.service.getStatus()).toMatchObject({
      state: 'update_pending',
      blockers: ['open_shift', 'open_cart'],
    });
  });

  it('waits when the operator is already signed in, even if the gate is clear', () => {
    const t = build();
    t.setBeforeSignIn(false);
    t.service.start();
    t.updater.emit('update-downloaded', { version: '0.1.1' });
    expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(t.service.getStatus().state).toBe('update_pending');
  });

  describe('shift close defers the install until the close has finished delivering', () => {
    // The close call returns before the forced-close handler has drained the shift outbox and
    // answered its caller. Installing inside the close call would quit the app mid-delivery, so
    // the evaluation waits `afterShiftCloseDelayMs` and re-reads the gate when it fires.
    const pending = () => {
      const t = build();
      t.setBeforeSignIn(false);
      t.service.start();
      t.updater.emit('update-downloaded', { version: '0.1.1' });
      return t;
    };

    it('does not touch the gate or the installer inside the close call', () => {
      const t = pending();
      t.gate.isSafeToInstall.mockClear();
      t.service.notifyShiftClosed();
      expect(t.gate.isSafeToInstall).not.toHaveBeenCalled();
      expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
      expect(t.defer).toHaveBeenCalledTimes(1);
      expect(t.defer).toHaveBeenCalledWith(expect.any(Function), 5000);
    });

    it('installs when the delay elapses and the gate is still clear', () => {
      const t = pending();
      t.service.notifyShiftClosed();
      t.deferred[0]?.();
      expect(t.gate.isSafeToInstall).toHaveBeenCalledTimes(2);
      expect(t.updater.quitAndInstall).toHaveBeenCalledTimes(1);
      expect(t.service.getStatus().state).toBe('installing');
    });

    it('re-reads the gate when the delay elapses: a shift opened meanwhile keeps it pending', () => {
      const t = pending();
      t.service.notifyShiftClosed();
      t.gate.isSafeToInstall.mockReturnValue({ safe: false, blockers: ['open_shift'] });
      t.deferred[0]?.();
      expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
      expect(t.service.getStatus()).toMatchObject({
        state: 'update_pending',
        blockers: ['open_shift'],
      });
    });

    it('stays pending while something is still in flight when the delay elapses', () => {
      const t = pending();
      t.service.notifyShiftClosed();
      t.gate.isSafeToInstall.mockReturnValue({ safe: false, blockers: ['payment_in_flight'] });
      t.deferred[0]?.();
      expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
      expect(t.service.getStatus().blockers).toEqual(['payment_in_flight']);
    });

    it('coalesces repeated notifications into one pending evaluation', () => {
      const t = pending();
      t.service.notifyShiftClosed();
      t.service.notifyShiftClosed();
      expect(t.defer).toHaveBeenCalledTimes(1);
    });

    it('can be scheduled again after a deferred evaluation has run', () => {
      const t = pending();
      t.gate.isSafeToInstall.mockReturnValue({ safe: false, blockers: ['open_shift'] });
      t.service.notifyShiftClosed();
      t.deferred[0]?.();
      t.service.notifyShiftClosed();
      expect(t.defer).toHaveBeenCalledTimes(2);
    });

    it('ignores a shift close when no update is waiting', () => {
      const t = build();
      t.service.start();
      t.service.notifyShiftClosed();
      expect(t.defer).not.toHaveBeenCalled();
      expect(t.gate.isSafeToInstall).not.toHaveBeenCalled();
      expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('does nothing when the update is no longer waiting at fire time', () => {
      const t = pending();
      t.service.notifyShiftClosed();
      t.updater.emit('error', new Error('ECONNRESET'));
      t.gate.isSafeToInstall.mockClear();
      t.deferred[0]?.();
      expect(t.gate.isSafeToInstall).not.toHaveBeenCalled();
      expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('cancels a pending evaluation on stop(), so nothing runs against a closed database', () => {
      const t = pending();
      t.service.notifyShiftClosed();
      t.service.stop();
      expect(t.cancelDefer).toHaveBeenCalledTimes(1);
    });

    it('installs at most once', () => {
      const t = pending();
      t.service.notifyShiftClosed();
      t.deferred[0]?.();
      t.service.notifyShiftClosed();
      expect(t.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    });
  });

  it('reports an error, and does not claim installing, when quitAndInstall throws', () => {
    const t = build();
    t.updater.quitAndInstall.mockImplementation(() => {
      throw new Error('spawn EPERM');
    });
    t.service.start();
    t.updater.emit('update-downloaded', { version: '0.1.1' });
    expect(t.service.getStatus().state).toBe('error');
  });
});

describe('UpdateService failures are visible and never install', () => {
  it.each([
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'is not signed by the application owner' }],
    [{ message: 'sha512 checksum mismatch, expected abc, got def' }],
    [{ code: 'ERR_CHECKSUM_MISMATCH', message: 'checksum' }],
  ])('maps %j to verify_failed', (err) => {
    const t = build();
    t.service.start();
    t.updater.emit('error', Object.assign(new Error(err.message), err));
    expect(t.service.getStatus().state).toBe('verify_failed');
    expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('maps our own "could not verify" marker to verify_unavailable, not verify_failed', () => {
    // electron-updater wraps any non-null verifier result as "not signed by the application
    // owner", so the marker must win over that pattern.
    const t = build();
    t.service.start();
    t.updater.emit(
      'error',
      Object.assign(
        new Error(
          `New version 0.1.1 is not signed by the application owner: ${VERIFIER_UNAVAILABLE_MARKER}: spawn EPERM`,
        ),
        { code: 'ERR_UPDATER_INVALID_SIGNATURE' },
      ),
    );
    expect(t.service.getStatus().state).toBe('verify_unavailable');
    expect(t.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('maps an inability to run the signature check to verify_unavailable', () => {
    const t = build();
    t.service.start();
    t.updater.emit('error', new Error('spawn powershell.exe ENOENT'));
    expect(t.service.getStatus().state).toBe('verify_unavailable');
  });

  it('maps any other failure to error', () => {
    const t = build();
    t.service.start();
    t.updater.emit('error', new Error('ECONNRESET'));
    expect(t.service.getStatus()).toMatchObject({ state: 'error', detail: 'ECONNRESET' });
  });

  it('logs the failure without crashing on a non-Error value', () => {
    const t = build();
    t.service.start();
    t.updater.emit('error', 'boom');
    expect(t.service.getStatus().state).toBe('error');
    expect(t.logger.warn).toHaveBeenCalled();
  });

  it('retries on the next scheduled check after a failure', () => {
    const t = build();
    t.service.start();
    t.updater.emit('error', new Error('sha512 checksum mismatch'));
    t.ticks[0]?.();
    expect(t.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
