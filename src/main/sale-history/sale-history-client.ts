/**
 * RT-542 — the Backend-Core sale-history client (`sale-history.yaml`, RT-537):
 *
 *   list             GET  /api/pos/v1/sale-history
 *   read             GET  /api/pos/v1/sale-history/{saleRef}
 *   authorizeReprint POST /api/pos/v1/sale-history/{saleRef}/reprints  (mode authorize)
 *
 * Backend-Core only; never ERPNext / Frappe / the Connector.
 *
 * The credential is an explicit argument, chosen by the main process from the
 * admitted session (OD-534-1):
 *   • `envelope` (manager / admin): `Authorization: Bearer <pos_operator envelope>`
 *     and NO `X-Cashier-Admission` (the contract answers 401 when both come);
 *   • `device` (cashier): `Authorization: Bearer <device token>` plus
 *     `X-Cashier-Admission: <admission_id>` — the admission is a selector, the
 *     device token is the credential (RT-537 Q-2).
 * The client never reads a session or a token itself, and never logs, stores or
 * bridges one. No usable credential → no request.
 *
 * `record`-mode reprints (a local reprint reported after the fact) need a
 * durable queue and are not sent here (RT-542 PR: follow-up).
 *
 * Outcome mapping:
 *   200 / 201 readable  → ok
 *   200 / 201 off-contract → unreadable
 *   400 → invalid · 401 / 403 → unauthorized · 404 → not_found
 *   422 → duplicate_unavailable (reprint only)
 *   429 / 5xx / any other status → server_error (the server answered)
 *   network / timeout / no credential → unreachable
 *   a body over 2 MB → unreadable (bounded memory on an untrusted answer)
 * Never throws.
 */

import type { SaleHistoryReprintKind } from '../../shared/sale-history/types.js';
import { isUuid, parseJsonBody } from '../returns/returns-wire.js';
import {
  isServerCursor,
  readHistoryDetail,
  readHistoryPage,
  readReprintBody,
  type WireHistoryDetail,
  type WireHistoryPage,
  type WireReprint,
} from './sale-history-wire.js';

export const SALE_HISTORY_PATH = '/api/pos/v1/sale-history';
export const SALE_HISTORY_REQUEST_TIMEOUT_MS = 15_000;

/** The contract `Idempotency-Key` rule (RT-181). */
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{16,128}$/;

export type SaleHistoryCredential =
  | { readonly kind: 'envelope'; readonly token: string }
  | { readonly kind: 'device'; readonly token: string; readonly admissionId: string };

type Failure =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'server_error' }
  | { readonly kind: 'unreachable' };

export type ListOutcome = { readonly kind: 'ok'; readonly page: WireHistoryPage } | Failure;
export type ReadOutcome = { readonly kind: 'ok'; readonly detail: WireHistoryDetail } | Failure;
export type ReprintOutcome =
  | { readonly kind: 'ok'; readonly reprint: WireReprint }
  | { readonly kind: 'duplicate_unavailable' }
  | Failure;

export interface ListQuery {
  readonly from: string;
  readonly to: string;
  readonly pageSize: number;
  readonly cursor: string | null;
}

export interface AuthorizeReprintRequest {
  readonly saleRef: string;
  readonly kind: SaleHistoryReprintKind;
  /** The terminal's print time (provenance). */
  readonly printedAt: string;
  readonly idempotencyKey: string;
}

export interface SaleHistoryClient {
  list(query: ListQuery, credential: SaleHistoryCredential): Promise<ListOutcome>;
  read(saleRef: string, credential: SaleHistoryCredential): Promise<ReadOutcome>;
  authorizeReprint(
    request: AuthorizeReprintRequest,
    credential: SaleHistoryCredential,
  ): Promise<ReprintOutcome>;
}

