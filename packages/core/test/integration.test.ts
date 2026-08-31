import { describe, expect, it } from "vitest";
import { emptyIntegration, laneIsBusy, reduceIntegration } from "../src/index.ts";
import { makeStream, unknownEvent } from "./support.ts";

const LANE = "int-nextloom-ai-admin-develop";

describe("reduceIntegration", () => {
  it("starts idle", () => {
    expect(reduceIntegration([])).toEqual(emptyIntegration);
    expect(laneIsBusy(reduceIntegration([]))).toBe(false);
  });

  it("holds the lane while attempting, and releases it on success", () => {
    const e = makeStream(LANE);
    const attempting = [
      e("IntegrationAttempted", { workItemId: "wi-a", branch: "agent/58", headSha: "sha-a" }),
    ];

    expect(laneIsBusy(reduceIntegration(attempting))).toBe(true);

    const done = reduceIntegration([
      ...attempting,
      e("IntegrationSucceeded", {
        workItemId: "wi-a",
        branch: "agent/58",
        base: "develop",
        mergeCommit: "merge1",
      }),
    ]);

    expect(laneIsBusy(done)).toBe(false);
    expect(done.base).toBe("develop");
    expect(done.landed).toEqual([
      { workItemId: "wi-a", branch: "agent/58", mergeCommit: "merge1" },
    ]);
  });

  /**
   * A refusal that left the lane held would turn one bad merge into a
   * permanently stuck base branch — nothing else could ever attempt it.
   */
  it("releases the lane on a refusal too", () => {
    const e = makeStream(LANE);
    const s = reduceIntegration([
      e("IntegrationAttempted", { workItemId: "wi-a", branch: "agent/58", headSha: "sha-a" }),
      e("IntegrationRefused", {
        workItemId: "wi-a",
        branch: "agent/58",
        reason: "dirty-base" as const,
        detail: "uncommitted changes in the operator's checkout",
      }),
    ]);

    expect(laneIsBusy(s)).toBe(false);
  });

  /**
   * The query that could not be written before. Six `return 1` paths in the old
   * `integrate()` emitted nothing at all; #58 and #59 re-ran five times for ~$29
   * while the real cause — a dirty checkout — was never reported.
   */
  it("tallies refusals by typed reason", () => {
    const e = makeStream(LANE);
    const refusal = (reason: "dirty-base" | "conflict" | "lane-busy", detail: string) =>
      e("IntegrationRefused", { workItemId: "wi-a", branch: "agent/58", reason, detail });

    const s = reduceIntegration([
      refusal("dirty-base", "operator checkout dirty"),
      refusal("dirty-base", "still dirty"),
      refusal("conflict", "src/a.ts"),
      refusal("lane-busy", "wi-b holds develop"),
    ]);

    expect(s.refusalsByReason).toEqual({ "dirty-base": 2, conflict: 1, "lane-busy": 1 });
    expect(s.refusals).toHaveLength(4);
    // Every one of them names why, which is the entire difference from before.
    expect(s.refusals.every((r) => r.detail.length > 0)).toBe(true);
  });

  it("counts attempts separately from outcomes", () => {
    const e = makeStream(LANE);
    const s = reduceIntegration([
      e("IntegrationAttempted", { workItemId: "wi-a", branch: "agent/58", headSha: "sha-a" }),
      e("IntegrationRefused", {
        workItemId: "wi-a",
        branch: "agent/58",
        reason: "conflict" as const,
        detail: "src/a.ts",
      }),
      e("IntegrationAttempted", { workItemId: "wi-a", branch: "agent/58", headSha: "sha-b" }),
      e("IntegrationSucceeded", {
        workItemId: "wi-a",
        branch: "agent/58",
        base: "develop",
        mergeCommit: "merge1",
      }),
    ]);

    // Two attempts, one landing: the cost of a merge is visible, not inferred.
    expect(s.attempts).toBe(2);
    expect(s.landed).toHaveLength(1);
    expect(s.refusals).toHaveLength(1);
  });

  it("ignores an event type it has never heard of", () => {
    const e = makeStream(LANE);
    const s = reduceIntegration([
      e("IntegrationAttempted", { workItemId: "wi-a", branch: "agent/58", headSha: "sha-a" }),
      unknownEvent(LANE, 2),
    ]);

    expect(laneIsBusy(s)).toBe(true);
    expect(s.version).toBe(2);
  });
});
