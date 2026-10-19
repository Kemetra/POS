/**
 * RT-15 S2 — the Backend-Core returns client.
 *
 * Two calls, both to the Backend-Core POS sales surface and nowhere else
 * (AC7 — never ERPNext / Frappe):
 *
 *   readSale     GET  /api/pos/v1/sales/{saleRef}
 *   recordReturn POST /api/pos/v1/sales/{saleRef}/returns
 *
 * Auth is the `operatorAuthorization` scheme: `Authorization: Bearer
 * <pos_operator envelope>`. The envelope is an explicit argument of every call
 * — the admitted authorization snapshot's own (RT-197 A5) — so the client never
 * reads the live session or token itself; it is never logged, stored or
 * bridged. No envelope → no request. `recordReturn` sends
 * the journaled body bytes verbatim with `Idempotency-Key` = the return's
 * `externalId`, so every retry is the identical request.
 *
 * Outcome mapping (contract + `sale-returns.service.ts` / `sales.controller.ts`):
 *   201 / 200          → recorded (a replay when `Idempotent-Replayed: true`
 *                        or 200); the body must carry the needed `SaleReturn`
 *                        fields, else `unknown` (the answer was not readable —
 *                        a resend replays it)
 *   400                → validation_error
 *   401 / 403          → unauthorized      (first send only; a resend → unknown)
 *   403 credit_sale_reversal_restricted (RT-577, RT-196 OD-196-9)
 *                      → that refusal, on a first send AND a resend: Backend-Core
 *                        decides it after the provenance replay, so it is
 *                        terminal for the request
 *   404                → returns_unavailable (gate off, or unknown sale;
 *                        first send only; a resend → unknown)
 *   409 over_return / already_reversed → that code; any other 409
 *                        (`conflict`, `idempotency_key_conflict`) → conflict
 *   422                → return_tender_mismatch
 *   429 / 5xx / other / network / timeout / no credential → unknown, with its
 *                        closed `cause` (RT-196 S1: why the answer is unknown)
 *
 * `unknown` is never success: nothing proves the server did or did not record
 * the return. Never throws.
 */
import type { ReturnUnknownCause, ServerReturnRefusal } from '../../shared/returns/types.js';
import {
  isUuid,
  parseJsonBody,
  readErrorCode,
  readSaleBody,
  readSaleReturnBody,
  type WireSale,
  type WireSaleReturn,
} from './returns-wire.js';

const SALES_PATH = '/api/pos/v1/sales';
/**
 * The request timeout of every returns exchange. Exported so the resolver's
 * drain bound (`RETURNS_DRAIN_TIMEOUT_MS`) is derived from it.
 */
export const RETURNS_REQUEST_TIMEOUT_MS = 15_000;

export type ReadSaleOutcome =
  | { readonly kind: 'ok'; readonly sale: WireSale }
  | { readonly kind: 'refused'; readonly reason: ServerReturnRefusal }
  | { readonly kind: 'unavailable' };

export type RecordReturnOutcome =
  | { readonly kind: 'recorded'; readonly replayed: boolean; readonly saleReturn: WireSaleReturn }
  | { readonly kind: 'refused'; readonly reason: ServerReturnRefusal }
  | { readonly kind: 'unknown'; readonly cause: ReturnUnknownCause };

export interface RecordReturnRequest {
  readonly saleRef: string;
  /** The exact JSON body from the journal (re-sent byte-identical). */
  readonly bodyJson: string;
  /** The return `externalId` (`pos-pulse-return:<uuidv7>`). */
  readonly idempotencyKey: string;
  /**
   * True when this send may follow an earlier one that reached the server
   * (the journal row was already attempted; a never-attempted row — even one
   * the resolver sends after a crash — is a first send). Backend-Core answers 401
   * (envelope refused) and 404 (`POS_RETURNS_ENABLED` off) BEFORE its
   * provenance replay, so on a resend those say nothing about whether the
   * return was recorded: they map to `unknown`, never a terminal refusal.
   */
  readonly resend: boolean;
}

/**
 * The opaque operator envelope a call authenticates with: the admitted
 * authorization snapshot's own (`AuthSnapshot.envelope`), or null (→ no request).
 */
export type OperatorEnvelope = string | null;

export interface ReturnsClient {
  readSale(saleRef: string, envelope: OperatorEnvelope): Promise<ReadSaleOutcome>;
  recordReturn(
    request: RecordReturnRequest,
    envelope: OperatorEnvelope,
  ): Promise<RecordReturnOutcome>;
}