export interface CreateSaleHistoryClientDeps {
  readonly baseUrl: string;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

interface HttpAnswer {
  readonly status: number;
  readonly json: unknown;
}

const FAILURE_BY_STATUS: Readonly<Record<number, Failure>> = {
  400: { kind: 'invalid' },
  401: { kind: 'unauthorized' },
  403: { kind: 'unauthorized' },
  404: { kind: 'not_found' },
};

const UNREACHABLE: Failure = { kind: 'unreachable' };
const SERVER_ERROR: Failure = { kind: 'server_error' };

/** The largest answer body read, in bytes (UTF-8 on the wire). */
export const SALE_HISTORY_MAX_BODY_BYTES = 2_000_000;

function failureOf(status: number): Failure {
  return FAILURE_BY_STATUS[status] ?? SERVER_ERROR;
}

/**
 * The body as text, read incrementally and abandoned (the stream cancelled) as
 * soon as it passes the cap, whatever Content-Length says; null when too large.
 */
async function boundedText(response: Response): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    bytes += chunk.value.byteLength;
    if (bytes > SALE_HISTORY_MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
}

/** The parsed body, or undefined when it is too large to read. */
async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > SALE_HISTORY_MAX_BODY_BYTES) return undefined;
  const text = await boundedText(response);
  return text === null ? undefined : parseJsonBody(text);
}

/** The auth headers of a usable credential, or null (→ no request). */
function authHeaders(credential: SaleHistoryCredential): Record<string, string> | null {
  if (credential.token.length === 0) return null;
  const authorization = { Authorization: `Bearer ${credential.token}` };
  if (credential.kind === 'envelope') return authorization;
  if (!isUuid(credential.admissionId)) return null;
  return { ...authorization, 'X-Cashier-Admission': credential.admissionId };
}

/** Maps a 2xx answer through `read`, else the status failure. */
function okOr<T, R extends { readonly kind: 'ok' }>(
  answer: HttpAnswer | null,
  okStatus: number,
  read: (json: unknown) => T | null,
  wrap: (value: T) => R,
): R | Failure {
  if (answer === null) return UNREACHABLE;
  if (answer.status !== okStatus) return failureOf(answer.status);
  const value = read(answer.json);
  return value === null ? { kind: 'unreadable' } : wrap(value);
}

function listUrl(query: ListQuery): string {
  const params = new URLSearchParams({
    from: query.from,
    to: query.to,
    page_size: String(query.pageSize),
  });
  if (query.cursor !== null) params.set('cursor', query.cursor);
  return `?${params.toString()}`;
}

export function createSaleHistoryClient(deps: CreateSaleHistoryClientDeps): SaleHistoryClient {
  const root = deps.baseUrl.replace(/\/$/, '');
  const timeoutMs = deps.timeoutMs ?? SALE_HISTORY_REQUEST_TIMEOUT_MS;

  /** One HTTP exchange; null on no credential or any transport fault. */
  async function exchange(
    path: string,
    request: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
    credential: SaleHistoryCredential,
  ): Promise<HttpAnswer | null> {
    const auth = authHeaders(credential);
    if (auth === null) return null;
    try {
      const response = await deps.fetch(`${root}${SALE_HISTORY_PATH}${path}`, {
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
        headers: { ...request.headers, ...auth },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, json: await boundedJson(response) };
    } catch {
      return null;
    }
  }

  return {
    async list(query, credential) {
      if (query.cursor !== null && !isServerCursor(query.cursor)) return { kind: 'invalid' };
      const answer = await exchange(listUrl(query), { method: 'GET', headers: {} }, credential);
      return okOr(answer, 200, readHistoryPage, (page) => ({ kind: 'ok', page }));
    },

    async read(saleRef, credential) {
      if (!isUuid(saleRef)) return { kind: 'not_found' };
      const answer = await exchange(`/${saleRef}`, { method: 'GET', headers: {} }, credential);
      return okOr(answer, 200, readHistoryDetail, (detail) => ({ kind: 'ok', detail }));
    },

    async authorizeReprint(request, credential) {
      if (!isUuid(request.saleRef)) return { kind: 'not_found' };
      if (!IDEMPOTENCY_KEY.test(request.idempotencyKey)) return { kind: 'invalid' };
      const answer = await exchange(
        `/${request.saleRef}/reprints`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': request.idempotencyKey,
          },
          body: JSON.stringify({
            mode: 'authorize',
            kind: request.kind,
            printedAt: request.printedAt,
          }),
        },
        credential,
      );
      if (answer?.status === 422) return { kind: 'duplicate_unavailable' };
      return okOr(answer, 201, readReprintBody, (reprint) => ({ kind: 'ok', reprint }));
    },
  };
}
