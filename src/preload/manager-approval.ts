import { ipcRenderer } from 'electron';

import {
  MANAGER_APPROVAL_IPC_CHANNELS,
  type ManagerApprovalBridgeAPI,
  type ManagerApprovalRequest,
  type ManagerApprovalResponse,
  type ManagerApproversResponse,
} from '../shared/operator/manager-approval.js';
import type { ManagerActionKind } from '../shared/operator/manager-action-kinds.js';

/**
 * RT-443 (MA-2) — `approval.*` preload bridge. Thin wire-up: each member is one
 * `ipcRenderer.invoke` on a typed channel. Main validates every payload,
 * checks the session and the manager's PIN, and owns the approval; the PIN
 * only goes in, and only an opaque `approval_id` comes back.
 */
export const approval: ManagerApprovalBridgeAPI = {
  listApprovers: (req: { action_kind: ManagerActionKind }) =>
    ipcRenderer.invoke(
      MANAGER_APPROVAL_IPC_CHANNELS.LIST_APPROVERS,
      req,
    ) as Promise<ManagerApproversResponse>,
  request: (req: ManagerApprovalRequest) =>
    ipcRenderer.invoke(
      MANAGER_APPROVAL_IPC_CHANNELS.REQUEST,
      req,
    ) as Promise<ManagerApprovalResponse>,
};
