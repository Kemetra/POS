/**
 * capture-sale-request.contract.test.ts — H-1 contract conformance (audit, 2026-06-19).
 *
 * AD-SALE-CAPTURE-1 (Option A, ratified 2026-06-19) authorized adding a contract
 * test "asserting the POS payload passes CaptureSaleRequestSchema." POS has no
 * runtime validator (no zod/ajv on the dep tree, and adding one is a gated
 * package-file edit), so the conformance check is enforced by the TypeScript
 * COMPILER against a vendored, provenance-pinned copy of DP-2's binding contract
 * type (`__contract__/capture-sale-request.contract.ts`, generated from the
 * SHARED `pos-sales/sales.yaml` both sides realize — NOT a hand re-derivation of
 * POS's belief).
 *
 * What this test locks, and what it deliberately leaves to others:
 *   • STRUCTURE (this file, compile-time): every required field present + correctly
 *     typed (the `_toContract` direction), and NO extra keys / no newly-required
 *     field missed (the `_fromContract` direction). This is the `.strict()` /
 *     mass-assignment + missing-required coverage AD-SALE-CAPTURE-1 asked for.
 *   • VALUE-GRAMMAR (elsewhere): the decimal-string grammar (`DecimalAmount`
 *     regex) is unit-tested in `create-sale-sync-client.test.ts`
 *     (`minorUnitsToDecimalString` — exponent 0/2/3); the RFC3339 `occurredAt`
 *     grammar is guaranteed at the source by `index.ts` binding
 *     `now: () => new Date().toISOString()` into finalize-transaction (verified
 *     2026-06-19), which always emits a `.datetime()`-valid `…Z` string. A
 *     runtime spot-check below re-asserts that grammar so this file is not read
 *     as covering only structure.
 *
 * The compiler is the assertion engine: if `toWireBody`'s output type and the
 * vendored contract type ever diverge structurally, this file FAILS TO COMPILE
 * (i.e. the test build breaks) — that is the gate.
 */
import { describe, expect, it } from 'vitest';

import { toWireBody } from '../create-sale-sync-client.js';
import type { CaptureSalePayload } from '../capture-payload.js';
import { nn } from './__helpers__/sales-sync-fixture.js';
import type {
  ContractCaptureSaleLine,
  ContractCaptureSaleRequest,
} from './__contract__/capture-sale-request.contract.js';

/**
 * The ACTUAL output type of the production wire transform — not a re-typed copy.
 * Coupling the assertion to `ReturnType<typeof toWireBody>` means a future drift
 * in `toWireBody` is caught here, not silently allowed by a stale local mirror.
 */
type WireBody = ReturnType<typeof toWireBody>;
type WireLine = WireBody['lines'][number];

// ── Compile-time bidirectional assignability (the contract gate) ───────────────
// `_toContract`: the POS wire body satisfies the DP-2 contract — every required
//   contract field is present and correctly typed. Fails if POS drops/mis-types one.
// `_fromContract`: the DP-2 contract satisfies the POS wire body — POS sends no
//   key the contract forbids, and would break here if the contract added a new
//   required field POS does not yet emit. Together = structural equivalence.
// (Assigned from `null as unknown as T` so the checks are pure type-level and run
//  no code; `void` keeps the linter from flagging them as unused.)
// `_fromContract` widens only `sourceSystem` (WireBody pins the literal
// `'pos-pulse'`; the contract types it `string` — a benign narrowing where POS is
// STRICTER than the contract). Widening it isolates that single field so the
// check still fires on what matters: a NEW required wire key the contract forbids
// (e.g. `tenantId` creeping back) — the mass-assignment regression guard. Type
// assertions use width subtyping (no excess-property check), so this reverse
// direction is the ONLY compile-time guard against a forbidden required key.
type WireBodyContractShape = Omit<WireBody, 'sourceSystem'> & { sourceSystem: string };
const _toContract: ContractCaptureSaleRequest = null as unknown as WireBody;
const _fromContract: WireBodyContractShape = null as unknown as ContractCaptureSaleRequest;
const _lineToContract: ContractCaptureSaleLine = null as unknown as WireLine;
const _lineFromContract: WireLine = null as unknown as ContractCaptureSaleLine;
void _toContract;
void _fromContract;
void _lineToContract;
void _lineFromContract;

