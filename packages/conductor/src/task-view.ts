/**
 * `task_view` — the one projection.
 *
 * It replaces `board`, `queue` and `guard_trips`. One row per task Escapement
 * has touched, holding the latest state and the metadata a card shows, and
 * nothing else: the board's list view is a `select` against this table and no
 * second query ([0012](../../../doc/decisions/0012-one-task-view.md)).
 *
 * ## What is deliberately not here
 *
 * **Gate evidence, review findings, guard trips themselves, the diff.** All of
 * it is read from the event stream when somebody opens one task. A list view
 * and a detail view have opposite economics — the list is read constantly and
 * needs to be cheap, the detail is read rarely by one person about one task,
 * and folding a few dozen events on the spot is imperceptible. Building a table
 * for the second is paying continuously for an occasional read.
 *
 * The old `board` projection carried all of it, and the card grew heavy for
 * exactly that reason: what is available gets rendered. Moving detail behind a
 * task id makes a card's contents a decision instead of a consequence.
 *
 * ## Two rules that keep a rebuild honest
 *
 * **Every timestamp comes from `event.at`, never from `now()`.** A projection
 * whose rows depend on the clock cannot be rebuilt to the same table twice,
 * which would cost the property that lets a projection's shape change freely at
 * all. That property is load-bearing here, because this table's shape is
 * expected to move.
 *
 * **Retention is the reader's job.** `closed_at` is recorded and every row is
 * kept; `readTasks` filters. The two-day window is a `where` clause, so it is
 * configurable without a rebuild and a rebuild does not depend on when it ran.
 *
 * ## Counting
 *
 * Increments are guarded by `updated_seq <` rather than `<=`, so a replay lands
 * on the same numbers. Gate verdicts are a keyed map rather than a list, for
 * the same reason: assignment is idempotent and appending is not. Only the
 * verdict is kept — the evidence that came with it is detail.
 */
import type { PayloadOf } from "@escapement/core";
import { databaseUrl } from "@escapement/env";
import type { Projection, ProjectionContext } from "@escapement/store";
import pg from "pg";

/**
 * Where a task is. `queued` is the only one that can be true without
 * Escapement having appended anything — see `syncQueued`.
 */
export type TaskState = "queued" | "running" | "gates" | "waiting" | "landed";

export const TASK_VIEW_TABLE = "task_view";

/** How long a landed task stays on the board. A query, not a rebuild. */
export const DEFAULT_RETENTION_DAYS = 2;

