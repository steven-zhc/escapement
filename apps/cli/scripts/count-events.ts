/**
 * How many events each database holds.
 *
 * Written to answer one question: why the board's rebuild test started timing
 * out. A rebuild replays the whole log, so its cost is the log's length, and
 * the test suite appends to its own log on every run without ever pruning it.
 */
import { directDatabaseUrl } from "@escapement/store";
import pg from "pg";

async function count(label: string, url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query("select count(*)::int as n, coalesce(max(seq), 0)::int as s from events");
    console.log(`${label}\t${r.rows[0].n} events\tmax seq ${r.rows[0].s}`);
  } finally {
    await client.end();
  }
}

// `directDatabaseUrl()` returns the TEST_* string when VITEST is set, so both
// are read here by flipping that rather than by reading process.env directly.
process.env["VITEST"] = "1";
await count("test", directDatabaseUrl());
delete process.env["VITEST"];
await count("main", directDatabaseUrl());
