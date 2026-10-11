import type { IpcMain } from 'electron';

import { REAUTH_IPC_CHANNELS } from '../../shared/operator/channels.js';
import type { ReauthenticateRequest, ReauthenticateResponse } from '../../shared/bridge-api.js';
import type { OperatorRefusal } from '../../shared/audit/event-shape.js';

/**
 * RT-358 (RT-247 D-A1) — `operator:reauthenticate`. Not on the locked-session
 * allowlist, so the lock guard refuses it while locked. Boundary validation
 * copies only `identifier` and `password` (non-empty strings) and refuses
 * generically; a thrown error never crosses the bridge. The response carries a
 * kind or a refusal category only — never the JWT.
 */

export interface ReauthHandlerIpcDeps {
  reauthHandler: { reauthenticate(req: ReauthenticateRequest): Promise<ReauthenticateResponse> };
}

const REFUSE_INVALID: OperatorRefusal = { kind: 'refused', category: 'invalid_input' };

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function asReauthenticateRequest(value: unknown): ReauthenticateRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const identifier = v['identifier'];
  const password = v['password'];
  if (!nonEmpty(identifier) || !nonEmpty(password)) return null;
  return { identifier, password };
}

export function registerReauthHandler(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: ReauthHandlerIpcDeps,
): void {
  ipcMain.handle(
    REAUTH_IPC_CHANNELS.REAUTHENTICATE,
    async (_event, request: unknown): Promise<ReauthenticateResponse> => {
      const req = asReauthenticateRequest(request);
      if (req === null) return REFUSE_INVALID;
      try {
        return await deps.reauthHandler.reauthenticate(req);
      } catch {
        return REFUSE_INVALID;
      }
    },
  );
}
