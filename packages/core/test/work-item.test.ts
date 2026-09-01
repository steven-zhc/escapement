import { describe, expect, it } from "vitest";
import { emptyWorkItem, reduceWorkItem } from "../src/index.ts";
import { makeStream, unknownEvent } from "./support.ts";

const discovered = {
  project: "nextloom-ai-admin",
  source: "github-issue" as const,
  externalRef: "117",
  title: "Migration hold",
  kind: "bug" as const,
  labels: ["agent:ready"],
};

describe("reduceWorkItem", () => {
  it("is backlog with nothing known before its first event", () => {
    const s = reduceWorkItem([]);
    expect(s).toEqual(emptyWorkItem);
    expect(s.lifecycle.status).toBe("backlog");
    expect(s.version).toBe(0);
  });

  it("records what discovery knew", () => {
    const e = makeStream("wi-nextloom-ai-admin-117");
    const s = reduceWorkItem([e("WorkItemDiscovered", discovered)]);

    expect(s.project).toBe("nextloom-ai-admin");
    expect(s.externalRef).toBe("117");
    expect(s.kind).toBe("bug");
    expect(s.labels).toEqual(["agent:ready"]);
    expect(s.lifecycle.status).toBe("backlog");
  });

  it("walks discovered → claimed → landed", () => {
    const e = makeStream("wi-nextloom-ai-admin-117");
    const s = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("WorkItemClaimed", { runId: "run-01JX", worker: "conductor@host", leaseUntilMs: 1_000, title: null, kind: null }),
      e("WorkItemLanded", { mergeCommit: "abc1234", base: "develop" }),
    ]);

    expect(s.lifecycle).toEqual({ status: "landed", mergeCommit: "abc1234", base: "develop" });
    expect(s.runs).toEqual(["run-01JX"]);
    expect(s.version).toBe(3);
  });

  it("returns to the backlog when released, and the lease goes with it", () => {
    const e = makeStream("wi-p-1");
    const s = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("WorkItemClaimed", { runId: "run-a", worker: "w", leaseUntilMs: 1, title: null, kind: null }),
      e("WorkItemReleased", { runId: "run-a", reason: "lease expired" }),
    ]);

    expect(s.lifecycle).toEqual({ status: "backlog" });
    // The run is still on the record — it happened — but it holds nothing.
    expect(s.runs).toEqual(["run-a"]);
  });

  it("carries the question when blocked, and drops it when unblocked", () => {
    const e = makeStream("wi-p-1");
    const events = [
      e("WorkItemDiscovered", discovered),
      e("WorkItemBlocked", {
        question: "Which base branch should this target?",
        needsFrom: "human" as const,
        runId: "run-a",
      }),
    ];

    const blocked = reduceWorkItem(events);
    expect(blocked.lifecycle).toEqual({
      status: "blocked",
      question: "Which base branch should this target?",
      needsFrom: "human",
      runId: "run-a",
    });

    const unblocked = reduceWorkItem([
      ...events,
      e("WorkItemUnblocked", { by: "human:steven", note: "develop" }),
    ]);
    expect(unblocked.lifecycle).toEqual({ status: "backlog" });
  });

  /**
   * The regression this whole aggregate exists for. #35 held `agent:blocked` and
   * `agent:review` at once because labels are a set, not a state. Here the
   * lifecycle is one value, so the second transition replaces the first — there
   * is no state in which both are true, and no way to construct one.
   */
  it("cannot be blocked and claimed at the same time", () => {
    const e = makeStream("wi-nextloom-ai-admin-35");
    const s = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("WorkItemBlocked", { question: "?", needsFrom: "human" as const, runId: null }),
      e("WorkItemClaimed", { runId: "run-b", worker: "w", leaseUntilMs: 2, title: null, kind: null }),
    ]);

    expect(s.lifecycle.status).toBe("claimed");
    expect(Object.keys(s.lifecycle).sort()).toEqual(["leaseUntilMs", "runId", "status", "worker"]);
    expect(s.lifecycle).not.toHaveProperty("question");
  });

  it("links a filed bug to the merge that caused it, without duplicating", () => {
    const e = makeStream("wi-nextloom-ai-admin-134");
    const link = { relation: "caused-by" as const, otherRef: "58" };
    const s = reduceWorkItem([
      e("WorkItemDiscovered", { ...discovered, externalRef: "134" }),
      e("WorkItemLinked", link),
      e("WorkItemLinked", link),
    ]);

    expect(s.links).toEqual([link]);
  });

  it("keeps every refused dispatch rather than counting them", () => {
    const e = makeStream("wi-p-1");
    const s = reduceWorkItem([
      e("WorkItemDiscovered", discovered),
      e("DispatchRefused", {
        requiredTier: "sandboxed" as const,
        runtime: "claude-code" as const,
        missing: ["filesystem-sandbox"],
      }),
    ]);

    expect(s.dispatchRefusals).toHaveLength(1);
    expect(s.dispatchRefusals[0]!.missing).toEqual(["filesystem-sandbox"]);
    // A refusal is not a transition: the item is still in the backlog, and the
    // tier was not silently downgraded to make it run.
    expect(s.lifecycle.status).toBe("backlog");
  });

  it("ignores an event type it has never heard of, but still advances", () => {
    const e = makeStream("wi-p-1");
    const first = e("WorkItemDiscovered", discovered);
    const s = reduceWorkItem([first, unknownEvent("wi-p-1", 2)]);

    expect(s.title).toBe("Migration hold");
    expect(s.lifecycle.status).toBe("backlog");
    // Version still advances, so the next append does not use a stale expectation.
    expect(s.version).toBe(2);
  });
});
