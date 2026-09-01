/**
 * `task_view`, against the real store.
 *
 * It spans all three aggregates — the task's own stream, the run's, and the
 * integration lane's — so the seed writes to all of them and the cases assert
 * what a card ends up saying.
 *
 * Two properties matter more than the rest:
 *
 * **Rebuilding changes nothing.** This is what makes the table's shape free to
 * change, and it is why every timestamp here comes from the event rather than
 * from `now()`.
 *
 * **Retention is a query.** A landed task falling out of the window must still
 * be a row. Deleting it would make the projection depend on when it last ran.
 */
import { directDatabaseUrl } from "@escapement/env";
import { createDb, createEventStore, createProjectionRunner, type Db, type EventStore } from "@escapement/store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationStream, readTasks, syncQueued, taskViewProjection } from "../src/index.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();
let client: Db;
let store: EventStore;

const wi = (n: number) => {
  const id = `wi-${PROJECT}-${n}`;
  created.add(id);
  return id;
};
const run = (n: number) => {
  const id = `run-${PROJECT}-${n}`;
  created.add(id);
  return id;
};

const discovered = (n: number, title: string, kind = "bug") => ({
  type: "WorkItemDiscovered",
  actor: "github",
  data: {
    project: PROJECT,
    source: "github-issue" as const,
    externalRef: String(n),
    title,
    kind,
    labels: [],
  },
});

const claimed = (n: number) => ({
  type: "WorkItemClaimed",
  actor: "conductor",
  data: { runId: run(n), worker: "w", leaseUntilMs: Date.now() + 60_000, title: null, kind: null },
});

const started = (n: number) => ({
  type: "RunStarted",
  actor: "conductor",
  data: {
    workItemId: wi(n),
    runtime: "claude-code",
    model: "m",
    promptVersion: "p",
    baseSha: "base000",
    configHash: "c",
    worktree: "/tmp/wt",
  },
});

async function seed(): Promise<void> {
  const prj = `prj-${PROJECT}`;
  created.add(prj);
  await store.append(prj, 0, [
    {
      type: "ProjectPolicySet",
      actor: "human:test",
      data: {
        project: PROJECT,
        tier: "guarded",
        requiredGates: [],
        approvers: [],
        concurrent: 1,
        by: "human:test",
        reason: "test",
      },
    },
  ]);

  // 1 — queued and nothing else.
  await store.append(wi(1), 0, [discovered(1, "still waiting")]);

  // 2 — running, guard tripped twice, cost recorded.
  await store.append(wi(2), 0, [discovered(2, "a race in the importer"), claimed(2)]);
  await store.append(run(2), 0, [
    started(2),
    { type: "GuardTripped", actor: `agent:${run(2)}`, data: { tool: "Bash", pattern: "rm -rf", redactedCommand: "rm -rf ***" } },
    { type: "GuardTripped", actor: `agent:${run(2)}`, data: { tool: "Bash", pattern: "curl", redactedCommand: "curl ***" } },
    { type: "RunFinished", actor: "conductor", data: { exitCode: 0, turns: 63, durationMs: 100, costUsd: 5.42 } },
  ]);

  // 3 — at the gates, one passed and one failed.
  await store.append(wi(3), 0, [discovered(3, "gates in progress", "feature"), claimed(3)]);
  await store.append(run(3), 0, [
    started(3),
    { type: "RunProducedDiff", actor: "conductor", data: { branch: "agent/3", headSha: "sha-a", files: 3, insertions: 40, deletions: 2 } },
    { type: "RunProposedCompletion", actor: "conductor", data: { headSha: "sha-a" } },
    { type: "GatePassed", actor: "conductor", data: { gate: "build", runId: run(3), onSha: "sha-a", evidence: "exit 0" } },
    { type: "GateFailed", actor: "conductor", data: { gate: "review", runId: run(3), onSha: "sha-a", evidence: "two findings", findings: [] } },
  ]);

  // 4 — refused by the integrator.
  await store.append(wi(4), 0, [discovered(4, "will not merge")]);
  const lane = integrationStream(PROJECT, "develop");
  created.add(lane);
  await store.append(lane, 0, [
    { type: "IntegrationAttempted", actor: "conductor", data: { workItemId: wi(4), branch: "agent/4", headSha: "sha" } },
    {
      type: "IntegrationRefused",
      actor: "conductor",
      data: { workItemId: wi(4), branch: "agent/4", reason: "dirty-base", detail: "uncommitted changes" },
    },
  ]);

  // 5 — landed.
  await store.append(wi(5), 0, [
    discovered(5, "landed a while ago"),
    { type: "WorkItemLanded", actor: "conductor", data: { mergeCommit: "abc1234def", base: "develop" } },
  ]);
}

async function build(): Promise<void> {
  const runner = createProjectionRunner({ projection: taskViewProjection, store });
  try {
    await runner.rebuild();
  } finally {
    await runner.close();
  }
}

