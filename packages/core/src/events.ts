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

// --------------------------------------------------------------- prepare ----

/**
 * Getting the worktree into a state the agent can work in — installing
 * dependencies, mostly — before the agent starts.
 *
 * These exist as their own events rather than as a `RunFailed` kind because the
 * run genuinely did not fail: it never began. Recording it as a failed run would
 * put "the agent broke it" on a board where no agent ever ran, which is the
 * exact category of lie this system was built to stop telling.
 *
 * `git worktree add` copies no `node_modules`. Without this stage the agent is
 * handed a checkout where it cannot run the repository's own tests, cannot
 * reproduce a failure and cannot check its own work — and the first thing that
 * says so is a gate failing at the end, after the money is spent.
 *
 * The command is recorded in full, unlike `GuardTripped`'s. That one is redacted
 * because an agent composed it; this one was written by a person and committed
 * to the repository under a hash that is already in the log.
 */
export const PreparationStarted = z.object({
  /**
   * Carried here as well as on `RunStarted`, because this is the first event on
   * a run's stream and the board resolves a card through the run. Without it a
   * ten-minute install would leave the card sitting in `queued`, and a run that
   * refused at prepare would never appear at all.
   */
  workItemId: z.string(),
  step: z.string(),
  run: z.string(),
});

export const PreparationPassed = z.object({
  step: z.string(),
  durationMs: z.number().int(),
});

export const PreparationFailed = z.object({
  step: z.string(),
  /** The log tail. A refusal with no output is a link to somewhere else. */
  evidence: z.string(),
  /** A step that ran out of time and one that ran and refused are different
   *  problems with different fixes. */
  timedOut: z.boolean(),
  durationMs: z.number().int(),
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

/**
 * The recipe as resolved from origin/<base>, hashed so replays can be compared.
 *
 * Two fields were added after the fact, and both for the same reason: what was
 * recorded turned out not to be enough to find the recipe again.
 *
 * `owner` is **schemaVer 2**. Version 1 recorded only the repository name, so
 * `esc status` could not reach GitHub for a project it had itself registered.
 *
 * `base` is **schemaVer 3**. Without it a run had to fall back to the
 * repository's *default* branch to find the recipe — which is only the same
 * branch by convention. `nextloom-ai-admin`'s default was a feature branch, so a
 * run would have read its rules from one branch and merged into another. The
 * base a project is governed from is a decision made once, at onboarding, and it
 * belongs in the log rather than in whatever GitHub happens to point HEAD at.
 *
 * Both are nullable because events written before the field existed genuinely
 * did not record it, and inventing a value for them would be worse than saying
 * so.
 */
export const ProjectConfigured = z.object({
  project: z.string(),
  owner: z.string().nullable(),
  base: z.string().nullable(),
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
  PreparationStarted,
  PreparationPassed,
  PreparationFailed,
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

/**
 * Current payload shape per type. Everything starts at 1; a type that has moved
 * on is listed here, and the same commit adds its upcaster in `upcast.ts`.
 */
const BUMPED: Partial<Record<EventType, number>> = {
  // 2: added `owner`. 3: added `base`. See ProjectConfigured above.
  ProjectConfigured: 3,
};

export const SCHEMA_VER: Record<EventType, number> = Object.fromEntries(
  (Object.keys(EVENTS) as EventType[]).map((k) => [k, BUMPED[k] ?? 1]),
) as Record<EventType, number>;

export function isEventType(t: string): t is EventType {
  return Object.hasOwn(EVENTS, t);
}

/** Parse a stored payload, or throw. The store never hands out unvalidated data. */
export function parsePayload<T extends EventType>(type: T, data: unknown): PayloadOf<T> {
  return EVENTS[type].parse(data) as PayloadOf<T>;
}
