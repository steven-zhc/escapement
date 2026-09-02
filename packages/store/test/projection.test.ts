/**
 * The projection runner, against the real database.
 *
 * Two properties carry the weight. **A rebuild produces the same table as the
 * incremental path** — that is what makes a projection's shape free to change,
 * because changing one then costs a truncate and a replay rather than a
 * migration. And **a handler that throws stops the projection with its
 * checkpoint intact** — a projection that skipped what it could not handle would
 * be quietly wrong, which is the failure mode this whole system exists to end.
 */
import type { Envelope } from "@escapement/core";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { directDatabaseUrl } from "../src/env.ts";
import {
  createDb,
  createEventStore,
  createProjectionRunner,
  type Db,
  type EventStore,
  type Projection,
  type ProjectionRunner,
  projectionLag,
} from "../src/index.ts";
import { cleanupStreams, streamId, waitFor } from "./support.ts";

let client: Db;
let store: EventStore;
const openRunners: ProjectionRunner[] = [];

function runStream(): string {
  return streamId("run");
}

/**
 * A projection that exists only here.
 *
 * These tests are about the *runner* — catch-up, checkpoints, rebuild
 * determinism, a failing apply — and not about any particular projection. They
 * used `guard_trips`, which coupled the store's tests to a projection that was
 * later deleted outright (ADR 0016 §6) and took a day's worth of machinery
 * coverage with it. Owning the subject here means the next deletion cannot.
 */
const TEST_TABLE = "esc_test_touches";

const testProjection: Projection = {
  name: TEST_TABLE,
  async create(ctx) {
    await ctx.query(
      `create table if not exists ${TEST_TABLE} (
         seq     bigint primary key,
         run_id  text not null,
         path    text not null
       )`,
    );
  },
  async reset(ctx) {
    await ctx.query(`drop table if exists ${TEST_TABLE}`);
  },
  async apply(events, ctx) {
    for (const event of events) {
      if (event.type !== "RunTouchedFile") continue;
      const d = event.data as { path: string };
      await ctx.query(
        `insert into ${TEST_TABLE} (seq, run_id, path) values ($1::bigint, $2, $3)
         on conflict (seq) do nothing`,
        [event.seq.toString(), event.streamId, d.path],
      );
    }
  },
};

/**
 * Was `guardTripsByPattern`; the same question, asked of the table above.
 *
 * Two counts rather than one, and that is the point of the test: "how often"
 * and "across how many runs" are different questions, and a projection makes
 * both a plain `select` instead of a fold over thousands of events.
 */
async function touchesByPath(): Promise<{ path: string; trips: number; runs: number }[]> {
  return direct((c) =>
    c
      .query<{ path: string; trips: number; runs: number }>(
        `select path,
                count(*)::int          as trips,
                count(distinct run_id)::int as runs
         from ${TEST_TABLE}
         group by path
         order by trips desc`,
      )
      .then((r) => r.rows),
  );
}

const tripped = (path: string, op = "write") => ({
  type: "RunTouchedFile",
  actor: "conductor",
  data: { path, op },
});

async function direct<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A deterministic dump of a table, for comparing two paths to the same state. */
function snapshot(table: string, order: string): Promise<string> {
  return direct(async (c) => {
    const r = await c.query<{ row: string }>(
      `select row_to_json(t)::text as row from (select * from ${table} order by ${order}) t`,
    );
    return r.rows.map((x) => x.row).join("\n");
  });
}

function track(r: ProjectionRunner): ProjectionRunner {
  openRunners.push(r);
  return r;
}

beforeAll(() => {
  client = createDb();
  store = createEventStore(client);
});

afterEach(async () => {
  await Promise.all(openRunners.splice(0).map((r) => r.close()));
});

afterAll(async () => {
  await client.close();
  await cleanupStreams();
  // Leave the database as it was found. The subject is this file's own table,
  // so it goes entirely rather than being emptied.
  await direct(async (c) => {
    await c.query(`drop table if exists ${TEST_TABLE}`);
    await c.query("delete from checkpoints where name in ('esc_test_touches', 'esc_test_boom')");
    await c.query("drop table if exists esc_test_boom");
  });
});

