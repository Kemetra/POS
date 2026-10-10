import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import type { ResumeStateView } from '../../shared/bridge-api.js';
import { RESUME_STATE_IPC_CHANNELS } from '../../shared/operator/channels.js';

/**
 * RT-352 (RT-116 §7.2) — `operator:get-resume-state`. Read-only, no request
 * arguments, and not on the locked-session allowlist (refused while locked).
 * The view carries ids and a count only. A failing read never crosses the
 * bridge as an error: it is logged and answered as "nothing to resume", and
 * the cart stays held for the next sign-in.
 */

export interface ResumeStateHandlerDeps {
  getResumeState: () => ResumeStateView;
  logger?: Pick<Logger, 'error'>;
}

const NOTHING_TO_RESUME: ResumeStateView = {
  cart_id: null,
  payment_attempt_id: null,
  other_held_cart_count: 0,
};

export function registerResumeStateHandler(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: ResumeStateHandlerDeps,
): void {
  ipcMain.handle(RESUME_STATE_IPC_CHANNELS.GET_RESUME_STATE, (): ResumeStateView => {
    try {
      return deps.getResumeState();
    } catch (err) {
      deps.logger?.error({ err, event: 'resume_state.read.failed' }, 'resume state read failed');
      return NOTHING_TO_RESUME;
    }
  });
}
