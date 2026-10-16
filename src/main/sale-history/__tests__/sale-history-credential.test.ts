import { describe, expect, it } from 'vitest';

import { createSaleHistoryCredentialResolver } from '../sale-history-credential.js';
import { CASHIER, MANAGER } from './__helpers__/service-fixtures.js';

const ADMISSION = '0190a3c4-0000-4000-8000-00000000ad01';
const USER = '0190a3c4-0000-4000-8000-0000000000c1';

type Rec = {
  id: string;
  role: 'cashier' | 'manager' | 'admin';
  backend_session_id: string;
  admission_id?: string;
  user_id?: string;
};

function resolver(
  record: Rec | null,
  opts: { envelope?: string | null; token?: string | null } = {},
) {
  return createSaleHistoryCredentialResolver({
    getSessionRecord: () => record,
    getEnvelope: (id) =>
      id === 'bs-1' ? (opts.envelope === undefined ? 'env' : opts.envelope) : null,
    readDeviceToken: () =>
      opts.token === undefined ? Promise.resolve('dev') : Promise.resolve(opts.token),
  });
}

const managerRecord: Rec = {
  id: MANAGER.operator_session_id,
  role: 'manager',
  backend_session_id: 'bs-1',
};
const cashierRecord: Rec = {
  id: CASHIER.operator_session_id,
  role: 'cashier',
  backend_session_id: 'bs-1',
  admission_id: ADMISSION,
  user_id: USER,
};

describe('RT-542 sale-history credential (OD-534-1)', () => {
  it('a manager or admin gets their envelope, never the device token', async () => {
    expect(await resolver(managerRecord)(MANAGER)).toEqual({
      credential: { kind: 'envelope', token: 'env' },
      cashierUserId: null,
    });
  });

  it('a cashier gets the device token with their own admission and user id', async () => {
    expect(await resolver(cashierRecord)(CASHIER)).toEqual({
      credential: { kind: 'device', token: 'dev', admissionId: ADMISSION },
      cashierUserId: USER,
    });
  });

  it('lower-cases the cashier user id it proves', async () => {
    const resolved = await resolver({ ...cashierRecord, user_id: USER.toUpperCase() })(CASHIER);
    expect(resolved?.cashierUserId).toBe(USER);
  });

  it('a cashier without an online admission holds no credential', async () => {
    const base = {
      id: CASHIER.operator_session_id,
      role: 'cashier' as const,
      backend_session_id: 'bs-1',
    };
    expect(await resolver({ ...base, user_id: USER })(CASHIER)).toBeNull();
    expect(await resolver({ ...base, admission_id: ADMISSION })(CASHIER)).toBeNull();
  });

  it('gives nothing for another, or no, live session', async () => {
    expect(await resolver(null)(MANAGER)).toBeNull();
    expect(await resolver(cashierRecord)(MANAGER)).toBeNull();
    expect(await resolver({ ...managerRecord, role: 'admin' })(MANAGER)).toBeNull();
  });

  it('gives nothing without the envelope or the device token, or when the read fails', async () => {
    expect(await resolver(managerRecord, { envelope: null })(MANAGER)).toBeNull();
    expect(await resolver(managerRecord, { envelope: '' })(MANAGER)).toBeNull();
    expect(await resolver(cashierRecord, { token: null })(CASHIER)).toBeNull();
    const failing = createSaleHistoryCredentialResolver({
      getSessionRecord: () => cashierRecord,
      getEnvelope: () => null,
      readDeviceToken: () => Promise.reject(new Error('dpapi')),
    });
    expect(await failing(CASHIER)).toBeNull();
  });
});
