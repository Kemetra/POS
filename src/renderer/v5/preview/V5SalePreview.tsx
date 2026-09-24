import type { JSX } from 'react';
import { V5Frame } from '../frame/V5Frame';
import { V5OperationalNotices } from '../frame/V5OperationalNotices';
import { LiveSaleWorkspace } from '../sale/LiveSaleWorkspace';

interface Props {
  onPaymentContinue: () => void;
}

/**
 * DEV-only composition: the v5 frame around the existing live Sale adapter.
 * Loaded lazily from the router's DEV branch only, so neither this module nor
 * its CSS reaches a production bundle. Behaviour stays owned by the Sale
 * controllers; this file only composes.
 */
export function V5SalePreview({ onPaymentContinue }: Props): JSX.Element {
  return (
    <V5Frame notices={<V5OperationalNotices />}>
      <LiveSaleWorkspace onPaymentContinue={onPaymentContinue} />
    </V5Frame>
  );
}
