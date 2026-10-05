/**
 * RT-217 — the registry of every Backend-Core call the POS makes.
 *
 * Each entry drives the REAL production client against a recording `fetch`, so the
 * suite observes the method, URL and `Authorization` header the client actually
 * sends; nothing about the request is declared by hand except the path template it
 * should resolve to. Each credential seam is fed the credential the composition
 * root (`src/main/index.ts`) wires into it in production, as a recognisable
 * sentinel; `wiring` names that source.
 *
 * Completeness is enforced by the suite, not by convention:
 *   - every `src/**` module that calls an injected `fetch` must appear in
 *     `CLIENT_MODULES` (or `NON_BACKEND_CORE_TRANSPORTS`) with its exact number of
 *     call sites;
 *   - every Backend-Core path literal (`/api/...`) in a client module must belong
 *     to a registered call;
 *   - for a factory-built client, its method set must equal the registered set.
 * A new client or client method therefore fails the suite until it is registered
 * here — and once registered, it is checked against the pinned contract.
 */
import { createBackendClient } from '../../../src/main/operator/backend-client.js';
import { createCashierAdmissionClient } from '../../../src/main/operator/cashier-admission-client.js';
import { createNetwork } from '../../../src/main/pairing/network.js';
import { createReadDownClient } from '../../../src/main/catalogue/read-down/read-down-client.js';
import { createSaleSyncClient } from '../../../src/main/sales-sync/create-sale-sync-client.js';
import type { CaptureSalePayload } from '../../../src/main/sales-sync/capture-payload.js';
import { createReturnsClient } from '../../../src/main/returns/returns-client.js';
import { validateVoucher } from '../../../src/main/payments/voucher-authority-client/validate.js';
import { redeemVoucher } from '../../../src/main/payments/voucher-authority-client/redeem.js';
import { reverseVoucher } from '../../../src/main/payments/voucher-authority-client/reverse.js';
import type { HttpMethod } from './openapi-index.js';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Base URL the harness gives every client. */
export const BASE_URL = 'https://backend-core.contract.invalid';

/**
 * Sentinel credentials. The suite classifies an observed request by which of these
 * it carries as `Authorization: Bearer <sentinel>`.
 */
export const SENTINEL = {
  device: 'sentinel-device-token',
  'operator-jwt': 'sentinel-operator-identity-jwt',
  'operator-envelope': 'sentinel-pos-operator-envelope',
} as const;

const SALE_REF = '0190a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b';
const UUID = '0190a3c4-0000-4000-8000-000000000001';

const NOOP_LOGGER = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

const CAPTURE_PAYLOAD: CaptureSalePayload = {
  externalId: 'pos-pulse:contract-conformance',
  sourceSystem: 'pos-pulse',
  tenantId: 't1',
  branchId: 'b1',
  terminalId: 'term-1',
  operatorId: 'op-1',
  occurredAt: '2026-10-04T10:00:00.000Z',
  totalMinor: 1000,
  lines: [
    {
      lineRef: 'l1',
      productRef: 'p1',
      lineName: 'Item',
      quantity: 1,
      unitPriceMinor: 1000,
      lineAmountMinor: 1000,
    },
  ],
};

export interface ClientCall {
  /** `<client>.<method>` — must equal the client's own method / function name. */
  readonly id: string;
  /** Repo-relative module that issues the request. */
  readonly module: string;
  readonly method: HttpMethod;
  /** The Backend-Core contract path template this call must resolve to. */
  readonly pathTemplate: string;
  /** The composition-root source of the credential this call's seam receives. */
  readonly wiring: string;
  /** Drive the real client once through `fetch`. */
  readonly invoke: (fetch: FetchLike) => Promise<unknown>;
}

export interface ClientModule {
  readonly module: string;
  /** Exact count of injected-`fetch` call expressions in the module. */
  readonly fetchCallSites: number;
  /**
   * For factory-built clients: build one, so the suite can compare its method set
   * with the registered calls. Omitted for modules exporting one function per call.
   */
  readonly surface?: (fetch: FetchLike) => object;
}

const backendClient = (fetch: FetchLike): ReturnType<typeof createBackendClient> =>
  createBackendClient({ baseUrl: BASE_URL, fetch });
const returnsClient = (fetch: FetchLike): ReturnType<typeof createReturnsClient> =>
  createReturnsClient({ baseUrl: BASE_URL, fetch });
const readDownClient = (fetch: FetchLike): ReturnType<typeof createReadDownClient> =>
  createReadDownClient({
    baseUrl: BASE_URL,
    fetch,
    getDeviceToken: () => Promise.resolve(SENTINEL.device),
  });
const saleSyncClient = (fetch: FetchLike): ReturnType<typeof createSaleSyncClient> =>
  createSaleSyncClient({
    baseUrl: BASE_URL,
    fetch,
    getOperatorToken: () => SENTINEL['operator-envelope'],
  });
