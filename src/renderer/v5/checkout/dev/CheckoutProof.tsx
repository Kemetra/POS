import type { JSX } from 'react';
import { MemoryRouter } from 'react-router-dom';

import type { PaymentIntentEnvelope } from '../../../../shared/cart/handoff-envelope';
import type {
  PaymentsBridgeAPI,
  PaymentsCancelResponse,
  PaymentsConfirmResponse,
  TenderApplyRequest,
  TenderApplyResponse,
  TenderBridgeAPI,
} from '../../../../shared/bridge-api';
import type {
  PaymentAttemptRendererView,
  TenderLineRendererView,
} from '../../../../shared/payments/types';
import { useFeatureFlagsStore } from '../../../stores/feature-flags-store';
import { useOperatorSessionStore } from '../../../stores/operator-session-store';
import { usePaymentStore } from '../../../stores/payment-store';
import { PaymentSurface } from '../../../ui/payments/PaymentSurface';
import { Banner } from '../../foundation/Banner';
import { V5Frame } from '../../frame/V5Frame';

/**
 * RT-243 W1-C — DEV-ONLY Checkout harness (`#/dev/checkout-proof`), the
 * "every payment state is reachable in the harness" leg of the acceptance.
 *
 * It renders the REAL `PaymentSurface` inside the REAL `V5Frame` on
 * `/app/checkout`, against an in-memory bridge that mimics main's projection
 * (apply records a line, read returns it, confirm settles a fully tendered
 * attempt, cancel reverses every line). It proves layout and presentation only:
 * no main process, DB, printer or sync runs here, so nothing it shows is
 * financial evidence. Packaged captures remain the acceptance evidence.
 *
 * `main.tsx` mounts it only under `import.meta.env.DEV`; Vite drops the branch
 * from production builds.
 *
 * Query (after the hash): `lines` = cart lines (default 10), `banner=1` adds a
 * frame banner, `preset` = none | partial | exact | change | card | mixed seeds
 * an attempt as a remount would find it (RT-243 F1).
 */

const NAMES = [
  'باراسيتامول 500 مجم · 24 قرص',
  'فيتامين C فوار 1000 مجم · 20 قرص',
  'شراب للكحة للأطفال · 100 مل',
  'كمامات طبية · 50 قطعة',
  'مناديل مبللة · 80 منديل',
  'واقي شمس SPF 50 · 50 مل',
  'مطهر كحولي 70% · 250 مل',
  'لاصق جروح متنوع · 40 قطعة',
  'معجون أسنان للحساسية · 75 مل',
  'أموكسيسيلين 500 مجم · 16 كبسولة',
] as const;

interface HarnessParams {
  readonly lines: number;
  readonly banner: boolean;
  readonly preset: string;
}

function readParams(): HarnessParams {
  const query = window.location.hash.split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  const lines = Number.parseInt(params.get('lines') ?? '10', 10);
  return {
    lines: Number.isSafeInteger(lines) && lines > 0 ? Math.min(lines, 60) : 10,
    banner: params.get('banner') === '1',
    preset: params.get('preset') ?? 'none',
  };
}

function makeEnvelope(lineCount: number): PaymentIntentEnvelope {
  const lines = Array.from({ length: lineCount }, (_, i) => {
    const quantity = (i % 3) + 1;
    const unit = 1250 + ((i * 735) % 9000);
    return {
      line_id: `line-${String(i)}`,
      item_ref: `item-${String(i)}`,
      display_name: NAMES[i % NAMES.length] ?? 'صنف',
      quantity,
      unit_price_minor: unit,
      line_subtotal_minor: unit * quantity,
      note: null,
      version: 1,
      last_action_id: `act-${String(i)}`,
    };
  });
  return {
    envelope_version: 'v1',
    cart_id: 'dev-cart',
    operator_session_id: 'dev-session',
    owning_operator_id: 'dev-operator',
    tenant_id: 'dev-tenant',
    branch_id: 'dev-branch',
    terminal_id: 'dev-terminal',
    lines,
    discount_placeholders: [],
    subtotal_minor: lines.reduce((sum, l) => sum + l.line_subtotal_minor, 0),
    created_at: new Date().toISOString(),
    handoff_action_id: 'dev-handoff',
  };
}

const ATTEMPT_ID = 'dev-attempt';

