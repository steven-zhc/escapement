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
  },
});
