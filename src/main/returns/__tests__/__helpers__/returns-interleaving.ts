/**
 * RT-197 I5 — a seeded, randomized interleaving of the return domain.
 *
 * Drives the REAL composed domain (service → dispatcher → repository on
 * sql.js, resolver, authorizer, audits) against a fake Backend-Core whose
 * latency and answers (recorded, recorded-but-lost, lost, 503, refused) are
 * drawn from a seeded PRNG. Steps interleave submits, background ticks,
 * on-demand resolves, operator sign-in / sign-out / switches, locks, envelope
 * rotations, clock advances and event-loop turns; at a random point the
 * domain is stopped the way the app quits (`stop()`, then no new work — the
 * renderer is gone — while in-flight work settles).
 *
 * The run records what the invariants need: every request with its envelope,
 * the envelopes issued to manager/admin sessions, the journal and audit rows
 * as they were at stop and at the end (so any write after stop shows as a
 * difference), any request made after stop, and any moment a sale had two
 * unresolved returns at once.
 */
import type { Role } from '../../../../shared/operator/role.js';
import type { AuditEvent } from '../../../../shared/audit/event-shape.js';
import { SeededRng } from './seeded-rng.js';
import {
  LINE_A,
  SALE_REF,
  committedAudits,
  errorBody,
  jsonResponse,
  returnsHarness,
  saleBody,
  secondsAfterNow,
  seedSyncedSale,
  type FakeBackend,
  type RecordedCall,
  type ReturnsHarness,
} from './returns-fixture.js';

const SALES = [
  { saleId: 'sale-1', saleRef: SALE_REF },
  { saleId: 'sale-2', saleRef: '0190f5a2-7b3c-7d4e-8f90-0000000000b2' },
  { saleId: 'sale-3', saleRef: '0190f5a2-7b3c-7d4e-8f90-0000000000b3' },
] as const;

type Action =
  | 'submit'
  | 'tick'
  | 'resolve'
  | 'sign_in'
  | 'sign_out'
  | 'lock'
  | 'rotate'
  | 'clock'
  | 'turn';

const ACTIONS: readonly (readonly [Action, number])[] = [
  ['submit', 25],
  ['tick', 18],
  ['resolve', 12],
  ['sign_in', 6],
  ['sign_out', 2],
  ['lock', 3],
  ['rotate', 3],
  ['clock', 12],
  ['turn', 19],
];

/** Who signs in: mostly someone who may return, sometimes a cashier. */
const SIGN_IN_ROLES: readonly Role[] = ['manager', 'manager', 'admin', 'cashier'];

type PostAnswer = 'record' | 'record_lost' | 'lost' | 'unavailable' | 'refuse';

const POST_ANSWERS: readonly (readonly [PostAnswer, number])[] = [
  ['record', 40],
  ['record_lost', 20],
  ['lost', 15],
  ['unavailable', 15],
  ['refuse', 10],
];

/** What a write could change on a journal row. */
export interface JournalRowState {
  readonly externalId: string;
  readonly state: string;
  readonly attemptCount: number;
  readonly updatedAt: string;
}

/** The live operator state at the instant a request left the till. */
export interface LiveAtSend {
  readonly envelope: string | null;
  readonly role: Role | null;
  readonly locked: boolean;
}

export interface InterleavingRun {
  readonly seed: number;
  /** Every request the fake backend received, in order. */
  readonly calls: readonly RecordedCall[];
  /** The live operator state when each of `calls` left (same order). */
  readonly liveAtSend: readonly LiveAtSend[];
  /** Envelopes issued to manager/admin sessions (the only admissible ones). */
  readonly admitted: ReadonlySet<string>;
  /** Committed audit rows at the end of the run. */
  readonly audits: readonly AuditEvent[];
  /** The journaled returns' external ids at the end of the run. */
  readonly journaledExternalIds: ReadonlySet<string>;
  /** Journal rows (by return id) at stop and at the end; equal when the run never stopped. */
  readonly journalAtStop: ReadonlyMap<string, JournalRowState>;
  readonly journalAtEnd: ReadonlyMap<string, JournalRowState>;
  /** Audit rows committed after stop. */
  readonly auditsAfterStop: readonly AuditEvent[];
  /** Requests sent after stop. */
  readonly callsAfterStop: number;
  /** Moments a sale had two unresolved returns at once. */
  readonly overlaps: readonly string[];
  /** Whether the run stopped the domain. */
  readonly stopped: boolean;
}