const card = (tasks: Awaited<ReturnType<typeof readTasks>>, n: number) =>
  tasks.find((t) => t.issue === String(n));

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  await seed();
  await build();
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule escapement_events_no_delete");
    for (const id of created) await c.query("delete from events where stream_id = $1", [id]);
  } finally {
    await c.query("alter table events enable rule escapement_events_no_delete");
    await c.end();
  }
});

describe("task_view", () => {
  it("puts each task in the state its stream says it is in", async () => {
    const tasks = await readTasks({ project: PROJECT });

    expect(card(tasks, 1)?.state).toBe("queued");
    expect(card(tasks, 2)?.state).toBe("running");
    expect(card(tasks, 3)?.state).toBe("gates");
    expect(card(tasks, 4)?.state).toBe("waiting");
    expect(card(tasks, 5)?.state).toBe("landed");
  });

  it("carries what a card shows and leaves the rest in the log", async () => {
    const tasks = await readTasks({ project: PROJECT });

    const two = card(tasks, 2)!;
    expect(two.turns).toBe(63);
    expect(two.costUsd).toBeCloseTo(5.42);
    expect(two.tier).toBe("guarded");
    // The count reaches the card. The trips themselves do not — they are read
    // from the stream when somebody opens the task.
    expect(two.guardTrips).toBe(2);

    const three = card(tasks, 3)!;
    expect(three.gatesPassed).toBe(1);
    expect(three.gatesFailed).toBe(1);
    expect(three.headSha).toBe("sha-a");
    expect(three.files).toBe(3);
  });

  it("records the attempt, which is what a backoff reads", async () => {
    const tasks = await readTasks({ project: PROJECT });
    const two = card(tasks, 2)!;

    // In the table rather than in memory: an in-memory set forgets on restart,
    // and the loop it prevents cost the old harness roughly $29.
    expect(two.attempts).toBe(1);
    expect(two.lastAttemptAt).toBeInstanceOf(Date);
    expect(card(tasks, 1)!.attempts).toBe(0);
  });

  it("says why a task is waiting, in one line", async () => {
    const tasks = await readTasks({ project: PROJECT });
    expect(card(tasks, 4)!.note).toContain("dirty-base");
  });

  /**
   * The property that makes this table's shape free to change. It only holds
   * because every timestamp comes from `event.at` — a projection that read the
   * clock would produce different rows on every rebuild, and the workflow for
   * changing a projection would stop being "rebuild it".
   */
  it("rebuilds to exactly what the incremental path produced", async () => {
    const before = await readTasks({ project: PROJECT });
    await build();
    const after = await readTasks({ project: PROJECT });

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  /**
   * Retention filters, it does not delete. If the projection dropped old rows
   * its contents would depend on when it last ran, and a rebuild would no longer
   * reproduce itself.
   */
  it("filters a landed task out of the window while keeping its row", async () => {
    const visible = await readTasks({ project: PROJECT, retentionDays: 0 });
    expect(card(visible, 5)).toBeUndefined();
    // Still queued and running tasks — the filter is about closed ones only.
    expect(card(visible, 1)).toBeDefined();

    const kept = await readTasks({ project: PROJECT, retentionDays: 3650 });
    expect(card(kept, 5)?.note).toBe("abc1234def");
  });
});

describe("the queue GitHub reported", () => {
  const other = `esctest${crypto.randomUUID().slice(0, 6)}`;

  it("adds what GitHub lists, drops what it stops listing, and leaves claimed work alone", async () => {
    await syncQueued(other, [
      { ref: "10", title: "one", kind: "bug" },
      { ref: "11", title: "two", kind: "feature" },
    ]);
    let tasks = await readTasks({ project: other });
    expect(tasks.map((t) => t.issue).sort()).toEqual(["10", "11"]);

    // GitHub stops listing 11 — it was closed by a person, and it was never
    // Escapement's state to keep.
    await syncQueued(other, [{ ref: "10", title: "one", kind: "bug" }]);
    tasks = await readTasks({ project: other });
    expect(tasks.map((t) => t.issue)).toEqual(["10"]);

    // A claimed task stays even though GitHub still lists it: the log is the
    // authority on what happened after the claim.
    const claimedId = `wi-${other}-10`;
    created.add(claimedId);
    await store.append(claimedId, 0, [
      { type: "WorkItemClaimed", actor: "conductor", data: { runId: `run-${other}-10`, worker: "w", leaseUntilMs: Date.now() + 60_000, title: null, kind: null } },
    ]);
    created.add(`run-${other}-10`);
    await build();

    await syncQueued(other, [{ ref: "10", title: "one", kind: "bug" }]);
    tasks = await readTasks({ project: other });
    expect(tasks[0]?.state).toBe("running");
  });

  afterAll(async () => {
    const c = new pg.Client({ connectionString: directDatabaseUrl() });
    await c.connect();
    try {
      await c.query("delete from task_view where project = $1", [other]);
    } finally {
      await c.end();
    }
  });
});
