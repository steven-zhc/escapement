/**
 * Reconciliation, against the real store and a real directory.
 *
 * The property that matters is not "it deletes things" but **which** things: a
 * live run's worktree must survive, because deleting one is worse than leaving
 * a dead one. So the fixture has both, side by side, and the assertion is about
 * the pair.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exists, findOrphans, reconcile } from "../src/index.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();
let client: Db;
let store: EventStore;
let home: string;

const wt = (runId: string) => join(home, "worktrees", PROJECT, runId);

async function plant(runId: string): Promise<void> {
  await mkdir(wt(runId), { recursive: true });
  await writeFile(join(wt(runId), "file.txt"), "work in progress");
}

const claim = (runId: string, leaseUntilMs: number) => ({
  type: "WorkItemClaimed",
  actor: "conductor",
  data: { runId, worker: "w", leaseUntilMs, title: null, kind: null },
});

const started = (taskId: string) => ({
  type: "RunStarted",
  actor: "conductor",
  data: {
    workItemId: taskId,
    runtime: "claude-code",
    model: "m",
    promptVersion: "p",
    baseSha: "base000",
    configHash: "c",
    worktree: "/tmp/wt",
  },
});

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  home = await mkdtemp(join(tmpdir(), "lingtai-reconcile-"));
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

describe("reconciliation", () => {
  it("removes a worktree the log says is finished, and leaves a live one alone", async () => {
    const dead = `run-${PROJECT}-dead`;
    const live = `run-${PROJECT}-live`;
    const deadTask = `wi-${PROJECT}-1`;
    const liveTask = `wi-${PROJECT}-2`;
    for (const id of [dead, live, deadTask, liveTask]) created.add(id);

    // Landed: the run is over, the directory is not.
    await store.append(deadTask, 0, [
      claim(dead, Date.now() + 60_000),
      { type: "WorkItemLanded", actor: "conductor", data: { mergeCommit: "abc1234", base: "develop" } },
    ]);
    await store.append(dead, 0, [started(deadTask)]);

    // Still claimed, lease good. An agent between tool calls looks exactly like
    // this, and deleting its worktree would be the worst thing this could do.
    await store.append(liveTask, 0, [claim(live, Date.now() + 3_600_000)]);
    await store.append(live, 0, [started(liveTask)]);

    await plant(dead);
    await plant(live);

    const found = await reconcile({ home, store });

    expect(found.map((f) => f.stream)).toEqual([dead]);
    expect(found[0]!.action).toBe("removed");
    expect(await exists(wt(dead))).toBe(false);
    expect(await exists(wt(live))).toBe(true);
  });

  /**
   * A lease is what makes a killed daemon recoverable without anybody
   * releasing anything. Once it lapses the task is fair game, so its worktree
   * is too.
   */
  it("treats an expired lease as finished", async () => {
    const stale = `run-${PROJECT}-stale`;
    const staleTask = `wi-${PROJECT}-3`;
    created.add(stale);
    created.add(staleTask);

    await store.append(staleTask, 0, [claim(stale, Date.now() - 1)]);
    await store.append(stale, 0, [started(staleTask)]);
    await plant(stale);

    const found = await findOrphans({ home, store, dryRun: true });
    expect(found.map((f) => f.stream)).toContain(stale);
    // Still there: dryRun reports, it does not act. A doctor that changed what
    // it was checking would describe a state that no longer exists.
    expect(await exists(wt(stale))).toBe(true);
  });

  /**
   * A worktree whose run never said what it was for is a mystery, and deleting
   * mysteries is how you stop being able to explain them.
   */
  it("reports a worktree it cannot attribute, and does not remove it", async () => {
    const nameless = `run-${PROJECT}-nameless`;
    await plant(nameless);

    const found = await reconcile({ home, store });
    const it_ = found.find((f) => f.stream === nameless);

    expect(it_?.action).toBe("reported");
    expect(await exists(wt(nameless))).toBe(true);
  });

  it("appends nothing when there is nothing to say", async () => {
    const quiet = await mkdtemp(join(tmpdir(), "lingtai-quiet-"));
    const before = (await store.read("ctl-conductor")).length;

    const found = await reconcile({ home: quiet, store });

    expect(found).toEqual([]);
    // An empty Reconciled on every startup would be noise in the one place
    // noise is expensive.
    expect((await store.read("ctl-conductor")).length).toBe(before);
  });
});