export const taskViewProjection: Projection = {
  name: "task_view",

  async create(ctx) {
    await ctx.query(`
      create table if not exists task_view (
        task_id      text primary key,
        project      text not null,
        issue        text not null,
        -- Null means not known yet. The reader renders the fallback, so a
        -- claim that carries no title cannot overwrite one that GitHub gave.
        title        text,
        kind         text,
        state        text not null,
        tier         text not null default 'guarded',

        run_id       text,
        turns        int,
        cost_usd     double precision,
        guard_trips  int not null default 0,

        base_sha     text,
        head_sha     text,
        files        int,
        insertions   int,
        deletions    int,

        -- { "build": "passed", "review": "failed" }. A map, so replaying is
        -- assignment rather than appending. Evidence is not here on purpose.
        gates        jsonb not null default '{}'::jsonb,

        -- One line for the card: what it is waiting on, or why it stopped.
        note         text,

        -- Retention and ordering. From the event's own clock, never now().
        updated_at   timestamptz not null,
        closed_at    timestamptz,

        -- The backoff #43 needs. In the table rather than in memory, because an
        -- in-memory set forgets on restart and the loop it prevents costs money:
        -- the old harness re-ran two tickets five times for roughly $29.
        attempts        int not null default 0,
        last_attempt_at timestamptz,

        updated_seq  bigint not null
      )`);
    await ctx.query("create index if not exists task_view_state_idx on task_view (project, state)");
    await ctx.query("create index if not exists task_view_closed_idx on task_view (closed_at)");

    // Which run belongs to which task. Run events arrive on their own stream and
    // name the task only at PreparationStarted or RunStarted.
    await ctx.query(`
      create table if not exists task_view_run (
        run_id  text primary key,
        task_id text not null
      )`);

    // Tier is policy and lives on the project's stream. Kept beside the tasks so
    // a card can show it without a second source.
    await ctx.query(`
      create table if not exists task_view_project (
        project text primary key,
        tier    text not null
      )`);
  },

  async reset(ctx) {
    // Dropped, not truncated. This table's shape is expected to change, and
    // `create table if not exists` would silently keep the old columns.
    await ctx.query("drop table if exists task_view");
    await ctx.query("drop table if exists task_view_run");
    await ctx.query("drop table if exists task_view_project");
  },

  async apply(events, ctx) {
    for (const event of events) {
      const seq = event.seq.toString();
      const at = event.at;

      switch (event.type) {
        case "ProjectPolicySet": {
          const d = event.data as PayloadOf<"ProjectPolicySet">;
          await ctx.query(
            `insert into task_view_project (project, tier) values ($1, $2)
             on conflict (project) do update set tier = excluded.tier`,
            [d.project, d.tier],
          );
          break;
        }

        // ---- the task's own stream ----

        /**
         * Still handled, though nothing appends it any more (#41): the queue is
         * read from GitHub now. Logs written before that change still contain
         * these, and a projection that cannot replay its own history is not a
         * projection.
         */
        case "WorkItemDiscovered": {
          const d = event.data as PayloadOf<"WorkItemDiscovered">;
          await upsert(ctx, event.streamId, seq, at, {
            project: d.project,
            issue: d.externalRef,
            title: d.title,
            kind: d.kind,
            state: "queued",
          });
          break;
        }

        case "WorkItemClaimed": {
          const d = event.data as PayloadOf<"WorkItemClaimed">;
          await linkRun(ctx, d.runId, event.streamId);
          // The claim creates the row, not just updates it. With the queue out
          // of the log there is no earlier event to have made one, so an UPDATE
          // here would leave every running and landed task with no row after a
          // rebuild — they would vanish from the board, and GitHub could not
          // supply them because it only lists what is still open.
          const { project, issue } = splitTaskId(event.streamId);
          // One statement, counting the attempt as it goes. Two statements
          // cannot work here: whichever runs first writes `updated_seq = seq`,
          // and the second is guarded on `updated_seq` being lower, so the
          // counter silently never moves. That is exactly the shape of bug
          // that leaves a backoff looking implemented and doing nothing.
          await upsert(ctx, event.streamId, seq, at, {
            project,
            issue,
            title: d.title,
            kind: d.kind,
            state: "running",
            runId: d.runId,
            attempt: true,
          });
          break;
        }

        case "WorkItemReleased":
          await set(ctx, event.streamId, seq, at, { state: "queued", run_id: null });
          break;

        case "WorkItemBlocked": {
          const d = event.data as PayloadOf<"WorkItemBlocked">;
          await set(ctx, event.streamId, seq, at, { state: "waiting", note: d.question });
          break;
        }

        case "WorkItemUnblocked":
          await set(ctx, event.streamId, seq, at, { state: "queued", note: null });
          break;

        case "WorkItemLanded": {
          const d = event.data as PayloadOf<"WorkItemLanded">;
          await set(ctx, event.streamId, seq, at, {
            state: "landed",
            note: d.mergeCommit,
            closed_at: at,
          });
          break;
        }

        case "DispatchRefused": {
          const d = event.data as PayloadOf<"DispatchRefused">;
          // An upsert, because this can be a task's first event: it refuses
          // before anything is claimed, and nothing is appended when an issue
          // is merely seen. An UPDATE would leave the refusal unreadable, which
          // is the failure it exists to report.
          const { project: p, issue: i } = splitTaskId(event.streamId);
          await upsert(ctx, event.streamId, seq, at, {
            project: p,
            issue: i,
            title: null,
            kind: null,
            state: "waiting",
          });
          await set(ctx, event.streamId, seq, at, {
            note: `needs ${d.requiredTier}; ${d.runtime} is missing ${d.missing.join(", ")}`,
          });
          break;
        }

        // ---- the run's stream ----

        /**
         * The card moves to `running` here rather than at `RunStarted`: a
         * ten-minute install is work in flight, and a card sitting in `queued`
         * through it says nothing is happening while something is.
         */
        case "PreparationStarted": {
          const d = event.data as PayloadOf<"PreparationStarted">;
          await linkRun(ctx, event.streamId, d.workItemId);
          await viaRun(ctx, event.streamId, seq, at, {
            state: "running",
            run_id: event.streamId,
          });
          break;
        }

        case "PreparationFailed": {
          const d = event.data as PayloadOf<"PreparationFailed">;
          await viaRun(ctx, event.streamId, seq, at, {
            state: "waiting",
            // Not "the run failed": no agent ever ran. The worktree could not be
            // made workable, which is a different problem with a different fix.
            note: `${d.timedOut ? "prepare timed out" : "prepare failed"} at ${d.step}`,
          });
          break;
        }

        case "RunStarted": {
          const d = event.data as PayloadOf<"RunStarted">;
          await linkRun(ctx, event.streamId, d.workItemId);
          await viaRun(ctx, event.streamId, seq, at, {
            state: "running",
            run_id: event.streamId,
            base_sha: d.baseSha,
          });
          break;
        }

        case "GuardTripped":
          await bump(ctx, event.streamId, seq, at);
          break;

        case "RunAwaitingInput": {
          const d = event.data as PayloadOf<"RunAwaitingInput">;
          await viaRun(ctx, event.streamId, seq, at, { state: "waiting", note: d.prompt });
          break;
        }

        case "RunProducedDiff": {
          const d = event.data as PayloadOf<"RunProducedDiff">;
          await viaRun(ctx, event.streamId, seq, at, {
            head_sha: d.headSha,
            files: d.files,
            insertions: d.insertions,
            deletions: d.deletions,
          });
          break;
        }

        case "RunProposedCompletion": {
          const d = event.data as PayloadOf<"RunProposedCompletion">;
          await viaRun(ctx, event.streamId, seq, at, { state: "gates", head_sha: d.headSha });
          break;
        }

        case "RunFinished": {
          const d = event.data as PayloadOf<"RunFinished">;
          await viaRun(ctx, event.streamId, seq, at, { turns: d.turns, cost_usd: d.costUsd });
          break;
        }

        case "RunFailed": {
          const d = event.data as PayloadOf<"RunFailed">;
          await viaRun(ctx, event.streamId, seq, at, {
            state: "waiting",
            note: `${d.kind}: ${d.detail}`,
          });
          break;
        }

        case "GatePassed":
        case "GateFailed":
        case "GateWaived":
        case "ApprovalRequested":
        case "ApprovalGranted":
        case "ApprovalRevoked": {
          const d = event.data as { gate: string; question?: string };
          const verdict = VERDICT[event.type];
          if (verdict) await setGate(ctx, event.streamId, seq, at, d.gate, verdict);
          if (event.type === "ApprovalRequested") {
            await viaRun(ctx, event.streamId, seq, at, {
              state: "waiting",
              note: (event.data as PayloadOf<"ApprovalRequested">).question,
            });
          }
          break;
        }

        // ---- the integration lane ----

        case "IntegrationRefused": {
          const d = event.data as PayloadOf<"IntegrationRefused">;
          await set(ctx, d.workItemId, seq, at, {
            state: "waiting",
            note: `${d.reason}: ${d.detail}`,
          });
          break;
        }

        case "IntegrationSucceeded": {
          const d = event.data as PayloadOf<"IntegrationSucceeded">;
          await set(ctx, d.workItemId, seq, at, {
            state: "landed",
            note: d.mergeCommit,
            closed_at: at,
          });
          break;
        }

        default:
          break;
      }
    }
  },
};

