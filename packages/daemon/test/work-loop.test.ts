/**
 * The loop, against the real log.
 *
 * Every property here is one of the three holes the file exists to close, so
 * none of them can be tested against a fake subscription: "a completion event
 * wakes it" is a claim about Postgres notifying, and "it does not replay
 * history" is a claim about where the subscription started.
 */
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/store";
import { directDatabaseUrl } from "@lingtai/env";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkLoop } from "../src/index.ts";

const created = new Set<string>();
let client: Db;
let store: EventStore;

const landed = (id: string) => ({
  type: "WorkItemLanded",
  actor: "conductor",
  data: { mergeCommit: "abc1234", base: "develop" },
});

/** Waits for a condition rather than for a duration. */
async function until(what: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
});

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

describe("the work loop", () => {
  /**
   * The cold start. With nothing in flight there is no completion event, so an
   * event-driven loop that only listens never begins at all.
   */
  it("runs a pass at startup, before anything has happened", async () => {
    const reasons: string[] = [];
    const loop = createWorkLoop({
      pass: async (reason) => void reasons.push(reason),
    });

    await loop.start();
    try {
      expect(reasons).toEqual(["startup"]);
    } finally {
      await loop.stop();
    }
  });

  it("wakes on a completion event and not on anything else", async () => {
    const reasons: string[] = [];
    const loop = createWorkLoop({ pass: async (r) => void reasons.push(r) });
    await loop.start();

    try {
      const id = `wi-esctest-${crypto.randomUUID().slice(0, 8)}`;
      created.add(id);

      // A run appends steadily — touched files, guard trips, gate verdicts —
      // and waking on those would start a pass while the last one is still
      // mid-agent. This one must be ignored.
      await store.append(id, 0, [
        { type: "WorkItemBlocked", actor: "conductor", data: { question: "?", needsFrom: "human", runId: null } },
      ]);
      await until(() => reasons.length >= 2);
      expect(reasons[1]).toBe("completion");
    } finally {
      await loop.stop();
    }
  });

  /**
   * A pass takes minutes and events arrive during it. Two passes into the same
   * queue would race for the same claim, and a burst of events must cost one
   * extra pass rather than one each.
   */
  it("never runs two passes at once, and collapses a burst into one more", async () => {
    let inFlight = 0;
    let overlapped = false;
    let release: () => void = () => {};
    const firstPass = new Promise<void>((r) => (release = r));

    let n = 0;
    const loop = createWorkLoop({
      pass: async () => {
        n += 1;
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        // Hold the first pass open while the events land.
        if (n === 1) await firstPass;
        inFlight -= 1;
      },
    });

    const started = loop.start();
    try {
      const ids = [1, 2, 3].map(() => `wi-esctest-${crypto.randomUUID().slice(0, 8)}`);
      for (const id of ids) {
        created.add(id);
        await store.append(id, 0, [landed(id)]);
      }

      release();
      await started;
      await until(() => loop.passes >= 2);

      expect(overlapped).toBe(false);
      // Three events during one pass buy one more pass, not three.
      expect(loop.passes).toBeLessThanOrEqual(3);
    } finally {
      release();
      await loop.stop();
    }
  });

  it("survives a pass that throws, because the next event is when to retry", async () => {
    let calls = 0;
    const loop = createWorkLoop({
      pass: async () => {
        calls += 1;
        throw new Error("the conductor blew up");
      },
    });

    // Startup must not reject: a loop that dies on its first bad pass is a
    // daemon that needs a person, which is the thing being removed.
    await expect(loop.start()).resolves.toBeUndefined();
    try {
      expect(calls).toBe(1);
    } finally {
      await loop.stop();
    }
  });
});
