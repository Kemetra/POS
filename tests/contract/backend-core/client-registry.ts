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
import { createSaleVoidClient } from '../../../src/main/sale-void/sale-void-client.js';
import {
  createSaleHistoryClient,
  type SaleHistoryCredential,
} from '../../../src/main/sale-history/sale-history-client.js';
import type { QueuedShiftFact } from '../../../src/main/shift-cashup/shift-cashup-repo.js';
import type { ShiftFactKind } from '../../../src/main/shift-cashup/shift-wire.js';
import { createShiftSyncClient } from '../../../src/main/shift-cashup/shift-sync-client.js';
import { buildForcedCloseShiftRequest } from '../../../src/main/shift-cashup/shift-wire.js';
import { validateVoucher } from '../../../src/main/payments/voucher-authority-client/validate.js';
import { redeemVoucher } from '../../../src/main/payments/voucher-authority-client/redeem.js';
import { reverseVoucher } from '../../../src/main/payments/voucher-authority-client/reverse.js';
import { runLivenessProbe } from '../../../src/main/terminal-status/liveness-probe.js';
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

const SHIFT_TERMINAL = 'term-1';

/** A queued manager-envelope forced close (RT-554), built by the real wire builder. */
function forcedCloseEnvelopeFact(): { terminalId: string; fact: QueuedShiftFact } {
  const built = buildForcedCloseShiftRequest({
    currencyCode: 'EGP',
    forcedReason: 'cashier_no_show',
    fact: {
      shiftId: UUID,
      closedAt: '2026-10-05T16:00:00.000Z',
      closingUserId: UUID,
      openingFloatMinor: 50_000,
      cashSalesTotalMinor: 0,
      cashRefundsTotalMinor: 0,
      payInTotalMinor: 0,
      payOutTotalMinor: 0,
      expectedCashMinor: 50_000,
      countedCashMinor: 50_000,
      varianceMinor: 0,
      saleCount: 0,
      cashRefundReturnRefs: [],
    },
  });
  return {
    terminalId: SHIFT_TERMINAL,
    fact: {
      seq: 1,
      factKind: 'close',
      shiftId: UUID,
      authPath: 'envelope',
      idempotencyKey: built.request.idempotencyKey,
      requestBody: built.request.body,
      attemptCount: 0,
    },
  };
}

/** A queued device-path shift fact (RT-17); the client sends its stored bytes as they are. */
function shiftFact(factKind: ShiftFactKind): { terminalId: string; fact: QueuedShiftFact } {
  return {
    terminalId: SHIFT_TERMINAL,
    fact: {
      seq: 1,
      factKind,
      shiftId: UUID,
      authPath: 'device',
      idempotencyKey: `pos-pulse-shift-${factKind}:${UUID}`,
      requestBody: '{}',
      attemptCount: 0,
    },
  };
}

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
const saleVoidClient = (fetch: FetchLike): ReturnType<typeof createSaleVoidClient> =>
  createSaleVoidClient({ baseUrl: BASE_URL, fetch });
const saleHistoryClient = (fetch: FetchLike): ReturnType<typeof createSaleHistoryClient> =>
  createSaleHistoryClient({ baseUrl: BASE_URL, fetch });
/** RT-542: both credential paths of every sale-history call (OD-534-1). */
const SALE_HISTORY_CREDENTIALS: readonly SaleHistoryCredential[] = [
  { kind: 'envelope', token: SENTINEL['operator-envelope'] },
  { kind: 'device', token: SENTINEL.device, admissionId: UUID },
];
const SALE_HISTORY_MODULE = 'src/main/sale-history/sale-history-client.ts';
const SALE_HISTORY_WIRING =
  'sale-history-credential.ts: manager/admin = the session envelope (operatorEnvelopeHolder); cashier = createSendableDeviceTokenRead + the session own X-Cashier-Admission';
async function eachSaleHistoryCredential(
  call: (credential: SaleHistoryCredential) => Promise<unknown>,
): Promise<void> {
  await Promise.all(SALE_HISTORY_CREDENTIALS.map((credential) => call(credential)));
}
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
    getDeviceToken: () => Promise.resolve(SENTINEL.device),
    currentTerminalId: () => CAPTURE_PAYLOAD.terminalId,
  });
