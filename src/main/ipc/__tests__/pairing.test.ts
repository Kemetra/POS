import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { registerPairingHandlers } from '../pairing.js';
import { PAIRING_IPC_CHANNELS } from '../../../shared/pairing-types.js';
import type { PairingStatus, PairingSubmitResult } from '../../../shared/pairing-types.js';
import type { PairingStore } from '../../pairing/store.js';
import type { PairingService } from '../../pairing/service.js';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * 002-terminal-pairing T012 + T024 — `pairing:*` IPC handler tests.
 *
 * The handler is the bridge between the renderer's
 * `window.api.pairing.*` and the main-process services. Mirrors the
 * Phase 9 `app:config` pattern: store + service are INJECTED so the
 * handler under test never reaches into a process-global. Constitution
 * III (no ad-hoc strings): the channel name comes from the canonical
 * PAIRING_IPC_CHANNELS constant.
 *
 * US2 scope (T024): adds the SUBMIT channel to the same registration
 * entry-point. The handler:
 *   - is registered exactly once under `PAIRING_IPC_CHANNELS.SUBMIT`,
 *   - rejects non-string input BEFORE reaching the service (defensive
 *     boundary check; the service ALSO checks, but we want to fail
 *     before crossing the trust boundary),
 *   - forwards the service's result unchanged (no rewrapping, no
 *     filtering — the service already shaped a renderer-safe
 *     PairingSubmitResult).
 */

function makeFakeStore(status: PairingStatus): PairingStore {
  return {
    getStatus: vi.fn(() => Promise.resolve(status)),
    getCurrentTerminalId: vi.fn(() => (status.kind === 'paired' ? status.terminal_id : null)),
    persist: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
  };
}

function makeFakeService(result: PairingSubmitResult): {
  service: PairingService;
  submit: ReturnType<typeof vi.fn<(code: string) => Promise<PairingSubmitResult>>>;
} {
  const submit = vi.fn<(code: string) => Promise<PairingSubmitResult>>(() =>
    Promise.resolve(result),
  );
  return { service: { submit }, submit };
}

const SUCCESS_RESULT: PairingSubmitResult = {
  outcome: 'success',
  tenant_id: 'tenant-A',
  branch_id: 'branch-B',
  terminal_id: 'terminal-C',
  terminal_label: 'Counter 1',
};

describe('registerPairingHandlers — pairing:get-status (T012)', () => {
  it('registers the handler under PAIRING_IPC_CHANNELS.GET_STATUS', () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const store = makeFakeStore({ kind: 'unpaired' });
    const { service } = makeFakeService(SUCCESS_RESULT);

    registerPairingHandlers(ipcMain, { store, service });

    expect(PAIRING_IPC_CHANNELS.GET_STATUS).toBe('pairing:get-status');
    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels).toContain(PAIRING_IPC_CHANNELS.GET_STATUS);
    // Each channel registered exactly once.
    expect(channels.filter((c) => c === PAIRING_IPC_CHANNELS.GET_STATUS)).toHaveLength(1);
  });

  it('forwards the store result for the unpaired branch unchanged', async () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const expected: PairingStatus = { kind: 'unpaired' };
    const store = makeFakeStore(expected);
    const { service } = makeFakeService(SUCCESS_RESULT);

    registerPairingHandlers(ipcMain, { store, service });

    const captured = handle.mock.calls.find((c) => c[0] === PAIRING_IPC_CHANNELS.GET_STATUS)?.[1];
    if (!captured) throw new Error('GET_STATUS handler not registered');
    const result = await captured({} as IpcMainInvokeEvent);
    expect(result).toEqual(expected);
  });

  it('forwards the store result for the paired branch unchanged', async () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const expected: PairingStatus = {
      kind: 'paired',
      tenant_id: 'tenant-A',
      branch_id: 'branch-B',
      terminal_id: 'terminal-C',
      terminal_label: 'Counter 1',
      paired_at: 1735689600,
    };
    const store = makeFakeStore(expected);
    const { service } = makeFakeService(SUCCESS_RESULT);

    registerPairingHandlers(ipcMain, { store, service });

    const captured = handle.mock.calls.find((c) => c[0] === PAIRING_IPC_CHANNELS.GET_STATUS)?.[1];
    if (!captured) throw new Error('GET_STATUS handler not registered');
    const result = await captured({} as IpcMainInvokeEvent);
    expect(result).toEqual(expected);
  });

  it('forwards the store result for each invalid reason unchanged', async () => {
    for (const reason of ['missing_token', 'orphaned_row', 'decrypt_failed'] as const) {
      const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
      const ipcMain = { handle } as unknown as IpcMain;
      const expected: PairingStatus = { kind: 'invalid', reason };
      const store = makeFakeStore(expected);
      const { service } = makeFakeService(SUCCESS_RESULT);

      registerPairingHandlers(ipcMain, { store, service });

      const captured = handle.mock.calls.find((c) => c[0] === PAIRING_IPC_CHANNELS.GET_STATUS)?.[1];
      if (!captured) throw new Error('GET_STATUS handler not registered');
      const result = await captured({} as IpcMainInvokeEvent);
      expect(result).toEqual(expected);
    }
  });

  it('calls the store on every invocation (no caching)', async () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const getStatusMock = vi.fn<() => Promise<PairingStatus>>(() =>
      Promise.resolve({ kind: 'unpaired' }),
    );
    const store: PairingStore = {
      getStatus: getStatusMock,
      getCurrentTerminalId: vi.fn(() => null),
      persist: vi.fn(() => Promise.resolve()),
      clear: vi.fn(() => Promise.resolve()),
    };
    const { service } = makeFakeService(SUCCESS_RESULT);

    registerPairingHandlers(ipcMain, { store, service });

    const captured = handle.mock.calls.find((c) => c[0] === PAIRING_IPC_CHANNELS.GET_STATUS)?.[1];
    if (!captured) throw new Error('GET_STATUS handler not registered');
    await captured({} as IpcMainInvokeEvent);
    await captured({} as IpcMainInvokeEvent);
    expect(getStatusMock).toHaveBeenCalledTimes(2);
  });
});

