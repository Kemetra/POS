/**
 * RT-15 S4 X7 — a seeded, randomized interleaving of the payout domain.
 *
 * Drives the REAL composed domain (payout service, repositories on sql.js,
 * authorizer, audits) with a fake drawer and printer whose latency and
 * answers (opened / failed / throw; printed / failed / throw) come from a
 * seeded PRNG. Steps interleave start, retry_drawer, manual, double clicks,
 * reprints, crash-and-restart (the old domain is stopped and its in-flight
 * work drained BEFORE the new one starts, as a real restart is sequential),
 * locks, sign-out, operator switches and event-loop turns.
 *
 * The run records what the invariants need: every kick with the returns that
 * were claimed and confirmed at that instant, and, per crash, the payout
 * state at the crash and after the crashed domain's in-flight work settled.
 */
import type { Role } from '../../../../shared/operator/role.js';
import type { ReturnPayoutAction } from '../../../../shared/returns/types.js';
import type { ComposedReturns } from '../../compose-returns.js';
import { SeededRng } from './seeded-rng.js';
import {
  committedAudits,
  confirmedReturn,
  returnsHarness,
  saleBody,
  seedSyncedSale,
  type ReturnsHarness,
} from './returns-fixture.js';

const SALES = [
  { saleId: 'sale-1', saleRef: '0190f5a2-7b3c-7d4e-8f90-0000000000b1' },
  { saleId: 'sale-2', saleRef: '0190f5a2-7b3c-7d4e-8f90-0000000000b2' },
  { saleId: 'sale-3', saleRef: '0190f5a2-7b3c-7d4e-8f90-0000000000b3' },
] as const;

type Action =
  | ReturnPayoutAction
  | 'double'
  | 'reprint'
  | 'crash'
  | 'lock'
  | 'sign_out'
  | 'sign_in'
  | 'turn';

const ACTIONS: readonly (readonly [Action, number])[] = [
  ['start', 20],
  ['retry_drawer', 12],
  ['manual', 10],
  ['double', 8],
  ['reprint', 6],
  ['crash', 5],
  ['lock', 4],
  ['sign_out', 2],
  ['sign_in', 6],
  ['turn', 27],
];

const SIGN_IN_ROLES: readonly Role[] = ['manager', 'admin', 'manager', 'cashier'];

/** The payout state of the till at one instant (to detect a write after a crash). */
export interface PayoutSnapshot {
  readonly journal: string;
  readonly payouts: string;
  readonly audits: number;
}

export interface PayoutRun {
  readonly seed: number;
  readonly harness: ReturnsHarness;
  /** Returns confirmed at setup (payable). */
  readonly confirmed: readonly string[];
  /** A journaled return that was never confirmed (never payable). */
  readonly unconfirmed: string;
  /** Per kick: the returns that were confirmed AND claimed when it happened. */
  readonly claimedAtKick: readonly (readonly string[])[];
  /** Per crash: the state at the crash and after the crashed domain settled. */
  readonly crashes: readonly { readonly at: PayoutSnapshot; readonly settled: PayoutSnapshot }[];
}

export async function runPayoutInterleaving(seed: number, steps: number): Promise<PayoutRun> {
  const world = new PayoutWorld(seed);
  await world.setUp();
  return world.run(steps);
}

class PayoutWorld {
  private readonly rng: SeededRng;
  readonly h: ReturnsHarness;
  private domain: ComposedReturns;
  private inFlight: Promise<unknown>[] = [];
  private confirmed: string[] = [];
  private unconfirmed = '';
  private readonly claimedAtKick: string[][] = [];
  private readonly crashes: { at: PayoutSnapshot; settled: PayoutSnapshot }[] = [];

  constructor(private readonly seed: number) {
    this.rng = new SeededRng(seed);
    this.h = returnsHarness();
    this.domain = this.h;
    for (const sale of SALES) {
      seedSyncedSale(this.h.db, { ...sale, sale: saleBody({ saleRef: sale.saleRef }) });
    }
    this.h.backend.saleFor = (saleRef) => saleBody({ saleRef });
  }

  async setUp(): Promise<void> {
    for (const sale of SALES.slice(0, 2)) {
      this.confirmed.push(await confirmedReturn(this.h.service, `SN-${sale.saleId}`));
    }
    // The third sale's return is journaled but its answer is lost: never payable.
    this.h.backend.onReturn = () => {
      throw new TypeError('socket hang up');
    };
    const lost = await this.h.service.submit({
      saleNumber: 'SN-sale-3',
      lines: [{ lineRef: saleBody().lines[0]?.lineRef ?? '', quantity: 1 }],
    });
    this.unconfirmed = lost.ret?.returnId ?? '';
    this.h.drawer.onKick = () => {
      this.claimedAtKick.push(this.claimedAndConfirmed());
    };
    this.h.drawer.answer = () => this.drawerAnswer();
    this.h.printer.answer = () => this.printerAnswer();
  }