const VERDICT: Record<string, string> = {
  GatePassed: "passed",
  GateFailed: "failed",
  GateWaived: "waived",
  ApprovalRequested: "pending",
  ApprovalGranted: "passed",
  ApprovalRevoked: "pending",
};

// ----------------------------------------------------------------- write ----

/**
 * `wi-nextloom-ai-admin-155` → project `nextloom-ai-admin`, issue `155`.
 *
 * Safe to parse because the same code writes it (`wi-${project}-${ref}`), and
 * splitting at the *last* hyphen is what makes a project name containing
 * hyphens survive — which every one of them does.
 */
function splitTaskId(taskId: string): { project: string; issue: string } {
  const body = taskId.startsWith("wi-") ? taskId.slice(3) : taskId;
  const cut = body.lastIndexOf("-");
  if (cut < 0) return { project: body, issue: "" };
  return { project: body.slice(0, cut), issue: body.slice(cut + 1) };
}

async function linkRun(ctx: ProjectionContext, runId: string, taskId: string): Promise<void> {
  await ctx.query(
    `insert into task_view_run (run_id, task_id) values ($1, $2)
     on conflict (run_id) do update set task_id = excluded.task_id`,
    [runId, taskId],
  );
}

/**
 * Creates the row if it is not there, updates it if it is.
 *
 * Needed because a task can now first be seen either from GitHub (`syncQueued`)
 * or from its own claim — the queue is not in the log any more, so there is no
 * single event that always comes first.
 */
