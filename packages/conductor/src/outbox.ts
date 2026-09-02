/**
 * Side effects that survive a crash.
 *
 * The old loop called `gh` inline. A failed call vanished — no record, no
 * retry, and no way afterwards to tell "we never commented" from "we commented
 * and it did not help". Everything that leaves this machine now goes through
 * here instead.
 *
 * ## The table is the migration's, not this projection's
 *
 * `outbox` is in the contract — it was designed there before any of this was
 * written, with `caused_by` naming the event that produced the row. So `create`
 * and `reset` here do **nothing**: a projection that dropped a schema-managed
 * table would take it out from under `db verify`, and `esc projection rebuild
 * outbox` would quietly destroy the migration's work.
 *
 * That turns out to be better rather than a compromise. Because the table is
 * never dropped, delivery state survives a rebuild on its own, and re-applying
 * the log is a no-op against rows that already exist.
 *
 * ## Why it is a projection
 *
 * "A crash between the event and the delivery loses nothing" is only true if
 * the pending row is *derived*. It is: `outbox` is replayed from the log, so a
 * process that dies between appending `WorkItemBlocked` and posting the comment
 * comes back with the row still there.
 *
 * That only works because delivery is **also** in the log. If `delivered_at`
 * lived only in this table, rebuilding it would forget everything already sent
 * and post every comment a second time — which is the exact failure the
 * idempotence criterion is about, arriving through the back door. So the worker
 * appends `OutboxDelivered`, and the projection folds it.
 *
 * ## What is deliverable
 *
 * Two kinds, and both are things a *person* reads on a ticket they are already
 * looking at. Nothing that changes code goes through here — that is git's job,
 * under the merge lane's lock.
 *
 * **Labels are set, never added.** `--add-label` is set union rather than a
 * transition, which is how #35 came to carry `agent:blocked` and `agent:review`
 * at once with nothing able to notice. A state that is computed and then
 * assigned cannot hold two contradictory values.
 *
 * `labelsFor` returns *only* Escapement's own labels, and the union with
 * whatever else is on the issue is taken in the deliverer (`apps/cli`), which
 * is the only layer that can see GitHub's current state. It has to be there:
 * a projection must be deterministic, and what else is on an issue is not in
 * the log. That was written as an assumption here before anything honoured it,
 * and the first outbox drain duly stripped `enhancement` off three issues.
 */
import type { PayloadOf } from "@escapement/core";
import { databaseUrl } from "@escapement/env";
import type { Projection, ProjectionContext } from "@escapement/store";
import pg from "pg";

export const OUTBOX_TABLE = "outbox";

/**
 * Give up after this many failures.
 *
 * There is no `failed_at` column in the contract, and adding one meant a
 * migration with a data backfill for a table that has never held a row —
 * paperwork for nothing. `attempts >= MAX_ATTEMPTS` is the dead-letter
 * condition instead, and a *permanent* failure sets the counter straight to it,
 * which is literally true: no more attempts will be made.
 */
export const MAX_ATTEMPTS = 6;

/** First retry after a second; doubling, capped. Jitter is the worker's. */
export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 15 * 60_000;

export type OutboxKind = "issue-comment" | "issue-labels";

/**
 * What a row carries, per kind.
 *
 * In `payload` rather than in columns because the contract has one jsonb column
 * for exactly this: the shape differs per kind, and a table with a nullable
 * column per kind would grow one every time a kind is added.
 */
export type OutboxPayload =
  | { project: string; target: string; body: string }
  | { project: string; target: string; labels: string[] };

export interface OutboxItem {
  /** `<seq>:<kind>` — the contract calls it `id`. */
  ref: string;
  kind: OutboxKind;
  project: string;
  /** The issue number, as text. */
  target: string;
  payload: OutboxPayload;
  attempts: number;
  lastError: string | null;
  deliveredAt: Date | null;
  /** True once no further attempt will be made. See `MAX_ATTEMPTS`. */
  dead: boolean;
  createdAt: Date;
}

/**
 * `wi-project-155` → project and issue.
 *
 * Safe because the same code writes it, and splitting at the last hyphen is
 * what keeps a project name containing hyphens intact.
 */
function splitTaskId(taskId: string): { project: string; issue: string } {
  const body = taskId.startsWith("wi-") ? taskId.slice(3) : taskId;
  const cut = body.lastIndexOf("-");
  if (cut < 0) return { project: body, issue: "" };
  return { project: body.slice(0, cut), issue: body.slice(cut + 1) };
}

/**
 * The label set a task's state implies.
 *
 * Computed, so it cannot contradict itself, and deliberately small: these say
 * what Escapement is doing, and every other label on the issue is somebody
 * else's and is left alone by the caller.
 */
export function labelsFor(state: string): string[] {
  switch (state) {
    case "running":
    case "gates":
      return ["escapement:working"];
    case "waiting":
      return ["escapement:waiting"];
    default:
      return [];
  }
}

