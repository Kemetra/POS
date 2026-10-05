import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PreloadBridgeAPI } from '../../shared/bridge-api';
import {
  PAIRING_IPC_CHANNELS,
  type PairingStatus,
  type PairingSubmitResult,
} from '../../shared/pairing-types';
import { OPERATOR_IPC_CHANNELS, SESSION_LOCK_IPC_CHANNELS } from '../../shared/operator/channels';

const exposeInMainWorld = vi.fn<(name: string, api: unknown) => void>();
const ipcRendererInvoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke: ipcRendererInvoke },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

/**
 * D2 / preload coverage — verifies that the preload script:
 *   - exposes exactly one bridge object on `window.api`,
 *   - routes `ping()` to `ipcRenderer.invoke('app:ping')`,
 *   - routes `appVersion()` to `ipcRenderer.invoke('app:version')`.
 *
 * `contextBridge` and `ipcRenderer` are runtime-mocked so the preload module
 * can be imported in Vitest without a live Electron runtime.
 */
describe('preload bridge', () => {
  it('exposes window.api with ping and appVersion methods', async () => {
    await import('../index');

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const call = exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    const [name, api] = call as [string, PreloadBridgeAPI];
    expect(name).toBe('api');
    expect(typeof api.ping).toBe('function');
    expect(typeof api.appVersion).toBe('function');
  });

  it('ping() invokes ipcRenderer with channel app:ping and resolves to "pong"', async () => {
    ipcRendererInvoke.mockResolvedValueOnce('pong');
    await import('../index');

    const call = exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    const [, api] = call as [string, PreloadBridgeAPI];

    const result = await api.ping();
    expect(ipcRendererInvoke).toHaveBeenCalledWith('app:ping');
    expect(result).toBe('pong');
  });

  it('appVersion() invokes ipcRenderer with channel app:version and resolves to a version string', async () => {
    ipcRendererInvoke.mockResolvedValueOnce('0.1.0');
    await import('../index');

    const call = exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    const [, api] = call as [string, PreloadBridgeAPI];

    const result = await api.appVersion();
    expect(ipcRendererInvoke).toHaveBeenCalledWith('app:version');
    expect(result).toBe('0.1.0');
  });

  /**
   * 002-terminal-pairing T014: pairing.getStatus() is now wired to
   * ipcRenderer.invoke(PAIRING_IPC_CHANNELS.GET_STATUS). pairing.submit
   * REMAINS a "not implemented" placeholder until US2 (T026) lands the
   * matching IPC handler.
   */
  it('pairing.getStatus() invokes ipcRenderer with PAIRING_IPC_CHANNELS.GET_STATUS and forwards the result', async () => {
    const expected: PairingStatus = { kind: 'unpaired' };
    ipcRendererInvoke.mockResolvedValueOnce(expected);
    await import('../index');

    const call = exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    const [, api] = call as [string, PreloadBridgeAPI];

    expect(typeof api.pairing.getStatus).toBe('function');
    const result = await api.pairing.getStatus();
    expect(ipcRendererInvoke).toHaveBeenCalledWith(PAIRING_IPC_CHANNELS.GET_STATUS);
    expect(PAIRING_IPC_CHANNELS.GET_STATUS).toBe('pairing:get-status');
    expect(result).toEqual(expected);
  });

  /**
   * 002-terminal-pairing T026: pairing.submit() is now wired to
   * ipcRenderer.invoke(PAIRING_IPC_CHANNELS.SUBMIT, code). The
   * placeholder rejection from PR #16 has been replaced.
   */
  it('pairing.submit() invokes ipcRenderer with PAIRING_IPC_CHANNELS.SUBMIT and forwards the result', async () => {
    const expected: PairingSubmitResult = {
      outcome: 'success',
      tenant_id: 'tenant-A',
      branch_id: 'branch-B',
      terminal_id: 'terminal-C',
      terminal_label: 'Counter 1',
    };
    ipcRendererInvoke.mockResolvedValueOnce(expected);
    await import('../index');

    const call = exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    const [, api] = call as [string, PreloadBridgeAPI];

    expect(typeof api.pairing.submit).toBe('function');
    const result = await api.pairing.submit('VALIDCODE');
    expect(ipcRendererInvoke).toHaveBeenCalledWith(PAIRING_IPC_CHANNELS.SUBMIT, 'VALIDCODE');
    expect(PAIRING_IPC_CHANNELS.SUBMIT).toBe('pairing:submit');
    expect(result).toEqual(expected);
  });

  /** RT-215 10897-A: pairing.recheckRevocation() triggers pairing:recheck, no argument. */
  it('pairing.recheckRevocation() invokes ipcRenderer with PAIRING_IPC_CHANNELS.RECHECK only', async () => {
    ipcRendererInvoke.mockResolvedValueOnce({ outcome: 'still_revoked' });
    await import('../index');

    const call = exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    const [, api] = call as [string, PreloadBridgeAPI];

    const result = await api.pairing.recheckRevocation?.();
    expect(ipcRendererInvoke).toHaveBeenCalledWith(PAIRING_IPC_CHANNELS.RECHECK);
    expect(result).toEqual({ outcome: 'still_revoked' });
  });

  it('pairing.submit() forwards each catch-all outcome (network_error, unknown_error) unchanged', async () => {
    for (const outcome of ['network_error', 'unknown_error'] as const) {
      vi.clearAllMocks();
      vi.resetModules();
      const expected: PairingSubmitResult = { outcome };
      ipcRendererInvoke.mockResolvedValueOnce(expected);
      await import('../index');

      const call = exposeInMainWorld.mock.calls[0];
      expect(call).toBeDefined();
      const [, api] = call as [string, PreloadBridgeAPI];
      const result = await api.pairing.submit('CODE');
      expect(result).toEqual(expected);
    }
  });

  it('operator namespace exposes the approved S5 methods only once', async () => {
    await import('../index');

    const call = exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    const [, api] = call as [string, PreloadBridgeAPI];

    expect(Object.keys(api.operator).sort()).toEqual(
      [
        '_emitAuditEventSmoke',
        '_reportActivity',
        'cancelTakeover',
        'confirmTakeover',
        'dismissShiftClosedNotice',
        'emitAuditEvent',
        'forceCloseShift',
        'getCurrentSession',
        'listBranchRoster',
        'listStuckShifts',
        'provisionCashierPin',
        'resetCashierPin',
        'signIn',
        'signOut',
        'unlockCashier',
        // RT-117 — inactivity lock
        'unlockSession',
        'getLockState',
        'onSessionStateChanged',
      ].sort(),
    );
  });

  it('operator S5 methods invoke the documented IPC channels', async () => {
    ipcRendererInvoke.mockResolvedValue({ kind: 'refused', category: 'invalid_input' });
    await import('../index');

    const call = exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    const [, api] = call as [string, PreloadBridgeAPI];

    await api.operator.listStuckShifts();
    await api.operator.dismissShiftClosedNotice();

    expect(ipcRendererInvoke).toHaveBeenCalledWith(OPERATOR_IPC_CHANNELS.LIST_STUCK_SHIFTS);
    expect(ipcRendererInvoke).toHaveBeenCalledWith(
      OPERATOR_IPC_CHANNELS.DISMISS_SHIFT_CLOSED_NOTICE,
    );
  });

  // RT-117 — the lock surface invokes its documented channels.
  it('operator lock methods invoke the documented IPC channels', async () => {
    ipcRendererInvoke.mockResolvedValue({ kind: 'refused', category: 'invalid_input' });
    await import('../index');

    const call = exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    const [, api] = call as [string, PreloadBridgeAPI];

    await api.operator.unlockSession({ method: 'pin', pin: '1234' });
    await api.operator.getLockState();

    expect(ipcRendererInvoke).toHaveBeenCalledWith(SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION, {
      method: 'pin',
      pin: '1234',
    });
    expect(ipcRendererInvoke).toHaveBeenCalledWith(SESSION_LOCK_IPC_CHANNELS.GET_LOCK_STATE);
  });
});
