/**
 * Claiming, against the real store.
 *
 * The claim is the thing that replaces a lock directory, so the two properties
 * worth proving are the ones a lock file could not give: **two claimants racing
 * produce exactly one winner**, and **an expired lease needs no cleanup**.
 */
import { directDatabaseUrl } from "@escapement/env";
import { createDb, createEventStore, type Db, type EventStore } from "@escapement/store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimWorkItem, releaseWorkItem } from "../src/index.ts";

const created = new Set<string>();
let a: Db;
let b: Db;
let store: EventStore;
let rival: EventStore;

/** A work item that has been discovered and nothing else. */
async function discovered(): Promise<string> {
  const id = `wi-esctest-${crypto.randomUUID().slice(0, 8)}`;
  created.add(id);
  await store.append(id, 0, [
    {
      type: "WorkItemDiscovered",
      actor: "github",
      data: {
        project: "esctest",
        source: "manual",
        externalRef: "1",
        title: "t",
        kind: "bug",
        labels: [],
      },
    },
  ]);
  return id;
}

beforeAll(() => {
  // Two clients, because "two claimants racing" has to be two connections.
  a = createDb();
  b = createDb();
  store = createEventStore(a);
  rival = createEventStore(b);
});

afterAll(async () => {
  await a.close();
  await b.close();
  if (created.size === 0) return;
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule escapement_events_no_delete");
    await c.query("delete from events where stream_id = any($1::text[])", [[...created]]);
  } finally {
    await c.query("alter table events enable rule escapement_events_no_delete");
    await c.end();
  }
});

describe("claimWorkItem", () => {
  it("takes an unclaimed item and records the lease", async () => {
    const id = await discovered();
    const result = await claimWorkItem(id, { runId: "run-a", worker: "w1", store });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claim.runId).toBe("run-a");
    expect(result.claim.leaseUntilMs).toBeGreaterThan(Date.now());
    expect(result.claim.version).toBe(2);
  });

  it("refuses an item someone else holds, naming who and for how long", async () => {
    const id = await discovered();
    await claimWorkItem(id, { runId: "run-a", worker: "w1", store });

    const second = await claimWorkItem(id, { runId: "run-b", worker: "w2", store });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal).toMatchObject({ reason: "held", by: "w1", runId: "run-a" });
  });

  /**
   * The property `.runtime/loop.lock.d` could not have. A process that died
   * holding this lease left an event that stopped being true; nothing was
   * allocated, so nothing has to be freed.
   */
  it("an expired lease needs no cleanup — it is simply claimable again", async () => {
    const id = await discovered();
    const held = await claimWorkItem(id, { runId: "run-dead", worker: "killed", leaseMs: 1, store });
    expect(held.ok).toBe(true);

    // No release, no unlock, no rm -rf. Time passes.
    const later = Date.now() + 60_000;
    const next = await claimWorkItem(id, {
      runId: "run-b",
      worker: "w2",
      store,
      now: () => later,
    });

    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.claim.runId).toBe("run-b");
  });

  it("a released item is claimable again, and the release is on the record", async () => {
    const id = await discovered();
    await claimWorkItem(id, { runId: "run-a", worker: "w1", store });
    await releaseWorkItem(id, "run-a", "gate failed", store);

    const again = await claimWorkItem(id, { runId: "run-b", worker: "w2", store });
    expect(again.ok).toBe(true);

    const types = (await store.read(id)).map((e) => e.type);
    expect(types).toEqual([
      "WorkItemDiscovered",
      "WorkItemClaimed",
      "WorkItemReleased",
      "WorkItemClaimed",
    ]);
  });

  it("refuses an item that has landed", async () => {
    const id = await discovered();
    await store.append(id, 1, [
      { type: "WorkItemLanded", actor: "conductor", data: { mergeCommit: "abc", base: "develop" } },
    ]);

    const result = await claimWorkItem(id, { runId: "run-a", store });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toEqual({ reason: "not-claimable", status: "landed" });
  });

  /**
   * Two real connections, appending at the same expected version. The unique
   * constraint decides, and the loser is told it lost rather than being handed a
   * driver error to interpret.
   */
  it("two claimants racing produce exactly one winner", async () => {
    for (let round = 0; round < 3; round++) {
      const id = await discovered();

      const [first, second] = await Promise.all([
        claimWorkItem(id, { runId: `run-a${round}`, worker: "w1", store }),
        claimWorkItem(id, { runId: `run-b${round}`, worker: "w2", store: rival }),
      ]);

      const winners = [first, second].filter((r) => r.ok);
      const losers = [first, second].filter((r) => !r.ok);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      // "lost-race" when both appended, "held" when one read after the other
      // had already committed. Both are correct outcomes of the same collision.
      const refusal = (losers[0] as { ok: false; refusal: { reason: string } }).refusal;
      expect(["lost-race", "held"]).toContain(refusal.reason);

      // And the log agrees: exactly one claim.
      const claims = (await store.read(id)).filter((e) => e.type === "WorkItemClaimed");
      expect(claims).toHaveLength(1);
    }
  });
});
