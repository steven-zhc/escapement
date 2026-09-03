import { describe, expect, it } from "vitest";
import { emptyRun, gatesOn, reduceRun } from "../src/index.ts";
import { makeStream, unknownEvent } from "./support.ts";

const started = {
  workItemId: "wi-nextloom-ai-admin-117",
  runtime: "claude-code" as const,
  model: "claude-opus-5",
  promptVersion: "ticket@3",
  baseSha: "base000",
  configHash: "cfg123",
  worktree: "/tmp/wt/117",
};

describe("reduceRun", () => {
  it("is pending until it starts", () => {
    expect(reduceRun([])).toEqual(emptyRun);
  });

  it("records the run's provenance, including the recipe it was bound to", () => {
    const e = makeStream("run-01JX");
    const s = reduceRun([e("RunStarted", started)]);

    expect(s.lifecycle.status).toBe("running");
    expect(s.configHash).toBe("cfg123");
    expect(s.promptVersion).toBe("ticket@3");
  });

  /**
   * 132 guard trips across 56 of 73 runs — 77% of runs — went to stderr inside a
   * log nobody parsed. Counting them is the entire reason the event exists.
   */
  it("records compaction as a metric, not as noise", () => {
    const e = makeStream("run-01JX");
    const s = reduceRun([
      e("RunStarted", started),
      e("RunContextExhausted", { turn: 41 }),
      e("RunContextExhausted", { turn: 88 }),
    ]);

    // Two compactions means the item was scoped far too large.
    expect(s.compactedAtTurns).toEqual([41, 88]);
  });

  it("lights up when the agent is waiting, and goes back to running on progress", () => {
    const e = makeStream("run-01JX");
    const waiting = [e("RunStarted", started), e("RunAwaitingInput", { prompt: "Which base?" })];

    expect(reduceRun(waiting).lifecycle).toEqual({
      status: "awaiting-input",
      prompt: "Which base?",
    });

    const moved = reduceRun([
      ...waiting,
      e("RunProducedDiff", {
        branch: "agent/117",
        headSha: "sha-a",
        files: 3,
        insertions: 40,
        deletions: 2,
      }),
    ]);
    expect(moved.lifecycle.status).toBe("running");
    expect(moved.diff).toEqual({ files: 3, insertions: 40, deletions: 2 });
  });

  it("enters gating on a proposed completion and collects verdicts", () => {
    const e = makeStream("run-01JX");
    const s = reduceRun([
      e("RunStarted", started),
      e("RunProposedCompletion", { headSha: "sha-a" }),
      e("GateRequested", { gate: "proposed", action: "build", runId: "run-01JX", onSha: "sha-a" }),
      e("GateStarted", { gate: "proposed", action: "build", runId: "run-01JX", onSha: "sha-a" }),
      e("GatePassed", { gate: "proposed", action: "build", runId: "run-01JX", onSha: "sha-a", evidence: "exit 0" }),
      e("GateFailed", {
        gate: "proposed", action: "review",
        runId: "run-01JX",
        onSha: "sha-a",
        evidence: "1 finding",
        findings: [
          {
            file: "src/a.ts",
            line: 12,
            claim: "check-then-write race",
            failureScenario: "two requests read 0, both write 1, one increment is lost",
            severity: "blocker" as const,
          },
        ],
      }),
    ]);

    expect(s.lifecycle).toEqual({ status: "gating", headSha: "sha-a" });
    expect(s.gates["proposed:build"]!.verdict).toBe("passed");
    expect(s.gates["proposed:review"]!.verdict).toBe("failed");
    expect(s.gates["proposed:review"]!.findings[0]!.failureScenario).toContain("increment is lost");
    expect(gatesOn(s).map((g) => g.gate).sort()).toEqual(["proposed:build", "proposed:review"]);
  });

  /**
   * The reason `onSha` is on every gate event. In the old system approval was a
   * label, and a label survives any amount of rewriting — so a force-push
   * inherited its own approval. Here a new head simply has no verdicts.
   */
  it("a force-push invalidates every verdict, without revoking anything", () => {
    const e = makeStream("run-01JX");
    const approved = [
      e("RunStarted", started),
      e("RunProposedCompletion", { headSha: "sha-a" }),
      e("GatePassed", { gate: "proposed", action: "build", runId: "run-01JX", onSha: "sha-a", evidence: "exit 0" }),
      e("ApprovalGranted", {
        gate: "merge",
        action: "human",
        runId: "run-01JX",
        onSha: "sha-a",
        by: "human:steven",
        note: "looks right",
      }),
    ];

    const before = reduceRun(approved);
    expect(gatesOn(before).map((g) => g.gate).sort()).toEqual(["merge:human", "proposed:build"]);

    const after = reduceRun([...approved, e("RunProposedCompletion", { headSha: "sha-b" })]);
    expect(after.headSha).toBe("sha-b");
    // The verdicts are still on the record — they were made, and about what —
    // but none of them is about the diff now on the table.
    expect(gatesOn(after)).toEqual([]);
    expect(after.gates["merge:human"]!.onSha).toBe("sha-a");
  });

  it("records a waiver with who and why — never silently", () => {
    const e = makeStream("run-01JX");
    const s = reduceRun([
      e("RunStarted", started),
      e("RunProposedCompletion", { headSha: "sha-a" }),
      e("GateWaived", {
        gate: "proposed", action: "review",
        runId: "run-01JX",
        onSha: "sha-a",
        by: "human:steven",
        reason: "reviewer unavailable, change is a docs typo",
      }),
    ]);

    expect(s.gates["proposed:review"]!.verdict).toBe("waived");
    expect(s.gates["proposed:review"]!.by).toBe("human:steven");
    expect(s.gates["proposed:review"]!.reason).toContain("docs typo");
  });

  it("waits on a person, then proceeds when they answer", () => {
    const e = makeStream("run-01JX");
    const asked = [
      e("RunStarted", started),
      e("RunProposedCompletion", { headSha: "sha-a" }),
      e("ApprovalRequested", {
        gate: "merge",
        action: "human",
        runId: "run-01JX",
        onSha: "sha-a",
        question: "Merge into develop?",
        artifacts: ["diff"],
      }),
    ];

    expect(reduceRun(asked).lifecycle).toEqual({
      status: "awaiting-approval",
      gate: "merge:human",
      onSha: "sha-a",
      question: "Merge into develop?",
    });

    const granted = reduceRun([
      ...asked,
      e("ApprovalGranted", {
        gate: "merge",
        action: "human",
        runId: "run-01JX",
        onSha: "sha-a",
        by: "human:steven",
        note: "",
      }),
    ]);
    expect(granted.lifecycle).toEqual({ status: "gating", headSha: "sha-a" });
    expect(granted.gates["merge:human"]!.verdict).toBe("passed");
  });

  /**
   * This asserted `failed` until #20. A withdrawn approval is not a gate that
   * refused the diff — nothing refused anything, someone took an answer back —
   * and the difference is what the card tells a person: "the build is broken"
   * versus "this is waiting on you". Only one of those is true, and acting on
   * the wrong one costs a person a search for a defect that does not exist.
   */
  it("returns a revoked approval to the gate, not to a refusal", () => {
    const e = makeStream("run-01JX");
    const s = reduceRun([
      e("RunStarted", started),
      e("RunProposedCompletion", { headSha: "sha-a" }),
      e("ApprovalGranted", {
        gate: "merge",
        action: "human",
        runId: "run-01JX",
        onSha: "sha-a",
        by: "human:steven",
        note: "",
      }),
      e("ApprovalRevoked", {
        gate: "merge",
        action: "human",
        runId: "run-01JX",
        onSha: "sha-a",
        by: "human:steven",
        reason: "spotted a migration",
      }),
    ]);

    expect(s.gates["merge:human"]!.verdict).toBe("requested");
    // And the run is waiting again, on the same commit, with the reason the
    // person gave — not merged, not queued, not failed.
    expect(s.lifecycle).toMatchObject({ status: "awaiting-approval", gate: "merge:human", onSha: "sha-a" });
    expect(s.lifecycle).toHaveProperty("question", expect.stringContaining("spotted a migration"));
  });

  it("keeps the receipt the old .jsonl could not be parsed for", () => {
    const e = makeStream("run-01JX");
    const s = reduceRun([
      e("RunStarted", started),
      e("RunFinished", { exitCode: 0, turns: 63, durationMs: 4_210_000, costUsd: 5.42 }),
    ]);

    expect(s.receipt).toEqual({ exitCode: 0, turns: 63, durationMs: 4_210_000, costUsd: 5.42 });
    expect(s.lifecycle.status).toBe("finished");
  });

  it("records a failure with its kind", () => {
    const e = makeStream("run-01JX");
    const s = reduceRun([
      e("RunStarted", started),
      e("RunFailed", { kind: "timeout" as const, detail: "2h wall clock" }),
    ]);

    expect(s.lifecycle).toEqual({ status: "failed", kind: "timeout", detail: "2h wall clock" });
  });

  it("ignores an event type it has never heard of", () => {
    const e = makeStream("run-01JX");
    const s = reduceRun([e("RunStarted", started), unknownEvent("run-01JX", 2)]);

    expect(s.lifecycle.status).toBe("running");
    expect(s.version).toBe(2);
  });
});
