/**
 * The `board` projection.
 *
 * The board is not a status page — it is **the place the backlog gets worked**.
 * The old loop's review queue reached 45 items growing at 14 a day against zero
 * processed, because working one meant leaving the tool and going to GitHub. If
 * the diff, the verdicts and the controls are not on the card, nothing about
 * that changes.
 *
 * This is the one projection that spans all three aggregates. A work item's own
 * stream knows it was claimed and that it landed; the *run* stream knows the
 * turns, the cost and the guard trips; the *integration* stream knows why a
 * merge was refused. None of them alone can render a card, which is exactly the
 * split design.md §4 chose and the reason composing them is a projection's job
 * rather than a reducer's.
 *
 * Three shapes here are arguments, not conveniences:
 *
 * **Guard trips are on the running card.** 77% of the old loop's runs tripped
 * the guard and nobody ever saw one.
 *
 * **"Waiting on you" is a column, not a label.** It is where the queue actually
 * stalls, so it gets its own place to stall in.
 *
 * **A landed card carries the regressions filed against it.** A merge that
 * produced two bugs should read as what it is.
 */
import type { PayloadOf } from "@escapement/core";
import { databaseUrl } from "@escapement/env";
import type { Projection, ProjectionContext } from "@escapement/store";
import pg from "pg";

export type BoardColumnId = "queued" | "running" | "gates" | "waiting" | "landed";