/** An in-memory stand-in for main's payment projection. Presentation only. */
function makeBridge(subtotal: number, seed: readonly TenderLineRendererView[]) {
  let lines: TenderLineRendererView[] = [...seed];
  let state: PaymentAttemptRendererView['state'] = 'started';
  const now = (): string => new Date().toISOString();
  const applied = (): number =>
    lines
      .filter((l) => l.state === 'applied')
      .reduce((sum, l) => sum + l.amount_applied_minor - (l.change_due_minor ?? 0), 0);
  const snapshot = (): PaymentAttemptRendererView => ({
    payment_attempt_id: ATTEMPT_ID,
    state,
    envelope_subtotal_minor: subtotal,
    started_at: now(),
    tender_lines: lines,
  });

  const payments = {
    start: () => Promise.resolve({ kind: 'ok' as const, payment_attempt_id: ATTEMPT_ID }),
    read: () => Promise.resolve({ kind: 'ok' as const, payment_attempt: snapshot() }),
    subscribe: () => Promise.resolve({ kind: 'ok' as const, payment_attempt: snapshot() }),
    confirm: (): Promise<PaymentsConfirmResponse> => {
      if (applied() < subtotal) {
        return Promise.resolve({ kind: 'refused', reason: 'invariant_violated' } as never);
      }
      state = 'settled';
      return Promise.resolve({ kind: 'ok', settled_at: now() });
    },
    cancel: (): Promise<PaymentsCancelResponse> => {
      const reversed = lines.filter((l) => l.state === 'applied').map((l) => l.tender_line_id);
      lines = lines.map((l) => ({ ...l, state: 'reversed' as const, reversed_at: now() }));
      state = 'cancelled';
      return Promise.resolve({
        kind: 'ok',
        cancelled_at: now(),
        reversed_tender_line_ids: reversed,
        reversal_pending_tender_line_ids: [],
      });
    },
    forceFail: () => Promise.resolve({ kind: 'ok' as const, force_failed_at: now() }),
  } as unknown as PaymentsBridgeAPI;

  const tender = {
    apply: (req: TenderApplyRequest): Promise<TenderApplyResponse> => {
      const remaining = Math.max(subtotal - applied(), 0);
      const change =
        req.tender_type === 'cash' ? Math.max(req.amount_applied_minor - remaining, 0) : 0;
      const id = `dev-line-${String(lines.length + 1)}`;
      lines = [
        ...lines,
        {
          tender_line_id: id,
          tender_type: req.tender_type,
          state: 'applied',
          amount_applied_minor: req.amount_applied_minor,
          ...(change > 0 ? { change_due_minor: change } : {}),
          applied_at: now(),
          apply_order: lines.length + 1,
        },
      ];
      return Promise.resolve({
        kind: 'ok',
        tender_line_id: id,
        applied_at: now(),
        ...(change > 0 ? { change_due_minor: change } : {}),
      });
    },
    reverse: () => Promise.resolve({ kind: 'ok' as const, reversed_at: now(), state: 'reversed' }),
    read: () => Promise.reject(new Error('not used by the harness')),
  } as unknown as TenderBridgeAPI;

  return { payments, tender };
}

function seedLine(
  order: number,
  type: TenderLineRendererView['tender_type'],
  amount: number,
  change = 0,
): TenderLineRendererView {
  return {
    tender_line_id: `seed-${String(order)}`,
    tender_type: type,
    state: 'applied',
    amount_applied_minor: amount,
    ...(change > 0 ? { change_due_minor: change } : {}),
    applied_at: new Date().toISOString(),
    apply_order: order,
  };
}

function presetLines(preset: string, subtotal: number): TenderLineRendererView[] {
  const half = Math.floor(subtotal / 2);
  switch (preset) {
    case 'partial':
      return [seedLine(1, 'cash', half)];
    case 'exact':
      return [seedLine(1, 'cash', subtotal)];
    case 'change': {
      const received = Math.ceil((subtotal + 1) / 10_000) * 10_000;
      return [seedLine(1, 'cash', received, received - subtotal)];
    }
    case 'card':
      return [seedLine(1, 'external_card_terminal', subtotal)];
    case 'mixed':
      return [seedLine(1, 'external_card_terminal', half), seedLine(2, 'cash', subtotal - half)];
    default:
      return [];
  }
}

let prepared: { bridge: ReturnType<typeof makeBridge>; params: HarnessParams } | null = null;

/** Seeds the stores once, before the first render (module state: the harness is one page). */
function prepare(): NonNullable<typeof prepared> {
  if (prepared !== null) return prepared;
  const params = readParams();
  const envelope = makeEnvelope(params.lines);
  const seed = presetLines(params.preset, envelope.subtotal_minor);
  useOperatorSessionStore.setState({
    state: {
      kind: 'signedIn',
      session: {
        id: 'dev-session',
        operator_id: 'dev-operator',
        display_name: 'سارة محمود',
        role: 'cashier',
        tenant_id: 'dev-tenant',
        branch_id: 'dev-branch',
        started_at: new Date().toISOString(),
      },
    },
  });
  useFeatureFlagsStore.getState().hydrate({ cart: true, payments: true, saleFinalization: true });
  const store = usePaymentStore.getState();
  store.mount(envelope);
  if (seed.length > 0) {
    store.applyAttemptSnapshot({
      payment_attempt_id: ATTEMPT_ID,
      state: 'started',
      envelope_subtotal_minor: envelope.subtotal_minor,
      started_at: new Date().toISOString(),
      tender_lines: seed,
    });
  }
  prepared = { bridge: makeBridge(envelope.subtotal_minor, seed), params };
  return prepared;
}

export function CheckoutProof(): JSX.Element {
  const { bridge, params } = prepare();
  return (
    <MemoryRouter initialEntries={['/app/checkout']}>
      <V5Frame
        notices={
          params.banner ? (
            <Banner tone="warning">
              لا توجد وردية مفتوحة على هذا الجهاز. افتح وردية بمبلغ الافتتاح قبل البيع.
            </Banner>
          ) : undefined
        }
      >
        <PaymentSurface
          _testBridge={bridge}
          onBackToSale={() => Promise.resolve(false)}
          backToSaleEligibility={params.preset === 'none' ? 'returnable' : 'blocked'}
          onNewSale={() => {
            window.location.reload();
          }}
        />
      </V5Frame>
    </MemoryRouter>
  );
}
