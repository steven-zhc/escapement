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
  GateActionUnavailableError,
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
      point: "proposed",
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
      point: "proposed",
      gates: [
        createProcessGate({ name: "build", run: "exit 0" }),
        createProcessGate({ name: "lint", run: "exit 0" }),
      ],
      context,
      emit,
    });

    // `gate` is the point and `action` is what ran there — two fields, because
    // "the build failed" and "something at the diff point failed" are different
    // questions and one name could not answer both.
    const started = events.filter((e) => e.type === "GateStarted");
    expect(started.map((e) => e.data.action)).toEqual(["build", "lint"]);
    expect(started.map((e) => e.data.gate)).toEqual(["proposed", "proposed"]);
  });

  /**
   * Stopping is deliberate. Running the rest costs money for verdicts about a
   * diff that is not going anywhere, and three green badges beside one red
   * invites the reading that it is three-quarters fine.
   */
  it("stops at the first failure and names what it skipped", async () => {
    const { events, emit } = collector();
    const result = await runGatePipeline({
      point: "proposed",
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
      point: "proposed",
      gates: [
        {
          name: "broken",
          kind: "run" as const,
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
    const result = await runGatePipeline({ point: "proposed", gates: [], context, emit });
    expect(result.ok).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("gatesFromRecipe", () => {
  it("builds the process gates", () => {
    const gates = gatesFromRecipe([
      { name: "build", run: "pnpm verify", timeout: "15m" },
    ]);
    expect(gates.map((g) => g.name)).toEqual(["build"]);
  });

  /**
   * A pipeline that silently skipped the `human` gate because nothing implements
   * it would produce a green board for a change nobody approved.
   */
  it("builds every kind the schema allows", () => {
    // All four exist now. The factory has an exhaustiveness check against the
    // schema union, so a fifth kind is a type error rather than a gate that
    // falls through and silently does nothing.
    expect(gatesFromRecipe([{ name: "approval", human: "Merge?" }])).toHaveLength(1);
    expect(
      gatesFromRecipe([{ name: "tamper", watch: ["**/x"], then: "fail" }], {
        watch: { changedFiles: async () => [] },
      }),
    ).toHaveLength(1);
  });

  it("refuses a gate whose dependencies are missing, rather than skipping it", () => {
    // `agent` is implemented, but it needs a runtime, a ticket and a diff, and
    // callers that only want to know whether a recipe *parses* do not have
    // them. Absent deps refuse for the same reason an unbuilt kind does: a gate
    // that is silently not run is worse than a run that will not start.
    expect(() => gatesFromRecipe([{ name: "review", agent: "p" }])).toThrow(
      GateActionUnavailableError,
    );
    expect(() => gatesFromRecipe([{ name: "review", agent: "p" }])).toThrow(
      /no reviewer was supplied/,
    );
    expect(() =>
      gatesFromRecipe([{ name: "tamper", watch: ["**/x"], then: "fail" }]),
    ).toThrow(/no file list was supplied/);
  });
});
