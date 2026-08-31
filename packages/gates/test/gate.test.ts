/**
 * The process gate and the pipeline, against real processes.
 *
 * Nothing is mocked: a gate is a command and an exit code, so a test that stubs
 * the command is testing nothing. The properties that matter are `onSha` on
 * every verdict, a timeout that is distinguishable from a refusal, evidence a
 * person could act on, and a pipeline that stops the moment something says no.
 */
import { describe, expect, it } from "vitest";
import {
  GateKindNotImplementedError,
  type GateEvent,
  createProcessGate,
  gatesFromRecipe,
  runGatePipeline,
  tail,
} from "../src/index.ts";

const context = {
  runId: "run-01JX",
  onSha: "sha-a",
  cwd: process.cwd(),
  env: { PATH: process.env["PATH"] ?? "" },
};

describe("the process gate", () => {
  it("passes on exit 0 and says what ran", async () => {
    const gate = createProcessGate({ name: "build", run: "exit 0" });
    const result = await gate.run(context);

    expect(result.verdict).toBe("passed");
    expect(result.evidence).toContain("exit 0");
  });

  /**
   * The board's promise is that a card is workable without leaving it. "The
   * build failed" with no output is a link to somewhere else wearing a disguise.
   */
  it("fails on a non-zero exit and carries the log tail", async () => {
    const gate = createProcessGate({
      name: "build",
      run: "echo 'src/a.ts(12,3): error TS2345'; echo 'Found 1 error.'; exit 2",
    });
    const result = await gate.run(context);

    expect(result.verdict).toBe("failed");
    expect(result.evidence).toContain("exited 2");
    expect(result.evidence).toContain("error TS2345");
    expect(result.evidence).toContain("Found 1 error.");
  });

  it("captures stderr as well as stdout, because compilers use both", async () => {
    const gate = createProcessGate({ name: "build", run: "echo boom >&2; exit 1" });
    expect((await gate.run(context)).evidence).toContain("boom");
  });

  /**
   * A gate that ran out of time and a gate that ran and refused are different
   * problems with different fixes. The old loop's could hang to the two-hour
   * wall clock and then report nothing at all.
   */
  it("distinguishes a timeout from a refusal", async () => {
    const gate = createProcessGate({ name: "build", run: "echo starting; sleep 5", timeout: "300ms" });
    const result = await gate.run(context);

    expect(result.verdict).toBe("failed");
    expect(result.evidence).toContain("timed out after 300ms");
    // And what it managed to print before being killed is still evidence.
    expect(result.evidence).toContain("starting");
    expect(result.evidence).not.toContain("exited");
  });

  it("fails rather than throwing when the command cannot run at all", async () => {
    const gate = createProcessGate({ name: "build", run: "this-command-does-not-exist" });
    const result = await gate.run(context);
    expect(result.verdict).toBe("failed");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("runs in the worktree it was given", async () => {
    const gate = createProcessGate({ name: "where", run: "pwd; exit 1" });
    const result = await gate.run({ ...context, cwd: "/tmp" });
    expect(result.evidence).toContain("/tmp");
  });

  it("refuses a timeout that is not a duration rather than defaulting to zero", () => {
    // A gate that silently got a 0ms timeout would fail every run for a reason
    // nobody could see.
    expect(() => createProcessGate({ name: "x", run: "true", timeout: "soon" })).toThrow(/duration/);
  });
});

describe("tail", () => {
  it("keeps the end, which is where the error is", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const kept = tail(text, 10);
    expect(kept).toContain("line 499");
    expect(kept).not.toContain("line 100");
  });

  it("caps bytes as well as lines, because one line can be a megabyte", () => {
    expect(tail("x".repeat(50_000), 10, 100).length).toBeLessThanOrEqual(101);
  });
});

describe("the pipeline", () => {
  function collector() {
    const events: GateEvent[] = [];
    return { events, emit: (e: GateEvent) => void events.push(e) };
  }

  it("puts onSha on every verdict", async () => {
    const { events, emit } = collector();
    await runGatePipeline({
      gates: [createProcessGate({ name: "build", run: "exit 0" })],
      context,
      emit,
    });

    // A verdict is about a diff, not about a ticket. Bind it to the commit and a
    // force-push invalidates the approval instead of inheriting it.
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual(["GateRequested", "GateStarted", "GatePassed"]);
    for (const e of events) expect(e.data.onSha).toBe("sha-a");
  });

  it("runs in recipe order", async () => {
    const { events, emit } = collector();
    await runGatePipeline({
      gates: [
        createProcessGate({ name: "build", run: "exit 0" }),
        createProcessGate({ name: "lint", run: "exit 0" }),
      ],
      context,
      emit,
    });

    expect(events.filter((e) => e.type === "GateStarted").map((e) => e.data.gate)).toEqual([
      "build",
      "lint",
    ]);
  });

  /**
   * Stopping is deliberate. Running the rest costs money for verdicts about a
   * diff that is not going anywhere, and three green badges beside one red
   * invites the reading that it is three-quarters fine.
   */
  it("stops at the first failure and names what it skipped", async () => {
    const { events, emit } = collector();
    const result = await runGatePipeline({
      gates: [
        createProcessGate({ name: "build", run: "exit 0" }),
        createProcessGate({ name: "lint", run: "echo nope; exit 1" }),
        createProcessGate({ name: "test", run: "exit 0" }),
      ],
      context,
      emit,
    });

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe("lint");
    expect(result.skipped).toEqual(["test"]);
    expect(events.map((e) => e.data.gate)).not.toContain("test");
    expect(events.at(-1)?.type).toBe("GateFailed");
  });

  it("turns a gate that throws into a failure rather than an escaped exception", async () => {
    const { emit } = collector();
    const result = await runGatePipeline({
      gates: [
        {
          name: "broken",
          kind: "process" as const,
          run: () => Promise.reject(new Error("the gate itself is broken")),
        },
      ],
      context,
      emit,
    });

    // A run must never end with no verdict.
    expect(result.ok).toBe(false);
    expect(result.results[0]!.evidence).toContain("the gate itself is broken");
  });

  it("emits nothing at all for an empty pipeline", async () => {
    const { events, emit } = collector();
    const result = await runGatePipeline({ gates: [], context, emit });
    expect(result.ok).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("gatesFromRecipe", () => {
  it("builds the process gates", () => {
    const gates = gatesFromRecipe([
      { kind: "process", name: "build", run: "pnpm verify", timeout: "15m" },
    ]);
    expect(gates.map((g) => g.name)).toEqual(["build"]);
  });

  /**
   * A pipeline that silently skipped the `human` gate because nothing implements
   * it would produce a green board for a change nobody approved.
   */
  it("refuses a kind that is not implemented, naming the issue", () => {
    expect(() => gatesFromRecipe([{ kind: "human", name: "approval" }])).toThrow(
      GateKindNotImplementedError,
    );
    expect(() => gatesFromRecipe([{ kind: "human", name: "approval" }])).toThrow(/#20/);
    expect(() => gatesFromRecipe([{ kind: "agent", name: "review", prompt: "p" }])).toThrow(/#18/);
  });
});