  async run(steps: number): Promise<PayoutRun> {
    for (let step = 0; step < steps; step += 1) await this.act(this.rng.weighted(ACTIONS));
    await this.settle();
    return {
      seed: this.seed,
      harness: this.h,
      confirmed: this.confirmed,
      unconfirmed: this.unconfirmed,
      claimedAtKick: this.claimedAtKick,
      crashes: this.crashes,
    };
  }

  private async act(action: Action): Promise<void> {
    const handlers: Record<Action, () => void | Promise<void>> = {
      start: () => {
        this.payout('start');
      },
      retry_drawer: () => {
        this.payout('retry_drawer');
      },
      manual: () => {
        this.payout('manual');
      },
      double: () => {
        const returnId = this.pickReturn();
        this.track(this.domain.service.payout({ returnId, action: 'start' }));
        this.track(this.domain.service.payout({ returnId, action: 'start' }));
      },
      reprint: () => {
        this.track(this.domain.service.reprintSlip({ returnId: this.pickReturn() }));
      },
      crash: () => this.crash(),
      lock: () => this.lockForAWhile(),
      sign_out: () => {
        this.h.state.role = null;
      },
      sign_in: () => {
        this.h.state.role = this.rng.pick(SIGN_IN_ROLES);
        this.h.state.locked = false;
      },
      turn: () => this.turns(),
    };
    await handlers[action]();
  }

  private payout(action: ReturnPayoutAction): void {
    this.track(this.domain.service.payout({ returnId: this.pickReturn(), action }));
  }

  /** Mostly a payable return, sometimes the never-confirmed one. */
  private pickReturn(): string {
    return this.rng.chance(0.15) ? this.unconfirmed : this.rng.pick(this.confirmed);
  }

  private track(work: Promise<unknown>): void {
    this.inFlight.push(work.catch(() => undefined));
  }

  /** Crash: stop the domain, let its in-flight work settle, then start again. */
  private async crash(): Promise<void> {
    const at = this.snapshot();
    this.domain = this.h.restart();
    await this.settle();
    this.crashes.push({ at, settled: this.snapshot() });
  }

  private async settle(): Promise<void> {
    let settled = -1;
    while (settled !== this.inFlight.length) {
      settled = this.inFlight.length;
      await Promise.all(this.inFlight);
    }
    this.inFlight = [];
  }

  private async lockForAWhile(): Promise<void> {
    this.h.state.locked = true;
    await this.turns();
    this.h.state.locked = false;
  }

  /** A few event-loop turns (microtasks and macrotasks), drawn from the PRNG. */
  private async turns(): Promise<void> {
    const n = this.rng.int(4);
    for (let i = 0; i < n; i += 1) {
      if (this.rng.chance(0.5)) await Promise.resolve();
      else await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private async drawerAnswer() {
    await this.turns();
    const roll = this.rng.next();
    if (roll < 0.6) return { ok: true } as const;
    if (roll < 0.9) return { ok: false, failure_reason: 'no_drawer_configured' } as const;
    throw new Error('drawer fault');
  }

  private async printerAnswer() {
    await this.turns();
    const roll = this.rng.next();
    if (roll < 0.7) return { ok: true, render_path: 'os_print' } as const;
    if (roll < 0.9) {
      return { ok: false, render_path: 'os_print', failure_reason: 'printer_offline' } as const;
    }
    throw new Error('spooler fault');
  }

  private claimedAndConfirmed(): string[] {
    const res = this.h.db.exec(
      `SELECT p.return_id FROM return_payouts p JOIN return_journal j USING (return_id)
       WHERE j.state = 'confirmed' AND p.paid_at IS NULL ORDER BY p.return_id`,
    )[0];
    return (res?.values ?? []).map((r) => String(r[0]));
  }

  private snapshot(): PayoutSnapshot {
    const rows = (sql: string): string => JSON.stringify(this.h.db.exec(sql)[0]?.values ?? []);
    return {
      journal: rows('SELECT return_id, state, updated_at FROM return_journal ORDER BY return_id'),
      payouts: rows('SELECT * FROM return_payouts ORDER BY return_id'),
      audits: committedAudits(this.h.db).length,
    };
  }
}
