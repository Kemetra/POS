/**
 * RT-608 / RT-854 — the shared stack for the manual-discount e2e tests: the
 * real manager PIN store (MA-1) with one enrolled manager, the real approval
 * service (MA-2) with the `cart.discount.manual` resolver, and the real cart
 * bridge, over one migrated sql.js database. Each test file owns its session,
 * clock and audit sink and passes them in.
 */
import { aeadSafeStorage } from '../../../operator/__tests__/__helpers__/offline-grant-fixture.js';
import {
  createManagerPinStore,
  type ManagerPinStore,
} from '../../../operator/manager-pin-store.js';
import {
  createManagerApprovalService,
  type ManagerApprovalService,
} from '../../../operator/manager-approval-service.js';
import type { OperatorSessionRecord } from '../../../operator/session-manager.js';
import type { DatabaseHandle } from '../../../db/client.js';
import { CartBridgeHandlers } from '../../cart-bridge.js';
import { bindCartStore, type CartStore } from '../../cart-store.js';
import { manualDiscountApprovalResolver } from '../../discount-approval.js';
import type { AuditEvent } from '../../../../shared/audit/event-shape.js';
import type { ManagerApprovalRequest } from '../../../../shared/operator/manager-approval.js';

export interface DiscountHarnessInput {
  db: DatabaseHandle;
  terminalId: string;
  scope: { tenantId: string; branchId: string; terminalId: string };
  manager: { userId: string; pin: string; displayName: string };
  enrolledAt: string;
  unitPriceMinor: number;
  getSession: () => OperatorSessionRecord | null;
  now: () => string;
  audit: { emit: (event: AuditEvent) => void };
}

export interface DiscountHarness {
  pins: ManagerPinStore;
  service: ManagerApprovalService;
  store: CartStore;
  cart: CartBridgeHandlers;
  /** The enrolled manager's opaque approver handle. */
  managerRef: () => string;
  /** `approval.request` for `cart.discount.manual`, with the manager's PIN. */
  ask: (
    req: Omit<ManagerApprovalRequest, 'action_kind' | 'approver_ref' | 'pin'>,
  ) => ReturnType<ManagerApprovalService['request']>;
}

export async function bootDiscountHarness(input: DiscountHarnessInput): Promise<DiscountHarness> {
  const { db, scope, manager } = input;
  const pins = createManagerPinStore({ db, safeStorage: aeadSafeStorage() });
  await pins.enrol({
    scope,
    userId: manager.userId,
    displayName: manager.displayName,
    sealed: await pins.seal(manager.pin),
    now: input.enrolledAt,
    onlineAt: input.enrolledAt,
    guard: () => undefined,
  });
  const store = bindCartStore(db);
  const service = createManagerApprovalService({
    db,
    getSession: input.getSession,
    isSessionLocked: () => false,
    currentTerminalId: () => input.terminalId,
    managerPins: pins,
    resolvers: { 'cart.discount.manual': manualDiscountApprovalResolver(store) },
    auditEmitter: input.audit,
    now: input.now,
  });
  const cart = new CartBridgeHandlers({
    getCurrentSession: input.getSession,
    getTerminalId: () => input.terminalId,
    cartStore: store,
    resolveItemRef: () =>
      Promise.resolve({ kind: 'ok', display_name: 'Item', unit_price_minor: input.unitPriceMinor }),
    auditEmitter: input.audit as never,
    cartPaymentStatus: () => 'none',
    approvals: service,
    clock: () => new Date(input.now()),
  });
  const managerRef = (): string => pins.list({ scope, now: input.enrolledAt })[0]?.managerRef ?? '';
  return {
    pins,
    service,
    store,
    cart,
    managerRef,
    ask: (req) =>
      service.request({
        ...req,
        action_kind: 'cart.discount.manual',
        approver_ref: managerRef(),
        pin: manager.pin,
      }),
  };
}

/** A cart with lines of the given item refs; returns the cart id and the line ids. */
export async function cartWithLines(
  cart: CartBridgeHandlers,
  itemRefs: readonly string[],
  quantity: number,
): Promise<{ cartId: string; lineIds: string[] }> {
  const created = await cart.create({ idempotency_key: 'create-1' });
  if (created.kind !== 'ok') throw new Error('create failed');
  const lineIds: string[] = [];
  for (const [i, itemRef] of itemRefs.entries()) {
    const added = await cart.linesAdd({
      cart_id: created.cart_id,
      item_ref: itemRef,
      quantity,
      idempotency_key: `line-add-${String(i + 1)}`,
    });
    if (added.kind !== 'ok') throw new Error(`linesAdd failed: ${added.reason}`);
    lineIds.push(added.line_id);
  }
  return { cartId: created.cart_id, lineIds };
}
