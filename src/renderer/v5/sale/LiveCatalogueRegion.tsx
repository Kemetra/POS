import { useCallback, useEffect, useRef, type JSX, type ReactNode } from 'react';
import type { CartBridgeAPI, CatalogueBridgeAPI } from '../../../shared/bridge-api';
import type { ProductSnapshotDisplay } from '../../../shared/catalogue/product-snapshot';
import type { AddedLineResult } from '../../sale/useSaleCartController';
import { useSaleCatalogueController } from '../../sale/useSaleCatalogueController';
import { useDirectSaleAdd, type AddBlock } from '../../sale/useDirectSaleAdd';
import { useCatalogueFreshness } from '../../sale/useCatalogueFreshness';
import { useScanOwner } from '../../scan/ScanGuardHost';
import { useScanNoticeStore } from '../../scan/scan-notice-store';
import { LiveProductRail } from './LiveProductRail';
import { focusScanOwner } from '../../scan/scan-anchor';

interface Props {
  onLineAdded: (
    line: AddedLineResult,
    actionId: string,
    product: ProductSnapshotDisplay,
    ticket: number,
  ) => void;
  /** A scan or pick was queued (anything offering Undo of an older action must go). */
  onAddQueued?: () => number;
  /** Read when each queued add runs: a paid or handed-off cart takes no line. */
  addBlock: () => AddBlock;
  /** Shown on the command bar's status line (scan owner + last cart action). */
  status?: ReactNode;
  cartBridge?: CartBridgeAPI;
  catalogueBridge?: CatalogueBridgeAPI;
}

function notifyScan(message: string): void {
  useScanNoticeStore.getState().show(message);
}

/**
 * Product discovery (the Direction B command bar) + direct add (owner decision
 * D-C1): a resolved scan or a picked result adds at once, with no confirm
 * dialog. Mounted only when the productSearch flag is on.
 */
export function LiveCatalogueRegion(props: Props): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null);
  const catalogue = useSaleCatalogueController({
    ...(props.cartBridge ? { cartBridge: props.cartBridge } : {}),
    ...(props.catalogueBridge ? { catalogueBridge: props.catalogueBridge } : {}),
  });
  const freshness = useCatalogueFreshness(props.catalogueBridge);
  // The first add creates the cart (#466).
  const direct = useDirectSaleAdd({
    ensureCart: catalogue.ensureCart,
    lookupScan: catalogue.lookupScan,
    addBlock: props.addBlock,
    onLineAdded: props.onLineAdded,
    notify: notifyScan,
    ...(props.onAddQueued ? { onQueued: props.onAddQueued } : {}),
    ...(props.cartBridge ? { bridge: props.cartBridge } : {}),
  });
  const focusSearch = useCallback((): void => {
    searchRef.current?.focus();
  }, []);
  // RT-239: a wedge burst is a scan wherever focus is; this screen receives it.
  const { scan } = direct;
  const receiveScan = useCallback(
    (code: string): void => {
      void scan(code);
    },
    [scan],
  );
  useScanOwner(receiveScan);
  // Arriving on the Sale (sign-in, unlock, «بيع جديد», Back from Checkout): the scan owner has focus.
  useEffect(() => {
    focusScanOwner();
  }, []);
  const { recover: clearSearch } = catalogue;
  const recover = useCallback((): void => {
    clearSearch();
    focusSearch();
  }, [clearSearch, focusSearch]);
  // 15 §3.3: Esc closes the results and the next scan is the next thing the cashier does.
  const dismiss = useCallback((): void => {
    clearSearch();
    focusScanOwner();
  }, [clearSearch]);
  // 15 §3.1 rule 6: a pick closes the results and hands focus back to the scan owner.
  const pick = useCallback(
    (product: ProductSnapshotDisplay): void => {
      clearSearch();
      focusScanOwner();
      void direct.pick(product);
    },
    [clearSearch, direct],
  );

  return (
    <LiveProductRail
      status={props.status}
      onDismiss={dismiss}
      state={catalogue.state}
      freshness={freshness.state}
      lastSuccessAt={freshness.lastSuccessAt}
      feedback={freshness.feedback}
      refreshing={freshness.refreshing}
      onRefresh={() => void freshness.refresh()}
      onSearch={(query) => void catalogue.runTypedSearch(query)}
      onScan={receiveScan}
      onSelect={pick}
      onRecover={recover}
      searchRef={searchRef}
    />
  );
}
