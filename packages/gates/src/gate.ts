/**
 * The gate: one primitive, four kinds.
 *
 * Verification, code review and human approval look like three features. They
 * are one — **a named check that produces a verdict about a specific diff** —
 * and collapsing them is what makes "configure it for another project" a YAML
 * file rather than a patch. Adding a CI check, a second reviewer or a security
 * scan is a configuration line.
 *
 * **`onSha` is load-bearing.** A verdict is about a diff, not about a ticket.
 * Bind it to the commit and a force-push invalidates the approval by
 * arithmetic — `gatesOn()` in `@escapement/core` simply stops returning it. In
 * the old system approval was a label, and a label survives any amount of
 * rewriting.
 *
 * All four are implemented. `process` and `human` need nothing from the caller;
 * `agent` needs a reviewer and `policy` needs the diff's file list, and
 * `run-once` supplies both. A kind whose dependency is missing is refused by
 * name rather than skipped — see `from-recipe.ts`. The pipeline, the events and
 * `onSha` are the same for all four.
 */
import type { GatePoint, PayloadOf } from "@escapement/core";

/**
 * `needs-approval` is a third outcome, not a flavour of failure.
 *
 * A policy gate that sees a migration in the diff, and a human gate, both end
 * the same way: nothing is wrong, and nothing may proceed until a person says
 * so. Folding that into `failed` would put "the build is broken" on a card
 * whose build is fine, and folding it into `passed` would merge it.
 */
export type GateVerdict = "passed" | "failed" | "needs-approval";

export interface GateFinding {
  file: string;
  line: number | null;
  claim: string;
  /** No failure scenario, no finding. An observation without one is an opinion. */
  failureScenario: string;
  severity: "blocker" | "major" | "minor";
}

export interface GateResult {
  verdict: GateVerdict;
  /**
   * What the board shows. For a process gate this is the log tail — enough to
   * act on without leaving the card, which is the whole point of the board.
   */
  evidence: string;
  findings: GateFinding[];
}

export interface GateContext {
  runId: string;
  /** The commit this verdict is about, and the only thing that makes it stale. */
  onSha: string;
  /** The worktree. Gates run where the agent worked, never anywhere else. */
  cwd: string;
  /** Filtered, exactly as the agent's was. */
  env: Record<string, string>;
  signal?: AbortSignal;
}

export interface Gate {
  readonly name: string;
  /** Which action shape produced it: `run`, `agent`, `watch` or `human`. */
  readonly kind: "run" | "agent" | "watch" | "human";
  run(context: GateContext): Promise<GateResult>;
}

/** Emitted for every gate, in order. The pipeline's whole output is events. */
export type GateEvent =
  | { type: "GateRequested"; data: PayloadOf<"GateRequested"> }
  | { type: "GateStarted"; data: PayloadOf<"GateStarted"> }
  | { type: "GatePassed"; data: PayloadOf<"GatePassed"> }
  | { type: "GateFailed"; data: PayloadOf<"GateFailed"> }
  /** The same event `--no-merge` emits. One vocabulary for one idea. */
  | { type: "ApprovalRequested"; data: PayloadOf<"ApprovalRequested"> };

export interface PipelineResult {
  /** True when every gate passed. Never true when one is waiting on a person. */
  ok: boolean;
  /** The gate that failed, when one did. */
  failedAt: string | null;
  /** The gate waiting on a person, when one is. */
  heldAt: string | null;
  results: { gate: string; verdict: GateVerdict; evidence: string }[];
  /** Gates never reached because an earlier one failed or is waiting. */
  skipped: string[];
}

export interface PipelineOptions {
  /** Which of the five points this pipeline is. Stamped on every verdict. */
  point: GatePoint;
  gates: readonly Gate[];
  context: GateContext;
  /**
   * Called for every event, in order, before the next gate starts.
   *
   * The pipeline does not touch the store itself: a gate that ran but whose
   * verdict was never recorded is the failure this design exists to remove, and
   * keeping the append in one place makes that impossible to forget.
   */
  emit: (event: GateEvent) => Promise<void> | void;
}

/**
 * Runs the gates in recipe order and stops at the first failure.
 *
 * Stopping is deliberate. Running the remaining gates after one has already
 * refused costs money and produces verdicts about a diff that is not going
 * anywhere; worse, a board showing three green badges and one red invites the
 * reading that it is three-quarters fine.
 */
export async function runGatePipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { gates, point, context, emit } = options;
  const results: PipelineResult["results"] = [];

  for (const [index, gate] of gates.entries()) {
    const base = { gate: point, action: gate.name, runId: context.runId, onSha: context.onSha };

    await emit({ type: "GateRequested", data: base });
    await emit({ type: "GateStarted", data: base });

    let result: GateResult;
    try {
      result = await gate.run(context);
    } catch (err) {
      // A gate that throws is a gate that failed. The alternative is an
      // exception escaping the pipeline and a run ending with no verdict at all.
      result = {
        verdict: "failed",
        evidence: `the ${gate.name} gate threw: ${(err as Error).message}`,
        findings: [],
      };
    }

    results.push({ gate: gate.name, verdict: result.verdict, evidence: result.evidence });

    if (result.verdict === "passed") {
      await emit({ type: "GatePassed", data: { ...base, evidence: result.evidence } });
      continue;
    }

    if (result.verdict === "needs-approval") {
      // Stops for the same reason a failure does — the gates after this one are
      // about a diff that is not going anywhere yet — but it is not a failure,
      // and the event says which.
      await emit({
        type: "ApprovalRequested",
        data: { ...base, question: result.evidence, artifacts: [] },
      });
      return {
        ok: false,
        failedAt: null,
        heldAt: gate.name,
        results,
        skipped: gates.slice(index + 1).map((g) => g.name),
      };
    }

    await emit({
      type: "GateFailed",
      data: { ...base, evidence: result.evidence, findings: result.findings },
    });
    return {
      ok: false,
      failedAt: gate.name,
      heldAt: null,
      results,
      skipped: gates.slice(index + 1).map((g) => g.name),
    };
  }

  return { ok: true, failedAt: null, heldAt: null, results, skipped: [] };
}
