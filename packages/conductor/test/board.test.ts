/**
 * The board projection, against the real store.
 *
 * It is the one projection that spans all three aggregates — the work item's
 * stream, the run's, and the integration lane's — so the cases below write to
 * all three and assert what a card ends up saying. The last one is the property
 * that makes a projection's shape free to change: **rebuilding changes nothing
 * on screen.**
 */
import { directDatabaseUrl } from "@escapement/env";
import { createDb, createEventStore, createProjectionRunner, type Db, type EventStore } from "@escapement/store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardProjection, integrationStream, readBoard } from "../src/index.ts";

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

  // 1 — queued and nothing else.
  await store.append(wi(1), 0, [discovered(1, "still waiting")]);

  // 2 — running, with a run that tripped the guard and compacted.
  await store.append(wi(2), 0, [
    discovered(2, "a race in the importer"),
    { type: "WorkItemClaimed", actor: "conductor", data: { runId: run(2), worker: "w", leaseUntilMs: Date.now() + 60_000 } },
  ]);
  await store.append(run(2), 0, [
    {
      type: "RunStarted",
      actor: "conductor",
      data: {
        workItemId: wi(2),
        runtime: "claude-code",
        model: "claude-opus-5",
        promptVersion: "ticket@3",
        baseSha: "base000",
        configHash: "cfg",
        worktree: "/tmp/wt",
      },
    },
    { type: "GuardTripped", actor: `agent:${run(2)}`, data: { tool: "Bash", pattern: "rm -rf", redactedCommand: "rm -rf ***" } },
    { type: "GuardTripped", actor: `agent:${run(2)}`, data: { tool: "Bash", pattern: "curl", redactedCommand: "curl ***" } },
    { type: "RunContextExhausted", actor: `agent:${run(2)}`, data: { turn: 41 } },
    { type: "RunFinished", actor: "conductor", data: { exitCode: 0, turns: 63, durationMs: 100, costUsd: 5.42 } },
  ]);

  // 3 — gating, with a stale verdict from before a force-push.
  await store.append(wi(3), 0, [
    discovered(3, "gates in progress", "feature"),
    { type: "WorkItemClaimed", actor: "conductor", data: { runId: run(3), worker: "w", leaseUntilMs: Date.now() + 60_000 } },
  ]);
  await store.append(run(3), 0, [
    {
      type: "RunStarted",
      actor: "conductor",
      data: { workItemId: wi(3), runtime: "claude-code", model: "m", promptVersion: "p", baseSha: "b", configHash: "c", worktree: "/tmp" },
    },
    { type: "RunProducedDiff", actor: "conductor", data: { branch: "agent/3", headSha: "sha-a", files: 3, insertions: 40, deletions: 2 } },
    { type: "RunProposedCompletion", actor: "conductor", data: { headSha: "sha-a" } },
    { type: "GatePassed", actor: "conductor", data: { gate: "build", runId: run(3), onSha: "sha-a", evidence: "exit 0" } },
    // The agent force-pushes: the head moves and the verdict is about a
    // different diff now.
    { type: "RunProposedCompletion", actor: "conductor", data: { headSha: "sha-b" } },
  ]);

  // 4 — refused by the integrator.
  await store.append(wi(4), 0, [discovered(4, "will not merge")]);
  await store.append(integrationStream(PROJECT, "develop"), 0, [
    { type: "IntegrationAttempted", actor: "conductor", data: { workItemId: wi(4), branch: "agent/4", headSha: "sha" } },
    {
      type: "IntegrationRefused",
      actor: "conductor",
      data: { workItemId: wi(4), branch: "agent/4", reason: "dirty-base", detail: "uncommitted changes" },
    },
  ]);
  created.add(integrationStream(PROJECT, "develop"));

  // 5 — landed, and later blamed for 6.
  await store.append(wi(5), 0, [
    discovered(5, "landed a while ago"),
    { type: "WorkItemLanded", actor: "conductor", data: { mergeCommit: "abc1234def", base: "develop" } },
  ]);
  await store.append(wi(6), 0, [
    discovered(6, "a bug caused by 5"),
    { type: "WorkItemLinked", actor: "human:test", data: { relation: "caused-by", otherRef: "5" } },
  ]);
}

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  await seed();

  // One rebuild, because this database is shared and the table may have been
  // created by an older shape of this projection. That is the whole workflow
  // for changing a projection — `esc projection rebuild board` — and it only
  // works because `reset` drops rather than truncates: `create table if not
  // exists` would otherwise keep the old columns and the runner would die on
  // the first write to a column that is not there.
  const runner = createProjectionRunner({ projection: boardProjection, store });
  try {
    await runner.rebuild();
  } finally {
    await runner.close();
  }
}, 180_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule escapement_events_no_delete");
    await c.query("delete from events where stream_id = any($1::text[])", [[...created]]);
  } finally {
    await c.query("alter table events enable rule escapement_events_no_delete");
    await c.query("delete from board where project = $1", [PROJECT]);
    await c.query("delete from board_project where project = $1", [PROJECT]);
    await c.query("delete from checkpoints where name = 'board'");
    await c.end();
  }
});

