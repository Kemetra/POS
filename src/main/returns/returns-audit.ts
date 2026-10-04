/**
 * RT-15 S2 — local audit events for the return flow (AC11).
 *
 * Every attempt, refusal, confirmation and payout-ready writes one
 * `audit_events` row through 004's validating `AuditEmitter` (mandatory FR-025
 * attributes + forbidden-key scan). Operator and terminal are the envelope's
 * `acting_operator_id` / `originating_terminal_id`; the payload carries the
 * sale / return references (`sale_ref`, `return_ref`) and minor-unit amounts.
 */
import type { AuditEvent } from '../../shared/audit/event-shape.js';
import type {
  AuditPayloadMap,
  SaleReturnRefusedPayload,
} from '../../shared/audit/payload-schemas.js';
import type { JournalEntry, ReturnScope } from './returns-repository.js';

type ReturnAuditCategory = Extract<AuditEvent['action_category'], `sale.return.${string}`>;

export interface ReturnsAuditSink {
  emit(event: AuditEvent): void;
}

/** Who acted, where: the envelope attributes of a return audit event. */
export interface ReturnActor {
  readonly scope: ReturnScope;
  readonly operatorId: string;
  readonly operatorSessionId: string;
}

export interface ReturnsAudit {
  attempted(entry: JournalEntry): void;
  refused(actor: ReturnActor, payload: SaleReturnRefusedPayload): void;
  confirmed(entry: JournalEntry, replayed: boolean): void;
  payoutReady(entry: JournalEntry): void;
}

export interface ReturnsAuditDeps {
  readonly sink: ReturnsAuditSink;
  readonly now: () => string;
  readonly newEventId: () => string;
}

function actorOf(entry: JournalEntry): ReturnActor {
  return {
    scope: entry.scope,
    operatorId: entry.operatorId,
    operatorSessionId: entry.operatorSessionId,
  };
}

type ConfirmedCategory = 'sale.return.confirmed' | 'sale.return.payout_ready';
type SharedConfirmedKey = 'return_id' | 'sale_ref' | 'return_ref' | 'currency_code';

interface ConfirmedFacts {
  readonly returnRef: string;
  readonly totalMinor: number;
}

/** The journaled return's confirmed facts; a programming error if absent. */
function confirmedFacts(entry: JournalEntry): ConfirmedFacts {
  if (entry.returnRef === null || entry.returnTotalMinor === null) {
    throw new Error('returns-audit: entry is not confirmed');
  }
  return { returnRef: entry.returnRef, totalMinor: entry.returnTotalMinor };
}

export function createReturnsAudit(deps: ReturnsAuditDeps): ReturnsAudit {
  function write<C extends ReturnAuditCategory>(
    actor: ReturnActor,
    category: C,
    payload: AuditPayloadMap[C],
  ): void {
    deps.sink.emit({
      event_id: deps.newEventId(),
      tenant_id: actor.scope.tenantId,
      branch_id: actor.scope.branchId,
      originating_terminal_id: actor.scope.terminalId,
      acting_operator_id: actor.operatorId,
      session_id: actor.operatorSessionId,
      shift_id: null,
      action_category: category,
      created_at: deps.now(),
      approving_supervisor_id: null,
      payload: { ...payload },
    });
  }

  /**
   * One builder for the two events that need a confirmed return: resolves the
   * server facts once and stamps the shared fields; `extra` adds the rest.
   */
  function writeConfirmedEvent<C extends ConfirmedCategory>(
    entry: JournalEntry,
    category: C,
    extra: (facts: ConfirmedFacts) => Omit<AuditPayloadMap[C], SharedConfirmedKey>,
  ): void {
    const facts = confirmedFacts(entry);
    const shared = {
      return_id: entry.returnId,
      sale_ref: entry.serverSaleRef,
      return_ref: facts.returnRef,
      currency_code: entry.currencyCode,
    };
    write(actorOf(entry), category, { ...shared, ...extra(facts) } as AuditPayloadMap[C]);
  }

  return {
    attempted(entry) {
      write(actorOf(entry), 'sale.return.attempted', {
        return_id: entry.returnId,
        sale_id: entry.saleId,
        sale_ref: entry.serverSaleRef,
        quoted_total_minor: entry.quotedTotalMinor,
        currency_code: entry.currencyCode,
        line_count: entry.lines.length,
      });
    },
    refused(actor, payload) {
      write(actor, 'sale.return.refused', payload);
    },
    confirmed(entry, replayed) {
      writeConfirmedEvent(entry, 'sale.return.confirmed', (facts) => ({
        sale_id: entry.saleId,
        return_total_minor: facts.totalMinor,
        replayed,
      }));
    },
    payoutReady(entry) {
      writeConfirmedEvent(entry, 'sale.return.payout_ready', (facts) => ({
        payout_minor: facts.totalMinor,
        method: 'cash' as const,
      }));
    },
  };
}
