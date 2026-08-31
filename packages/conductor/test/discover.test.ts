/**
 * Discovery, and the queue it feeds.
 *
 * `considerIssue` is pure, so most of the rules are testable without a database
 * or a network. The parts that append and project are run against the real
 * store, because "re-discovering is a no-op" is a claim about what is in the
 * log, not about what a function returned.
 */
import type { Recipe } from "@escapement/config";
import type { GitHubClient, Issue } from "@escapement/github";
import { createDb, createEventStore, createProjectionRunner, type Db, type EventStore } from "@escapement/store";
import pg from "pg";
import { directDatabaseUrl } from "@escapement/env";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { considerIssue, discover, kindOf, queueProjection, readQueue, workItemStream } from "../src/index.ts";

const recipe = {
  version: 1,
  repo: { base: "develop", submodules: false },
  source: { kinds: ["bug", "feature"], exclude: ["blocked", "needs-design"] },
  env: { allow: [], plantAt: ".env.local" },
  gates: [{ kind: "process", name: "build", run: "pnpm verify", timeout: "15m" }],
  runtime: { agent: "claude-code", limits: { turns: 300, wall: "2h" } },
} as unknown as Recipe;

const issue = (over: Partial<Issue> & { number: number }): Issue => ({
  title: `issue ${over.number}`,
  body: "",
  labels: [],
  state: "open",
  url: `https://example.invalid/${over.number}`,
  ...over,
});

describe("kindOf", () => {
  it("reads the kind from a label, however it is cased or spaced", () => {
    expect(kindOf(issue({ number: 1, labels: ["Bug"] }))).toBe("bug");
    expect(kindOf(issue({ number: 2, labels: ["tech debt"] }))).toBe("tech-debt");
    expect(kindOf(issue({ number: 3, labels: ["enhancement"] }))).toBe("enhancement");
  });

  it("is null when nothing says, rather than guessing", () => {
    // Guessing `bug` would put every unclassified issue at the front of a queue
    // whose priority order is by kind.
    expect(kindOf(issue({ number: 4, labels: ["documentation", "good first issue"] }))).toBeNull();
  });
});

describe("considerIssue", () => {
  it("accepts an open issue of a wanted kind", () => {
    expect(considerIssue(issue({ number: 1, labels: ["bug"] }), recipe).skip).toBeNull();
  });

  /**
   * The Phase 1 safety rule. `agent-loop.sh` is still working this repository on
   * an hourly cycle and writes its state into the `agent:*` namespace; the two
   * systems must never both claim a ticket.
   */
  it("refuses anything the old loop has touched", () => {
    expect(considerIssue(issue({ number: 2, labels: ["bug", "agent:wip"] }), recipe).skip).toBe(
      "owned-by-another-agent",
    );
    expect(considerIssue(issue({ number: 3, labels: ["bug", "agent:review"] }), recipe).skip).toBe(
      "owned-by-another-agent",
    );
  });

  it("honours the recipe's own exclude list", () => {
    expect(considerIssue(issue({ number: 4, labels: ["bug", "blocked"] }), recipe).skip).toBe(
      "excluded-label",
    );
    expect(considerIssue(issue({ number: 5, labels: ["bug", "Needs-Design"] }), recipe).skip).toBe(
      "excluded-label",
    );
  });

  it("skips a kind this project does not want, and says which reason", () => {
    expect(considerIssue(issue({ number: 6, labels: ["tech-debt"] }), recipe).skip).toBe(
      "kind-not-wanted",
    );
    expect(considerIssue(issue({ number: 7, labels: [] }), recipe).skip).toBe("no-kind");
    expect(considerIssue(issue({ number: 8, labels: ["bug"], state: "closed" }), recipe).skip).toBe(
      "closed",
    );
  });
});

// ---------------------------------------------------------------- live ----

/**
 * A fresh project per test. They share one `events` table and one `queue`, so a
 * test that asserted on "the queue" would be asserting on its neighbours' rows
 * too — which is exactly how it failed the first time.
 */
const projects = new Set<string>();
function newProject(): string {
  const p = `esctest${crypto.randomUUID().slice(0, 6)}`;
  projects.add(p);
  return p;
}

const created = new Set<string>();

/** A client that answers from a fixed set of issues. */
function fakeClient(issues: Issue[], project = "esctest"): GitHubClient {
  return {
    owner: "steven-zhc",
    repo: project,
    installation: { id: 1, permissions: {}, account: "steven-zhc", repositorySelection: "selected" },
    request: async () => {
      throw new Error("not used");
    },
    defaultBranch: async () => "develop",
    fileAt: async () => null,
    refSha: async () => "0".repeat(40),
    listOpenIssues: async () => issues,
    getIssue: async (n) => issues.find((i) => i.number === n) ?? issue({ number: n }),
  };
}

let client: Db;
let store: EventStore;

beforeAll(() => {
  client = createDb();
  store = createEventStore(client);
});

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule escapement_events_no_delete");
    await c.query("delete from events where stream_id = any($1::text[])", [[...created]]);
  } finally {
    await c.query("alter table events enable rule escapement_events_no_delete");
    await c.query("delete from queue where project = any($1::text[])", [[...projects]]);
    await c.query("delete from checkpoints where name = 'queue'");
    await c.end();
  }
});

