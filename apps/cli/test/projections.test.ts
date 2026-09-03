/**
 * Catching the board up without a daemon.
 *
 * The failure this pins down is not subtle and was not caught by anything: a
 * whole queue was worked by hand, the log was right, and `task_view` — the only
 * table the board reads — never moved, because the follower lives in the
 * daemon and nobody had started one. `lingtai projection lag` said *no
 * projection has a checkpoint yet* through nine runs.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { readTasks } from "@lingtai/conductor";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catchUpProjections, PROJECTIONS } from "../src/projections.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const wi = `wi-${PROJECT}-1`;
const runId = `run-${PROJECT}-1`;
let client: Db;
let store: EventStore;

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  await store.append(wi, 0, [
    {
      type: "WorkItemDiscovered",
      actor: "github",
      data: {
        project: PROJECT,
        source: "github-issue",
        externalRef: "1",
        title: "a run nobody is watching",
        kind: "bug",
        labels: [],
      },
    },
    {
      type: "WorkItemClaimed",
      actor: "conductor",
      data: { runId, worker: "w", leaseUntilMs: Date.now() + 60_000, title: null, kind: null },
    },
  ]);
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = $1", [wi]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("catchUpProjections", () => {
  it("brings every projection to the head of the log and stops", async () => {
    const lags = await catchUpProjections();

    expect(lags.map((l) => l.name).sort()).toEqual(Object.keys(PROJECTIONS).sort());
    for (const lag of lags) expect(lag.lag).toBe(0n);
  });

  it("leaves the card current, which is what the board reads", async () => {
    await catchUpProjections();

    const tasks = await readTasks({ project: PROJECT });
    expect(tasks.map((t) => [t.issue, t.state])).toEqual([["1", "running"]]);
  });
});
