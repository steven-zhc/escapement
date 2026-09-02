/**
 * Empty the test database's log.
 *
 *   ESCAPEMENT_TEST=1 pnpm --filter @escapement/store db:reset-test
 *
 * The suite appends real events and cleans up its own streams, but the log as a
 * whole only grows: 945 events and a sequence past 11,000 after a few weeks of
 * runs. Most tests do not care. `rebuilding changes nothing on screen` does,
 * because a rebuild replays the *whole* log — so that test's cost is the log's
 * length, and it got slower with every suite run anyone had ever done until it
 * crossed the 60s timeout and started failing for a reason that had nothing to
 * do with the code being tested.
 *
 * Deliberately a separate command rather than a hook in `beforeAll`. Wiping a
 * database is not something a test run should do on its own initiative, and a
 * suite that silently truncates is one nobody can point at a database they care
 * about — which is exactly the mistake this is cleaning up after.
 *
 * ## Why this cannot hit the real log
 *
 * Two independent checks, because one is a typo away from nothing. The test
 * flag must be set, *and* the resolved connection string must differ from the
 * one resolved without it. If someone points TEST_DATABASE_URL at their own
 * database, the second check is what refuses.
 */
import pg from "pg";
import { directDatabaseUrl } from "@escapement/store";

if (!process.env["ESCAPEMENT_TEST"] && !process.env["VITEST"]) {
  console.error("refusing: set ESCAPEMENT_TEST=1 to say which database you mean");
  process.exit(2);
}

const testUrl = directDatabaseUrl();

delete process.env["ESCAPEMENT_TEST"];
delete process.env["VITEST"];
let mainUrl = null;
try {
  mainUrl = directDatabaseUrl();
} catch {
  // No main database configured at all. Nothing to collide with.
}

if (mainUrl && mainUrl === testUrl) {
  console.error("refusing: TEST_DIRECT_DATABASE_URL resolves to the same database as DIRECT_DATABASE_URL");
  process.exit(2);
}

const client = new pg.Client({ connectionString: testUrl });
await client.connect();
try {
  const before = await client.query("select count(*)::int as n from events");

  // The table carries a rule that turns deletes into no-ops — the log is
  // append-only and means it. Cleaning up is an explicit, temporary exception.
  await client.query("alter table events disable rule escapement_events_no_delete");
  try {
    await client.query("truncate table events restart identity");
    // Checkpoints name a sequence that no longer exists; a projection resuming
    // from one would sit forever waiting for events behind it.
    await client.query("truncate table checkpoints");
    // The outbox outlives a log reset because the contract owns the table and
    // no projection drops it. Left behind, a dead letter from a suite that
    // exercised a permanent failure makes `esc doctor` red forever — the check
    // being right about data that no longer means anything.
    await client.query("truncate table outbox");
  } finally {
    await client.query("alter table events enable rule escapement_events_no_delete");
  }

  console.log(`test log reset — ${before.rows[0].n} events removed, sequence restarted`);
  console.log("projection tables are rebuilt on next start; their checkpoints are cleared");
} finally {
  await client.end();
}