export interface CreateReturnsClientDeps {
  /** Backend-Core base URL. */
  readonly baseUrl: string;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

type HttpAnswer = { readonly status: number; readonly headers: Headers; readonly json: unknown };

/** An exchange that produced no HTTP answer, and why. */
type ExchangeFault = { readonly fault: 'no_credential' | 'timeout' | 'network' };

const STATUS_REFUSALS: Readonly<Record<number, ServerReturnRefusal>> = {
  400: 'validation_error',
  401: 'unauthorized',
  403: 'unauthorized',
  404: 'returns_unavailable',
  422: 'return_tender_mismatch',
};

const CONFLICT_CODES: ReadonlySet<string> = new Set(['over_return', 'already_reversed']);

/** RT-577's credit refusal: a 403 told apart from the operator guard's by `error.code`. */
const CREDIT_REVERSAL_CODE = 'credit_sale_reversal_restricted';

/** Map a non-2xx status (and its `error.code`) onto a refusal, or null = unknown. */
export function classifyRefusal(status: number, code: string | null): ServerReturnRefusal | null {
  if (status === 409) {
    return code !== null && CONFLICT_CODES.has(code) ? (code as ServerReturnRefusal) : 'conflict';
  }
  if (status === 403 && code === CREDIT_REVERSAL_CODE) return CREDIT_REVERSAL_CODE;
  return STATUS_REFUSALS[status] ?? null;
}

function isReplay(answer: HttpAnswer): boolean {
  return answer.status === 200 || answer.headers.get('Idempotent-Replayed') === 'true';
}

/**
 * Statuses Backend-Core decides before the provenance replay (the operator
 * guard's 401/403, the deployment gate's 404). Deterministic on a first send;
 * inconclusive on a resend, where the return may already be recorded.
 */
const PRE_REPLAY_STATUSES: ReadonlySet<number> = new Set([401, 403, 404]);

const PRE_REPLAY_CAUSES: Readonly<Record<number, ReturnUnknownCause>> = {
  401: 'pre_replay_401',
  403: 'pre_replay_403',
  404: 'pre_replay_404',
};

/** Why a status the contract does not map to a refusal leaves the answer unknown. */
function causeOfStatus(status: number): ReturnUnknownCause {
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'server_5xx' : 'unexpected_status';
}

/**
 * A pre-replay status on a resend says nothing about whether the return was
 * recorded, so it stays unknown. The credit refusal is the exception: decided
 * AFTER the provenance replay, so terminal even on a resend (OD-196-9).
 */
function isInconclusiveResend(answer: HttpAnswer, resend: boolean, reason: string | null) {
  if (!resend || !PRE_REPLAY_STATUSES.has(answer.status)) return false;
  return reason !== CREDIT_REVERSAL_CODE;
}

function toRecordOutcome(answer: HttpAnswer, resend: boolean): RecordReturnOutcome {
  if (answer.status === 200 || answer.status === 201) {
    const saleReturn = readSaleReturnBody(answer.json);
    if (saleReturn === null) return { kind: 'unknown', cause: 'unreadable_body' };
    return { kind: 'recorded', replayed: isReplay(answer), saleReturn };
  }
  const reason = classifyRefusal(answer.status, readErrorCode(answer.json));
  if (isInconclusiveResend(answer, resend, reason)) {
    return { kind: 'unknown', cause: PRE_REPLAY_CAUSES[answer.status] ?? 'unexpected_status' };
  }
  return reason === null
    ? { kind: 'unknown', cause: causeOfStatus(answer.status) }
    : { kind: 'refused', reason };
}

function toReadOutcome(answer: HttpAnswer): ReadSaleOutcome {
  if (answer.status === 200) {
    const sale = readSaleBody(answer.json);
    return sale === null ? { kind: 'unavailable' } : { kind: 'ok', sale };
  }
  const reason = classifyRefusal(answer.status, readErrorCode(answer.json));
  return reason === null ? { kind: 'unavailable' } : { kind: 'refused', reason };
}

function isFault(answer: HttpAnswer | ExchangeFault): answer is ExchangeFault {
  return 'fault' in answer;
}

/** The request's own `AbortSignal.timeout` fired (a `TimeoutError`, or an abort). */
function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export function createReturnsClient(deps: CreateReturnsClientDeps): ReturnsClient {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? RETURNS_REQUEST_TIMEOUT_MS;

  /** One HTTP exchange; a fault (never thrown) on no credential or any transport/body failure. */
  async function exchange(request: {
    path: string;
    init: RequestInit;
    envelope: OperatorEnvelope;
  }): Promise<HttpAnswer | ExchangeFault> {
    const token = request.envelope;
    if (token === null || token.length === 0) return { fault: 'no_credential' };
    try {
      const response = await deps.fetch(`${root}${SALES_PATH}${request.path}`, {
        ...request.init,
        headers: {
          ...(request.init.headers as Record<string, string>),
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = parseJsonBody(await response.text());
      return { status: response.status, headers: response.headers, json };
    } catch (err) {
      return { fault: isTimeout(err) ? 'timeout' : 'network' };
    }
  }

  return {
    async readSale(saleRef: string, envelope: OperatorEnvelope): Promise<ReadSaleOutcome> {
      if (!isUuid(saleRef)) return { kind: 'refused', reason: 'returns_unavailable' };
      const init: RequestInit = { method: 'GET', headers: {} };
      const answer = await exchange({ path: `/${saleRef}`, init, envelope });
      return isFault(answer) ? { kind: 'unavailable' } : toReadOutcome(answer);
    },

    async recordReturn(
      request: RecordReturnRequest,
      envelope: OperatorEnvelope,
    ): Promise<RecordReturnOutcome> {
      if (!isUuid(request.saleRef)) return { kind: 'refused', reason: 'returns_unavailable' };
      const answer = await exchange({
        envelope,
        path: `/${request.saleRef}/returns`,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': request.idempotencyKey,
          },
          body: request.bodyJson,
        },
      });
      return isFault(answer)
        ? { kind: 'unknown', cause: answer.fault }
        : toRecordOutcome(answer, request.resend);
    },
  };
}
