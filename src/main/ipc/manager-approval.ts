/**
 * RT-443 (MA-2) — `approval:*` IPC: `listApprovers` and `request`.
 *
 * Every payload is a closed shape, validated before the service runs; anything
 * else answers `invalid_input` and reaches nothing:
 *   • `listApprovers`: exactly `{ action_kind }`, a catalogued kind;
 *   • `request`: exactly `{ action_kind, subject_ref, reason_code,
 *     reason_note?, approver_ref, pin }` — a catalogued kind, a bounded id, a
 *     reason code (`^[a-z][a-z0-9_]{0,39}$`), an optional note of at most 200
 *     characters, a manager handle (lower-case UUID) and a manager PIN (6–8
 *     digits).
 *
 * Neither channel is on the locked-session allowlist (default deny). An
 * unexpected failure is logged by its name only (never the PIN) and answers
 * the generic `approval_unavailable`.
 */
import type { IpcMain } from 'electron';
import type { Logger } from 'pino';

import { isManagerActionKind } from '../../shared/operator/manager-action-kinds.js';
import {
  APPROVAL_REASON_CODE_PATTERN,
  APPROVAL_REASON_NOTE_MAX_LENGTH,
  MANAGER_APPROVAL_IPC_CHANNELS,
  type ManagerApprovalRequest,
  type ManagerApprovalResponse,
  type ManagerApproversResponse,
} from '../../shared/operator/manager-approval.js';
import type { ManagerActionKind } from '../../shared/operator/manager-action-kinds.js';
import { MANAGER_PIN_PATTERN, MANAGER_REF_PATTERN } from '../../shared/shift-cashup/types.js';
import type { ManagerApprovalService } from '../operator/manager-approval-service.js';

const INVALID = { kind: 'refused', reason: 'invalid_input' } as const;
const SUBJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const LIST_KEYS = ['action_kind'] as const;
const REQUEST_KEYS = [
  'action_kind',
  'subject_ref',
  'reason_code',
  'reason_note',
  'approver_ref',
  'pin',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  return !Array.isArray(value);
}

function isClosedShape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}

function isString(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

/** `{ action_kind }` exactly, or null. */
export function readListApproversRequest(
  value: unknown,
): { action_kind: ManagerActionKind } | null {
  if (!isClosedShape(value, LIST_KEYS)) return null;
  const kind = value['action_kind'];
  return isManagerActionKind(kind) ? { action_kind: kind } : null;
}

function readNote(value: unknown): { reason_note?: string } | null {
  if (value === undefined) return {};
  if (typeof value !== 'string' || value.length > APPROVAL_REASON_NOTE_MAX_LENGTH) return null;
  return { reason_note: value };
}

/** The request's required fields, each with its check. */
const REQUIRED_FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  action_kind: isManagerActionKind,
  subject_ref: (value) => isString(value, SUBJECT_REF_PATTERN),
  reason_code: (value) => isString(value, APPROVAL_REASON_CODE_PATTERN),
  approver_ref: (value) => isString(value, MANAGER_REF_PATTERN),
  pin: (value) => isString(value, MANAGER_PIN_PATTERN),
};

function hasRequiredFields(value: Record<string, unknown>): boolean {
  return Object.entries(REQUIRED_FIELDS).every(([key, check]) => check(value[key]));
}

/** The approval request's closed shape, or null. */
export function readApprovalRequest(value: unknown): ManagerApprovalRequest | null {
  if (!isClosedShape(value, REQUEST_KEYS) || !hasRequiredFields(value)) return null;
  const note = readNote(value['reason_note']);
  if (note === null) return null;
  const { action_kind, subject_ref, reason_code, approver_ref, pin } =
    value as unknown as ManagerApprovalRequest;
  return { action_kind, subject_ref, reason_code, approver_ref, pin, ...note };
}

export interface ManagerApprovalIpcDeps {
  service: Pick<ManagerApprovalService, 'listApprovers' | 'request'>;
  logger: Pick<Logger, 'warn'>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function registerManagerApprovalHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: ManagerApprovalIpcDeps,
): void {
  const { service, logger } = deps;
  const unavailable = (op: string, error: unknown) => {
    logger.warn({ op, error: errorName(error) }, 'approval:failed');
    return { kind: 'refused', reason: 'approval_unavailable' } as const;
  };

  ipcMain.handle(
    MANAGER_APPROVAL_IPC_CHANNELS.LIST_APPROVERS,
    (_event, request: unknown): ManagerApproversResponse | typeof INVALID => {
      const req = readListApproversRequest(request);
      if (req === null) return INVALID;
      try {
        return service.listApprovers({ actionKind: req.action_kind });
      } catch (error) {
        return unavailable('listApprovers', error);
      }
    },
  );

  ipcMain.handle(
    MANAGER_APPROVAL_IPC_CHANNELS.REQUEST,
    async (_event, request: unknown): Promise<ManagerApprovalResponse | typeof INVALID> => {
      const req = readApprovalRequest(request);
      if (req === null) return INVALID;
      try {
        const outcome = await service.request(req);
        return outcome.kind === 'approved'
          ? { kind: 'approved', approval_id: outcome.approvalId }
          : outcome;
      } catch (error) {
        return unavailable('request', error);
      }
    },
  );
}