const pairingNetwork = (fetch: FetchLike): ReturnType<typeof createNetwork> =>
  createNetwork({ baseUrl: BASE_URL, fetch });
const cashierAdmissionClient = (
  fetch: FetchLike,
): ReturnType<typeof createCashierAdmissionClient> =>
  createCashierAdmissionClient({
    baseUrl: BASE_URL,
    fetch,
    getDeviceToken: () => Promise.resolve(SENTINEL.device),
  });

const BACKEND_CLIENT = 'src/main/operator/backend-client.ts';
const CASHIER_ADMISSION_CLIENT = 'src/main/operator/cashier-admission-client.ts';
const CASHIER_ADMISSION_WIRING =
  'index.ts createCashierAdmissionClient: `getDeviceToken` reads DEVICE_TOKEN_KEY (paired only)';
const VOUCHER_DIR = 'src/main/payments/voucher-authority-client';

export const CLIENT_MODULES: readonly ClientModule[] = [
  { module: BACKEND_CLIENT, fetchCallSites: 2, surface: backendClient },
  { module: 'src/main/pairing/network.ts', fetchCallSites: 1, surface: pairingNetwork },
  { module: CASHIER_ADMISSION_CLIENT, fetchCallSites: 1, surface: cashierAdmissionClient },
  {
    module: 'src/main/catalogue/read-down/read-down-client.ts',
    fetchCallSites: 1,
    surface: readDownClient,
  },
  {
    module: 'src/main/sales-sync/create-sale-sync-client.ts',
    fetchCallSites: 1,
    surface: saleSyncClient,
  },
  { module: 'src/main/returns/returns-client.ts', fetchCallSites: 1, surface: returnsClient },
  { module: `${VOUCHER_DIR}/validate.ts`, fetchCallSites: 1 },
  { module: `${VOUCHER_DIR}/redeem.ts`, fetchCallSites: 1 },
  { module: `${VOUCHER_DIR}/reverse.ts`, fetchCallSites: 1 },
];

/** Modules that call `fetch` but not Backend-Core. Each needs a reason. */
export const NON_BACKEND_CORE_TRANSPORTS: ReadonlyArray<{
  readonly module: string;
  readonly fetchCallSites: number;
  readonly reason: string;
}> = [
  {
    module: 'src/main/operator/clerk-client.ts',
    fetchCallSites: 2,
    reason:
      'Clerk Frontend API (the identity provider) — mints the operator-identity JWT; not a Backend-Core route.',
  },
];

