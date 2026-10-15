/**
 * RT-530 — local audit events of the sale void: requested, confirmed, refused.
 *
 * Every event goes through 004's validating `AuditEmitter` (mandatory FR-025
 * attributes and the forbidden-key scan). Requester, approver, sale, amount,
 * device (`originating_terminal_id`) and `policy_version` are all on the
 * event: the requesting operator is `acting_operator_id`, the approving
 * manager (`users.id`) is `approving_supervisor_id`.
 */
import type { AuditEvent } from '../../shared/audit/event-shape.js';
import type { AuditPayloadMap } from '../../shared/audit/payload-schemas.js';
import type { VoidEntry } from './sale-void-repository.js';

type VoidAuditCategory = Extract<AuditEvent['action_category'], `sale.void.${string}`>;

export interface SaleVoidAuditSink {
  emit(event: AuditEvent): void;
}

export interface SaleVoidAudit {
  /** The void was journaled and its approval consumed (inside that transaction). */
  requested(entry: VoidEntry): void;
  confirmed(entry: VoidEntry, replayed: boolean): void;
  refused(entry: VoidEntry): void;
}

export interface SaleVoidAuditDeps {
  readonly sink: SaleVoidAuditSink;
  readonly now: () => string;
  readonly newEventId: () => string;
}

export function createSaleVoidAudit(deps: SaleVoidAuditDeps): SaleVoidAudit {
  function write<C extends VoidAuditCategory>(
    entry: VoidEntry,
    category: C,
    payload: AuditPayloadMap[C],
  ): void {
    deps.sink.emit({
      event_id: deps.newEventId(),
      tenant_id: entry.scope.tenantId,
      branch_id: entry.scope.branchId,
      originating_terminal_id: entry.scope.terminalId,
      acting_operator_id: entry.requesterOperatorId,
      session_id: entry.operatorSessionId,
      shift_id: null,
      action_category: category,
      created_at: deps.now(),
      approving_supervisor_id: entry.approverUserId,
      payload: { ...payload },
    });
  }

  return {
    requested(entry) {
      write(entry, 'sale.void.requested', {
        void_id: entry.voidId,
        sale_id: entry.saleId,
        amount_minor: entry.amountMinor,
        currency_code: entry.currencyCode,
        business_date: entry.businessDate,
        approval_id: entry.approvalId,
        policy_version: entry.policyVersion,
        approved_at: entry.approvedAt,
        requester_user_id: entry.requesterUserId,
      });
    },
    confirmed(entry, replayed) {
      write(entry, 'sale.void.confirmed', {
        void_id: entry.voidId,
        sale_id: entry.saleId,
        void_ref: entry.voidRef ?? '',
        amount_minor: entry.amountMinor,
        currency_code: entry.currencyCode,
        replayed,
      });
    },
    refused(entry) {
      write(entry, 'sale.void.refused', {
        void_id: entry.voidId,
        sale_id: entry.saleId,
        reason: entry.refusalReason ?? 'unknown',
        amount_minor: entry.amountMinor,
        currency_code: entry.currencyCode,
        approval_id: entry.approvalId,
        policy_version: entry.policyVersion,
      });
    },
  };
}