export const boardProjection: Projection = {
  name: "board",

  async create(ctx) {
    await ctx.query(`
      create table if not exists board (
        work_item_id text primary key,
        project      text not null,
        external_ref text not null,
        title        text not null,
        kind         text not null,
        col          text not null,

        run_id       text,
        turns        int,
        cost_usd     double precision,
        -- 132 of these were invisible in the old loop. They belong on the card.
        guard_trips  int  not null default 0,
        compactions  int  not null default 0,

        -- [{ gate, verdict, onSha, evidence }]. A verdict whose onSha is not the
        -- head is stale, which is how a force-push invalidates approval.
        gates        jsonb not null default '[]'::jsonb,
        head_sha     text,
        files        int,
        insertions   int,
        deletions    int,

        refusal      text,
        refusal_detail text,
        question     text,
        merge_commit text,
        -- Work items later filed against this one.
        regressions  text[] not null default '{}',

        updated_seq  bigint not null
      )`);
    await ctx.query("create index if not exists board_col_idx on board (project, col)");

    // Which run belongs to which work item. Run events arrive on their own
    // stream and carry no work item id except at RunStarted.
    await ctx.query(`
      create table if not exists board_run (
        run_id       text primary key,
        work_item_id text not null
      )`);

    // The containment tier is policy, and policy lives on the project's stream.
    // Kept beside the board so a card can show it without a second source.
    await ctx.query(`
      create table if not exists board_project (
        project text primary key,
        tier    text not null
      )`);
  },

  async reset(ctx) {
    await ctx.query("truncate table board");
    await ctx.query("truncate table board_run");
    await ctx.query("truncate table board_project");
  },

  async apply(events, ctx) {
    for (const event of events) {
      const seq = event.seq.toString();

      switch (event.type) {
        case "ProjectPolicySet": {
          const d = event.data as PayloadOf<"ProjectPolicySet">;
          await ctx.query(
            `insert into board_project (project, tier) values ($1, $2)
             on conflict (project) do update set tier = excluded.tier`,
            [d.project, d.tier],
          );
          break;
        }

        // ---- the work item's own stream ----
        case "WorkItemDiscovered": {
          const d = event.data as PayloadOf<"WorkItemDiscovered">;
          await ctx.query(
            `insert into board (work_item_id, project, external_ref, title, kind, col, updated_seq)
             values ($1, $2, $3, $4, $5, 'queued', $6)
             on conflict (work_item_id) do nothing`,
            [event.streamId, d.project, d.externalRef, d.title, d.kind, seq],
          );
          break;
        }

        case "WorkItemClaimed": {
          const d = event.data as PayloadOf<"WorkItemClaimed">;
          await set(ctx, event.streamId, seq, {
            col: "running",
            run_id: d.runId,
            question: null,
            refusal: null,
          });
          await ctx.query(
            `insert into board_run (run_id, work_item_id) values ($1, $2)
             on conflict (run_id) do update set work_item_id = excluded.work_item_id`,
            [d.runId, event.streamId],
          );
          break;
        }

        case "WorkItemReleased":
          await set(ctx, event.streamId, seq, { col: "queued", run_id: null });
          break;

        case "WorkItemBlocked": {
          const d = event.data as PayloadOf<"WorkItemBlocked">;
          // Its own column, because it is where the queue stalls.
          await set(ctx, event.streamId, seq, { col: "waiting", question: d.question });
          break;
        }

        case "WorkItemUnblocked":
          await set(ctx, event.streamId, seq, { col: "queued", question: null });
          break;

        case "WorkItemLanded": {
          const d = event.data as PayloadOf<"WorkItemLanded">;
          await set(ctx, event.streamId, seq, { col: "landed", merge_commit: d.mergeCommit });
          break;
        }

        case "WorkItemLinked": {
          const d = event.data as PayloadOf<"WorkItemLinked">;
          if (d.relation !== "caused-by") break;
          // The regression goes on the card of the item that *caused* it, so a
          // merge that produced two bugs reads as what it is. #134 and #136 were
          // races in code #58 had merged, and nothing connected them.
          await ctx.query(
            `update board
             set regressions = (select array_agg(distinct x) from unnest(regressions || $2::text) x),
                 updated_seq = greatest(updated_seq, $3::bigint)
             where project = (select project from board where work_item_id = $1)
               and external_ref = $4`,
            [event.streamId, refOf(event.streamId), seq, d.otherRef],
          );
          break;
        }

        case "DispatchRefused": {
          const d = event.data as PayloadOf<"DispatchRefused">;
          await set(ctx, event.streamId, seq, {
            refusal: "dispatch-refused",
            refusal_detail: `needs ${d.requiredTier}; ${d.runtime} is missing ${d.missing.join(", ")}`,
          });
          break;
        }

        // ---- the run's stream ----
        /**
         * The first event a run writes, when a recipe declares any preparation.
         * It creates the run→card link that `viaRun` needs, because everything
         * below assumes `RunStarted` did that and prepare happens before it.
         *
         * The card moves to `running` here rather than at `RunStarted`: a
         * ten-minute install is work in flight, and leaving the card in `queued`
         * for it would say nothing is happening while something is.
         */
        case "PreparationStarted": {
          const d = event.data as PayloadOf<"PreparationStarted">;
          await ctx.query(
            `insert into board_run (run_id, work_item_id) values ($1, $2)
             on conflict (run_id) do update set work_item_id = excluded.work_item_id`,
            [event.streamId, d.workItemId],
          );
          await viaRun(ctx, event.streamId, seq, { col: "running", run_id: event.streamId });
          break;
        }

        case "PreparationFailed": {
          const d = event.data as PayloadOf<"PreparationFailed">;
          await viaRun(ctx, event.streamId, seq, {
            col: "waiting",
            // Not `run-failed`: no agent ever ran. The card has to say the
            // worktree could not be made workable, which is a different problem
            // with a different fix.
            refusal: d.timedOut ? "prepare-timed-out" : "prepare-failed",
            refusal_detail: `the ${d.step} step: ${d.evidence}`,
          });
          break;
        }

        case "RunStarted": {
          const d = event.data as PayloadOf<"RunStarted">;
          await ctx.query(
            `insert into board_run (run_id, work_item_id) values ($1, $2)
             on conflict (run_id) do update set work_item_id = excluded.work_item_id`,
            [event.streamId, d.workItemId],
          );
          await viaRun(ctx, event.streamId, seq, { col: "running", run_id: event.streamId });
          break;
        }

        case "GuardTripped":
          await bump(ctx, event.streamId, seq, "guard_trips");
          break;

        case "RunContextExhausted":
          await bump(ctx, event.streamId, seq, "compactions");
          break;

        case "RunAwaitingInput": {
          const d = event.data as PayloadOf<"RunAwaitingInput">;
          await viaRun(ctx, event.streamId, seq, { col: "waiting", question: d.prompt });
          break;
        }

        case "RunProducedDiff": {
          const d = event.data as PayloadOf<"RunProducedDiff">;
          await viaRun(ctx, event.streamId, seq, {
            head_sha: d.headSha,
            files: d.files,
            insertions: d.insertions,
            deletions: d.deletions,
          });
          break;
        }

        case "RunProposedCompletion": {
          const d = event.data as PayloadOf<"RunProposedCompletion">;
          await viaRun(ctx, event.streamId, seq, { col: "gates", head_sha: d.headSha });
          break;
        }

        case "RunFinished": {
          const d = event.data as PayloadOf<"RunFinished">;
          await viaRun(ctx, event.streamId, seq, { turns: d.turns, cost_usd: d.costUsd });
          break;
        }

        case "RunFailed": {
          const d = event.data as PayloadOf<"RunFailed">;
          await viaRun(ctx, event.streamId, seq, {
            col: "waiting",
            refusal: d.kind,
            refusal_detail: d.detail,
          });
          break;
        }

        case "GateRequested":
        case "GateStarted":
        case "GatePassed":
        case "GateFailed":
        case "GateWaived":
        case "ApprovalRequested":
        case "ApprovalGranted":
        case "ApprovalRevoked": {
          const d = event.data as { gate: string; onSha: string; evidence?: string };
          // Every case above is a key of VERDICT; the fallback keeps the type
          // honest rather than asserting it away.
          const verdict = VERDICT[event.type] ?? "pending";
          await upsertGate(ctx, event.streamId, seq, d.gate, verdict, d.onSha, d.evidence ?? null);
          if (event.type === "ApprovalRequested") {
            await viaRun(ctx, event.streamId, seq, {
              col: "waiting",
              question: (event.data as PayloadOf<"ApprovalRequested">).question,
            });
          }
          break;
        }

        // ---- the integration lane ----
        case "IntegrationRefused": {
          const d = event.data as PayloadOf<"IntegrationRefused">;
          await set(ctx, d.workItemId, seq, {
            col: "waiting",
            refusal: d.reason,
            refusal_detail: d.detail,
          });
          break;
        }

        case "IntegrationSucceeded": {
          const d = event.data as PayloadOf<"IntegrationSucceeded">;
          await set(ctx, d.workItemId, seq, {
            col: "landed",
            merge_commit: d.mergeCommit,
            refusal: null,
            refusal_detail: null,
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
  GateRequested: "pending",
  GateStarted: "running",
  GatePassed: "passed",
  GateFailed: "failed",
  GateWaived: "waived",
  ApprovalRequested: "pending",
  ApprovalGranted: "passed",
  ApprovalRevoked: "failed",
};

/** `wi-project-117` → `117`. */
function refOf(workItemId: string): string {
  return workItemId.slice(workItemId.lastIndexOf("-") + 1);
}

/**
 * Updates a card by work item id.
 *
 * `updated_seq` guards a replay: events arrive in seq order, so a write from an
 * earlier seq is a bug rather than something to apply.
 */
async function set(
  ctx: ProjectionContext,
  workItemId: string,
  seq: string,
  values: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(values);
  const sets = entries.map(([k], i) => `${k} = $${i + 3}`).join(", ");
  await ctx.query(
    `update board set ${sets}, updated_seq = $2::bigint
     where work_item_id = $1 and updated_seq <= $2::bigint`,
    [workItemId, seq, ...entries.map(([, v]) => v)],
  );
}

/** The same, for an event that arrived on a run's stream. */
async function viaRun(
  ctx: ProjectionContext,
  runId: string,
  seq: string,
  values: Record<string, unknown>,
): Promise<void> {
  const rows = await ctx.query<{ work_item_id: string }>(
    "select work_item_id from board_run where run_id = $1",
    [runId],
  );
  const workItemId = rows[0]?.work_item_id;
  // A run whose start was never seen has no card to update. That is a gap in
  // the log rather than something to invent a card for.
  if (workItemId) await set(ctx, workItemId, seq, values);
}

async function bump(
  ctx: ProjectionContext,
  runId: string,
  seq: string,
  column: "guard_trips" | "compactions",
): Promise<void> {
  const rows = await ctx.query<{ work_item_id: string }>(
    "select work_item_id from board_run where run_id = $1",
    [runId],
  );
  const workItemId = rows[0]?.work_item_id;
  if (!workItemId) return;
  // Idempotent by seq, like every other write here: a replay must produce the
  // same table, and `+ 1` on its own would not.
  await ctx.query(
    `update board set ${column} = ${column} + 1, updated_seq = $2::bigint
     where work_item_id = $1 and updated_seq < $2::bigint`,
    [workItemId, seq],
  );
}

async function upsertGate(
  ctx: ProjectionContext,
  runId: string,
  seq: string,
  gate: string,
  verdict: string,
  onSha: string,
  evidence: string | null,
): Promise<void> {
  const rows = await ctx.query<{ work_item_id: string }>(
    "select work_item_id from board_run where run_id = $1",
    [runId],
  );
  const workItemId = rows[0]?.work_item_id;
  if (!workItemId) return;

  await ctx.query(
    `update board
     set gates = (
           select coalesce(jsonb_agg(g), '[]'::jsonb)
           from (
             select g from jsonb_array_elements(gates) g
             where g->>'gate' <> $3
             union all
             select $4::jsonb
           ) t(g)
         ),
         updated_seq = greatest(updated_seq, $2::bigint)
     where work_item_id = $1`,
    [workItemId, seq, gate, JSON.stringify({ gate, verdict, onSha, evidence })],
  );
}

// ------------------------------------------------------------------ read ----

export interface BoardGate {
  gate: string;
  verdict: string;
  onSha: string;
  evidence: string | null;
  /** False when the verdict is about a commit that is no longer the head. */
  current: boolean;
}

export interface BoardCard {
  workItemId: string;
  project: string;
  externalRef: string;
  title: string;
  kind: string;
  column: BoardColumnId;
  tier: string;
  run: { runId: string; turns: number | null; costUsd: number | null; guardTrips: number; compactions: number } | null;
  diff: { headSha: string; files: number; insertions: number; deletions: number } | null;
  gates: BoardGate[];
  refusal: { reason: string; detail: string | null } | null;
  question: string | null;
  mergeCommit: string | null;
  regressions: string[];
}

export async function readBoard(project?: string, url = databaseUrl()): Promise<BoardCard[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query(
      `select b.*, coalesce(p.tier, 'guarded') as tier
       from board b
       left join board_project p on p.project = b.project
       ${project ? "where b.project = $1" : ""}
       order by b.project,
         -- "Waiting on you" is ordered oldest first, because it is the column
         -- that stalls and the thing that has waited longest is the thing to do
         -- next. Ascending updated_seq is exactly "least recently touched".
         -- Null for every other column, so they keep falling through to the
         -- ticket number.
         case when b.col = 'waiting' then b.updated_seq end asc nulls last,
         nullif(regexp_replace(b.external_ref, '\\D', '', 'g'), '')::bigint`,
      project ? [project] : [],
    );

    return r.rows.map((row) => {
      const gates = (row.gates as BoardGate[]).map((g) => ({
        ...g,
        // A verdict is about a diff. If the head moved, it is not about this one.
        current: row.head_sha === null || g.onSha === row.head_sha,
      }));
      return {
        workItemId: row.work_item_id,
        project: row.project,
        externalRef: row.external_ref,
        title: row.title,
        kind: row.kind,
        column: row.col as BoardColumnId,
        tier: row.tier,
        run: row.run_id
          ? {
              runId: row.run_id,
              turns: row.turns,
              costUsd: row.cost_usd,
              guardTrips: row.guard_trips,
              compactions: row.compactions,
            }
          : null,
        diff: row.head_sha
          ? {
              headSha: row.head_sha,
              files: row.files ?? 0,
              insertions: row.insertions ?? 0,
              deletions: row.deletions ?? 0,
            }
          : null,
        gates,
        refusal: row.refusal ? { reason: row.refusal, detail: row.refusal_detail } : null,
        question: row.question,
        mergeCommit: row.merge_commit,
        regressions: row.regressions ?? [],
      };
    });
  } finally {
    await client.end();
  }
}
