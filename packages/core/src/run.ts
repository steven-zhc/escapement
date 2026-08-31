/**
 * The Run aggregate: `run-{ulid}`, alive for hours, noisy.
 *
 * This is where the old loop's telemetry went to die. Guard blocks went to
 * stderr inside a log nobody parsed — 132 of them across 56 of 73 runs, 77% of
 * runs tripping the guard, and not one of them ever seen. Cost records went to a
 * `.jsonl` that also contained raw `pnpm build` output, so 9,555 of its 42,147
 * lines were not JSON and the file would not parse. Every number this reducer
 * exposes is a number that existed before and could not be read.
 *
 * The load-bearing subtlety is `onSha`. A gate verdict is about **a diff**, not
 * about a ticket. In the old system approval was a label, and a label survives
 * any amount of rewriting — so a force-push inherited its own approval. Here a
 * verdict records the sha it was made against, and `gatesOn(state)` returns only
 * the verdicts that match the current head. Nothing has to remember to
 * invalidate anything; a new head simply has no verdicts yet.
 */
import type { Envelope } from "./envelope.ts";
import type { PayloadOf, RuntimeId } from "./events.ts";

export type GateVerdict = "requested" | "running" | "passed" | "failed" | "waived";

export interface GateFinding {
  file: string;
  line: number | null;
  claim: string;
  /** No failure scenario, no finding. An observation without one is an opinion. */
  failureScenario: string;
  severity: "blocker" | "major" | "minor";
}

export interface GateState {
  gate: string;
  verdict: GateVerdict;
  /** The commit this verdict is about. A verdict on any other sha is stale. */
  onSha: string;
  evidence: string | null;
  findings: readonly GateFinding[];
  /** Set for a waiver, and for an approval. A waiver is recorded, never silent. */
  by: string | null;
  reason: string | null;
}

export type RunLifecycle =
  | { status: "pending" }
  | { status: "running" }
  | { status: "awaiting-input"; prompt: string }
  | { status: "gating"; headSha: string }
  | { status: "awaiting-approval"; gate: string; onSha: string; question: string }
  | { status: "finished"; exitCode: number; turns: number; durationMs: number; costUsd: number | null }
  | { status: "failed"; kind: "timeout" | "crash" | "no-commits" | "guard-hard-stop"; detail: string };

export type RunStatus = RunLifecycle["status"];

export interface GuardTrip {
  tool: string;
  pattern: string;
  /** Redacted at the source: what trips the guard is often what should not be stored. */
  redactedCommand: string;
}

export interface RunState {
  lifecycle: RunLifecycle;

  workItemId: string | null;
  runtime: RuntimeId | null;
  model: string | null;
  promptVersion: string | null;
  baseSha: string | null;
  /** Hash of the recipe as read from `origin/<base>`, never from the agent's branch. */
  configHash: string | null;
  worktree: string | null;

  /** Current head of the agent's branch. Changes invalidate gate verdicts. */
  headSha: string | null;
  branch: string | null;
  diff: { files: number; insertions: number; deletions: number } | null;

  /** Files the agent wrote, in order, so the card can show them live. */
  touched: readonly { path: string; op: "edit" | "write" | "delete" }[];
  /** Every one of these was invisible in the old loop. */
  guardTrips: readonly GuardTrip[];
  /**
   * Turns at which the context was compacted. Compaction means the work item was
   * scoped too large — a metric, not noise.
   */
  compactedAtTurns: readonly number[];
  prompts: number;

  /** Latest verdict per gate name, each carrying the sha it was made against. */
  gates: Readonly<Record<string, GateState>>;

  receipt: { exitCode: number; turns: number; durationMs: number; costUsd: number | null } | null;

  version: number;
  lastSeq: bigint | null;
}

export const emptyRun: RunState = {
  lifecycle: { status: "pending" },
  workItemId: null,
  runtime: null,
  model: null,
  promptVersion: null,
  baseSha: null,
  configHash: null,
  worktree: null,
  headSha: null,
  branch: null,
  diff: null,
  touched: [],
  guardTrips: [],
  compactedAtTurns: [],
  prompts: 0,
  gates: {},
  receipt: null,
  version: 0,
  lastSeq: null,
};

/**
 * The gate verdicts that are actually about the current head.
 *
 * A force-push moves `headSha`, and every verdict made against the old one stops
 * counting here without anything having to revoke it. That is the whole reason
 * `onSha` is on the event.
 */
export function gatesOn(state: RunState): GateState[] {
  if (state.headSha === null) return [];
  return Object.values(state.gates).filter((g) => g.onSha === state.headSha);
}

function withGate(state: RunState, gate: GateState): Readonly<Record<string, GateState>> {
  return { ...state.gates, [gate.gate]: gate };
}