async function build(): Promise<Awaited<ReturnType<typeof readBoard>>> {
  const runner = createProjectionRunner({ projection: boardProjection, store });
  try {
    await runner.start();
    return await readBoard(PROJECT);
  } finally {
    await runner.close();
  }
}

describe("the board projection", () => {
  it("puts each item in the column its events say it is in", async () => {
    const cards = await build();
    const by = Object.fromEntries(cards.map((c) => [c.externalRef, c]));

    expect(by["1"]!.column).toBe("queued");
    expect(by["2"]!.column).toBe("running");
    expect(by["3"]!.column).toBe("gates");
    // A refusal is something waiting on a person, not a silent dead end.
    expect(by["4"]!.column).toBe("waiting");
    expect(by["5"]!.column).toBe("landed");
  });

  /** 132 guard trips across 56 of 73 runs, and nobody ever saw one. */
  it("a running card carries turns, cost, guard trips, compactions and tier", async () => {
    const card = (await build()).find((c) => c.externalRef === "2")!;

    expect(card.run).toMatchObject({ turns: 63, costUsd: 5.42, guardTrips: 2, compactions: 1 });
    expect(card.tier).toBe("guarded");
  });

  /**
   * The reason `onSha` is on every verdict. Nothing revoked the build's pass —
   * the head moved, so it is about a different diff.
   */
  it("marks a verdict stale when the head has moved past it", async () => {
    const card = (await build()).find((c) => c.externalRef === "3")!;

    const build_ = card.gates.find((g) => g.gate === "build")!;
    expect(build_.verdict).toBe("passed");
    expect(build_.onSha).toBe("sha-a");
    expect(build_.current).toBe(false);
    expect(card.diff?.files).toBe(3);
  });

  it("a refused card shows the typed reason and its detail", async () => {
    const card = (await build()).find((c) => c.externalRef === "4")!;
    expect(card.refusal).toEqual({ reason: "dirty-base", detail: "uncommitted changes" });
  });

  /** A merge that produced two bugs should read as what it is. */
  it("a landed card carries its receipt and the regressions filed against it", async () => {
    const cards = await build();
    const landed = cards.find((c) => c.externalRef === "5")!;

    expect(landed.mergeCommit).toBe("abc1234def");
    expect(landed.regressions).toEqual(["6"]);
  });

  /**
   * The property that makes a projection's shape free to change: changing one
   * costs a truncate and a replay, not a migration. If a rebuild differed from
   * the incremental path, `apply` would depend on something other than the log.
   */
  it("rebuilding changes nothing on screen", async () => {
    const before = await build();

    const runner = createProjectionRunner({ projection: boardProjection, store });
    let after: typeof before;
    try {
      await runner.rebuild();
      after = await readBoard(PROJECT);
    } finally {
      await runner.close();
    }

    // Keyed and sorted, so a genuine difference is reported as *which card*
    // rather than as two long strings that differ somewhere.
    const key = (cs: typeof before) =>
      Object.fromEntries(
        [...cs].sort((a, b) => a.workItemId.localeCompare(b.workItemId)).map((c) => [c.externalRef, c]),
      );

    const a = key(before);
    const b = key(after);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    for (const ref of Object.keys(a)) {
      expect(b[ref], `card #${ref} differs after a rebuild`).toEqual(a[ref]);
    }
    expect(after.length).toBeGreaterThan(0);
  });
});
