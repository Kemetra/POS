/**
 * RT-17 slice 3 part 2 — `createShiftSyncClient`: sends ONE queued shift fact
 * to Backend-Core on the DEVICE path (`pos-shifts.openapi.yaml` 1.1.0-draft,
 * `openShift` / `recordCashMovement` / `closeShift`).
 *
 * What is sent. The fact's STORED request body, byte for byte, and its STORED
 * `Idempotency-Key` (both decided once, when the fact was recorded; RT-17
 * 10931 / 10934), with `Authorization: Bearer <device token>`. The path comes
 * from the fact's kind and its shift id. The client never builds, parses or
 * re-serialises a body, so every retry is the same request.
 *
 * Never sent:
 *   • an `envelope` row (a manager-envelope repair of a dead letter; 10919
 *     decision 4). Its body has no `operatorUserId`, and the envelope client
 *     is a later part of RT-17; it is never sent with the device bearer →
 *     `not_sent` `envelope_path`;
 *   • a fact handed to the method of another kind → `not_sent` `kind_mismatch`;
 *   • without a device token (unpaired, revoked, a failing secret-store read)
 *     → `not_sent` `no_device_credential`;
 *   • under any terminal but the fact's own (RT-221): the current pairing is
 *     read before and between two token reads and once more, synchronously,
 *     right before the request, as the sale client does (Codex P2 on #547). A
 *     re-pair during the reads → `not_sent` `terminal_changed`.
 *
 * Outcome mapping (from the status; the body is read only to label a refusal):
 *   200 / 201 → `ok`, a first record or a replay (`Idempotent-Replayed`);
 *   425 / 429 → `transient` with the parsed `Retry-After` (RT-194);
 *   5xx, an unexpected 2xx / 3xx → `transient`;
 *   transport fault or timeout → `no_connection`;
 *   401 → `device_unauthorized` (the device credential; the fact stays queued);
 *   403 → `rejected` `cashier_claim_refused` (the generic `refused`; never a
 *     revocation; the body is not read);
 *   400 / 404 / 409 / 422 → `rejected` with the contract's `error.code` when
 *     it is one the contract documents for that status, else `rejected`
 *     (any other 4xx too).
 *
 * RT-215: every answer is reported to the device-401 detector through
 * `withDeviceCallObservation`, tagged `sale_sync` (`SHIFT_SYNC_DEVICE_SOURCE`).
 * The tag names the device-path outbox sync family, which the shift drain
 * joins: a new tag would change the closed `DeviceRevokedSource` set carried
 * by the `pairing.device_revoked` audit payload and the RT-215 detector in
 * `src/main/pairing/`, and the sale-sync tag already means "a device-only
 * fetch whose every answer counts".
 *
 * Never logged, never in a result: the token, the body, server text (P7).
 */
import {
  withDeviceCallObservation,
  type DeviceAuthDetector,
} from '../pairing/device-auth-detector.js';
import { parseRetryAfterMs } from '../sales-sync/retry-after.js';
import type { QueuedShiftFact, ShiftSyncDeadLetterReason } from './shift-cashup-repo.js';
import type { ShiftFactKind } from './shift-wire.js';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The RT-215 detector tag of the shift drain's device fetch (see the header). */
export const SHIFT_SYNC_DEVICE_SOURCE = 'sale_sync' as const;

const SHIFTS_PATH = '/api/pos/v1/shifts';
/** The default request timeout (also the bound of a stopping worker's drain). */
export const SHIFT_SYNC_REQUEST_TIMEOUT_MS = 15_000;

/** One fact to send, with the terminal it was recorded on (the drain's scope). */
export interface ShiftSyncSend {
  terminalId: string;
  fact: QueuedShiftFact;
}

export type ShiftSyncNotSentReason =
  | 'envelope_path'
  | 'kind_mismatch'
  | 'no_device_credential'
  | 'terminal_changed';

