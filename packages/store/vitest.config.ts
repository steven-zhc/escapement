import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test in this package but `timestamptz` talks to the real database
    // over the network. The default 5s is not enough for a Supabase round trip,
    // let alone five races in a row.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One file at a time: they share one `events` table, and the cleanup hook
    // toggles a table-level rule.
    fileParallelism: false,
    // Removes this run's throwaway `esctest*` projects from the test log. Without
    // it the residue outlives the run, and `lingtai doctor`'s own test — which
    // asserts the whole database is green — fails on rows an earlier package's
    // tests left behind. See the file for what that looked like.
    globalSetup: ["./test-support/teardown.ts"],
  },
});
