/**
 * One task, folded from its streams on demand.
 *
 * Nothing here is maintained in a table. A detail view is read rarely, by one
 * person, about one task — folding a few dozen events on the spot is
 * imperceptible, and it means what this shows can change without a migration or
 * a rebuild ([0012](../../../../doc/decisions/0012-one-task-view.md)).
 *
 * It reads two streams: the task's own, and the run's. They are separate
 * aggregates on purpose (design.md §4), and joining them is a reader's job
 * rather than a reducer's.
 */
import { eventStore } from "@escapement/store";
import { GATE_POINTS, type Envelope } from "@escapement/core";

export interface Finding {
  file: string;
  line: number | null;
  claim: string;
  failureScenario: string;
  severity: string;
}

export interface GateVerdict {
  gate: string;
  state: string;
  /**
   * False when the verdict was made against a commit that is no longer the
   * head. A force-push revokes nothing; it makes every verdict about a
   * different diff.
   */
  current: boolean;
  evidence: string | null;
  findings: Finding[];
}

/**
 * One of the five points, and what happened there.
 *
 * `skipped` is a first-class state and not an absence. ADR 0016 §4 rests on it:
 * a gate nobody configured does not run, and that is the user's decision — but
 * it has to be *shown*, because a point that is merely omitted is
 * indistinguishable from one that was configured and silently did not run. That
 * second case is Escapement's bug, and this is where it becomes visible.
 */
export interface PointView {
  point: string;
  /** Empty when nothing was configured. */
  planned: string[];
  verdicts: GateVerdict[];
  skipped: boolean;
}

export interface TaskDetail {
  taskId: string;
  runId: string | null;
  headSha: string | null;
  baseSha: string | null;
  gates: GateVerdict[];
  /** All five, in loop order, including the ones nothing was configured at. */
  points: PointView[];
  /** Everything, in order, for the question a summary did not anticipate. */
  history: { at: string; type: string; actor: string; summary: string }[];
}

const VERDICT: Record<string, string> = {
  GateRequested: "pending",
  GateStarted: "running",
  GatePassed: "passed",
  GateFailed: "failed",
  GateWaived: "waived",
  ApprovalRequested: "pending",
  ApprovalGranted: "passed",
  ApprovalRevoked: "pending",
};

/** A line of history. Deliberately terse — the raw payload is one click below. */
function summarise(event: Envelope): string {
  const d = (event.data ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "WorkItemClaimed":
      return `run ${String(d["runId"]).slice(4, 12)}`;
    case "WorkItemBlocked":
      return String(d["question"] ?? "");
    case "WorkItemLanded":
      return `merged as ${String(d["mergeCommit"]).slice(0, 7)}`;
    case "RunFinished":
      return `${String(d["turns"])} turns, $${Number(d["costUsd"] ?? 0).toFixed(2)}`;
    case "RunFailed":
      return `${String(d["kind"])}: ${String(d["detail"] ?? "")}`;
    case "RunProducedDiff":
      return `${String(d["files"])} files +${String(d["insertions"])} −${String(d["deletions"])}`;
    case "PreparationPassed":
      return `${String(d["step"])} in ${(Number(d["durationMs"] ?? 0) / 1000).toFixed(1)}s`;
    case "PreparationFailed":
      return `${String(d["step"])}: ${String(d["evidence"] ?? "").slice(0, 120)}`;
    default: {
      const gate = d["gate"];
      if (typeof gate === "string") return gate;
      return "";
    }
  }
}

export async function loadTask(taskId: string): Promise<TaskDetail | null> {
  const own = await eventStore.read(taskId);
  if (own.length === 0) return null;

  // The most recent run. A task can have several attempts; the detail view is
  // about the one that produced what is on screen.
  let runId: string | null = null;
  for (const e of own) {
    if (e.type === "WorkItemClaimed") runId = String((e.data as { runId: string }).runId);
  }

  const run = runId ? await eventStore.read(runId) : [];

  let headSha: string | null = null;
  let baseSha: string | null = null;
  const gates = new Map<string, GateVerdict>();

  for (const e of run) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === "RunStarted") baseSha = String(d["baseSha"] ?? "") || null;
    if (e.type === "RunProducedDiff" || e.type === "RunProposedCompletion") {
      headSha = String(d["headSha"] ?? "") || null;
    }
    const verdict = VERDICT[e.type];
    if (verdict && typeof d["gate"] === "string") {
      // `point:action` — see task-view. Two points may run an action of the
      // same name, and the card has to show both.
      const key = `${String(d["gate"])}:${String(d["action"] ?? "")}`;
      gates.set(key, {
        gate: key,
        state: verdict,
        current: true,
        evidence: (d["evidence"] as string) ?? null,
        findings: (d["findings"] as Finding[]) ?? [],
      });
    }
  }

  // Applied after the fold, because `headSha` is only final once every event
  // has been seen — a verdict recorded before a force-push is stale, and which
  // ones those are is not knowable while still reading.
  for (const g of gates.values()) {
    const onSha = run.find(
      (e) => (e.data as { gate?: string })?.gate === g.gate && (e.data as { onSha?: string })?.onSha,
    );
    const sha = (onSha?.data as { onSha?: string } | undefined)?.onSha ?? null;
    g.current = headSha === null || sha === null || sha === headSha;
  }

  const history = [...own, ...run]
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
    .map((e) => ({
      at: e.at.toISOString(),
      type: e.type,
      actor: e.actor,
      summary: summarise(e),
    }));

  // The plan the conductor wrote down when the run started. Without it the page
  // could only show points that reported, which is exactly the omission ADR
  // 0016 §4 forbids.
  const resolved = run.find((e) => e.type === "GatesResolved");
  const plan = (resolved?.data as { points?: { gate: string; actions: string[] }[] } | undefined)?.points;

  const all = [...gates.values()];
  const points: PointView[] = GATE_POINTS.map((point) => {
    const planned = plan?.find((p) => p.gate === point)?.actions ?? [];
    const verdicts = all.filter((g) => g.gate.startsWith(`${point}:`));
    return { point, planned, verdicts, skipped: planned.length === 0 && verdicts.length === 0 };
  });

  return { taskId, runId, headSha, baseSha, gates: all, points, history };
}