const shiftSyncClient = (fetch: FetchLike): ReturnType<typeof createShiftSyncClient> =>
  createShiftSyncClient({
    baseUrl: BASE_URL,
    fetch,
    detector: { observe: () => undefined },
    getDeviceToken: () => Promise.resolve(SENTINEL.device),
    currentTerminalId: () => SHIFT_TERMINAL,
    // RT-554: a forced close goes out under a manager / admin's operator envelope.
    getEnvelope: () => SENTINEL['operator-envelope'],
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
  'index.ts createCashierAdmissionClient: `getDeviceToken` = createSendableDeviceTokenReader (paired only; never once revoked, RT-215)';
const VOUCHER_DIR = 'src/main/payments/voucher-authority-client';
const SHIFT_SYNC_CLIENT = 'src/main/shift-cashup/shift-sync-client.ts';
const SHIFT_SYNC_WIRING =
  'not wired yet (RT-17 slice 3 part 3): `getDeviceToken` = createSendableDeviceTokenReader (paired only; never once revoked, RT-215)';
const SHIFT_SYNC_ENVELOPE_WIRING =
  'index.ts startShiftSync: `getEnvelope` = createManagerEnvelopeReader (the manager / admin session envelope from operatorEnvelopeHolder; null for a cashier session)';

const LIVENESS_PROBE = 'src/main/terminal-status/liveness-probe.ts';

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
  // RT-530: the sale void, under the requester's own operator envelope only.
  { module: 'src/main/sale-void/sale-void-client.ts', fetchCallSites: 1, surface: saleVoidClient },
  // RT-542: the store-wide sales history (envelope or device + cashier admission).
  { module: SALE_HISTORY_MODULE, fetchCallSites: 1, surface: saleHistoryClient },
  { module: SHIFT_SYNC_CLIENT, fetchCallSites: 1, surface: shiftSyncClient },
  { module: `${VOUCHER_DIR}/validate.ts`, fetchCallSites: 1 },
  { module: `${VOUCHER_DIR}/redeem.ts`, fetchCallSites: 1 },
  { module: `${VOUCHER_DIR}/reverse.ts`, fetchCallSites: 1 },
  // RT-602: the connection monitor's credential-free liveness probe.
  { module: LIVENESS_PROBE, fetchCallSites: 1 },
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
  {
    module: 'src/main/operator/descope-client.ts',
    fetchCallSites: 1,
    reason:
      'RT-792 Descope password sign-in (the alternative identity provider) — mints the operator-identity JWT; not a Backend-Core route.',
  },
];

/**
 * RT-215 — transport DECORATORS: they call the fetch they wrap with the request
 * an already-registered client built, unchanged, and originate no request of
 * their own. Each needs a reason.
 */
export const TRANSPORT_DECORATORS: ReadonlyArray<{
  readonly module: string;
  readonly fetchCallSites: number;
  readonly reason: string;
}> = [
  {
    module: 'src/main/pairing/device-auth-detector.ts',
    fetchCallSites: 1,
    reason:
      'withDeviceAuthObservation wraps the fetch of the device-bearer clients (cashier admissions, read-down) and only reads the response status for the RT-215 device-401 detector.',
  },
  {
    module: 'src/main/terminal-status/reachability-observation.ts',
    fetchCallSites: 1,
    reason:
      'RT-601 withReachabilityObservation wraps the fetch of the Backend-Core device and operator clients and only reports the response status, or that the request rejected, to the connection monitor; request and response pass through untouched.',
  },
  {
    module: 'src/main/terminal-status/compose-terminal-status.ts',
    fetchCallSites: 1,
    reason:
      'RT-602 trackInFlight wraps the same observed fetch and only counts the request as in flight (no liveness probe meanwhile); request and response pass through untouched.',
  },
  {
    module: 'src/main/observability/request-id.ts',
    fetchCallSites: 1,
    reason:
      'RT-634 withRequestId wraps the base fetch of every Backend-Core client and the liveness probe: it adds a fresh UUID X-Request-Id header (OBS-1 contract §2; not declared in the pinned OpenAPI — Backend-Core honours it globally) and logs id, method, path and status; other headers, body and response pass through untouched.',
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
    wiring: 'pin-management.ts: operatorJwtHolder (the manager session, RT-214)',
    invoke: (fetch) => backendClient(fetch).listRoster(UUID, SENTINEL['operator-jwt']),
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
    invoke: (fetch) => cashierAdmissionClient(fetch).end(UUID, 'contract-conformance-generation'),
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
    wiring:
      'index.ts read-down driver: `getDeviceToken` = createSendableDeviceTokenReader (paired only; never once revoked, RT-215)',
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
    // RT-224 step 2 (Option B, sales.yaml 1.5.0-draft): the device bearer plus the
    // sale's own cashier `operatorUserId` (never the envelope).
    id: 'saleSyncClient.postSaleAsCashier',
    module: 'src/main/sales-sync/create-sale-sync-client.ts',
    method: 'post',
    pathTemplate: '/api/pos/v1/sales',
    wiring: 'index.ts: `getDeviceToken` reads DEVICE_TOKEN_KEY (paired only)',
    invoke: (fetch) => saleSyncClient(fetch).postSaleAsCashier(CAPTURE_PAYLOAD, UUID),
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
  // RT-530: the queued sale void. The envelope is the requester's own (the
  // server binds `approval.requesterUserId` to it); there is no device path.
  {
    id: 'saleVoidClient.recordVoid',
    module: 'src/main/sale-void/sale-void-client.ts',
    method: 'post',
    pathTemplate: '/api/pos/v1/sales/{saleRef}/void',
    wiring:
      'compose-sale-void.ts: the signed-in requester envelope (operatorEnvelopeHolder), sent only while the requester is the signed-in operator',
    invoke: (fetch) =>
      saleVoidClient(fetch).recordVoid(
        {
          saleRef: SALE_REF,
          bodyJson: '{}',
          idempotencyKey: 'pos-pulse-void:contract-conformance',
        },
        SENTINEL['operator-envelope'],
      ),
  },
  // RT-542: the store-wide sales history, detail and reprint authorization.
  {
    id: 'saleHistoryClient.list',
    module: SALE_HISTORY_MODULE,
    method: 'get',
    pathTemplate: '/api/pos/v1/sale-history',
    wiring: SALE_HISTORY_WIRING,
    invoke: (fetch) =>
      eachSaleHistoryCredential((credential) =>
        saleHistoryClient(fetch).list(
          { from: '2026-10-01', to: '2026-10-16', pageSize: 50, cursor: null },
          credential,
        ),
      ),
  },
  {
    id: 'saleHistoryClient.read',
    module: SALE_HISTORY_MODULE,
    method: 'get',
    pathTemplate: '/api/pos/v1/sale-history/{saleRef}',
    wiring: SALE_HISTORY_WIRING,
    invoke: (fetch) =>
      eachSaleHistoryCredential((credential) =>
        saleHistoryClient(fetch).read(SALE_REF, credential),
      ),
  },
  {
    id: 'saleHistoryClient.authorizeReprint',
    module: SALE_HISTORY_MODULE,
    method: 'post',
    pathTemplate: '/api/pos/v1/sale-history/{saleRef}/reprints',
    wiring: SALE_HISTORY_WIRING,
    invoke: (fetch) =>
      eachSaleHistoryCredential((credential) =>
        saleHistoryClient(fetch).authorizeReprint(
          {
            saleRef: SALE_REF,
            kind: 'duplicate',
            printedAt: '2026-10-16T11:00:00.000Z',
            idempotencyKey: 'pos-pulse-reprint:contract-conformance',
          },
          credential,
        ),
      ),
  },
  // RT-17 slice 3 part 2: the shift outbox drain, device bearer + the stored
  // `operatorUserId` claim (never the envelope; envelope repair rows are not sent).
  {
    id: 'shiftSyncClient.openShift',
    module: SHIFT_SYNC_CLIENT,
    method: 'post',
    pathTemplate: '/api/pos/v1/shifts',
    wiring: SHIFT_SYNC_WIRING,
    invoke: (fetch) => shiftSyncClient(fetch).openShift(shiftFact('open')),
  },
  {
    id: 'shiftSyncClient.recordCashMovement',
    module: SHIFT_SYNC_CLIENT,
    method: 'post',
    pathTemplate: '/api/pos/v1/shifts/{shift_id}/cash-movements',
    wiring: SHIFT_SYNC_WIRING,
    invoke: (fetch) => shiftSyncClient(fetch).recordCashMovement(shiftFact('movement')),
  },
  {
    id: 'shiftSyncClient.closeShift',
    module: SHIFT_SYNC_CLIENT,
    method: 'post',
    pathTemplate: '/api/pos/v1/shifts/{shift_id}/close',
    wiring: SHIFT_SYNC_WIRING,
    invoke: (fetch) => shiftSyncClient(fetch).closeShift(shiftFact('close')),
  },
  // RT-554 (b): a manager's FORCED close, the stored envelope-path bytes (no
  // `operatorUserId`), under the manager envelope (never the device bearer).
  {
    id: 'shiftSyncClient.sendEnvelope',
    module: SHIFT_SYNC_CLIENT,
    method: 'post',
    pathTemplate: '/api/pos/v1/shifts/{shift_id}/close',
    wiring: SHIFT_SYNC_ENVELOPE_WIRING,
    invoke: (fetch) => shiftSyncClient(fetch).sendEnvelope?.(forcedCloseEnvelopeFact()),
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
  {
    id: 'runLivenessProbe',
    module: LIVENESS_PROBE,
    method: 'get',
    pathTemplate: '/api/v1/health/live',
    wiring:
      'none — the public liveness probe sends no credential (index.ts composeTerminalStatus probe, RT-602)',
    invoke: (fetch) => runLivenessProbe({ fetch, baseUrl: BASE_URL, timeoutMs: 4_000 }),
  },
];