/** One seeded run of `steps` random actions (then a drain). */
export async function runInterleaving(seed: number, steps: number): Promise<InterleavingRun> {
  const world = new InterleavingWorld(seed);
  try {
    return await world.run(steps);
  } finally {
    world.dispose();
  }
}

class InterleavingWorld {
  private readonly rng: SeededRng;
  private readonly h: ReturnsHarness;
  private readonly inFlight: Promise<unknown>[] = [];
  private readonly admitted = new Set<string>();
  private readonly liveAtSend: LiveAtSend[] = [];
  private journalAtStop: Map<string, JournalRowState> | null = null;
  private auditCountAtStop = 0;
  private readonly overlaps: string[] = [];
  private envelopes = 0;
  private seconds = 0;
  /** Clock reads so far: each read is 1 ms later, so journal rows never tie on created_at. */
  private clockReads = 0;
  private stopped = false;
  private callsAtStop = 0;

  constructor(private readonly seed: number) {
    this.rng = new SeededRng(seed);
    this.h = returnsHarness();
    for (const sale of SALES) {
      seedSyncedSale(this.h.db, { ...sale, sale: saleBody({ saleRef: sale.saleRef }) });
    }
    this.h.backend.saleFor = (saleRef) => saleBody({ saleRef });
    this.h.backend.readLatency = () => {
      this.recordLive();
      return this.latency();
    };
    this.h.backend.onReturn = (call, backend) => this.answerPost(call, backend);
    // A strictly increasing domain clock: the resolver's oldest-first order (and
    // so the whole run) is then a function of the seed alone.
    Object.defineProperty(this.h.state, 'now', { get: () => this.readClock() });
    this.signIn('manager');
  }

  async run(steps: number): Promise<InterleavingRun> {
    const stopAt = this.rng.chance(0.7) ? Math.floor(steps / 2) + this.rng.int(steps / 2) : -1;
    for (let step = 0; step < steps && !this.stopped; step += 1) {
      if (step === stopAt) this.stop();
      else await this.act(this.rng.weighted(ACTIONS));
      this.checkOverlap(step);
    }
    await this.drain();
    return this.result();
  }

  dispose(): void {
    this.h.close();
  }

  private async act(action: Action): Promise<void> {
    const handlers: Record<Action, () => void | Promise<void>> = {
      submit: () => {
        this.track(this.h.service.submit(this.submitRequest()));
      },
      tick: () => {
        this.track(this.h.resolver.tick());
      },
      resolve: () => {
        this.track(this.h.service.resolve());
      },
      sign_in: () => {
        this.signIn(this.rng.pick(SIGN_IN_ROLES));
      },
      sign_out: () => {
        this.signOut();
      },
      lock: () => this.lockForAWhile(),
      rotate: () => {
        this.rotateEnvelope();
      },
      clock: () => {
        this.advanceClock();
      },
      turn: () => this.latency(),
    };
    await handlers[action]();
  }

  private submitRequest() {
    const sale = this.rng.pick(SALES);
    return { saleNumber: `SN-${sale.saleId}`, lines: [{ lineRef: LINE_A, quantity: 1 }] };
  }

  private track(work: Promise<unknown>): void {
    this.inFlight.push(work.catch(() => undefined));
  }

  /** A new operator session: a fresh envelope, unlocked. */
  private signIn(role: Role): void {
    this.h.state.role = role;
    this.h.state.locked = false;
    this.h.state.token = this.issueEnvelope(role);
  }

  private signOut(): void {
    this.h.state.role = null;
    this.h.state.token = null;
  }

  /** An inactivity lock for a few event-loop turns, then the same operator unlocks. */
  private async lockForAWhile(): Promise<void> {
    this.h.state.locked = true;
    await this.latency();
    this.h.state.locked = false;
  }

  /** Same session, its envelope replaced. */
  private rotateEnvelope(): void {
    if (this.h.state.role !== null) this.h.state.token = this.issueEnvelope(this.h.state.role);
  }

  private issueEnvelope(role: Role): string {
    this.envelopes += 1;
    const envelope = `${role}-envelope-${String(this.envelopes)}`;
    if (role === 'manager' || role === 'admin') this.admitted.add(envelope);
    return envelope;
  }

