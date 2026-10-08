/**
 * RT-113 P1.2 — shared harness for the offline grant wiring tests: the REAL
 * grant store on the full migration stack (sql.js) with the authenticated
 * AES-GCM fake of safeStorage, a recording audit emitter and logger, and the
 * seam/pairing helpers. The state is module-level (live bindings): tests read
 * it directly and change it only through the setters below.
 */
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';

import type { AuditEvent } from '../../../../shared/audit/event-shape.js';
import {
  makeSecretKey,
  type SecretKey,
  type SecretStore,
} from '../../../../shared/secret-store.js';
import type { PersistInput } from '../../../pairing/store.js';
import type {
  CashierAdmissionInvalidation,
  CashierAdmittedEvent,
} from '../../cashier-admission.js';
import {
  createOfflineGrantStore,
  type OfflineGrantEvaluation,
  type OfflineGrantStore,
} from '../../offline-grant-store.js';
import { createOfflineGrantWiring, type OfflineGrantWiring } from '../../offline-grant-wiring.js';

import {
  BRANCH,
  T0,
  T0_MS,
  TENANT,
  TERMINAL,
  USER,
  aeadSafeStorage,
  admitted,
  grantBlob,
  grantDb,
  initGrantSql,
  scope,
  type AeadSafeStorage,
  type GrantDb,
} from './offline-grant-fixture.js';

export const USER_2 = 'user-SENTINEL-2c88';
export const OPERATOR_2 = 'user_clerk_SENTINEL_77aa';
export const CATEGORY = 'operator.offline_grant.invalidated';

export let g: GrantDb;
export let ss: AeadSafeStorage;
export let clock: Date;
export let logCalls: unknown[][];
export let audits: AuditEvent[];
export let store: OfflineGrantStore;
export let wiring: OfflineGrantWiring;
export let uuidSeq: number;

export const logger = {
  info: (...args: unknown[]): void => {
    logCalls.push(['info', ...args]);
  },
  warn: (...args: unknown[]): void => {
    logCalls.push(['warn', ...args]);
  },
};

export function makeWiring(
  over: { store?: OfflineGrantStore; emit?: (e: AuditEvent) => void } = {},
): OfflineGrantWiring {
  return createOfflineGrantWiring({
    store: over.store ?? store,
    audit: {
      emit:
        over.emit ??
        ((e) => {
          audits.push(e);
        }),
    },
    uuid: () => `evt-${String(++uuidSeq)}`,
    now: () => clock,
    logger,
  });
}

/** Register the shared hooks: call once at the top of each test file. */
export function installWiringHarness(): void {
  beforeAll(async () => {
    await initGrantSql();
  });

  beforeEach(() => {
    g = grantDb();
    ss = aeadSafeStorage();
    clock = T0;
    logCalls = [];
    audits = [];
    uuidSeq = 0;
    store = createOfflineGrantStore({ db: g.handle, safeStorage: ss, now: () => clock, logger });
    wiring = makeWiring();
    wiring.setScope(scope());
  });

  afterEach(() => {
    wiring.stop();
    vi.useRealTimers();
    g.raw.close();
  });
}

/** The harness state is module-level; tests change it only through these. */
export function setWiring(w: OfflineGrantWiring): void {
  wiring = w;
}

export function setClock(d: Date): void {
  clock = d;
}

export function resetLogCalls(): void {
  logCalls = [];
}

export function resetAudits(): void {
  audits = [];
}

export function refusal(category: string): OfflineGrantEvaluation {
  return { admissible: false, category } as OfflineGrantEvaluation;
}

export function categoryOf(e: OfflineGrantEvaluation): string {
  return e.admissible ? 'admissible' : e.category;
}

/** An `admitted` for a request sent under the CURRENT pairing (P1-b). */
export function current(
  w: OfflineGrantWiring,
  over: Partial<CashierAdmittedEvent> = {},
): CashierAdmittedEvent {
  return admitted({
    pairing_generation: w.seam.pairingGeneration?.(),
    invalidation_seq: w.seam.invalidationSeq?.(),
    ...over,
  });
}

export function admit(over: Partial<CashierAdmittedEvent> = {}): void {
  wiring.seam.onCashierAdmitted(current(wiring, over));
}

export function admitBoth(): void {
  admit();
  admit({ user_id: USER_2, operator_id: OPERATOR_2 });
}

export function invalidate(event: CashierAdmissionInvalidation): void {
  wiring.seam.onCashierAdmissionInvalidated(event);
}

export function body(user = USER): Record<string, unknown> {
  return JSON.parse(ss.decryptString(grantBlob(g.raw, user))) as Record<string, unknown>;
}

/** A store whose every method can be made to throw, the rest delegating to the real one. */
export function breakable(): { store: OfflineGrantStore; broken: Set<keyof OfflineGrantStore> } {
  const broken = new Set<keyof OfflineGrantStore>();
  const proxy = new Proxy(store, {
    get(target, prop: keyof OfflineGrantStore) {
      if (broken.has(prop)) {
        return () => {
          throw new Error('store down');
        };
      }
      return target[prop];
    },
  });
  return { store: proxy, broken };
}

export function auditOf(e: AuditEvent): { reason: unknown; operator: string } {
  return { reason: e.payload['reason'], operator: e.acting_operator_id };
}

// ── pairing helpers ──

export const TOKEN_KEY: SecretKey = makeSecretKey('terminal.device-token');

export function memorySecretStore(): SecretStore {
  const m = new Map<string, string>();
  return {
    get: (k) => Promise.resolve(m.get(k) ?? null),
    set: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
    delete: (k) => {
      m.delete(k);
      return Promise.resolve();
    },
    isProductionBacked: () => false,
  };
}

export function pairInput(over: Partial<PersistInput> = {}): PersistInput {
  return {
    device_token: 'device-token-SECRET',
    tenant_id: TENANT,
    branch_id: BRANCH,
    terminal_id: TERMINAL,
    terminal_label: 'Till 1',
    paired_at: Math.floor(T0_MS / 1000),
    branch_name: null,
    branch_address: null,
    tenant_tax_registration_id: null,
    printer_vendor_id: null,
    printer_product_id: null,
    printer_com_port: null,
    ...over,
  };
}
