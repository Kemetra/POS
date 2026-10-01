import type { IpcMain } from 'electron';

import { SESSION_LOCK_IPC_CHANNELS } from '../../shared/operator/channels.js';
import type {
  LockStateView,
  UnlockSessionRequest,
  UnlockSessionResponse,
} from '../../shared/bridge-api.js';
import type { OperatorRefusal } from '../../shared/audit/event-shape.js';

/**
 * RT-117 (RT-116 §2.4, §7.2) — `operator:unlock-session` and
 * `operator:get-lock-state`. Both are on the locked-session allowlist
 * (`session-lock-guard.ts`). Boundary validation copies only the known
 * fields and refuses generically; a thrown error never crosses the bridge.
 */

export interface SessionLockHandlerDeps {
  unlockHandler: { unlock(req: UnlockSessionRequest): Promise<UnlockSessionResponse> };
  getLockState: () => LockStateView;
}

const REFUSE_INVALID: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function asUnlockRequest(value: unknown): UnlockSessionRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['method'] === 'pin' && nonEmpty(v['pin'])) {
    return { method: 'pin', pin: v['pin'] };
  }
  if (v['method'] === 'online_credential' && nonEmpty(v['identifier']) && nonEmpty(v['password'])) {
    return { method: 'online_credential', identifier: v['identifier'], password: v['password'] };
  }
  return null;
}

export function registerSessionLockHandlers(ipcMain: IpcMain, deps: SessionLockHandlerDeps): void {
  ipcMain.handle(
    SESSION_LOCK_IPC_CHANNELS.UNLOCK_SESSION,
    async (_event, request: unknown): Promise<UnlockSessionResponse> => {
      const req = asUnlockRequest(request);
      if (req === null) return REFUSE_INVALID;
      try {
        return await deps.unlockHandler.unlock(req);
      } catch {
        return REFUSE_INVALID;
      }
    },
  );

  ipcMain.handle(
    SESSION_LOCK_IPC_CHANNELS.GET_LOCK_STATE,
    (): LockStateView => deps.getLockState(),
  );
}