export type ShiftSyncResult =
  | { kind: 'ok' }
  | { kind: 'transient'; retryAfterMs?: number }
  | { kind: 'no_connection' }
  | { kind: 'device_unauthorized' }
  | { kind: 'rejected'; reason: ShiftSyncDeadLetterReason }
  | { kind: 'not_sent'; reason: ShiftSyncNotSentReason };

/** One method per contract operation; each resolves, never rejects. */
export interface ShiftSyncClient {
  openShift(input: ShiftSyncSend): Promise<ShiftSyncResult>;
  recordCashMovement(input: ShiftSyncSend): Promise<ShiftSyncResult>;
  closeShift(input: ShiftSyncSend): Promise<ShiftSyncResult>;
}

export interface CreateShiftSyncClientDeps {
  /** Backend-Core base URL. */
  baseUrl: string;
  /** The device-path fetch (production: the global fetch). */
  fetch: FetchLike;
  /** RT-215: the device-401 detector every answer is reported to. */
  detector: Pick<DeviceAuthDetector, 'observe'>;
  /** The paired terminal's device token, read fresh per send; null when none. */
  getDeviceToken: () => Promise<string | null>;
  /** The current pairing's `terminal_id`, synchronously; null when unpaired. */
  currentTerminalId: () => string | null;
  timeoutMs?: number;
  /** Epoch-ms clock for an HTTP-date `Retry-After`. Defaults to `Date.now`. */
  nowMs?: () => number;
}

/** The contract path of a fact: the kind decides the operation, the shift id the resource. */
export function shiftFactPath(fact: Pick<QueuedShiftFact, 'factKind' | 'shiftId'>): string {
  if (fact.factKind === 'open') return SHIFTS_PATH;
  const operation = fact.factKind === 'movement' ? 'cash-movements' : 'close';
  return `${SHIFTS_PATH}/${encodeURIComponent(fact.shiftId)}/${operation}`;
}

/**
 * The refusal codes the contract documents per status (`OpenShiftConflict`,
 * `CashMovementConflict`, `CloseShiftConflict`, `CloseShiftUnprocessable`,
 * `ShiftNotFound`, `ValidationFailure`), as 0043 dead-letter reasons.
 */
const CONTRACT_CODES: ReadonlyMap<number, ReadonlySet<string>> = new Map([
  [400, new Set(['validation_error'])],
  [404, new Set(['shift_not_found'])],
  [
    409,
    new Set([
      'idempotency_key_conflict',
      'shift_payload_conflict',
      'shift_already_open',
      'shift_closed',
    ]),
  ],
  [422, new Set(['shift_cashup_inconsistent', 'currency_mismatch', 'refund_ref_invalid'])],
]);

const OK_STATUSES: ReadonlySet<number> = new Set([200, 201]);
const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([425, 429]);

type StatusClass = 'ok' | 'retry_after' | 'transient' | 'unauthorized' | 'refused' | 'rejected';