async function upsert(
  ctx: ProjectionContext,
  taskId: string,
  seq: string,
  at: Date,
  values: {
    project: string;
    issue: string;
    /** Null when the caller does not know it. Never overwrites one that is known. */
    title: string | null;
    kind: string | null;
    state: TaskState;
    runId?: string;
    /** True when this event is a fresh attempt, so the backoff can count it. */
    attempt?: boolean;
  },
): Promise<void> {
  const n = values.attempt ? 1 : 0;
  await ctx.query(
    // `coalesce` in both directions: a claim that carries no title must not
    // replace a real one with `#155`, and a row created by a claim must still
    // say something. Whoever knows the title wins, in either order of arrival.
    `insert into task_view
       (task_id, project, issue, title, kind, state, run_id, attempts, last_attempt_at,
        updated_at, updated_seq)
     values ($1, $2, $3, $4, $5, $6, $9, $10, case when $10::int > 0 then $7::timestamptz end, $7, $8::bigint)
     on conflict (task_id) do update
       set title = coalesce(excluded.title, task_view.title),
           kind = coalesce(excluded.kind, task_view.kind),
           state = excluded.state,
           run_id = coalesce(excluded.run_id, task_view.run_id),
           attempts = task_view.attempts + $10::int,
           last_attempt_at = case when $10::int > 0 then excluded.updated_at else task_view.last_attempt_at end,
           note = case when $10::int > 0 then null else task_view.note end,
           updated_at = excluded.updated_at,
           updated_seq = excluded.updated_seq
     where task_view.updated_seq < excluded.updated_seq`,
    [taskId, values.project, values.issue, values.title, values.kind, values.state, at, seq,
     values.runId ?? null, n],
  );
}

/**
 * Updates a row by task id.
 *
 * `updated_seq` guards a replay: events arrive in seq order, so a write carrying
 * an earlier seq is a bug rather than something to apply.
 */
async function set(
  ctx: ProjectionContext,
  taskId: string,
  seq: string,
  at: Date,
  values: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(values);
  const sets = entries.map(([k], i) => `${k} = $${i + 4}`).join(", ");
  await ctx.query(
    `update task_view set ${sets}, updated_at = $3, updated_seq = $2::bigint
     where task_id = $1 and updated_seq <= $2::bigint`,
    [taskId, seq, at, ...entries.map(([, v]) => v)],
  );
}

/** The same, for an event that arrived on a run's stream. */
async function viaRun(
  ctx: ProjectionContext,
  runId: string,
  seq: string,
  at: Date,
  values: Record<string, unknown>,
): Promise<void> {
  const rows = await ctx.query<{ task_id: string }>(
    "select task_id from task_view_run where run_id = $1",
    [runId],
  );
  const taskId = rows[0]?.task_id;
  // A run whose start was never seen has no row to update. That is a gap in the
  // log, not a reason to invent a task.
  if (taskId) await set(ctx, taskId, seq, at, values);
}

