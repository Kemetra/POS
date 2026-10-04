/**
 * RT-15 S4 X7 — a seeded, randomized interleaving of the payout domain.
 *
 * Drives the REAL composed domain (payout service, repositories on sql.js,
 * authorizer, audits) with a fake drawer and printer whose latency and
 * answers (opened / failed / throw; printed / failed / throw) come from a
 * seeded PRNG. Steps interleave start, retry_drawer, manual, double clicks,
 * reprints, crash-and-restart, locks, sign-out, operator switches and
 * event-loop turns.
 *
 * A crash is a dead process: the old domain is latched stopped and its
 * in-flight drawer and printer answers never arrive (nothing it awaited ever
 * resumes), then a fresh domain starts over the same database.
 *
 * The run records what the invariants need: every kick attributed to its own
 * return (the return whose durable `kick_count` the kick just incremented),
 * with that return's claim and drawer audits at that instant; both answers of
 * every double click; the live session at every `paid_out` audit; and, per
 * crash, the payout state at the crash and after the abandoned work.
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

/** One drawer kick, attributed to its return, with what was known at that instant. */
export interface KickEvent {
  /** The returns whose kick_count this kick incremented (exactly one is right). */
  readonly returnIds: readonly string[];
  /** Whether each such return had its `payout_started` audit already. */
  readonly claimed: boolean;
  /** That return's drawer audits so far, as their `kick_outcome`s. */
  readonly earlierOutcomes: readonly unknown[];
}

/** Who was live (and unlocked) when a `paid_out` audit was written. */
export interface PaidOutAtCommit {
  readonly acting: string;
  readonly liveRole: Role | null;
  readonly locked: boolean;
}

export interface PayoutRun {
  readonly seed: number;
  readonly harness: ReturnsHarness;
  /** Returns confirmed at setup (payable). */
  readonly confirmed: readonly string[];
  /** A journaled return that was never confirmed (never payable). */
  readonly unconfirmed: string;
  readonly kicks: readonly KickEvent[];
  /** Both answers of every double click (the same admitted actor). */
  readonly doubles: readonly (readonly [unknown, unknown])[];
  readonly paidOutAtCommit: readonly PaidOutAtCommit[];
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
  private readonly kicks: KickEvent[] = [];
  private readonly doubles: [unknown, unknown][] = [];
  private readonly paidOutAtCommit: PaidOutAtCommit[] = [];
  private kickCounts = new Map<string, number>();
  /** The live process; answers issued to an older one never arrive. */
  private generation = 0;
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
      this.kicks.push(this.attributeKick());
    };
    this.h.state.onAudit = (event) => {
      if (event.action_category !== 'sale.return.paid_out') return;
      const { role, locked } = this.h.state;
      this.paidOutAtCommit.push({ acting: event.acting_operator_id, liveRole: role, locked });
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
      kicks: this.kicks,
      doubles: this.doubles,
      paidOutAtCommit: this.paidOutAtCommit,
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
        const action = this.rng.pick<ReturnPayoutAction>(['start', 'retry_drawer', 'manual']);
        const first = this.domain.service.payout({ returnId, action });
        const second = this.domain.service.payout({ returnId, action });
        this.track(
          Promise.all([first, second]).then((pair) => {
            this.doubles.push(pair);
          }),
        );
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

  /**
   * Crash: the process dies. Its in-flight answers never arrive (abandoned,
   * not awaited); a fresh domain starts over the same database. A few turns
   * later the database must still be exactly as the crash left it.
   */
  private async crash(): Promise<void> {
    const at = this.snapshot();
    this.generation += 1;
    this.inFlight = [];
    this.domain = this.h.restart();
    await this.turns();
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.crashes.push({ at, settled: this.snapshot() });
  }

  /** After the latency: the answer, unless its process has died meanwhile. */
  private async afterLatency<T>(answer: () => T): Promise<T> {
    const generation = this.generation;
    await this.turns();
    if (generation !== this.generation) return new Promise<T>(() => undefined);
    return answer();
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

  private drawerAnswer() {
    return this.afterLatency(() => {
      const roll = this.rng.next();
      if (roll < 0.5) return { ok: true } as const;
      if (roll < 0.8) return { ok: false, failure_reason: 'no_drawer_configured' } as const;
      if (roll < 0.9) return { ok: false, failure_reason: 'os_error' } as const;
      throw new Error('drawer fault');
    });
  }

  private printerAnswer() {
    return this.afterLatency(() => {
      const roll = this.rng.next();
      if (roll < 0.7) return { ok: true, render_path: 'os_print' } as const;
      if (roll < 0.9) {
        return { ok: false, render_path: 'os_print', failure_reason: 'printer_offline' } as const;
      }
      throw new Error('spooler fault');
    });
  }

  /** The kick just sent: the return whose durable kick_count it incremented. */
  private attributeKick(): KickEvent {
    const res = this.h.db.exec('SELECT return_id, kick_count FROM return_payouts')[0];
    const counts = new Map((res?.values ?? []).map((r) => [String(r[0]), Number(r[1])]));
    const returnIds = [...counts]
      .filter(([id, n]) => n > (this.kickCounts.get(id) ?? 0))
      .map(([id]) => id);
    this.kickCounts = counts;
    const audits = committedAudits(this.h.db).filter(
      (a) => a.payload['return_id'] === returnIds[0],
    );
    return {
      returnIds,
      claimed: audits.some((a) => a.action_category === 'sale.return.payout_started'),
      earlierOutcomes: audits
        .filter((a) => /^sale\.return\.drawer_(opened|failed)$/.test(a.action_category))
        .map((a) => a.payload['kick_outcome']),
    };
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
