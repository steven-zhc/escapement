/**
 * The event catalogue.
 *
 * This file is the one thing in the project worth over-building. Everything
 * else — the board, the scheduler, every projection — is derived from these
 * shapes and can be thrown away in an afternoon. A wrong event name or a
 * missing payload field costs a migration over real history.
 *
 * Two rules hold for every entry:
 *
 *   1. Past tense. An event is something that happened, never an intention.
 *   2. Self-contained. A reader a year from now must not need to join against
 *      GitHub, a log file, or a worktree that no longer exists.
 *
 * Bump `SCHEMA_VER` for a type and add an upcaster rather than changing a
 * payload in place.
 */
import { z } from "zod";

// ---------------------------------------------------------------- shared ----

export const WorkKind = z.enum(["bug", "feature", "enhancement", "tech-debt"]);
export type WorkKind = z.infer<typeof WorkKind>;

/** Which containment a project demands. See doc/decisions/0005. */
export const Tier = z.enum(["open", "guarded", "sandboxed"]);
export type Tier = z.infer<typeof Tier>;

export const RuntimeId = z.enum(["claude-code", "codex"]);
export type RuntimeId = z.infer<typeof RuntimeId>;

/**
 * Why an integration did not happen. Every one of these was a silent
 * `return 1` in the old loop's `integrate()` — no log line, no comment, no
 * label, and five re-runs of the same ticket before anyone noticed.
 */
export const RefusalReason = z.enum([
  "conflict",
  "dirty-base",
  "unpushed-base",
  "pending-migration",
  "gate-failed",
  "no-commits",
  "lane-busy",
]);
export type RefusalReason = z.infer<typeof RefusalReason>;

// ------------------------------------------------------------- work item ----

export const WorkItemDiscovered = z.object({
  project: z.string(),
  source: z.enum(["github-issue", "manual", "agent-followup"]),
  externalRef: z.string(),
  title: z.string(),
  kind: WorkKind,
  labels: z.array(z.string()),
});

export const WorkItemClaimed = z.object({
  runId: z.string(),
  worker: z.string(),
  /** Absence of a heartbeat past this is the expiry. Nothing to clean up. */
  leaseUntilMs: z.number().int(),
});

export const WorkItemReleased = z.object({ runId: z.string(), reason: z.string() });

export const WorkItemBlocked = z.object({
  /** The question, not just the fact. The old `agent:blocked` label carried no question. */
  question: z.string(),
  needsFrom: z.enum(["human", "schema", "external"]),
  runId: z.string().nullable(),
});

export const WorkItemUnblocked = z.object({ by: z.string(), note: z.string() });

/**
 * How "merged is not correct" becomes queryable. #134 and #136 were bugs filed
 * against code that #58 had already merged, and nothing connected them.
 */
export const WorkItemLinked = z.object({
  relation: z.enum(["caused-by", "follows-up", "duplicates"]),
  otherRef: z.string(),
});

export const WorkItemLanded = z.object({ mergeCommit: z.string(), base: z.string() });

/** Capability matching refused the dispatch. Never silently downgrade a tier. */
export const DispatchRefused = z.object({
  requiredTier: Tier,
  runtime: RuntimeId,
  missing: z.array(z.string()),
});

// ------------------------------------------------------------------- run ----

export const RunStarted = z.object({
  workItemId: z.string(),
  runtime: RuntimeId,
  model: z.string(),
  promptVersion: z.string(),
  baseSha: z.string(),
  /** Hash of the recipe as read from origin/<base>, never from the agent's branch. */
  configHash: z.string(),
  worktree: z.string(),
});

export const RunPrompted = z.object({ promptVersion: z.string(), bytes: z.number().int() });

export const RunTouchedFile = z.object({ path: z.string(), op: z.enum(["edit", "write", "delete"]) });

/**
 * 132 of these across 56 of 73 runs in the old loop, all invisible — they went
 * to stderr inside a log file nobody parsed. The command is redacted because
 * the thing that tripped the guard is frequently the thing worth not storing.
 */
export const GuardTripped = z.object({
  tool: z.string(),
  pattern: z.string(),
  redactedCommand: z.string(),
});

/** Compaction means the ticket was scoped too large. That is a metric, not noise. */
export const RunContextExhausted = z.object({ turn: z.number().int() });

export const RunAwaitingInput = z.object({ prompt: z.string() });

export const RunProducedDiff = z.object({
  branch: z.string(),
  headSha: z.string(),
  files: z.number().int(),
  insertions: z.number().int(),
  deletions: z.number().int(),
});

/** The moment the gate pipeline fires. */
export const RunProposedCompletion = z.object({ headSha: z.string() });

