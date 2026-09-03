/**
 * The exit tally, against the real store.
 *
 * The case that matters is the first one: a run this process held, and that
 * somebody approved and the integrate lane merged while the same pass carried
 * on. `runOnce` returned `held` and it was true when it was returned; by the
 * time the summary printed it was not. Counting what the process did printed
 * `0 landed` over a merge and exited 1 on the count.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tallyPass } from "../src/index.ts";
import type { RunOnceResult } from "../src/index.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();
let client: Db;
let store: EventStore;

const wi = (n: number) => {
  const id = `wi-${PROJECT}-${n}`;
  created.add(id);
  return id;
};
const runId = (n: number) => `run-${PROJECT}-${n}`;

const discovered = (n: number) => ({
  type: "WorkItemDiscovered",
  actor: "github",
  data: {
    project: PROJECT,
    source: "github-issue" as const,
    externalRef: String(n),
    title: `issue ${n}`,
    kind: "bug",
    labels: [],
  },
});

const claimed = (n: number) => ({
  type: "WorkItemClaimed",
  actor: "conductor",
  data: { runId: runId(n), worker: "w", leaseUntilMs: Date.now() + 60_000, title: null, kind: null },
});

const blocked = (n: number, question: string) => ({
  type: "WorkItemBlocked",
  actor: "conductor",
  data: { question, needsFrom: "human" as const, runId: runId(n) },
});

const landed = { type: "WorkItemLanded", actor: "conductor", data: { mergeCommit: "abc1234", base: "develop" } };
const released = (n: number) => ({
  type: "WorkItemReleased",
  actor: "conductor",
  data: { runId: runId(n), reason: "the agent produced no diff" },
});

const held = (n: number): RunOnceResult => ({
  ok: "held",
  workItemId: wi(n),
  runId: runId(n),
  headSha: "sha-a",
  gate: "merge",
});
const failed = (n: number, stage: string): RunOnceResult => ({
  ok: false,
  workItemId: wi(n),
  runId: runId(n),
  stage,
  detail: "why",
});

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);

  // 1 — held at the merge gate, then approved and merged while the pass ran on.
  await store.append(wi(1), 0, [discovered(1), claimed(1), blocked(1, "merge?"), landed]);
  // 2 — merged by this run.
  await store.append(wi(2), 0, [discovered(2), claimed(2), landed]);
  // 3 — held at the merge gate and still held.
  await store.append(wi(3), 0, [discovered(3), claimed(3), blocked(3, "merge?")]);
  // 4 — the integrator refused, which blocks rather than releases.
  await store.append(wi(4), 0, [discovered(4), claimed(4), blocked(4, "dirty-base: ...")]);
  // 5 — the run failed and the item went back into the queue.
  await store.append(wi(5), 0, [discovered(5), claimed(5), released(5)]);
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    for (const id of created) await c.query("delete from events where stream_id = $1", [id]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("tallyPass", () => {
  it("counts an item that landed after the run that held it", async () => {
    // What the process saw. What the log says is that it landed.
    expect(await tallyPass([held(1)], store)).toEqual({ landed: 1, held: 0, stopped: 0 });
  });

  it("counts a merge this run performed", async () => {
    const merged: RunOnceResult = { ok: true, workItemId: wi(2), runId: runId(2), mergeCommit: "abc1234" };
    expect(await tallyPass([merged], store)).toEqual({ landed: 1, held: 0, stopped: 0 });
  });

  it("counts a question a person now holds as held, however the run ended", async () => {
    // A gate hold and an integrator refusal both leave the item blocked, and
    // the board puts both in "Waiting on you". The run's own `ok` disagrees
    // about the second one, and the board is the one that is right.
    expect(await tallyPass([held(3), failed(4, "integrate")], store)).toEqual({
      landed: 0,
      held: 2,
      stopped: 0,
    });
  });

  it("counts a released item as stopped", async () => {
    expect(await tallyPass([failed(5, "agent")], store)).toEqual({ landed: 0, held: 0, stopped: 1 });
  });

  it("counts a refusal with no work item as stopped", async () => {
    const noItem: RunOnceResult = { ok: false, workItemId: null, runId: null, stage: "recipe", detail: "no recipe" };
    expect(await tallyPass([noItem], store)).toEqual({ landed: 0, held: 0, stopped: 1 });
  });

  it("counts a whole pass", async () => {
    const pass = [held(1), held(3), failed(4, "integrate"), failed(5, "agent")];
    expect(await tallyPass(pass, store)).toEqual({ landed: 1, held: 2, stopped: 1 });
  });
});
