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
import type { Envelope } from "@escapement/core";

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

export interface GuardTrip {
  tool: string;
  pattern: string;
  /** Already redacted where it was recorded. Never re-derived here. */
  command: string;
  at: string;
}

export interface TaskDetail {
  taskId: string;
  runId: string | null;
  headSha: string | null;
  baseSha: string | null;
  gates: GateVerdict[];
  guardTrips: GuardTrip[];
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
    case "GuardTripped":
      return `${String(d["tool"])} matched ${String(d["pattern"])}`;
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
  const guardTrips: GuardTrip[] = [];

  for (const e of run) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.type === "RunStarted") baseSha = String(d["baseSha"] ?? "") || null;
    if (e.type === "RunProducedDiff" || e.type === "RunProposedCompletion") {
      headSha = String(d["headSha"] ?? "") || null;
    }
    if (e.type === "GuardTripped") {
      guardTrips.push({
        tool: String(d["tool"] ?? ""),
        pattern: String(d["pattern"] ?? ""),
        command: String(d["redactedCommand"] ?? ""),
        at: e.at.toISOString(),
      });
    }
    const verdict = VERDICT[e.type];
    if (verdict && typeof d["gate"] === "string") {
      gates.set(d["gate"], {
        gate: d["gate"],
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

  return { taskId, runId, headSha, baseSha, gates: [...gates.values()], guardTrips, history };
}