describe('registerPairingHandlers — pairing:submit (T024)', () => {
  it('registers the handler under PAIRING_IPC_CHANNELS.SUBMIT exactly once', () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const store = makeFakeStore({ kind: 'unpaired' });
    const { service } = makeFakeService(SUCCESS_RESULT);

    registerPairingHandlers(ipcMain, { store, service });

    expect(PAIRING_IPC_CHANNELS.SUBMIT).toBe('pairing:submit');
    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels).toContain(PAIRING_IPC_CHANNELS.SUBMIT);
    expect(channels.filter((c) => c === PAIRING_IPC_CHANNELS.SUBMIT)).toHaveLength(1);
  });

  it('forwards the service success result unchanged', async () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const store = makeFakeStore({ kind: 'unpaired' });
    const { service, submit } = makeFakeService(SUCCESS_RESULT);

    registerPairingHandlers(ipcMain, { store, service });

    const captured = handle.mock.calls.find((c) => c[0] === PAIRING_IPC_CHANNELS.SUBMIT)?.[1];
    if (!captured) throw new Error('SUBMIT handler not registered');
    const result = await captured({} as IpcMainInvokeEvent, 'VALIDCODE');

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('VALIDCODE');
    expect(result).toEqual(SUCCESS_RESULT);
  });

  it('forwards each catch-all outcome (network_error, unknown_error) unchanged', async () => {
    for (const outcome of ['network_error', 'unknown_error'] as const) {
      const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
      const ipcMain = { handle } as unknown as IpcMain;
      const store = makeFakeStore({ kind: 'unpaired' });
      const expected: PairingSubmitResult = { outcome };
      const { service } = makeFakeService(expected);

      registerPairingHandlers(ipcMain, { store, service });

      const captured = handle.mock.calls.find((c) => c[0] === PAIRING_IPC_CHANNELS.SUBMIT)?.[1];
      if (!captured) throw new Error('SUBMIT handler not registered');
      const result = await captured({} as IpcMainInvokeEvent, 'CODE');
      expect(result).toEqual(expected);
    }
  });

  it('rejects non-string input BEFORE reaching the service', async () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const store = makeFakeStore({ kind: 'unpaired' });
    const { service, submit } = makeFakeService(SUCCESS_RESULT);

    registerPairingHandlers(ipcMain, { store, service });

    const captured = handle.mock.calls.find((c) => c[0] === PAIRING_IPC_CHANNELS.SUBMIT)?.[1];
    if (!captured) throw new Error('SUBMIT handler not registered');

    // Each non-string input MUST throw (sync or rejection) before
    // reaching the service. Electron's IPC layer turns a sync throw
    // into a rejection on the renderer side, so the observable
    // behaviour is identical; we accept either form here.
    for (const bad of [undefined, null, 42, true, {}, [], Symbol('x')]) {
      let caught = false;
      try {
        const r = captured({} as IpcMainInvokeEvent, bad);
        if (r instanceof Promise) await r;
      } catch {
        caught = true;
      }
      expect(caught).toBe(true);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it('does NOT include pairing_code in the rejection message for non-string input', async () => {
    // Defensive: the rejection message MUST be a stable string that
    // does not echo the renderer-supplied payload (which could itself
    // be a sensitive object). Constitution VII.
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const store = makeFakeStore({ kind: 'unpaired' });
    const { service } = makeFakeService(SUCCESS_RESULT);

    registerPairingHandlers(ipcMain, { store, service });

    const captured = handle.mock.calls.find((c) => c[0] === PAIRING_IPC_CHANNELS.SUBMIT)?.[1];
    if (!captured) throw new Error('SUBMIT handler not registered');

    const sentinel = 'SUPER-SECRET-CONTAMINATION';
    let capturedErr: unknown = null;
    try {
      const r = captured({} as IpcMainInvokeEvent, { code: sentinel });
      if (r instanceof Promise) await r;
    } catch (err) {
      capturedErr = err;
    }
    expect(capturedErr).toBeInstanceOf(Error);
    if (capturedErr instanceof Error) {
      expect(capturedErr.message).not.toContain(sentinel);
    }
  });

  it('calls the service on every invocation (no caching)', async () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const store = makeFakeStore({ kind: 'unpaired' });
    const { service, submit } = makeFakeService({ outcome: 'unknown_error' });

    registerPairingHandlers(ipcMain, { store, service });

    const captured = handle.mock.calls.find((c) => c[0] === PAIRING_IPC_CHANNELS.SUBMIT)?.[1];
    if (!captured) throw new Error('SUBMIT handler not registered');
    await captured({} as IpcMainInvokeEvent, 'CODE_A');
    await captured({} as IpcMainInvokeEvent, 'CODE_B');
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledWith('CODE_A');
    expect(submit).toHaveBeenCalledWith('CODE_B');
  });

  it('the SUBMIT channel name is namespace-prefixed under "pairing:" (Constitution III)', () => {
    expect(PAIRING_IPC_CHANNELS.SUBMIT.startsWith('pairing:')).toBe(true);
  });

  it('SUBMIT and GET_STATUS are the only channels registered (no namespace creep)', () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const store = makeFakeStore({ kind: 'unpaired' });
    const { service } = makeFakeService(SUCCESS_RESULT);

    registerPairingHandlers(ipcMain, { store, service });

    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels.sort()).toEqual(
      [PAIRING_IPC_CHANNELS.GET_STATUS, PAIRING_IPC_CHANNELS.SUBMIT].sort(),
    );
  });
});