function track(streams: string[]): void {
  for (const s of streams) created.add(s);
}

describe("discover", () => {
  it("appends one WorkItemDiscovered per eligible issue, and explains the rest", async () => {
    const PROJECT = newProject();
    const issues = [
      issue({ number: 101, labels: ["bug"], title: "a race in the importer" }),
      issue({ number: 102, labels: ["feature"] }),
      issue({ number: 103, labels: ["bug", "agent:wip"] }),
      issue({ number: 104, labels: [] }),
    ];

    const result = await discover({ project: PROJECT, client: fakeClient(issues, PROJECT), recipe, store });
    track(result.discovered);

    expect(result.discovered).toEqual([
      workItemStream(PROJECT, 101),
      workItemStream(PROJECT, 102),
    ]);
    expect(result.skipped).toEqual([
      { ref: 103, reason: "owned-by-another-agent" },
      { ref: 104, reason: "no-kind" },
    ]);

    const events = await store.read(workItemStream(PROJECT, 101));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("WorkItemDiscovered");
    expect(events[0]!.actor).toBe("github");
    expect((events[0]!.data as { title: string }).title).toBe("a race in the importer");
  });

  it("re-discovering is a no-op, not a duplicate event", async () => {
    const PROJECT = newProject();
    const issues = [issue({ number: 201, labels: ["bug"] })];

    const first = await discover({ project: PROJECT, client: fakeClient(issues, PROJECT), recipe, store });
    track(first.discovered);
    const second = await discover({ project: PROJECT, client: fakeClient(issues, PROJECT), recipe, store });

    expect(second.discovered).toEqual([]);
    expect(second.skipped).toEqual([{ ref: 201, reason: "already-discovered" }]);
    expect(await store.read(workItemStream(PROJECT, 201))).toHaveLength(1);
  });

  it("can be restricted to nominated issue numbers", async () => {
    const PROJECT = newProject();
    const issues = [
      issue({ number: 301, labels: ["bug"] }),
      issue({ number: 302, labels: ["bug"] }),
    ];

    // Phase 1 runs against numbers you nominate, not against the queue.
    const result = await discover({
      project: PROJECT,
      client: fakeClient(issues, PROJECT),
      recipe,
      store,
      only: [302],
    });
    track(result.discovered);

    expect(result.discovered).toEqual([workItemStream(PROJECT, 302)]);
    expect(await store.read(workItemStream(PROJECT, 301))).toEqual([]);
  });
});

describe("the queue projection", () => {
  it("orders by the recipe's kinds, then oldest first", async () => {
    const PROJECT = newProject();
    const issues = [
      issue({ number: 410, labels: ["feature"] }),
      issue({ number: 402, labels: ["bug"] }),
      issue({ number: 401, labels: ["feature"] }),
      issue({ number: 409, labels: ["bug"] }),
    ];
    track((await discover({ project: PROJECT, client: fakeClient(issues, PROJECT), recipe, store })).discovered);

    const runner = createProjectionRunner({ projection: queueProjection, store });
    try {
      await runner.start();

      const queue = await readQueue(PROJECT, recipe.source.kinds);
      // bug before feature because the recipe lists it first; #402 before #409
      // numerically, not lexically.
      expect(queue.map((q) => q.externalRef)).toEqual(["402", "409", "401", "410"]);
      expect(queue.every((q) => q.heldBy === null)).toBe(true);
    } finally {
      await runner.close();
    }
  });

  it("a claimed item leaves the queue, and a release brings it back", async () => {
    const PROJECT = newProject();
    const issues = [issue({ number: 501, labels: ["bug"] })];
    const { discovered } = await discover({ project: PROJECT, client: fakeClient(issues, PROJECT), recipe, store });
    track(discovered);
    const stream = discovered[0]!;

    const runner = createProjectionRunner({ projection: queueProjection, store });
    try {
      await runner.start();
      expect((await readQueue(PROJECT, recipe.source.kinds)).some((q) => q.workItemId === stream)).toBe(true);

      await store.append(stream, 1, [
        {
          type: "WorkItemClaimed",
          actor: "conductor",
          data: { runId: "run-x", worker: "test", leaseUntilMs: Date.now() + 60_000 },
        },
      ]);
      await runner.stop();
      await runner.start();

      // It left because an event said so, not because a label was added.
      expect((await readQueue(PROJECT, recipe.source.kinds)).some((q) => q.workItemId === stream)).toBe(false);
      const held = await readQueue(PROJECT, recipe.source.kinds, { includeHeld: true });
      expect(held.find((q) => q.workItemId === stream)?.heldBy).toBe("running");

      await store.append(stream, 2, [
        { type: "WorkItemReleased", actor: "conductor", data: { runId: "run-x", reason: "lease expired" } },
      ]);
      await runner.stop();
      await runner.start();

      expect((await readQueue(PROJECT, recipe.source.kinds)).some((q) => q.workItemId === stream)).toBe(true);
    } finally {
      await runner.close();
    }
  });
});