  private advanceClock(): void {
    this.seconds += 1 + this.rng.int(120);
  }

  private readClock(): string {
    this.clockReads += 1;
    return secondsAfterNow(this.seconds + this.clockReads / 1_000);
  }

  /** A few event-loop turns (microtasks and macrotasks), drawn from the PRNG. */
  private async latency(): Promise<void> {
    const turns = this.rng.int(4);
    for (let i = 0; i < turns; i += 1) {
      if (this.rng.chance(0.5)) await Promise.resolve();
      else await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** Called synchronously as a request arrives: who was live when it left. */
  private recordLive(): void {
    const { token, role, locked } = this.h.state;
    this.liveAtSend.push({ envelope: token, role, locked });
  }

  private async answerPost(call: RecordedCall, backend: FakeBackend): Promise<Response> {
    this.recordLive();
    await this.latency();
    const key = call.headers['Idempotency-Key'] ?? '';
    // A recorded key always replays (Backend-Core's provenance replay comes first).
    const answer = backend.recorded.has(key)
      ? this.rng.pick<PostAnswer>(['record', 'record_lost'])
      : this.rng.weighted(POST_ANSWERS);
    return this.respond(answer, call, backend);
  }

  private respond(answer: PostAnswer, call: RecordedCall, backend: FakeBackend): Response {
    if (answer === 'unavailable') return jsonResponse(503, errorBody('internal_error'));
    if (answer === 'refuse') return jsonResponse(409, errorBody('over_return'));
    if (answer === 'lost') throw new TypeError('socket hang up');
    const recorded = backend.recordIdempotently(call);
    if (answer === 'record_lost') throw new TypeError('socket hang up');
    return recorded;
  }

  /**
   * The app quits: the worker stopper latches the domain stopped (the
   * renderer is gone, so no new work starts; in-flight work settles).
   */
  private stop(): void {
    this.h.stop();
    this.stopped = true;
    this.callsAtStop = this.h.backend.calls.length;
    this.journalAtStop = this.journalRows();
    this.auditCountAtStop = committedAudits(this.h.db).length;
  }

  private journalRows(): Map<string, JournalRowState> {
    const res = this.h.db.exec(
      'SELECT return_id, external_id, state, attempt_count, updated_at FROM return_journal',
    )[0];
    const rows = new Map<string, JournalRowState>();
    for (const [id, externalId, state, attempts, updatedAt] of res?.values ?? []) {
      rows.set(String(id), {
        externalId: String(externalId),
        state: String(state),
        attemptCount: Number(attempts),
        updatedAt: String(updatedAt),
      });
    }
    return rows;
  }

  /** Two unresolved returns on one sale at once would break D6. */
  private checkOverlap(step: number): void {
    if (this.stopped) return;
    const rows = this.h.db.exec(
      `SELECT sale_id FROM return_journal WHERE state IN ('pending', 'unknown')
       GROUP BY sale_id HAVING COUNT(*) > 1`,
    )[0];
    if (rows !== undefined) this.overlaps.push(`step ${String(step)}: ${JSON.stringify(rows)}`);
  }

  /** Let every in-flight operation settle (they may still be running after stop). */
  private async drain(): Promise<void> {
    let settled = -1;
    while (settled !== this.inFlight.length) {
      settled = this.inFlight.length;
      await Promise.all(this.inFlight);
    }
    await this.h.resolver.drain(1_000);
  }

  private result(): InterleavingRun {
    const audits = committedAudits(this.h.db);
    const journalAtEnd = this.journalRows();
    return {
      seed: this.seed,
      calls: [...this.h.backend.calls],
      liveAtSend: this.liveAtSend,
      admitted: this.admitted,
      audits,
      journaledExternalIds: new Set([...journalAtEnd.values()].map((r) => r.externalId)),
      journalAtStop: this.journalAtStop ?? journalAtEnd,
      journalAtEnd,
      auditsAfterStop: this.stopped ? audits.slice(this.auditCountAtStop) : [],
      callsAfterStop: this.stopped ? this.h.backend.calls.length - this.callsAtStop : 0,
      overlaps: this.overlaps,
      stopped: this.stopped,
    };
  }
}
