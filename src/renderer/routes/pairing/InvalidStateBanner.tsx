import type { JSX } from 'react';

import type { PairingStatus } from '../../../shared/pairing-types';
import { ToneIcon } from '../../v5/foundation/ToneIcon';
import '../../v5/foundation/messages.css';

type InvalidReason = Extract<PairingStatus, { kind: 'invalid' }>['reason'];

const MESSAGES: Record<InvalidReason, string> = {
  missing_token: 'يجب ربط الجهاز مرة أخرى. مفتاح الأمان مفقود.',
  orphaned_row: 'يجب ربط الجهاز مرة أخرى. بيانات الربط المحفوظة ناقصة.',
  decrypt_failed: 'يجب ربط الجهاز مرة أخرى. تعذّر استرجاع مفتاح الأمان.',
  // RT-215 — the device credential was confirmed revoked by Backend-Core.
  // Sales are never reversed or discarded (RT-24 / RT-138 L6): unsent ones
  // stay on the terminal, held from the previous pairing (RT-221). The copy
  // must keep saying so.
  device_revoked:
    'تم إيقاف صلاحية هذا الجهاز. المبيعات التي لم تُرسَل محفوظة على الجهاز. أدخل رمز ربط جديدًا من لوحة الإدارة للمتابعة.',
  // RT-306 — the sealed token does not belong to the stored pairing (a crash
  // during a re-pair). Nothing was sent with it.
  inconsistent: 'يجب ربط الجهاز مرة أخرى. آخر عملية ربط لم تكتمل.',
};

interface InvalidStateBannerProps {
  reason: InvalidReason;
}

/**
 * RT-244 — the v5 warning notice inside the pairing card, in the owner-approved
 * Arabic (2026-10-12).
 */
export function InvalidStateBanner({ reason }: Readonly<InvalidStateBannerProps>): JSX.Element {
  return (
    <div role="alert" className="v5-notice" data-tone="warning" data-testid="invalid-state-banner">
      <ToneIcon tone="warning" />
      <span className="v5-notice__text">{MESSAGES[reason]}</span>
    </div>
  );
}
