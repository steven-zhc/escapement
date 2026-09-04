/**
 * The `end` point's resolution, without a database.
 *
 * The interesting behaviour is a pure function on purpose: *what the point
 * resolved to* is decided from the recipe and the item's own stream, and
 * nothing about it needs a merge lane, a worktree or GitHub. The path that
 * lands an item through an approval is exercised for real in `run-once.test.ts`.
 */
import type { GateAction } from "@lingtai/config";
import type { Envelope } from "@lingtai/core";
import { describe, expect, it } from "vitest";
import { resolveEndActions } from "../src/end-point.ts";

const CLOSE: GateAction = { name: "close the ticket", close: true, when: "landed" };
const LABEL: GateAction = { name: "label it", labels: ["lingtai:done"], when: "any" };
const BUILD: GateAction = { name: "build", run: "true", timeout: "2m" };

/** One event on a work item stream. Only `type` and `data` are read here. */
const event = (type: string, data: unknown): Envelope => ({
  seq: 1n,
  streamId: "wi-p-1",
  version: 1,
  type,
  schemaVer: 1,
  data,
  actor: "conductor",
  causation: null,
  at: new Date(),
});

const resolved = (outcome: string, actions: unknown[] = []) =>
  event("EndActionsResolved", { outcome, actions });

describe("the end point", () => {
  it("says nothing when the recipe declares nothing", () => {
    // The skip is the operator's decision, and `GatesResolved` already records
    // that the point was empty.
    expect(resolveEndActions([], [], "landed")).toEqual([]);
  });

  it("takes the actions whose `when` matches, and the ones that match anything", () => {
    const [ev] = resolveEndActions([], [CLOSE, LABEL], "landed");
    expect(ev?.type).toBe("EndActionsResolved");
    expect(ev?.data).toEqual({
      outcome: "landed",
      actions: [{ name: "close the ticket", close: true }, { name: "label it", labels: ["lingtai:done"] }],
    });
  });

  /**
   * The distinction the whole model rests on (0016 §4): a point that was
   * configured and resolved to nothing is not the same fact as a point that
   * never ran, and from the log they must not look alike.
   */
  it("still records the point when nothing matches the outcome", () => {
    const [ev] = resolveEndActions([], [CLOSE], "failed");
    expect(ev?.data).toEqual({ outcome: "failed", actions: [] });
  });

  it("ignores an action at `end` that has no verdict to give", () => {
    // A `run:` at `end` is a misconfiguration: the point cannot refuse, so
    // there is nothing for a command's exit code to mean. The point still ran.
    const [ev] = resolveEndActions([], [BUILD], "landed");
    expect(ev?.data).toEqual({ outcome: "landed", actions: [] });
  });

  it("resolves once per outcome, from the item's own stream", () => {
    const stream = [event("WorkItemLanded", {}), resolved("landed", [{ name: "close the ticket", close: true }])];
    expect(resolveEndActions(stream, [CLOSE], "landed")).toEqual([]);
  });

  it("still resolves a different outcome the item reaches later", () => {
    // Blocked, then unblocked, then landed: two things happened to the issue
    // and both are the point doing its job.
    const stream = [resolved("blocked")];
    const [ev] = resolveEndActions(stream, [CLOSE], "landed");
    expect(ev?.data).toMatchObject({ outcome: "landed" });
  });
});
