import { vi } from 'vitest';

import type {
  CashierAdmissionAdmitted,
  CashierAdmissionClient,
  CashierAdmissionOnlineRequest,
  CashierAdmissionResult,
  CashierRosterResult,
} from '../../cashier-admission-client.js';
import type {
  CashierAdmissionDeps,
  CashierAdmissionInvalidation,
  CashierAdmittedEvent,
} from '../../cashier-admission.js';

/** RT-113 P2 — shared fakes for the device-authenticated cashier-admissions client. */

export const FAKE_USER_ID = '0192f6a0-1b2c-7d3e-8f40-123456789abc';
export const FAKE_ADMISSION_ID = '0192f6a0-aaaa-7bbb-8ccc-000000000001';

export const ADMITTED: CashierAdmissionAdmitted = {
  kind: 'admitted',
  admission_id: FAKE_ADMISSION_ID,
  offline_grace_seconds: 86_400,
  admission_ttl_seconds: 43_200,
  server_time: '2026-10-04T10:00:00.000Z',
  display_name: 'Server Name',
};

type AdmitImpl =
  | CashierAdmissionResult
  | ((
      req: CashierAdmissionOnlineRequest,
    ) => CashierAdmissionResult | Promise<CashierAdmissionResult>);

export interface FakeAdmission {
  client: CashierAdmissionClient;
  admitCalls: CashierAdmissionOnlineRequest[];
  endCalls: string[];
  admitted: CashierAdmittedEvent[];
  invalidated: CashierAdmissionInvalidation[];
  deviceRevoked: ReturnType<typeof vi.fn>;
  deps: CashierAdmissionDeps;
  /** Replace the admit behaviour for the next calls. */
  setAdmit(impl: AdmitImpl): void;
  setEnd(impl: () => Promise<{ kind: 'ended' }>): void;
}

export function fakeCashierAdmission(
  admit: AdmitImpl = ADMITTED,
  roster: CashierRosterResult = { kind: 'roster', cashiers: [] },
): FakeAdmission {
  let admitImpl = admit;
  let endImpl: () => Promise<{ kind: 'ended' }> = () => Promise.resolve({ kind: 'ended' });
  let keyCounter = 0;
  const admitCalls: CashierAdmissionOnlineRequest[] = [];
  const endCalls: string[] = [];
  const admitted: CashierAdmittedEvent[] = [];
  const invalidated: CashierAdmissionInvalidation[] = [];
  const deviceRevoked = vi.fn();
  const client: CashierAdmissionClient = {
    admit: vi.fn((req: CashierAdmissionOnlineRequest) => {
      admitCalls.push(req);
      return Promise.resolve(typeof admitImpl === 'function' ? admitImpl(req) : admitImpl);
    }),
    end: vi.fn((id: string) => {
      endCalls.push(id);
      return endImpl();
    }),
    listRoster: vi.fn(() => Promise.resolve(roster)),
  };
  const deps: CashierAdmissionDeps = {
    client,
    grantSeam: {
      onCashierAdmitted: (e) => admitted.push(e),
      onCashierAdmissionInvalidated: (e) => invalidated.push(e),
    },
    onDeviceRevoked: deviceRevoked,
    newIdempotencyKey: () => `test-idempotency-key-${String(++keyCounter).padStart(4, '0')}`,
  };
  return {
    client,
    admitCalls,
    endCalls,
    admitted,
    invalidated,
    deviceRevoked,
    deps,
    setAdmit(impl) {
      admitImpl = impl;
    },
    setEnd(impl) {
      endImpl = impl;
    },
  };
}
