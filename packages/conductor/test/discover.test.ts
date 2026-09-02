/**
 * Discovery, and the queue it feeds.
 *
 * `considerIssue` is pure, so most of the rules are testable without a database
 * or a network. `refreshQueue` gets the real store anyway, because "it appends
 * nothing" is a claim about the log rather than about a return value.
 */
import type { Recipe } from "@escapement/config";
import type { GitHubClient, Issue } from "@escapement/github";
import { createDb, createEventStore, type Db, type EventStore } from "@escapement/store";
import pg from "pg";
import { directDatabaseUrl } from "@escapement/env";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { considerIssue, kindOf, refreshQueue, workItemStream } from "../src/index.ts";

const recipe = {
  version: 1,
  repo: { base: "develop", submodules: false },
  source: { kinds: ["bug", "feature"], exclude: ["blocked", "needs-design"] },
  env: { allow: [], plantAt: ".env.local" },
  gates: { admit: [], prepared: [], diff: [{ name: "build", run: "pnpm verify", timeout: "15m" }], merge: [], end: [] },
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
    // Throws rather than returning a dummy: these tests clone from a local path
    // and must never authenticate. If something starts asking for a token, the
    // test should say so loudly rather than quietly succeed with a fake one.
    token: async () => {
      throw new Error("not used");
    },
    defaultBranch: async () => "develop",
    fileAt: async () => null,
    refSha: async () => "0".repeat(40),
    listOpenIssues: async () => issues,
  comment: async () => { throw new Error("no writes in this test"); },
  setLabels: async () => { throw new Error("no writes in this test"); },
    closeIssue: async () => {},
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

describe("refreshQueue", () => {
  /**
   * Nothing is appended any more. What is runnable is what GitHub lists that
   * the recipe will take, written into `task_view` — so the assertion is about
   * what was handed to the sync, not about what landed in the log.
   */
  it("reports what is runnable and explains every issue it passed over", async () => {
    const PROJECT = newProject();
    const issues = [
      issue({ number: 101, labels: ["bug"], title: "a race in the importer" }),
      issue({ number: 102, labels: ["feature"] }),
      issue({ number: 103, labels: ["bug", "agent:wip"] }),
      issue({ number: 104, labels: [] }),
    ];

    const synced: unknown[] = [];
    const result = await refreshQueue({
      project: PROJECT,
      client: fakeClient(issues, PROJECT),
      recipe,
      sync: (async (_p: string, list: unknown[]) => {
        synced.push(list);
        return { added: list.length, removed: 0 };
      }) as never,
    });

    expect(result.runnable.map((r) => r.ref)).toEqual(["101", "102"]);
    expect(result.runnable[0]).toEqual({ ref: "101", title: "a race in the importer", kind: "bug" });
    expect(result.skipped).toEqual([
      { ref: 103, reason: "owned-by-another-agent" },
      { ref: 104, reason: "no-kind" },
    ]);
    expect(synced).toHaveLength(1);
  });

  it("appends nothing at all", async () => {
    const PROJECT = newProject();
    const issues = [issue({ number: 201, labels: ["bug"] })];

    await refreshQueue({
      project: PROJECT,
      client: fakeClient(issues, PROJECT),
      recipe,
      sync: (async () => ({ added: 0, removed: 0 })) as never,
    });

    // The whole point of 0012: which issues exist is GitHub's state, and one
    // event per issue per pass was reproducing a fact GitHub answers on demand.
    expect(await store.read(workItemStream(PROJECT, 201))).toEqual([]);
  });

  /**
   * `only` means "look at these", not "these are all there is". Syncing on a
   * partial refresh would delete every queued task the caller did not name.
   */
  it("does not touch the stored queue when it is restricted to some issues", async () => {
    const PROJECT = newProject();
    const issues = [
      issue({ number: 301, labels: ["bug"] }),
      issue({ number: 302, labels: ["bug"] }),
    ];

    let synced = 0;
    const result = await refreshQueue({
      project: PROJECT,
      client: fakeClient(issues, PROJECT),
      recipe,
      only: [302],
      sync: (async () => {
        synced += 1;
        return { added: 0, removed: 0 };
      }) as never,
    });

    expect(result.runnable.map((r) => r.ref)).toEqual(["302"]);
    expect(synced).toBe(0);
  });
});
