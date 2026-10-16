/**
 * RT-542 — the Backend-Core credential of the admitted session (OD-534-1),
 * resolved in the main process only:
 *
 *   • manager / admin → the session's own `pos_operator` envelope;
 *   • cashier → the paired device token plus the session's OWN live cashier
 *     admission (`admission_id`) and the cashier's backend user id. A cashier
 *     without an online admission (PIN-only / offline sign-in) holds no
 *     credential, so the history shows this device only.
 *
 * The credential is bound to the session record whose id the gate admitted: a
 * different (or no) live record gives no credential. Nothing here is logged or
 * bridged.
 */

import type { OperatorSessionRecord } from '../operator/session-manager.js';
import type { OperatorSessionForSales } from '../sales/sales-bridge.js';
import type { ResolvedCredential } from './sale-history-access.js';

export interface SaleHistoryCredentialDeps {
  /** The live operator session record (main-only fields included). */
  readonly getSessionRecord: () => Pick<
    OperatorSessionRecord,
    'id' | 'role' | 'backend_session_id' | 'admission_id' | 'user_id'
  > | null;
  /** The envelope held for a backend session, or null. */
  readonly getEnvelope: (backendSessionId: string) => string | null;
  /** The sendable device token (null unless paired and not revoked). */
  readonly readDeviceToken: () => Promise<string | null>;
}

const present = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

type SessionRecord = NonNullable<ReturnType<SaleHistoryCredentialDeps['getSessionRecord']>>;

function envelopeCredential(
  deps: SaleHistoryCredentialDeps,
  record: SessionRecord,
): ResolvedCredential | null {
  const token = deps.getEnvelope(record.backend_session_id);
  return present(token) ? { credential: { kind: 'envelope', token }, cashierUserId: null } : null;
}

async function readTokenOrNull(deps: SaleHistoryCredentialDeps): Promise<string | null> {
  try {
    return await deps.readDeviceToken();
  } catch {
    return null;
  }
}

async function cashierCredential(
  deps: SaleHistoryCredentialDeps,
  record: SessionRecord,
): Promise<ResolvedCredential | null> {
  const { admission_id: admissionId, user_id: userId } = record;
  if (!present(admissionId) || !present(userId)) return null;
  const token = await readTokenOrNull(deps);
  if (!present(token)) return null;
  const cashierUserId = userId.toLowerCase();
  return { credential: { kind: 'device', token, admissionId }, cashierUserId };
}

export function createSaleHistoryCredentialResolver(
  deps: SaleHistoryCredentialDeps,
): (session: OperatorSessionForSales) => Promise<ResolvedCredential | null> {
  return async (session) => {
    const record = deps.getSessionRecord();
    if (record?.id !== session.operator_session_id || record.role !== session.role) return null;
    return record.role === 'cashier'
      ? cashierCredential(deps, record)
      : envelopeCredential(deps, record);
  };
}
