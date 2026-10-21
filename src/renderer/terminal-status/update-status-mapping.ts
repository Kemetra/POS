import type { UpdateStatusSnapshot } from '../../shared/update-status/types';
import { UPDATE_COPY } from './status-copy';

/**
 * RT-322 (S-B, design §6) — which update notice the cashier sees, if any.
 * Calm by construction: an update never blocks the sale, so the worst tone is
 * `warning`, and every state that is not worth a cashier's attention (idle,
 * checking, downloading, installing, the reserved `compat_blocked`) shows
 * nothing. The installing state needs no notice: the app is closing.
 */
export interface UpdateNotice {
  readonly tone: 'info' | 'warning';
  readonly copy: string;
}

export function mapUpdateNotice(snapshot: UpdateStatusSnapshot | null): UpdateNotice | null {
  if (snapshot === null) return null;
  switch (snapshot.state) {
    case 'downloaded':
    case 'update_pending':
      return { tone: 'info', copy: UPDATE_COPY.ready };
    case 'verify_failed':
      return { tone: 'warning', copy: UPDATE_COPY.verifyFailed };
    case 'verify_unavailable':
      return { tone: 'warning', copy: UPDATE_COPY.verifyUnavailable };
    case 'error':
      return { tone: 'warning', copy: UPDATE_COPY.error };
    default:
      return null;
  }
}