export const CLIENT_CALLS: readonly ClientCall[] = [
  {
    id: 'backendClient.signIn',
    module: BACKEND_CLIENT,
    method: 'post',
    pathTemplate: '/api/pos/v1/operators/sign-in',
    wiring: 'sign-in-handler.ts: the Clerk-exchanged JWT (`exchange.jwt`)',
    invoke: (fetch) =>
      backendClient(fetch).signIn(
        { kind: 'manager_admin', device_token_attestation: SENTINEL.device },
        SENTINEL['operator-jwt'],
      ),
  },
  {
    id: 'backendClient.signOut',
    module: BACKEND_CLIENT,
    method: 'post',
    pathTemplate: '/api/pos/v1/operators/sign-out',
    wiring: 'sign-out-handler.ts: operatorJwtHolder (`jwtFor`)',
    invoke: (fetch) => backendClient(fetch).signOut({ session_id: UUID }, SENTINEL['operator-jwt']),
  },
  {
    id: 'backendClient.listRoster',
    module: BACKEND_CLIENT,
    method: 'get',
    pathTemplate: '/api/pos/v1/operators/roster',
    wiring: 'none — the method takes no credential (pin-management.ts)',
    invoke: (fetch) => backendClient(fetch).listRoster(UUID),
  },
  {
    id: 'backendClient.confirmTakeover',
    module: BACKEND_CLIENT,
    method: 'post',
    pathTemplate: '/api/pos/v1/operators/takeover/confirm',
    wiring: 'takeover-handler.ts: the proto-session JWT (`proto.jwt`)',
    invoke: (fetch) =>
      backendClient(fetch).confirmTakeover(
        { event_id: UUID, operator_id: 'op-1', device_token_attestation: SENTINEL.device },
        SENTINEL['operator-jwt'],
      ),
  },
  {
    id: 'backendClient.getStuckShifts',
    module: BACKEND_CLIENT,
    method: 'get',
    pathTemplate: '/api/pos/v1/shifts/stuck',
    wiring: 'stuck-shifts-handler.ts: operatorJwtHolder',
    invoke: (fetch) => backendClient(fetch).getStuckShifts(UUID, SENTINEL['operator-jwt']),
  },
  {
    id: 'cashierAdmissionClient.admit',
    module: CASHIER_ADMISSION_CLIENT,
    method: 'post',
    pathTemplate: '/api/pos/v1/cashier-admissions',
    wiring: CASHIER_ADMISSION_WIRING,
    invoke: (fetch) =>
      cashierAdmissionClient(fetch).admit({
        mode: 'online',
        user_id: UUID,
        takeover: false,
        idempotency_key: 'pos-cashier-adm-contract-conformance',
      }),
  },
  {
    id: 'cashierAdmissionClient.end',
    module: CASHIER_ADMISSION_CLIENT,
    method: 'post',
    pathTemplate: '/api/pos/v1/cashier-admissions/{admission_id}/end',
    wiring: CASHIER_ADMISSION_WIRING,
    invoke: (fetch) => cashierAdmissionClient(fetch).end(UUID),
  },
  {
    id: 'cashierAdmissionClient.listRoster',
    module: CASHIER_ADMISSION_CLIENT,
    method: 'get',
    pathTemplate: '/api/pos/v1/cashier-admissions/roster',
    wiring: CASHIER_ADMISSION_WIRING,
    invoke: (fetch) => cashierAdmissionClient(fetch).listRoster(),
  },
  {
    id: 'pairingNetwork.pair',
    module: 'src/main/pairing/network.ts',
    method: 'post',
    pathTemplate: '/api/pos/v1/terminals/pair',
    wiring: 'none — pairing precedes any credential (index.ts createNetwork)',
    invoke: (fetch) => pairingNetwork(fetch).pair('ABCD-1234'),
  },
  {
    id: 'readDownClient.fetchSnapshot',
    module: 'src/main/catalogue/read-down/read-down-client.ts',
    method: 'get',
    pathTemplate: '/api/pos/v1/catalog/snapshot',
    wiring: 'index.ts read-down driver: `getDeviceToken` reads DEVICE_TOKEN_KEY',
    invoke: (fetch) => readDownClient(fetch).fetchSnapshot(),
  },
  {
    id: 'saleSyncClient.postSale',
    module: 'src/main/sales-sync/create-sale-sync-client.ts',
    method: 'post',
    pathTemplate: '/api/pos/v1/sales',
    wiring: 'index.ts: `getOperatorToken` = createSaleSyncTokenReader(…, operatorEnvelopeHolder)',
    invoke: (fetch) => saleSyncClient(fetch).postSale(CAPTURE_PAYLOAD),
  },
  {
    id: 'returnsClient.readSale',
    module: 'src/main/returns/returns-client.ts',
    method: 'get',
    pathTemplate: '/api/pos/v1/sales/{saleRef}',
    wiring: 'compose-returns.ts: the authorization snapshot envelope (operatorEnvelopeHolder)',
    invoke: (fetch) => returnsClient(fetch).readSale(SALE_REF, SENTINEL['operator-envelope']),
  },
  {
    id: 'returnsClient.recordReturn',
    module: 'src/main/returns/returns-client.ts',
    method: 'post',
    pathTemplate: '/api/pos/v1/sales/{saleRef}/returns',
    wiring: 'compose-returns.ts: the authorization snapshot envelope (operatorEnvelopeHolder)',
    invoke: (fetch) =>
      returnsClient(fetch).recordReturn(
        {
          saleRef: SALE_REF,
          bodyJson: '{}',
          idempotencyKey: 'pos-pulse-return:contract-conformance',
          resend: false,
        },
        SENTINEL['operator-envelope'],
      ),
  },
  {
    id: 'validateVoucher',
    module: `${VOUCHER_DIR}/validate.ts`,
    method: 'post',
    pathTemplate: '/api/pos/v1/vouchers/validate',
    wiring: 'none — the function takes no credential (apply-voucher-line.ts)',
    invoke: (fetch) =>
      validateVoucher(
        {
          code: 'VOUCHER',
          payment_attempt_id: UUID,
          applied_amount_minor: 100,
          remaining_balance_minor: 100,
        },
        { baseUrl: BASE_URL, fetch, logger: NOOP_LOGGER, idempotencyKey: UUID },
      ),
  },
  {
    id: 'redeemVoucher',
    module: `${VOUCHER_DIR}/redeem.ts`,
    method: 'post',
    pathTemplate: '/api/pos/v1/vouchers/redeem',
    wiring: 'none — the function takes no credential (payments-confirm.ts)',
    invoke: (fetch) =>
      redeemVoucher(
        { payment_attempt_id: UUID, redemption_intent_token: 'intent' },
        { baseUrl: BASE_URL, fetch, logger: NOOP_LOGGER, idempotencyKey: UUID },
      ),
  },
  {
    id: 'reverseVoucher',
    module: `${VOUCHER_DIR}/reverse.ts`,
    method: 'post',
    pathTemplate: '/api/pos/v1/vouchers/reverse',
    wiring: 'none — the function takes no credential (index.ts deferred-reversal resolver)',
    invoke: (fetch) =>
      reverseVoucher(
        { redemption_id: UUID },
        { baseUrl: BASE_URL, fetch, logger: NOOP_LOGGER, idempotencyKey: UUID },
      ),
  },
];
