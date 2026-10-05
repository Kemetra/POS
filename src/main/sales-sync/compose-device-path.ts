/**
 * RT-224 step 2 (Option B, Backend-Core #709; rev547 F2) — the composition of the
 * sale-sync device path, kept out of `index.ts` so it is unit-tested.
 *
 *   • `client` — the client's device deps: `getDeviceToken` (the paired
 *     terminal's device token, read in process per POST; never rejects — a
 *     secret-store failure reads as "no device credential", logged once per
 *     episode) and `currentTerminalId`, which binds each send to the sale's own
 *     terminal (Codex P2: a re-pair during the token read never sends the old
 *     sale; logged once per episode).
 *   • `engine` — the engine deps: whether the device credential is held, the
 *     per-sale route resolver over the sale's OWN `payment.settled` payload
 *     (never the current session — this module has no access to it), and the
 *     device-path 401 hook.
 *
 * Every log line is closed-set: `{}` or `{ sale_id, reason }` — never a token, a
 * user id or an envelope (P7). A device-path 401 is logged and the sale stays
 * queued; revoking the device is RT-215's detector's call.
 *
 * RT-215 (POS #546): once it merges, `isPaired` / `readToken` become its
 * `createSendableDeviceTokenReader`, and the device-path capture fetch is tagged
 * with its detector (see the PR's Coordination section).
 */
import type { DatabaseHandle } from '../db/client.js';
import { createSaleSyncDeviceTokenReader } from './sale-sync-device-token.js';
import type { SaleSyncEngineDeps } from './sale-sync-engine.js';
import type { CreateSaleSyncClientDeps } from './create-sale-sync-client.js';
import { createSellingUserIdResolver } from './selling-user-id.js';

/** The closed-set log lines of the device path. */
export const DEVICE_TOKEN_UNREADABLE_LOG = 'sale_sync:device_token_unreadable';
export const SELLING_USER_UNRESOLVED_LOG = 'sale_sync:selling_user_unresolved';
export const SELLING_USER_LOOKUP_FAILED_LOG = 'sale_sync:selling_user_lookup_failed';
export const DEVICE_UNAUTHORIZED_LOG = 'sale_sync:device_unauthorized';
export const DEVICE_TERMINAL_CHANGED_LOG = 'sale_sync:device_terminal_changed';

export interface SaleSyncDevicePathDeps {
  db: DatabaseHandle;
  /** Whether the terminal is paired right now. */
  isPaired: () => Promise<boolean>;
  /** The stored device token (may reject on a secret-store failure). */
  readToken: () => Promise<string | null | undefined>;
  /** The current pairing's `terminal_id`, synchronously (`getCurrentTerminalId`). */
  currentTerminalId: () => string | null;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

export interface SaleSyncDevicePath {
  /** Spread into `createSaleSyncClient`. `getDeviceToken` never rejects. */
  client: Required<
    Pick<
      CreateSaleSyncClientDeps,
      'getDeviceToken' | 'currentTerminalId' | 'onDeviceTerminalChanged'
    >
  >;
  /** Spread into `createSaleSyncEngine`. */
  engine: Required<
    Pick<SaleSyncEngineDeps, 'hasDeviceCredential' | 'sellingUsers' | 'onDeviceUnauthorized'>
  >;
}

export function composeSaleSyncDevicePath(deps: SaleSyncDevicePathDeps): SaleSyncDevicePath {
  const { logger } = deps;
  const readDeviceToken = createSaleSyncDeviceTokenReader({
    isPaired: deps.isPaired,
    readToken: deps.readToken,
    onReadFailure: () => {
      logger.warn({}, DEVICE_TOKEN_UNREADABLE_LOG);
    },
  });
  return {
    client: {
      getDeviceToken: readDeviceToken,
      currentTerminalId: deps.currentTerminalId,
      onDeviceTerminalChanged: () => {
        logger.warn({}, DEVICE_TERMINAL_CHANGED_LOG);
      },
    },
    engine: {
      hasDeviceCredential: async () => (await readDeviceToken()) !== null,
      sellingUsers: createSellingUserIdResolver({
        db: deps.db,
        onUnresolved: ({ saleId, reason }) => {
          logger.warn({ sale_id: saleId, reason }, SELLING_USER_UNRESOLVED_LOG);
        },
        onLookupFailed: () => {
          logger.warn({}, SELLING_USER_LOOKUP_FAILED_LOG);
        },
      }),
      onDeviceUnauthorized: () => {
        logger.warn({}, DEVICE_UNAUTHORIZED_LOG);
      },
    },
  };
}
