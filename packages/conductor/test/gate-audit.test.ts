/**
 * The comparison itself: the plan in the log against the verdicts in the log.
 *
 * Written from events rather than from a run, because that is exactly what the
 * check reads. A run takes two minutes and proves the conductor's wiring; this
 * proves the *reading* — which is the half that was missing when `merge` and
 * `end` both quietly stopped executing (#58, #55) and nothing noticed for a day.
 *
 * The interesting case is the negative one: an item that landed, whose run
 * planned a person at `merge`, and whose stream holds no gate event for that
 * point. That is the shape of the two changes that merged into `main` with
 * nobody's approval.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { parsePayload } from "@lingtai/core";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { landedWithoutGatePoints } from "../src/gate-audit.ts";
import { workItemStream } from "../src/discover.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();

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
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1::text[])", [[...created]]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

/** The five points, with actions only where a case asks for them. */
const plan = (points: Record<string, string[]>) =>
  (["admit", "prepared", "proposed", "merge", "end"] as const).map((gate) => ({
    gate,
    actions: points[gate] ?? [],
  }));

const SHA = "a".repeat(40);

/**
 * One item that landed, with a run that planned `points` and recorded `ran`.
 *
 * Both halves written as events, since both halves are read as events.
 */
async function landedItem(
  issue: number,
  points: Record<string, string[]>,
  ran: { gate: string; action: string }[],
): Promise<{ workItemId: string; runId: string }> {
  const workItemId = workItemStream(PROJECT, issue);
  const runId = `run-${crypto.randomUUID()}`;
  created.add(workItemId);
  created.add(runId);

  await store.append(runId, 0, [
    {
      type: "RunStarted",
      actor: "conductor",
      data: parsePayload("RunStarted", {
        workItemId,
        runtime: "claude-code",
        model: "",
        promptVersion: "ticket@1",
        baseSha: SHA,
        configHash: "seeded",
        worktree: "/tmp/none",
      }),
    },
    {
      type: "GatesResolved",
      actor: "conductor",
      data: parsePayload("GatesResolved", { runId, configHash: "seeded", points: plan(points) }),
    },
    ...ran.map((r) => ({
      type: "GatePassed",
      actor: "conductor",
      data: parsePayload("GatePassed", { ...r, runId, onSha: SHA, evidence: "ok" }),
    })),
  ]);

  await store.append(workItemId, 0, [
    {
      type: "WorkItemLanded",
      actor: "conductor",
      data: parsePayload("WorkItemLanded", { mergeCommit: "b".repeat(40), base: "main" }),
    },
  ]);
  return { workItemId, runId };
}

const forProject = async () =>
  (await landedWithoutGatePoints(directDatabaseUrl())).filter((f) => f.project === PROJECT);

describe("landedWithoutGatePoints", () => {
  it("finds the change that merged past a point the recipe configured", async () => {
    // #58 in miniature: a person declared at `merge`, and the point never ran.
    const { workItemId } = await landedItem(
      201,
      { proposed: ["build"], merge: ["approval"] },
      [{ gate: "proposed", action: "build" }],
    );

    const found = await forProject();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ workItemId, issue: 201, points: ["merge"] });
  });

  it("says nothing when every planned point recorded a verdict", async () => {
    await landedItem(
      202,
      { proposed: ["build"], merge: ["approval"] },
      [
        { gate: "proposed", action: "build" },
        { gate: "merge", action: "approval" },
      ],
    );

    expect((await forProject()).map((f) => f.issue)).not.toContain(202);
  });

  /**
   * The distinction the whole model rests on. A point with nothing at it is the
   * operator's decision and must never be reported; only a point that was
   * configured and did not run is Lingtai's bug.
   */
  it("says nothing about a point that was never configured", async () => {
    await landedItem(203, { proposed: ["build"] }, [{ gate: "proposed", action: "build" }]);
    expect((await forProject()).map((f) => f.issue)).not.toContain(203);
  });

  it("names every point that was skipped, in the order they run", async () => {
    await landedItem(204, { prepared: ["install"], proposed: ["build"], merge: ["approval"] }, []);

    const found = (await forProject()).find((f) => f.issue === 204);
    expect(found?.points).toEqual(["prepared", "proposed", "merge"]);
  });

  /**
   * `end` is the other half of this comparison and has its own check, because
   * its record lives on the work item's stream rather than the run's. Reporting
   * it from here as well would fail twice for one gap.
   */
  it("leaves the end point to the check that can see it", async () => {
    await landedItem(205, { end: ["close the ticket"] }, []);
    expect((await forProject()).map((f) => f.issue)).not.toContain(205);
  });
});
