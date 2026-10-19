/**
 * RT-542 — one sale's detail from Backend-Core, shared by `saleHistory.read`
 * and the reprint: credential → `readSaleHistoryDetail` → session re-check →
 * the server answered the sale asked for → OD-534-1 ownership in main (a
 * cashier sees only a sale whose recorded operator is their own backend user,
 * else `role_denied` (RT-741), audited) → this terminal's own
 * record joined (`local_sale_id`). Online only: no credential is `unavailable`.
 */

import type {
  SaleHistoryDetail,
  SaleHistoryRefusalReason,
} from '../../shared/sale-history/types.js';
import type { SaleId } from '../../shared/sales/types.js';
import { SALE_OWNERSHIP_REFUSAL } from '../sales/sale-access-policy.js';
import type { Admitted, ResolvedCredential, SaleHistoryAccess } from './sale-history-access.js';
import type { ReadOutcome, SaleHistoryClient } from './sale-history-client.js';
import type { SaleHistoryLocalReads } from './sale-history-local.js';

export type DetailFetch =
  | { readonly ok: true; readonly detail: SaleHistoryDetail; readonly resolved: ResolvedCredential }
  | { readonly ok: false; readonly reason: SaleHistoryRefusalReason };

export interface DetailReader {
  fetchDetail(admitted: Admitted, saleRef: string): Promise<DetailFetch>;
}

export interface DetailReaderDeps {
  readonly client: Pick<SaleHistoryClient, 'read'>;
  readonly local: Pick<SaleHistoryLocalReads, 'localSaleIds'>;
  readonly access: SaleHistoryAccess;
}

const FAILURE: Readonly<Record<string, SaleHistoryRefusalReason>> = {
  not_found: 'sale_not_found',
  unauthorized: 'server_refused',
};

const refusal = (reason: SaleHistoryRefusalReason): DetailFetch => ({ ok: false, reason });

export function createDetailReader(deps: DetailReaderDeps): DetailReader {
  const { access } = deps;

  /** The checked, joined detail of a server answer, or why it is not shown. */
  function checked(
    admitted: Admitted,
    resolved: ResolvedCredential,
    saleRef: string,
    outcome: ReadOutcome,
  ): DetailFetch {
    if (outcome.kind !== 'ok') return refusal(FAILURE[outcome.kind] ?? 'unavailable');
    const { detail, operator_ref: operatorRef } = outcome.detail;
    if (detail.summary.sale_ref !== saleRef) return refusal('unavailable');
    if (!access.owns(admitted, resolved, { saleRef, operatorRef }))
      return refusal(SALE_OWNERSHIP_REFUSAL);
    const localId = deps.local.localSaleIds(admitted.scope, [saleRef]).get(saleRef) ?? null;
    const summary = { ...detail.summary, local_sale_id: localId as SaleId | null };
    return { ok: true, resolved, detail: { ...detail, summary } };
  }

  return {
    async fetchDetail(admitted, saleRef) {
      const resolved = await access.credential(admitted);
      if (!access.stillCurrent(admitted)) return refusal('session_changed');
      if (resolved === null) return refusal('unavailable');
      const outcome = await deps.client.read(saleRef, resolved.credential);
      if (!access.stillCurrent(admitted)) return refusal('session_changed');
      return checked(admitted, resolved, saleRef, outcome);
    },
  };
}
