/**
 * RT-197 I5 — a tiny seeded PRNG for reproducible randomized tests
 * (mulberry32; no dependency — package.json is gated). The same seed always
 * yields the same sequence, so a failing seed replays exactly.
 */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** One of `items`, uniformly. */
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('SeededRng.pick: empty list');
    return item;
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** An entry of `table`, with probability proportional to its weight. */
  weighted<T>(table: readonly (readonly [T, number])[]): T {
    const total = table.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of table) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return this.pick(table.map(([value]) => value));
  }
}