export const outboxProjection: Projection = {
  name: "outbox",

  // Both no-ops. The contract owns this table (see the header); dropping or
  // recreating it here would put this projection and `db verify` at odds.
  async create() {},
  async reset() {},

  async apply(events, ctx) {
    for (const event of events) {
      const seq = event.seq.toString();
      const at = event.at;

      switch (event.type) {
        /**
         * The one message worth sending unprompted: something is waiting on a
         * person, and the question is the payload. `agent:blocked` carried no
         * question, which is why the old review queue was unworkable from the
         * outside.
         */
        case "WorkItemBlocked": {
          const d = event.data as PayloadOf<"WorkItemBlocked">;
          const { project, issue } = splitTaskId(event.streamId);
          if (!issue) break;
          await enqueue(ctx, `${seq}:issue-comment`, {
            kind: "issue-comment",
            payload: { project, target: issue, body: `**Escapement is waiting on you.**\n\n${d.question}` },
            at,
            seq,
          });
          break;
        }

        case "WorkItemClaimed":
        case "WorkItemReleased":
        case "WorkItemLanded": {
          const { project, issue } = splitTaskId(event.streamId);
          if (!issue) break;
          const state =
            event.type === "WorkItemClaimed" ? "running" : event.type === "WorkItemLanded" ? "landed" : "queued";
          await enqueue(ctx, `${seq}:issue-labels`, {
            kind: "issue-labels",
            payload: { project, target: issue, labels: labelsFor(state) },
            at,
            seq,
          });
          break;
        }

        // ---- what the worker wrote back ----

        case "OutboxDelivered": {
          const d = event.data as PayloadOf<"OutboxDelivered">;
          await ctx.query(
            "update outbox set delivered_at = $2 where id = $1 and delivered_at is null",
            [d.ref, at],
          );
          break;
        }

        case "OutboxFailed": {
          const d = event.data as PayloadOf<"OutboxFailed">;
          // A permanent failure jumps the counter to the limit rather than
          // incrementing. "No more attempts will be made" is exactly what that
          // number means, so saying it directly is honest rather than clever.
          await ctx.query(
            `update outbox
             set attempts = case when $3::boolean then ${MAX_ATTEMPTS} else attempts + 1 end,
                 last_error = $2
             where id = $1 and delivered_at is null`,
            [d.ref, d.error, d.permanent],
          );
          break;
        }

        default:
          break;
      }
    }
  },
};

async function enqueue(
  ctx: ProjectionContext,
  id: string,
  row: { kind: OutboxKind; payload: OutboxPayload; at: Date; seq: string },
): Promise<void> {
  // Keyed on the triggering event's seq, so replaying the log produces the same
  // row rather than a second one. That is the whole of the idempotence: a retry
  // cannot double-post because there is only ever one row to deliver, and no
  // amount of care in the worker could substitute for it.
  await ctx.query(
    `insert into outbox (id, caused_by, kind, payload, created_at)
     values ($1, $2::bigint, $3, $4::jsonb, $5)
     on conflict (id) do nothing`,
    [id, row.seq, row.kind, JSON.stringify(row.payload), row.at],
  );
}

// ------------------------------------------------------------------ read ----

export interface PendingOptions {
  /** Injectable so a test does not have to wait out a backoff. */
  now?: Date;
  limit?: number;
  url?: string;
}

/**
 * What is due to be delivered, oldest first.
 *
 * The backoff is computed here rather than stored, from the attempt count and
 * the row's age, so it cannot drift out of step with the log.
 */
export async function pendingOutbox(options: PendingOptions = {}): Promise<OutboxItem[]> {
  const client = new pg.Client({ connectionString: options.url ?? databaseUrl() });
  await client.connect();
  try {
    const r = await client.query(
      `select * from outbox
       where delivered_at is null and attempts < ${MAX_ATTEMPTS}
       order by created_at
       limit $1`,
      [options.limit ?? 50],
    );
    const now = (options.now ?? new Date()).getTime();
    return r.rows
      .map(toItem)
      .filter((i) => now - i.createdAt.getTime() >= backoffFor(i.attempts));
  } finally {
    await client.end();
  }
}

/** Everything that will never be delivered, for `esc doctor` to shout about. */
export async function deadOutbox(url = databaseUrl()): Promise<OutboxItem[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query(
      `select * from outbox
       where delivered_at is null and attempts >= ${MAX_ATTEMPTS}
       order by created_at`,
    );
    return r.rows.map(toItem);
  } finally {
    await client.end();
  }
}

export function backoffFor(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts);
}

function toItem(row: Record<string, unknown>): OutboxItem {
  const payload = row["payload"] as OutboxPayload;
  const attempts = row["attempts"] as number;
  return {
    ref: row["id"] as string,
    kind: row["kind"] as OutboxKind,
    // From the payload, which is where the contract keeps per-kind data.
    project: payload.project,
    target: payload.target,
    payload,
    attempts,
    lastError: (row["last_error"] as string) ?? null,
    deliveredAt: (row["delivered_at"] as Date) ?? null,
    dead: attempts >= MAX_ATTEMPTS,
    createdAt: row["created_at"] as Date,
  };
}