/** Strictly `<`, so a replay lands on the same number rather than double-counting. */
async function bump(ctx: ProjectionContext, runId: string, seq: string, at: Date): Promise<void> {
  const rows = await ctx.query<{ task_id: string }>(
    "select task_id from task_view_run where run_id = $1",
    [runId],
  );
  const taskId = rows[0]?.task_id;
  if (!taskId) return;
  await ctx.query(
    `update task_view set guard_trips = guard_trips + 1, updated_at = $3, updated_seq = $2::bigint
     where task_id = $1 and updated_seq < $2::bigint`,
    [taskId, seq, at],
  );
}

/** Assignment into a keyed map, so replaying is idempotent without a guard. */
async function setGate(
  ctx: ProjectionContext,
  runId: string,
  seq: string,
  at: Date,
  gate: string,
  verdict: string,
): Promise<void> {
  const rows = await ctx.query<{ task_id: string }>(
    "select task_id from task_view_run where run_id = $1",
    [runId],
  );
  const taskId = rows[0]?.task_id;
  if (!taskId) return;
  await ctx.query(
    `update task_view
     set gates = gates || jsonb_build_object($3::text, $4::text),
         updated_at = $5,
         updated_seq = greatest(updated_seq, $2::bigint)
     where task_id = $1`,
    [taskId, seq, gate, verdict, at],
  );
}

/**
 * Writes the runnable set GitHub reported.
 *
 * The queue is not in the log any more ([0012](../../../doc/decisions/0012-one-task-view.md)),
 * so something has to put queued rows here — and it is the conductor, not the
 * board. A board that asked GitHub per render would hit the rate limit with a
 * few tabs open and an event stream refreshing them.
 *
 * Rows already past `queued` are left alone: GitHub still lists an issue that
 * Escapement has claimed, and the log is the authority on what happened to it.
 * Queued rows that GitHub no longer lists are dropped, because they were never
 * Escapement's state to keep.
 */
export async function syncQueued(
  project: string,
  issues: readonly { ref: string; title: string; kind: string }[],
  at: Date = new Date(),
  url = databaseUrl(),
): Promise<{ added: number; removed: number }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const refs = issues.map((i) => i.ref);
    for (const issue of issues) {
      await client.query(
        `insert into task_view (task_id, project, issue, title, kind, state, updated_at, updated_seq)
         values ($1, $2, $3, $4, $5, 'queued', $6, 0)
         on conflict (task_id) do update
           set title = excluded.title, kind = excluded.kind`,
        [`wi-${project}-${issue.ref}`, project, issue.ref, issue.title, issue.kind, at],
      );
    }
    const gone = await client.query(
      `delete from task_view
       where project = $1 and state = 'queued' and not (issue = any($2::text[]))
       returning task_id`,
      [project, refs],
    );
    return { added: issues.length, removed: gone.rowCount ?? 0 };
  } finally {
    await client.end();
  }
}

// ------------------------------------------------------------------ read ----

export interface TaskCard {
  taskId: string;
  project: string;
  issue: string;
  title: string;
  kind: string;
  state: TaskState;
  tier: string;
  runId: string | null;
  turns: number | null;
  costUsd: number | null;
  guardTrips: number;
  gatesPassed: number;
  gatesFailed: number;
  baseSha: string | null;
  headSha: string | null;
  files: number | null;
  insertions: number | null;
  deletions: number | null;
  note: string | null;
  updatedAt: Date;
  closedAt: Date | null;
  attempts: number;
  lastAttemptAt: Date | null;
}

/** Long enough that a failing ticket stops costing money; short enough to retry today. */
export const DEFAULT_BACKOFF_MS = 60 * 60_000;

