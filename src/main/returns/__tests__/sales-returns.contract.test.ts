/**
 * RT-15 S2 — contract conformance against the vendored Backend-Core pin
 * (`__contract__/sales-returns.contract.ts`, sales.yaml 1.4.0-draft).
 *
 * The TypeScript compiler is the assertion engine (same posture as
 * `capture-sale-request.contract.test.ts`; POS has no runtime schema
 * validator):
 *   • REQUEST — the body the till builds and the contract `RecordReturnRequest`
 *     are mutually assignable: every required field present and typed, and no
 *     key the strict (`additionalProperties: false`) boundary would reject;
 *   • RESPONSES — the contract `Sale` / `SaleLine` / `SaleReturn` / `Error` are
 *     assignable to what the lenient readers return, so every field the till
 *     reads exists in the contract with a compatible type (D-g).
 * Runtime checks below re-assert the value grammar the types cannot express.
 */
import { describe, expect, it } from 'vitest';

import { buildRecordReturnBody, type RecordReturnBody } from '../returns-quote.js';
import {
  readErrorCode,
  readSaleBody,
  readSaleReturnBody,
  type WireSale,
  type WireSaleLine,
  type WireSaleReturn,
} from '../returns-wire.js';
import type {
  ContractError,
  ContractRecordReturnRequest,
  ContractSale,
  ContractSaleLine,
  ContractSaleReturn,
} from './__contract__/sales-returns.contract.js';
import {
  LINE_A,
  LINE_B,
  SALE_REF,
  errorBody,
  omit,
  saleBody,
  saleReturnFor,
} from './__helpers__/returns-fixture.js';

// ── Compile-time gates ─────────────────────────────────────────────────────
const _requestToContract: ContractRecordReturnRequest = null as unknown as RecordReturnBody;
const _requestFromContract: Omit<RecordReturnBody, never> = null as unknown as Required<
  Omit<ContractRecordReturnRequest, 'reason'>
>;
const _saleFromContract: WireSale = null as unknown as ContractSale;
const _lineFromContract: WireSaleLine = null as unknown as ContractSaleLine;
const _returnFromContract: WireSaleReturn = null as unknown as ContractSaleReturn;
const _errorFromContract: { error: { code: string } } = null as unknown as ContractError;
void _requestToContract;
void _requestFromContract;
void _saleFromContract;
void _lineFromContract;
void _returnFromContract;
void _errorFromContract;

const CONTRACT_REQUEST_KEYS = ['sourceSystem', 'externalId', 'lines', 'refundTenders', 'reason'];
const DECIMAL = /^[0-9]{1,15}(\.[0-9]{1,4})?$/;
const QUANTITY = /^[0-9]{1,13}(\.[0-9]{1,6})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('RecordReturnRequest conformance', () => {
  const body = buildRecordReturnBody('pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6', {
    saleRef: SALE_REF,
    currencyCode: 'EGP',
    lines: [
      { lineRef: LINE_A, quantity: 2, amountMinor: 3000 },
      { lineRef: LINE_B, quantity: 1, amountMinor: 2000 },
    ],
    totalMinor: 5000,
  });

  it('emits only contract keys, with contract value grammar', () => {
    for (const key of Object.keys(body)) expect(CONTRACT_REQUEST_KEYS).toContain(key);
    expect(body.lines.length).toBeGreaterThanOrEqual(1);
    for (const line of body.lines) {
      expect(Object.keys(line).sort()).toEqual(['lineRef', 'quantity']);
      expect(line.lineRef).toMatch(UUID);
      expect(line.quantity).toMatch(QUANTITY);
    }
    expect(body.refundTenders).toEqual([{ method: 'cash', amount: '50.00' }]);
    expect(body.refundTenders[0]?.amount).toMatch(DECIMAL);
    expect(body.externalId.length).toBeLessThanOrEqual(200);
    expect(body.externalId).toMatch(/^[\x21-\x7E]{16,128}$/);
  });
});

describe('response readers accept full contract bodies', () => {
  it('reads a full contract Sale (all optional fields present and absent)', () => {
    expect(readSaleBody(saleBody())).not.toBeNull();
    const required = omit(saleBody(), 'tenders', 'processedAt', 'sourceClockAt');
    expect(readSaleBody(required)).not.toBeNull();
  });

  it('reads a full contract SaleReturn and Error', () => {
    const ret = saleReturnFor({
      externalId: 'pos-pulse-return:k',
      lines: [{ lineRef: LINE_A, quantity: '1' }],
      refundTenders: [{ method: 'cash', amount: '15.00' }],
    });
    expect(readSaleReturnBody(ret)).toMatchObject({ returnTotal: '15.0000' });
    expect(readErrorCode(errorBody('over_return'))).toBe('over_return');
  });
});