/** The class of an HTTP status (no body needed). */
function classifyStatus(status: number): StatusClass {
  if (OK_STATUSES.has(status)) return 'ok';
  if (RETRY_AFTER_STATUSES.has(status)) return 'retry_after';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'refused';
  if (status >= 500) return 'transient';
  return status >= 400 ? 'rejected' : 'transient';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `error.code` of an `ApiError` body, or null. Pure; never throws. */
function errorCodeOf(bodyText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const error = isRecord(parsed) ? parsed['error'] : undefined;
    const code = isRecord(error) ? error['code'] : undefined;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/** The dead-letter reason of a refusal: a documented code of its status, else `rejected`. */
async function refusalReason(response: Response): Promise<ShiftSyncDeadLetterReason> {
  let code: string | null;
  try {
    code = errorCodeOf(await response.text());
  } catch {
    return 'rejected';
  }
  const documented = CONTRACT_CODES.get(response.status)?.has(code ?? '') === true;
  return documented ? (code as ShiftSyncDeadLetterReason) : 'rejected';
}

type TokenRead =
  | { kind: 'token'; token: string }
  | { kind: 'not_sent'; reason: ShiftSyncNotSentReason };

export function createShiftSyncClient(deps: CreateShiftSyncClientDeps): ShiftSyncClient {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? SHIFT_SYNC_REQUEST_TIMEOUT_MS;
  const nowMs = deps.nowMs ?? Date.now;
  // RT-215: every answer of this device-only fetch counts for the detector.
  const fetchImpl = withDeviceCallObservation(deps.fetch, deps.detector, SHIFT_SYNC_DEVICE_SOURCE);

  /** The current pairing is `terminalId` right now (fail closed). */
  function onTerminal(terminalId: string): boolean {
    try {
      return deps.currentTerminalId() === terminalId;
    } catch {
      return false;
    }
  }

  /** The device token; null when none or the read fails. */
  async function readToken(): Promise<string | null> {
    try {
      const token = await deps.getDeviceToken();
      return token === null || token.length === 0 ? null : token;
    } catch {
      return null;
    }
  }

  /** The token of the fact's terminal: terminal, token, terminal, token again. */
  async function tokenOf(terminalId: string): Promise<TokenRead> {
    const changed: TokenRead = { kind: 'not_sent', reason: 'terminal_changed' };
    if (!onTerminal(terminalId)) return changed;
    const token = await readToken();
    if (token === null) return { kind: 'not_sent', reason: 'no_device_credential' };
    if (!onTerminal(terminalId)) return changed;
    return (await readToken()) === token ? { kind: 'token', token } : changed;
  }

  /** RT-194 `Retry-After`; a failing clock leaves the normal backoff in charge. */
  function retryAfter(response: Response): ShiftSyncResult {
    try {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), nowMs());
      return retryAfterMs === undefined
        ? { kind: 'transient' }
        : { kind: 'transient', retryAfterMs };
    } catch {
      return { kind: 'transient' };
    }
  }

  const outcomes: Readonly<
    Record<StatusClass, (response: Response) => ShiftSyncResult | Promise<ShiftSyncResult>>
  > = {
    ok: () => ({ kind: 'ok' }),
    retry_after: retryAfter,
    transient: () => ({ kind: 'transient' }),
    unauthorized: () => ({ kind: 'device_unauthorized' }),
    refused: () => ({ kind: 'rejected', reason: 'cashier_claim_refused' }),
    rejected: async (response) => ({ kind: 'rejected', reason: await refusalReason(response) }),
  };

  async function post(input: { fact: QueuedShiftFact; token: string }): Promise<ShiftSyncResult> {
    const { fact } = input;
    let response: Response;
    try {
      response = await fetchImpl(`${root}${shiftFactPath(fact)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.token}`,
          'Idempotency-Key': fact.idempotencyKey,
        },
        body: fact.requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { kind: 'no_connection' };
    }
    return outcomes[classifyStatus(response.status)](response);
  }

  /** Why `fact` cannot go out through the method of `kind` on the device path, or null. */
  function refusalToSend(input: {
    kind: ShiftFactKind;
    fact: QueuedShiftFact;
  }): ShiftSyncNotSentReason | null {
    if (input.fact.authPath !== 'device') return 'envelope_path';
    return input.fact.factKind === input.kind ? null : 'kind_mismatch';
  }

  async function send(kind: ShiftFactKind, input: ShiftSyncSend): Promise<ShiftSyncResult> {
    const refused = refusalToSend({ kind, fact: input.fact });
    if (refused !== null) return { kind: 'not_sent', reason: refused };
    const read = await tokenOf(input.terminalId);
    if (read.kind === 'not_sent') return read;
    // T3: no await between this check and the request.
    if (!onTerminal(input.terminalId)) return { kind: 'not_sent', reason: 'terminal_changed' };
    return post({ fact: input.fact, token: read.token });
  }

  return {
    openShift: (input) => send('open', input),
    recordCashMovement: (input) => send('movement', input),
    closeShift: (input) => send('close', input),
  };
}