export interface RunnableOptions {
  project: string;
  /** The recipe's priority order. Priority is asked, not stored. */
  kinds: readonly string[];
  /**
   * Skip anything attempted inside this window.
   *
   * The whole of the loop guard. A failed run releases its task, a release is a
   * completion event, and a completion event is what tells the conductor to
   * pick up the next one — so without this the top of the queue is the ticket
   * that just failed, forever, at agent prices. The old harness re-ran #58 and
   * #59 five times for roughly $29 exactly this way.
   *
   * In the table rather than in memory on purpose: an in-memory set forgets on
   * restart, and a daemon that crashes on a bad ticket would come back and
   * spend the money again.
   */
  backoffMs?: number;
  /** Injectable so a test does not have to wait an hour. */
  now?: Date;
  url?: string;
}

/**
 * What the conductor may pick up next, best first.
 *
 * Reads `task_view` rather than a queue projection of its own: what is queued
 * is what GitHub last reported minus what the log says is claimed, and both of
 * those already land in this table.
 */
export async function readRunnable(options: RunnableOptions): Promise<TaskCard[]> {
  const kinds = options.kinds.length > 0 ? [...options.kinds] : ["bug"];
  const tasks = await readTasks({
    project: options.project,
    // Retention is about landed work; a queued task is never filtered by it.
    retentionDays: 36_500,
    ...(options.url === undefined ? {} : { url: options.url }),
  });

  const now = (options.now ?? new Date()).getTime();
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  return tasks
    .filter((t) => t.state === "queued")
    .filter((t) => kinds.includes(t.kind))
    .filter((t) => t.lastAttemptAt === null || now - t.lastAttemptAt.getTime() >= backoff)
    .sort((a, b) => {
      const byKind = kinds.indexOf(a.kind) - kinds.indexOf(b.kind);
      if (byKind !== 0) return byKind;
      // Numerically, not lexically: #402 comes before #409 and both before #4100.
      return Number(a.issue) - Number(b.issue);
    });
}

export interface ReadTasksOptions {
  project?: string;
  /**
   * How long a landed task stays visible. Here rather than in the projection,
   * so changing it is a different query and not a rebuild — and so a rebuild
   * does not depend on when it ran.
   */
  retentionDays?: number;
  url?: string;
}

export async function readTasks(options: ReadTasksOptions = {}): Promise<TaskCard[]> {
  const client = new pg.Client({ connectionString: options.url ?? databaseUrl() });
  await client.connect();
  try {
    const days = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const args: unknown[] = [days];
    let where = `where (t.closed_at is null or t.closed_at > now() - ($1 || ' days')::interval)`;
    if (options.project) {
      args.push(options.project);
      where += ` and t.project = $2`;
    }

    const r = await client.query(
      `select t.*, coalesce(p.tier, 'guarded') as tier
       from task_view t
       left join task_view_project p on p.project = t.project
       ${where}
       order by t.project,
         -- "Waiting on you" is oldest first: it is the column that stalls, and
         -- what has waited longest is what to do next. Null everywhere else, so
         -- the other lanes fall through to the ticket number.
         case when t.state = 'waiting' then t.updated_at end asc nulls last,
         nullif(regexp_replace(t.issue, '\\D', '', 'g'), '')::bigint`,
      args,
    );

    return r.rows.map((row) => {
      const gates = (row.gates ?? {}) as Record<string, string>;
      const verdicts = Object.values(gates);
      return {
        taskId: row.task_id,
        project: row.project,
        issue: row.issue,
        title: row.title ?? `#${row.issue}`,
        kind: row.kind ?? "unknown",
        state: row.state as TaskState,
        tier: row.tier,
        runId: row.run_id,
        turns: row.turns,
        costUsd: row.cost_usd,
        guardTrips: row.guard_trips,
        gatesPassed: verdicts.filter((v) => v === "passed" || v === "waived").length,
        gatesFailed: verdicts.filter((v) => v === "failed").length,
        baseSha: row.base_sha,
        headSha: row.head_sha,
        files: row.files,
        insertions: row.insertions,
        deletions: row.deletions,
        note: row.note,
        updatedAt: row.updated_at,
        closedAt: row.closed_at,
        attempts: row.attempts,
        lastAttemptAt: row.last_attempt_at,
      };
    });
  } finally {
    await client.end();
  }
}