/** A representative internal payload (integer minor units, as `buildCapturePayload` emits). */
const PAYLOAD: CaptureSalePayload = {
  externalId: 'pos-pulse:handoff-abc',
  sourceSystem: 'pos-pulse',
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  terminalId: 'terminal-1',
  operatorId: 'operator-1',
  // Sourced the way production does — `new Date().toISOString()` (index.ts) — so
  // this is representative of the real `occurredAt`, not a hand-cleaned value.
  occurredAt: new Date('2026-06-19T10:00:00.000Z').toISOString(),
  totalMinor: 2550,
  lines: [
    {
      lineRef: 'line-1',
      productRef: 'sku-1',
      lineName: 'Item One',
      quantity: 2,
      unitPriceMinor: 1000,
      lineAmountMinor: 2000,
    },
    {
      lineRef: 'line-2',
      productRef: 'sku-2',
      lineName: 'Item Two',
      quantity: 1,
      unitPriceMinor: 550,
      lineAmountMinor: 550,
    },
  ],
};

describe('capture-sale-request contract conformance (H-1, AD-SALE-CAPTURE-1)', () => {
  it('runtime: toWireBody output is assignable to the DP-2 contract type', () => {
    // Runtime echo of the compile-time guard — a generated payload typed AS the
    // contract. If the structures diverged this would not compile.
    const wire: ContractCaptureSaleRequest = toWireBody(PAYLOAD, 'EGP');
    expect(wire.sourceSystem).toBe('pos-pulse');
    expect(wire.posTotal).toBe('25.50');
    expect(wire.currencyCode).toBe('EGP');
    expect(wire.lines).toHaveLength(2);
  });

  it('omits every server-resolved / non-contract key (additionalProperties:false)', () => {
    const wire = toWireBody(PAYLOAD, 'EGP') as unknown as Record<string, unknown>;
    // Mass-assignment ban (FR-061/062): these resolve server-side and MUST NOT ride
    // the body. This list is ENUMERATED (known forbidden keys), not exhaustive —
    // the compile-time `_fromContract` check is the guard against an UNKNOWN new
    // required key; this runtime check pins the specific server-resolved IDs.
    for (const forbidden of ['tenantId', 'branchId', 'terminalId', 'operatorId']) {
      expect(wire[forbidden]).toBeUndefined();
    }
    const line = nn((wire.lines as Record<string, unknown>[])[0]);
    // Internal-only keys the strict line schema rejects.
    for (const forbidden of ['lineRef', 'productRef', 'unitPriceMinor', 'lineAmountMinor']) {
      expect(line[forbidden]).toBeUndefined();
    }
  });

  it('RT-35: a catalogue (UUID) line carries tenantProductRef and still no internal keys', () => {
    const tenantProductId = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
    const first = nn(PAYLOAD.lines[0]);
    const wire: ContractCaptureSaleRequest = toWireBody(
      { ...PAYLOAD, lines: [{ ...first, productRef: tenantProductId }] },
      'EGP',
    );
    const line = nn(wire.lines[0]) as unknown as Record<string, unknown>;
    expect(line['tenantProductRef']).toBe(tenantProductId);
    for (const forbidden of ['lineRef', 'productRef', 'unitPriceMinor', 'lineAmountMinor']) {
      expect(line[forbidden]).toBeUndefined();
    }
  });

  it('value-grammar: occurredAt is RFC3339 (passes DP-2 z.string().datetime())', () => {
    const wire = toWireBody(PAYLOAD, 'EGP');
    // The exact grammar DP-2 enforces: ISO-8601 with `T` and a `Z`/offset zone.
    expect(wire.occurredAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    );
    // Round-trips through Date without loss (Number.isNaN would mean an invalid instant).
    expect(Number.isNaN(Date.parse(wire.occurredAt))).toBe(false);
  });

  it('value-grammar: money fields are exact-decimal strings (DecimalAmount), never floats', () => {
    const wire = toWireBody(PAYLOAD, 'EGP');
    const decimal = /^-?[0-9]{1,15}(\.[0-9]{1,4})?$/; // DP-2 DecimalAmount grammar
    expect(wire.posTotal).toMatch(decimal);
    for (const line of wire.lines) {
      expect(line.unitPrice).toMatch(decimal);
      expect(line.lineAmount).toMatch(decimal);
      expect(typeof line.quantity).toBe('string');
    }
  });
});