describe("projection runner", () => {
  it("catches up, applies, and advances the checkpoint", async () => {
    const run = runStream();
    const written = await store.append(run, 0, [tripped("rm -rf"), tripped("curl")]);

    const runner = track(createProjectionRunner({ projection: testProjection, store }));
    await runner.start();

    const rows = await direct((c) =>
      c
        .query<{ pattern: string }>(`select path from ${TEST_TABLE} where run_id = $1 order by seq`, [
          run,
        ])
        .then((r) => r.rows),
    );
    expect(rows.map((r) => r.path)).toEqual(["rm -rf", "curl"]);

    const lag = await runner.lag();
    expect(lag.lastSeq).toBe(written[1]!.seq);
    expect(lag.lag).toBe(0n);
    expect(lag.updatedAt).toBeInstanceOf(Date);
  });

  it("follows the log live, after catching up", async () => {
    const runner = track(createProjectionRunner({ projection: testProjection, store }));
    await runner.start();

    const run = runStream();
    const [written] = await store.append(run, 0, [tripped("git push --force")]);

    await waitFor(
      async () =>
        (await direct((c) =>
          c.query(`select 1 from ${TEST_TABLE} where seq = $1`, [written!.seq.toString()]),
        )).rowCount === 1,
      () => "the live event never reached the projection",
    );
  });

  it("reports lag for every projection with a checkpoint", async () => {
    const runner = track(createProjectionRunner({ projection: testProjection, store }));
    await runner.start();

    const all = await projectionLag();
    const mine = all.find((p) => p.name === TEST_TABLE);
    expect(mine).toBeDefined();
    expect(mine!.lag).toBeGreaterThanOrEqual(0n);
    expect(mine!.headSeq).toBeGreaterThanOrEqual(mine!.lastSeq);
  });

  /**
   * The property that makes a projection's shape cheap to change. If these two
   * ever differ, `apply` depends on something other than the events — and the
   * "just truncate and replay" story is false.
   */
  it("rebuild produces the same table as the incremental path", async () => {
    const runA = runStream();
    const runB = runStream();
    await store.append(runA, 0, [tripped("rm -rf"), tripped("curl"), tripped("rm -rf")]);
    await store.append(runB, 0, [tripped("sudo"), tripped("curl")]);

    const runner = track(createProjectionRunner({ projection: testProjection, store }));
    await runner.start();

    // A second incremental batch, so the incremental path is genuinely
    // incremental rather than one big catch-up.
    const [live] = await store.append(runA, 3, [tripped("git push --force")]);
    await waitFor(
      async () =>
        (await direct((c) =>
          c.query(`select 1 from ${TEST_TABLE} where seq = $1`, [live!.seq.toString()]),
        )).rowCount === 1,
      () => "the incremental event never landed",
    );

    const incremental = await snapshot(TEST_TABLE, "seq");
    expect(incremental.length).toBeGreaterThan(0);

    await runner.rebuild();

    const rebuilt = await snapshot(TEST_TABLE, "seq");
    expect(rebuilt).toBe(incremental);

    // And the checkpoint is back where it was, not left at zero.
    expect((await runner.lag()).lag).toBe(0n);
  });

  it("answers which patterns fire most, which is what it is for", async () => {
    const runA = runStream();
    const runB = runStream();
    await store.append(runA, 0, [tripped("rm -rf"), tripped("rm -rf"), tripped("curl")]);
    await store.append(runB, 0, [tripped("rm -rf")]);

    const runner = track(createProjectionRunner({ projection: testProjection, store }));
    await runner.start();

    const tally = await touchesByPath();
    const rm = tally.find((t) => t.path === "rm -rf");
    expect(rm).toBeDefined();
    // Three touches across two runs — the shape of question a projection makes
    // a plain `select` instead of a fold over thousands of events.
    expect(rm!.trips).toBeGreaterThanOrEqual(3);
    expect(rm!.runs).toBeGreaterThanOrEqual(2);
  });

  it("stops on a handler error and leaves the checkpoint where it was", async () => {
    const run = runStream();
    const written = await store.append(run, 0, [tripped("first"), tripped("poison")]);

    // A projection that refuses one specific event, in its own table so the real
    // one is unaffected.
    const boom: Projection = {
      name: "esc_test_boom",
      async create(ctx) {
        await ctx.query("create table if not exists esc_test_boom (seq bigint primary key)");
      },
      async reset(ctx) {
        await ctx.query("truncate table esc_test_boom");
      },
      async apply(events: readonly Envelope[], ctx) {
        for (const e of events) {
          if ((e.data as { path?: string }).path === "poison") {
            throw new Error("this projection cannot handle that");
          }
          await ctx.query("insert into esc_test_boom (seq) values ($1) on conflict do nothing", [
            e.seq.toString(),
          ]);
        }
      },
    };

    // Start it just behind its own two events rather than at zero.
    //
    // `start()` registers a checkpoint with `on conflict do nothing`, so a row
    // put down here survives. Without it the runner catches up from the
    // beginning of the log, and this test asserted a property of the log's
    // *length* without saying so: with fewer than `batchSize` events before the
    // poison, nothing commits and the table stays empty — with more, an earlier
    // batch commits legitimately and the assertion below reads 1000 rows and
    // calls the runner broken. That is what it did once the shared test log
    // grew past a thousand events.
    const base = written[0].seq - 1n;
    await direct((c) =>
      // Upsert: the row outlives the test run, and the base is different every
      // time because the log has grown.
      c.query(
        `insert into checkpoints (name, last_seq, updated_at) values ($1, $2, now())
           on conflict (name) do update set last_seq = excluded.last_seq, updated_at = now()`,
        [boom.name, base.toString()],
      ),
    );

    const runner = track(
      createProjectionRunner({ projection: boom, store, batchSize: 1_000, onError: () => {} }),
    );
    // The failure happens during catch-up, so `start()` never reaches "caught up".
    await runner.start().catch(() => {});

    await waitFor(
      () => runner.failure !== null,
      () => "the runner did not record a handler failure",
    );
    expect(runner.running).toBe(false);

    // Nothing partial survived: the batch and its checkpoint advance were one
    // transaction, so the good event before the poison rolled back with it.
    const rows = await direct((c) => c.query("select seq from esc_test_boom").then((r) => r.rowCount));
    expect(rows).toBe(0);

    // Checkpoint intact means: still where it started. It never advances past an
    // event the projection refused.
    const lag = await projectionLag();
    expect(lag.find((p) => p.name === "esc_test_boom")?.lastSeq).toBe(base);
    expect(written).toHaveLength(2);
  });

  it("is idempotent when the same events are applied twice", async () => {
    const run = runStream();
    await store.append(run, 0, [tripped("rm -rf"), tripped("curl")]);

    const runner = track(createProjectionRunner({ projection: testProjection, store }));
    await runner.start();
    const once = await snapshot(TEST_TABLE, "seq");

    // Rewind the checkpoint by hand — what a process killed after Postgres
    // committed but before the runner noticed would leave behind — and let it
    // re-consume the same events.
    await direct((c) => c.query(`update checkpoints set last_seq = 0 where name = '${TEST_TABLE}'`));
    await runner.stop();
    await runner.start();

    expect(await snapshot(TEST_TABLE, "seq")).toBe(once);
  });
});
