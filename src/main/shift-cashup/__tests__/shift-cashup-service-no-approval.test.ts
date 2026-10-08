/**
 * RT-17 owner decision 2026-10-07 (supersedes 10920): the cashier closes their own
 * shift whatever the variance. The shortage is recorded against the closer
 * anyway, so a manager is not needed to finish a shift. The approval mechanism
 * stays in the service behind `varianceApprovalThresholdMinor`; its default is
 * "never required" (the other service tests configure threshold 0).
 */
import type { Database as SqlJsDatabase } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  freshSalesSyncDb,
  initSalesSyncSql,
} from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import {
  MANAGER_PIN,
  MANAGER_REF,
  OPENED_AT,
  serviceHarness,
  storedBody,
  type ServiceHarness,
} from './__helpers__/shift-cashup-service-fixture.js';

const FLOAT = 50_000;

let db: SqlJsDatabase;
let harness: ServiceHarness;

beforeAll(async () => {
  await initSalesSyncSql();
});

beforeEach(() => {
  db = freshSalesSyncDb();
  harness = serviceHarness(db, { varianceApprovalThresholdMinor: null });
  harness.service.openShift({ openingFloatMinor: FLOAT });
  expect(harness.state.clock).toBe(OPENED_AT);
});

afterEach(() => {
  db.close();
});

describe('the cashier closes alone, whatever the variance', () => {
  it.each([
    ['one minor unit short', FLOAT - 1, -1],
    ['5 short', FLOAT - 500, -500],
    ['500 short', FLOAT - 50_000, -50_000],
    ['over', FLOAT + 12_345, 12_345],
  ])('closes %s with no approver and records the variance', (_name, counted, variance) => {
    const closed = harness.service.closeShift({ countedCashMinor: counted });
    expect(closed.varianceMinor).toBe(variance);
    const body = storedBody(db, 2);
    expect(body).not.toHaveProperty('varianceApprovedByUserId');
    expect(body).toHaveProperty('closingUserId');
    expect(body).toHaveProperty('variance');
  });

  it('never asks for a manager PIN, whatever the variance', async () => {
    for (const counted of [FLOAT, FLOAT - 1, FLOAT - 90_000]) {
      const approver = await harness.service.verifyApprover({
        countedCashMinor: counted,
        managerRef: MANAGER_REF,
        managerPin: MANAGER_PIN,
      });
      expect(approver).toBeNull();
    }
    expect(harness.state.verifyCalls).toEqual([]);
  });
});
