/**
 * T094b — `payment.settled` → `FinalizeInput` dispatch-projection.
 *
 * The AD-2 worker (T090, `finalize-listener.ts`) scans `audit_events` for
 * `payment.settled` rows with no matching `sales` row and hands the dispatch
 * closure one `handoff_action_id` per match. This module turns that id into
 * the full `FinalizeInput` the atomic finalize transaction (T091) consumes,
 * by reading back the durable state that 006 settlement left behind.
 *
 * Read sources (all durable — the worker runs session-independently during
 * boot recovery per T112, so NOTHING may come from a live session):
 *
 *   1. `audit_events` (action_category='payment.settled') — payload carries
 *      cart_id, payment_attempt_id, settled_at, attribution_operator_id,
 *      selling_operator_display_name (persisted at confirm-time, Step 0), and
 *      the tender_lines breakdown.
 *   2. `payment_attempts` — envelope_subtotal_minor + tenant/branch/terminal
 *      + operator_session_id.
 *   3. `payment_tender_lines` (applied) — tender summary + cash change due.
 *   4. `terminal_assignment` — terminal_label + the four receipt-header gap
 *      fields (branch_name, branch_address, tenant_tax_registration_id).
 *   5. `carts.handoff_envelope_json` — the frozen `LineSnapshot[]` for
 *      byte-stable reprints (FR-015/FR-016).
 *
 * `total_tax_minor` is hardcoded to 0 for 008 v1 (Egyptian VAT is a §A5
 * production-readiness item — see coordination.md §"Slice 1 closeout gap").
 *
 * Failure modes are explicit refusals (never thrown) so the worker can log
 * and skip a malformed/incomplete settlement without crashing the tick.
 */

import type { DatabaseHandle } from '../db/client.js';
import type { LineSnapshot } from '../../shared/cart/handoff-envelope.js';
import type { SalesTenderType } from '../../shared/sales/types.js';
import type { FinalizeInput, FinalizeTenderLineSummary } from './finalize-transaction.js';

// ── Narrow better-sqlite3 surfaces (sql.js-compatible at test time) ─────────

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}

interface PrepareAll<Row> {
  all(...params: unknown[]): Row[];
}

// ── Refusal reasons (dispatch-internal; distinct from the finalize txn's) ───

export type DispatchRefusalReason =
  | 'settled_event_not_found'
  | 'attempt_not_found'
  | 'terminal_assignment_not_found'
  | 'cart_envelope_not_found'
  | 'malformed_settled_payload';

export type BuildFinalizeInputResult =
  | { kind: 'ok'; input: FinalizeInput }
  | { kind: 'refused'; reason: DispatchRefusalReason };

export interface BuildFinalizeInputDeps {
  db: DatabaseHandle;
  handoff_action_id: string;
  /**
   * Maps an ISO-8601 settled_at instant to the terminal's local calendar day
   * (`YYYY-MM-DD`) for the AD-7 sale-number anchor. Injected for testability;
   * defaults to the UTC date portion. A future PR can resolve the terminal's
   * IANA timezone from config and shift accordingly (research §R-7).
   */
  localCalendarDayFor?: (settled_at: string) => string;
}

// ── Read-shape projections ───────────────────────────────────────────────────

interface AuditPayloadRow {
  payload: string | null;
}

interface SettledPayload {
  payment_attempt_id?: unknown;
  cart_id?: unknown;
  settled_at?: unknown;
  attribution_operator_id?: unknown;
  selling_operator_display_name?: unknown;
}

interface AttemptRow {
  tenant_id: string;
  branch_id: string;
  terminal_id: string;
  operator_session_id: string;
  envelope_subtotal_minor: number;
}

interface TenderLineRow {
  tender_type: string;
  amount_applied_minor: number;
  change_due_minor: number | null;
  external_reference: string | null;
  voucher_authority_redemption_id: string | null;
}

interface TerminalAssignmentRow {
  terminal_label: string;
  branch_name: string | null;
  branch_address: string | null;
  tenant_tax_registration_id: string | null;
}

interface CartEnvelopeRow {
  state: string;
  handoff_envelope_json: string | null;
}

