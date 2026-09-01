/**
 * `guard_trips` — which guard patterns fire, and how often.
 *
 * The first real projection, and it exists because of a number: **132 guard
 * blocks across 56 of 73 runs.** 77% of the old loop's runs tripped the guard,
 * every block went to stderr inside a log nobody parsed, and nobody ever saw
 * one. Not one pattern was ever tuned, because there was no way to know which
 * ones were firing or whether they were right to.
 *
 * Deliberately not in the Prisma contract. A projection's shape follows its
 * reader, and changing this one costs a `TRUNCATE` and a replay rather than a
 * migration — which is exactly why the DDL lives here, next to the code that
 * depends on it.
 */
import type { PayloadOf } from "@escapement/core";
import pg from "pg";
import { databaseUrl } from "../env.ts";
import type { Projection } from "../projection.ts";

export const GUARD_TRIPS_TABLE = "guard_trips";

export const guardTripsProjection: Projection = {
  name: "guard_trips",

  async create(ctx) {
    await ctx.query(`
      create table if not exists guard_trips (
        seq              bigint primary key,
        run_id           text        not null,
        tool             text        not null,
        pattern          text        not null,
        redacted_command text        not null,
        at               timestamptz not null
      )`);
    await ctx.query("create index if not exists guard_trips_pattern_idx on guard_trips (pattern)");
    await ctx.query("create index if not exists guard_trips_run_idx on guard_trips (run_id)");
  },

  async reset(ctx) {
    // Dropped, not truncated — see the note on Projection.reset.
    await ctx.query("drop table if exists guard_trips");
  },

  async apply(events, ctx) {
    for (const event of events) {
      if (event.type !== "GuardTripped") continue;
      const d = event.data as PayloadOf<"GuardTripped">;
      // `seq` as the primary key with `do nothing` makes this idempotent for
      // free, which the runner requires: a process killed after Postgres
      // committed will re-read the same batch, and so will a rebuild.
      //
      // The command is already redacted at the source — what trips the guard is
      // frequently the thing worth not storing.
      await ctx.query(
        `insert into guard_trips (seq, run_id, tool, pattern, redacted_command, at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (seq) do nothing`,
        [
          event.seq.toString(),
          // A GuardTripped is written to its run's stream, so the stream *is*
          // the run id. The payload does not repeat it.
          event.streamId,
          d.tool,
          d.pattern,
          d.redactedCommand,
          event.at.toISOString(),
        ],
      );
    }
  },
};

export interface GuardPatternTally {
  pattern: string;
  tool: string;
  trips: number;
  runs: number;
}

/**
 * The query the projection exists for: which patterns fire most, so the false
 * positives can be found and tuned. A pattern with many trips across many runs
 * is either load-bearing or wrong, and either way it is worth looking at.
 */
export async function guardTripsByPattern(url = databaseUrl()): Promise<GuardPatternTally[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query<{ pattern: string; tool: string; trips: string; runs: string }>(
      `select pattern, tool, count(*)::text as trips, count(distinct run_id)::text as runs
       from guard_trips
       group by pattern, tool
       order by count(*) desc, pattern`,
    );
    return r.rows.map((row) => ({
      pattern: row.pattern,
      tool: row.tool,
      trips: Number(row.trips),
      runs: Number(row.runs),
    }));
  } finally {
    await client.end();
  }
}
