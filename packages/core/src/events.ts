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

/**
 * The five points in the loop where the conductor waits for a verdict.
 *
 * **Closed forever** ([ADR 0016](../../../doc/decisions/0016-the-settled-model.md)
 * §3). Four of them name a branch the loop already had — dispatch, preparation,
 * the gate pipeline, the merge hold — and `end` was added for the things that
 * must happen once an item is finished, which had nowhere to be declared before.
 *
 * A gate is a *place*, not a kind of check. What runs there is open and comes
 * from the recipe; where it can run is not. That is what lets extension be
 * unbounded while the core stays finite.
 *
 * `end` is the one that cannot refuse — nothing can be stopped once a merge has
 * landed. Recorded as an imprecision rather than smoothed over: a separate
 * concept for it would cost more than the imprecision does.
 */
export const GatePoint = z.enum(["admit", "prepared", "diff", "merge", "end"]);
export type GatePoint = z.infer<typeof GatePoint>;

/**
 * The five, in the order the loop reaches them.
 *
 * Exported as a tuple because "every point, in order" is a thing several places
 * need to iterate — `GatesResolved`, the board, `esc add` — and each writing its
 * own list is how one of them ends up missing a point and nobody notices.
 */
export const GATE_POINTS = GatePoint.options;

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
  /**
   * What the task is, recorded at the moment Escapement takes responsibility
   * for it.
   *
   * Here because the queue left the log (0012). `WorkItemDiscovered` used to be
   * where a title entered, and without it a rebuilt projection had no row at
   * all for anything claimed — every running and landed task simply vanished,
   * since GitHub's *open* issue list cannot supply a title for work that has
   * already merged.
   *
   * Null for a v1 event, and for a claim made without the queue entry to hand.
   * The projection falls back to the issue number, which is honest about not
   * knowing rather than inventing something.
   */
  title: z.string().nullable(),
  kind: z.string().nullable(),
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
 * The command is recorded in full. It was written by a person and committed to
 * the repository under a hash that is already in the log — unlike anything an
 * agent composes, which is why this needs no redaction.
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
  kind: z.enum(["timeout", "crash", "no-commits", "aborted"]),
  detail: z.string(),
});

// ------------------------------------------------------------------ gate ----

/**
 * Verification, code review and human approval are one primitive: a named
 * check that produces a verdict about a specific diff. `onSha` is what makes a
 * verdict about a diff rather than about a ticket — so a force-push invalidates
 * an approval instead of inheriting it, which a label could never do.
 */
/**
 * `gate` is the point; `action` is what ran there.
 *
 * Two fields rather than one because "the build failed" and "something at the
 * diff point failed" are different questions, and a single name could not answer
 * both. `onSha` binds the verdict to a commit, which is what makes a force-push
 * invalidate it by arithmetic rather than by anybody noticing.
 */
const gateBase = { gate: GatePoint, action: z.string(), runId: z.string(), onSha: z.string() };

/**
 * The plan for a run: all five points, and what will run at each.
 *
 * One event, appended before anything is claimed. It exists because the log
 * could not otherwise say what was *supposed* to happen — `ProjectConfigured`
 * carries a `configHash`, not the configuration, so a point with nothing
 * configured was indistinguishable from a point that did not exist.
 *
 * That distinction is what the whole model rests on ([ADR 0016](../../../doc/decisions/0016-the-settled-model.md)
 * §4). A gate nobody configured is skipped, and that is the user's decision; a
 * gate that *was* configured and did not run is Escapement's bug. Comparing this
 * to the verdicts that follow is how the second is detectable, and rendering it
 * is how the board shows an empty point as `skipped` rather than omitting it.
 */
export const GatesResolved = z.object({
  runId: z.string(),
  configHash: z.string(),
  /** Every point, in order, with the ordered action names resolved for it. */
  points: z.array(z.object({ gate: GatePoint, actions: z.array(z.string()) })).length(5),
});

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

// --------------------------------------------------------------- control ----

/**
 * What an operator told the conductor to do.
 *
 * In the log because it is a decision somebody made, and `ApprovalGranted` is
 * already exactly that shape — "who stopped the conductor at four o'clock"
 * should not need a different mechanism than "who approved this merge"
 * ([0013](../../../doc/decisions/0013-daemon-hosts-the-work.md)).
 *
 * It also means a command issued while the daemon is restarting is *waiting*
 * when it comes back, rather than being a race somebody has to handle.
 *
 * Liveness deliberately does **not** go here. A heartbeat every few seconds
 * fails the log's admission test — is this worth remembering later — and would
 * bury everything that is.
 */