function defaultLocalCalendarDay(settled_at: string): string {
  // ISO-8601 instants are `YYYY-MM-DDT…`; the date portion is the first 10
  // chars in UTC. Terminal-timezone shifting is deferred (see deps doc).
  return settled_at.slice(0, 10);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

export function buildFinalizeInput(deps: BuildFinalizeInputDeps): BuildFinalizeInputResult {
  const { db, handoff_action_id } = deps;
  const localCalendarDayFor = deps.localCalendarDayFor ?? defaultLocalCalendarDay;

  // 1 — the payment.settled audit row (json_extract on the payload). Mirrors
  // the finalize-listener scan column reference.
  const auditStmt = db.prepare(
    `SELECT payload FROM audit_events
      WHERE action_category = 'payment.settled'
        AND json_extract(payload, '$.handoff_action_id') = ?
      ORDER BY created_at ASC
      LIMIT 1`,
  ) as PrepareGet<AuditPayloadRow>;
  const auditRow = auditStmt.get(handoff_action_id);
  if (auditRow === undefined || auditRow.payload === null) {
    return { kind: 'refused', reason: 'settled_event_not_found' };
  }

  // The row matched `json_extract(payload, …) = ?`, which both sql.js and
  // better-sqlite3 evaluate only against well-formed JSON — so JSON.parse
  // here cannot throw and the non-object guard cannot trip for a matched
  // row. Both are kept as defence-in-depth; the unreachable arms are
  // c8-ignored. The reachable malformed path is "valid JSON object missing
  // required string fields", covered by the type guard below.
  let payload: SettledPayload;
  /* c8 ignore start */
  try {
    const parsed: unknown = JSON.parse(auditRow.payload);
    if (!isObject(parsed)) return { kind: 'refused', reason: 'malformed_settled_payload' };
    payload = parsed;
  } catch {
    return { kind: 'refused', reason: 'malformed_settled_payload' };
  }
  /* c8 ignore stop */

  const payment_attempt_id = payload.payment_attempt_id;
  const cart_id = payload.cart_id;
  const settled_at = payload.settled_at;
  const attribution_operator_id = payload.attribution_operator_id;
  const display_name = payload.selling_operator_display_name;
  if (
    typeof payment_attempt_id !== 'string' ||
    typeof cart_id !== 'string' ||
    typeof settled_at !== 'string' ||
    typeof attribution_operator_id !== 'string' ||
    typeof display_name !== 'string'
  ) {
    return { kind: 'refused', reason: 'malformed_settled_payload' };
  }

  // 2 — the payment_attempts row.
  const attemptStmt = db.prepare(
    `SELECT tenant_id, branch_id, terminal_id, operator_session_id, envelope_subtotal_minor
       FROM payment_attempts WHERE payment_attempt_id = ?`,
  ) as PrepareGet<AttemptRow>;
  const attempt = attemptStmt.get(payment_attempt_id);
  if (attempt === undefined) {
    return { kind: 'refused', reason: 'attempt_not_found' };
  }

  // 3 — the applied tender lines (the durable source of the tender summary).
  const tenderStmt = db.prepare(
    `SELECT tender_type, amount_applied_minor, change_due_minor,
            external_reference, voucher_authority_redemption_id
       FROM payment_tender_lines
      WHERE payment_attempt_id = ? AND state = 'applied'
      ORDER BY apply_order ASC`,
  ) as PrepareAll<TenderLineRow>;
  const tenderRows = tenderStmt.all(payment_attempt_id);
  const tender_lines_summary: FinalizeTenderLineSummary[] = tenderRows.map((row) => {
    const summary: FinalizeTenderLineSummary = {
      tender_type: row.tender_type as SalesTenderType,
      amount_applied_minor: row.amount_applied_minor,
    };
    if (row.change_due_minor !== null) summary.change_due_minor = row.change_due_minor;
    if (row.external_reference !== null) summary.external_reference = row.external_reference;
    if (row.voucher_authority_redemption_id !== null) {
      summary.voucher_authority_redemption_id = row.voucher_authority_redemption_id;
    }
    return summary;
  });
  const total_change_due_minor = tenderRows.reduce(
    (sum, row) => sum + (row.tender_type === 'cash' ? (row.change_due_minor ?? 0) : 0),
    0,
  );

  // 4 — the terminal_assignment row (single row at id = 1).
  const assignmentStmt = db.prepare(
    `SELECT terminal_label, branch_name, branch_address, tenant_tax_registration_id
       FROM terminal_assignment WHERE id = 1`,
  ) as PrepareGet<TerminalAssignmentRow>;
  const assignment = assignmentStmt.get();
  if (
    assignment === undefined ||
    assignment.branch_name === null ||
    assignment.branch_address === null ||
    assignment.tenant_tax_registration_id === null
  ) {
    return { kind: 'refused', reason: 'terminal_assignment_not_found' };
  }

  // 5 — the frozen cart envelope → lines snapshot.
  const cartStmt = db.prepare(
    `SELECT state, handoff_envelope_json FROM carts WHERE cart_id = ?`,
  ) as PrepareGet<CartEnvelopeRow>;
  const cartRow = cartStmt.get(cart_id);
  // §A4 review: a cancelled cart is never finalized, even if an attempt for
  // it settled; only a still-handed-off cart becomes a sale.
  if (
    cartRow === undefined ||
    cartRow.state !== 'frozen_handed_off' ||
    cartRow.handoff_envelope_json === null
  ) {
    return { kind: 'refused', reason: 'cart_envelope_not_found' };
  }
  let lines: readonly LineSnapshot[];
  try {
    const envelope: unknown = JSON.parse(cartRow.handoff_envelope_json);
    if (!isObject(envelope) || !Array.isArray(envelope.lines)) {
      return { kind: 'refused', reason: 'cart_envelope_not_found' };
    }
    lines = envelope.lines as LineSnapshot[];
    /* c8 ignore start — stored envelopes are always valid JSON from
       JSON.stringify at handoff; the parse-throw arm is defence-in-depth. */
  } catch {
    return { kind: 'refused', reason: 'cart_envelope_not_found' };
  }
  /* c8 ignore stop */

  const input: FinalizeInput = {
    envelope_handoff_action_id: handoff_action_id,
    payment_attempt_id,
    envelope_cart_id: cart_id,
    tenant_id: attempt.tenant_id,
    branch_id: attempt.branch_id,
    terminal_id: attempt.terminal_id,
    terminal_label: assignment.terminal_label,
    selling_operator_id: attribution_operator_id,
    selling_operator_display_name: display_name,
    selling_operator_session_id: attempt.operator_session_id,
    subtotal_minor: attempt.envelope_subtotal_minor,
    // TODO(008-v2): Egyptian VAT compliance — see coordination.md §"Slice 1
    // closeout gap discovery" (Q1). v1 ships sale-level tax = 0 behind the
    // §A5 production-readiness flag.
    total_tax_minor: 0,
    total_change_due_minor,
    tender_lines_summary,
    settled_at,
    tenant_tax_registration_id: assignment.tenant_tax_registration_id,
    branch_name: assignment.branch_name,
    branch_address: assignment.branch_address,
    local_calendar_day: localCalendarDayFor(settled_at),
    lines,
  };

  return { kind: 'ok', input };
}