export const RunFinished = z.object({
  exitCode: z.number().int(),
  turns: z.number().int(),
  durationMs: z.number().int(),
  costUsd: z.number().nullable(),
});

export const RunFailed = z.object({
  kind: z.enum(["timeout", "crash", "no-commits", "guard-hard-stop"]),
  detail: z.string(),
});

// ------------------------------------------------------------------ gate ----

/**
 * Verification, code review and human approval are one primitive: a named
 * check that produces a verdict about a specific diff. `onSha` is what makes a
 * verdict about a diff rather than about a ticket — so a force-push invalidates
 * an approval instead of inheriting it, which a label could never do.
 */
const gateBase = { gate: z.string(), runId: z.string(), onSha: z.string() };

export const GateRequested = z.object(gateBase);
export const GateStarted = z.object(gateBase);
export const GatePassed = z.object({ ...gateBase, evidence: z.string() });
export const GateFailed = z.object({
  ...gateBase,
  evidence: z.string(),
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().nullable(),
      claim: z.string(),
      /** No failure scenario, no finding. An observation without one is an opinion. */
      failureScenario: z.string(),
      severity: z.enum(["blocker", "major", "minor"]),
    }),
  ),
});

/** Humans need an escape hatch. It is recorded, never silent. */
export const GateWaived = z.object({ ...gateBase, by: z.string(), reason: z.string() });

export const ApprovalRequested = z.object({ ...gateBase, question: z.string(), artifacts: z.array(z.string()) });
export const ApprovalGranted = z.object({ ...gateBase, by: z.string(), note: z.string() });
export const ApprovalRevoked = z.object({ ...gateBase, by: z.string(), reason: z.string() });

// ----------------------------------------------------------- integration ----

export const IntegrationAttempted = z.object({ workItemId: z.string(), branch: z.string(), headSha: z.string() });
export const IntegrationRefused = z.object({
  workItemId: z.string(),
  branch: z.string(),
  reason: RefusalReason,
  detail: z.string(),
});
export const IntegrationSucceeded = z.object({
  workItemId: z.string(),
  branch: z.string(),
  base: z.string(),
  mergeCommit: z.string(),
});

// --------------------------------------------------------------- project ----

/** Policy lives here, not in the managed repo. See doc/decisions/0005. */
export const ProjectPolicySet = z.object({
  project: z.string(),
  tier: Tier,
  requiredGates: z.array(z.string()),
  approvers: z.array(z.string()),
  concurrent: z.number().int().positive(),
  by: z.string(),
  reason: z.string(),
});

/** The recipe as resolved from origin/<base>, hashed so replays can be compared. */
export const ProjectConfigured = z.object({
  project: z.string(),
  configHash: z.string(),
  fromSha: z.string(),
});

/** What a restarted conductor found that the log did not predict. */
export const Reconciled = z.object({
  findings: z.array(z.object({ stream: z.string(), expected: z.string(), actual: z.string() })),
});

// -------------------------------------------------------------- registry ----

export const EVENTS = {
  WorkItemDiscovered,
  WorkItemClaimed,
  WorkItemReleased,
  WorkItemBlocked,
  WorkItemUnblocked,
  WorkItemLinked,
  WorkItemLanded,
  DispatchRefused,
  RunStarted,
  RunPrompted,
  RunTouchedFile,
  GuardTripped,
  RunContextExhausted,
  RunAwaitingInput,
  RunProducedDiff,
  RunProposedCompletion,
  RunFinished,
  RunFailed,
  GateRequested,
  GateStarted,
  GatePassed,
  GateFailed,
  GateWaived,
  ApprovalRequested,
  ApprovalGranted,
  ApprovalRevoked,
  IntegrationAttempted,
  IntegrationRefused,
  IntegrationSucceeded,
  ProjectPolicySet,
  ProjectConfigured,
  Reconciled,
} as const;

export type EventType = keyof typeof EVENTS;
export type PayloadOf<T extends EventType> = z.infer<(typeof EVENTS)[T]>;

/** Current payload shape per type. Bump one and add an upcaster; never edit in place. */
export const SCHEMA_VER: Record<EventType, number> = Object.fromEntries(
  (Object.keys(EVENTS) as EventType[]).map((k) => [k, 1]),
) as Record<EventType, number>;

export function isEventType(t: string): t is EventType {
  return Object.hasOwn(EVENTS, t);
}

/** Parse a stored payload, or throw. The store never hands out unvalidated data. */
export function parsePayload<T extends EventType>(type: T, data: unknown): PayloadOf<T> {
  return EVENTS[type].parse(data) as PayloadOf<T>;
}