export const ConductorPaused = z.object({
  by: z.string(),
  reason: z.string(),
});

export const ConductorResumed = z.object({ by: z.string() });

/**
 * Run this one now, ahead of the queue.
 *
 * The same mechanism rather than a second channel: a person asking for a
 * specific ticket is a decision, and it belongs beside the pause that came
 * before it.
 */
/**
 * GitHub said something about the queue changed.
 *
 * The queue is not in the log (0012), so a webhook cannot append the change
 * itself — what it can do is say that one happened, which is enough to wake the
 * daemon into asking GitHub. That keeps one mechanism instead of two: the loop
 * already wakes on appends, and this is an append.
 *
 * `delivery` is GitHub's own id for the delivery. It makes a retry — which
 * GitHub does, several times, on any non-2xx — cheap to recognise and drop.
 */
/**
 * A side effect that was actually carried out.
 *
 * The outbox is a *projection*, which is what makes "a crash between the event
 * and the delivery loses nothing" true: the pending row is derived from the
 * log, so it comes back on replay. But that only works if delivery is also in
 * the log — otherwise rebuilding the projection would forget what had already
 * been sent and post every comment again.
 *
 * So this is the half that makes the other half safe, and it is a fact worth
 * keeping on its own: *we commented on #155 at 14:02, and here is the id*.
 */
export const OutboxDelivered = z.object({
  /** `<seq>:<kind>` — stable across replay, because seq is. */
  ref: z.string(),
  kind: z.string(),
  target: z.string(),
  /** Whatever identifies the thing that was created, when there is one. */
  detail: z.string(),
});

/**
 * An attempt that did not work.
 *
 * Every failed attempt, not just the last: the count is what the backoff reads,
 * and keeping it in the log is what stops a restart from resetting the delay
 * and hammering an endpoint that is already unhappy.
 *
 * `permanent` is the difference between "try again later" and "this will never
 * work" — a 404 on an issue somebody deleted is not a retry candidate, and
 * retrying it forever is how a queue silently stops meaning anything.
 */
export const OutboxFailed = z.object({
  ref: z.string(),
  kind: z.string(),
  target: z.string(),
  error: z.string(),
  permanent: z.boolean(),
});

export const QueueChanged = z.object({
  project: z.string(),
  /** `issues.opened`, `issues.labeled`, and so on. */
  reason: z.string(),
  delivery: z.string(),
});

export const RunRequested = z.object({
  project: z.string(),
  issue: z.string(),
  by: z.string(),
});


// --------------------------------------------------------------- project ----


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

/**
 * What a restarted daemon found that the log did not predict, and what it did.
 *
 * **Recorded, not quietly repaired.** A system that silently tidies up after
 * itself cannot tell you it has been crashing: the disk gets cleaner, the
 * symptom disappears, and you find out six weeks later. The old harness's
 * integrate step had six silent `return 1` paths and this is the same failure
 * wearing a different hat.
 *
 * A batch rather than one event per finding, because "what did the restart at
 * 04:12 find" is the question people actually ask — a startup that found
 * nothing appends nothing at all.
 */
export const Reconciled = z.object({
  findings: z.array(
    z.object({
      stream: z.string(),
      expected: z.string(),
      actual: z.string(),
      /**
       * What was done about it: `removed`, or `reported` when nothing was.
       *
       * Added in v2. Without it the event says a divergence existed and leaves
       * you to guess whether it still does, which is most of what you wanted
       * to know.
       */
      action: z.string(),
    }),
  ),
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
  RunContextExhausted,
  RunAwaitingInput,
  RunProducedDiff,
  RunProposedCompletion,
  RunFinished,
  RunFailed,
  GatesResolved,
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
  ConductorPaused,
  ConductorResumed,
  OutboxDelivered,
  OutboxFailed,
  QueueChanged,
  RunRequested,
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
  // 2: added `title` and `kind`, because the queue left the log. See above.
  WorkItemClaimed: 2,
  // 2: each finding gained `action`. See Reconciled above.
  Reconciled: 2,
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
