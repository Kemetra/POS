import type { UpdateStatusSnapshot } from '../../shared/update-status/types';
import { UPDATE_COPY } from './status-copy';

/**
 * RT-322 (S-B, design §6) — the one update notice the cashier sees: a verified
 * update is ready and installs after shift close. Every other state shows
 * nothing: failures, refused configuration and network errors belong to the
 * fleet / operator surface (design §9), never to the cashier. An update never
 * blocks the sale, so the notice is informational.
 */
export interface UpdateNotice {
  readonly tone: 'info';
  readonly copy: string;
}

export function mapUpdateNotice(snapshot: UpdateStatusSnapshot | null): UpdateNotice | null {
  if (snapshot?.state === 'downloaded' || snapshot?.state === 'update_pending') {
    return { tone: 'info', copy: UPDATE_COPY.ready };
  }
  return null;
}
