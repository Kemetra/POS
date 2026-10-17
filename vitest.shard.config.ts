import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// RT-588 — config for the CI test shards (`vitest --shard=i/N --reporter=blob`).
//
// A shard sees only a slice of the suite, so evaluating the coverage
// thresholds on one shard would fail falsely (the slice does not cover every
// file) — and could never prove anything about the whole suite. The shards
// therefore only COLLECT coverage into their blob report; the thresholds
// (per-file 80%, money.ts 95%, every per-glob override in vitest.config.ts)
// are evaluated exactly once, by the `test` merge job running
// `vitest run --merge-reports --coverage` with the UNMODIFIED vitest.config.ts.
//
// Everything else — include globs, coverage include/exclude, aliases,
// environment — is inherited from vitest.config.ts so a shard measures exactly
// the same files the merge job gates. Only thresholds and the (informational,
// per-slice) text/lcov reporters differ.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    coverage: {
      ...base.test?.coverage,
      thresholds: undefined,
      reporter: [],
    },
  },
});