export function applyRun(state: RunState, event: Envelope): RunState {
  const at = { version: event.version, lastSeq: event.seq };

  switch (event.type) {
    case "RunStarted": {
      const d = event.data as PayloadOf<"RunStarted">;
      return {
        ...state,
        ...at,
        lifecycle: { status: "running" },
        workItemId: d.workItemId,
        runtime: d.runtime,
        model: d.model,
        promptVersion: d.promptVersion,
        baseSha: d.baseSha,
        configHash: d.configHash,
        worktree: d.worktree,
      };
    }

    case "RunPrompted":
      return { ...state, ...at, prompts: state.prompts + 1 };

    case "RunTouchedFile": {
      const d = event.data as PayloadOf<"RunTouchedFile">;
      return { ...state, ...at, touched: [...state.touched, d] };
    }

    case "GuardTripped": {
      const d = event.data as PayloadOf<"GuardTripped">;
      return { ...state, ...at, guardTrips: [...state.guardTrips, d] };
    }

    case "RunContextExhausted": {
      const d = event.data as PayloadOf<"RunContextExhausted">;
      return { ...state, ...at, compactedAtTurns: [...state.compactedAtTurns, d.turn] };
    }

    case "RunAwaitingInput": {
      const d = event.data as PayloadOf<"RunAwaitingInput">;
      // The board lights up instead of the run burning to the wall clock.
      return { ...state, ...at, lifecycle: { status: "awaiting-input", prompt: d.prompt } };
    }

    case "RunProducedDiff": {
      const d = event.data as PayloadOf<"RunProducedDiff">;
      return {
        ...state,
        ...at,
        branch: d.branch,
        headSha: d.headSha,
        diff: { files: d.files, insertions: d.insertions, deletions: d.deletions },
        lifecycle: state.lifecycle.status === "awaiting-input" ? { status: "running" } : state.lifecycle,
      };
    }

    case "RunProposedCompletion": {
      const d = event.data as PayloadOf<"RunProposedCompletion">;
      // The moment the gate pipeline fires.
      return { ...state, ...at, headSha: d.headSha, lifecycle: { status: "gating", headSha: d.headSha } };
    }

    case "RunFinished": {
      const d = event.data as PayloadOf<"RunFinished">;
      return {
        ...state,
        ...at,
        receipt: d,
        lifecycle: {
          status: "finished",
          exitCode: d.exitCode,
          turns: d.turns,
          durationMs: d.durationMs,
          costUsd: d.costUsd,
        },
      };
    }

    case "RunFailed": {
      const d = event.data as PayloadOf<"RunFailed">;
      return { ...state, ...at, lifecycle: { status: "failed", kind: d.kind, detail: d.detail } };
    }

    case "GateRequested":
    case "GateStarted": {
      const d = event.data as PayloadOf<"GateRequested">;
      return {
        ...state,
        ...at,
        gates: withGate(state, {
          gate: d.gate,
          verdict: event.type === "GateRequested" ? "requested" : "running",
          onSha: d.onSha,
          evidence: null,
          findings: [],
          by: null,
          reason: null,
        }),
      };
    }

    case "GatePassed": {
      const d = event.data as PayloadOf<"GatePassed">;
      return {
        ...state,
        ...at,
        gates: withGate(state, {
          gate: d.gate,
          verdict: "passed",
          onSha: d.onSha,
          evidence: d.evidence,
          findings: [],
          by: null,
          reason: null,
        }),
      };
    }

    case "GateFailed": {
      const d = event.data as PayloadOf<"GateFailed">;
      return {
        ...state,
        ...at,
        gates: withGate(state, {
          gate: d.gate,
          verdict: "failed",
          onSha: d.onSha,
          evidence: d.evidence,
          findings: d.findings,
          by: null,
          reason: null,
        }),
      };
    }

    case "GateWaived": {
      const d = event.data as PayloadOf<"GateWaived">;
      return {
        ...state,
        ...at,
        gates: withGate(state, {
          gate: d.gate,
          verdict: "waived",
          onSha: d.onSha,
          evidence: null,
          findings: [],
          by: d.by,
          reason: d.reason,
        }),
      };
    }

    case "ApprovalRequested": {
      const d = event.data as PayloadOf<"ApprovalRequested">;
      return {
        ...state,
        ...at,
        lifecycle: { status: "awaiting-approval", gate: d.gate, onSha: d.onSha, question: d.question },
        gates: withGate(state, {
          gate: d.gate,
          verdict: "requested",
          onSha: d.onSha,
          evidence: null,
          findings: [],
          by: null,
          reason: null,
        }),
      };
    }

    case "ApprovalGranted": {
      const d = event.data as PayloadOf<"ApprovalGranted">;
      return {
        ...state,
        ...at,
        lifecycle: { status: "gating", headSha: d.onSha },
        gates: withGate(state, {
          gate: d.gate,
          verdict: "passed",
          onSha: d.onSha,
          evidence: null,
          findings: [],
          by: d.by,
          reason: d.note,
        }),
      };
    }

    case "ApprovalRevoked": {
      const d = event.data as PayloadOf<"ApprovalRevoked">;
      return {
        ...state,
        ...at,
        gates: withGate(state, {
          gate: d.gate,
          verdict: "failed",
          onSha: d.onSha,
          evidence: null,
          findings: [],
          by: d.by,
          reason: d.reason,
        }),
      };
    }

    default:
      // See the note in work-item.ts: ignored, not rejected.
      return { ...state, ...at };
  }
}

export function reduceRun(events: readonly Envelope[]): RunState {
  return events.reduce(applyRun, emptyRun);
}