describe('registerPairingHandlers — pairing:recheck (RT-215 10897-A)', () => {
  it('registers the RECHECK channel once when the recheck is wired, and forwards its result', async () => {
    const handle = vi.fn<(channel: string, fn: IpcHandler) => void>();
    const ipcMain = { handle } as unknown as IpcMain;
    const recheck = vi.fn(() => Promise.resolve({ outcome: 'still_revoked' } as const));
    registerPairingHandlers(ipcMain, {
      store: makeFakeStore({ kind: 'invalid', reason: 'device_revoked' }),
      service: makeFakeService(SUCCESS_RESULT).service,
      recheck,
    });

    expect(PAIRING_IPC_CHANNELS.RECHECK).toBe('pairing:recheck');
    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels.filter((c) => c === PAIRING_IPC_CHANNELS.RECHECK)).toHaveLength(1);
    const captured = handle.mock.calls.find((c) => c[0] === PAIRING_IPC_CHANNELS.RECHECK)?.[1];
    if (captured === undefined) throw new Error('RECHECK handler not registered');
    // The renderer can only TRIGGER it: any argument it sends is ignored.
    await expect(captured({} as IpcMainInvokeEvent, { token: 'x' })).resolves.toEqual({
      outcome: 'still_revoked',
    });
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledWith();
  });
});
