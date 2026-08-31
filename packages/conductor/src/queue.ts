/**
 * The `queue` projection: what is runnable, and in what order.
 *
 * This replaces `pick_ticket`, which was a GitHub issue search re-run every
 * hour. Two things are different, and both matter more than the speed.
 *
 * **It is derived from the log, not from labels.** A work item leaves the queue
 * because a `WorkItemClaimed` said so, not because a label was added. There is
 * no way for it to be simultaneously claimed and runnable.
 *
 * **Order is not baked in.** The projection stores the *kind*; the caller
 * supplies the priority order, which is the recipe's `source.kinds`. A recipe
 * that reorders its kinds must not require a projection rebuild — priority is a
 * question you ask, not a fact you store.
 */
import type { WorkKind } from "@escapement/core";
import type { PayloadOf } from "@escapement/core";
import { databaseUrl } from "@escapement/env";
import type { Projection } from "@escapement/store";
import pg from "pg";

export const queueProjection: Projection = {
  name: "queue",

  async create(ctx) {
    await ctx.query(`
      create table if not exists queue (
        work_item_id  text primary key,
        project       text        not null,
        external_ref  text        not null,
        title         text        not null,
        kind          text        not null,
        -- Why it is not runnable, or null when it is. Kept rather than deleting
        -- the row: "what left the queue and why" is the question the old loop
        -- could not answer at all.
        held_by       text,
        discovered_at timestamptz not null,
        updated_seq   bigint      not null
      )`);
    await ctx.query("create index if not exists queue_runnable_idx on queue (project, held_by)");
  },

  async reset(ctx) {
    await ctx.query("truncate table queue");
  },

  async apply(events, ctx) {
    for (const event of events) {
      switch (event.type) {
        case "WorkItemDiscovered": {
          const d = event.data as PayloadOf<"WorkItemDiscovered">;
          await ctx.query(
            `insert into queue
               (work_item_id, project, external_ref, title, kind, held_by, discovered_at, updated_seq)
             values ($1, $2, $3, $4, $5, null, $6, $7)
             on conflict (work_item_id) do nothing`,
            [
              event.streamId,
              d.project,
              d.externalRef,
              d.title,
              d.kind,
              event.at.toISOString(),
              event.seq.toString(),
            ],
          );
          break;
        }

        // Everything below is "this left the queue" or "this came back". Each
        // one is a transition in the log, never a label.
        case "WorkItemClaimed":
          await hold(ctx, event.streamId, "running", event.seq);
          break;
        case "WorkItemBlocked":
          await hold(ctx, event.streamId, "blocked", event.seq);
          break;
        case "WorkItemLanded":
          await hold(ctx, event.streamId, "landed", event.seq);
          break;
        case "DispatchRefused":
          await hold(ctx, event.streamId, "dispatch-refused", event.seq);
          break;

        case "WorkItemReleased":
        case "WorkItemUnblocked":
          await hold(ctx, event.streamId, null, event.seq);
          break;

        default:
          break;
      }
    }
  },
};

async function hold(
  ctx: { query: (text: string, values?: readonly unknown[]) => Promise<unknown> },
  workItemId: string,
  heldBy: string | null,
  seq: bigint,
): Promise<void> {
  // `updated_seq` guards against an out-of-order replay writing a stale state:
  // events arrive in seq order, so an update from an earlier seq is a bug rather
  // than something to apply.
  await ctx.query(
    `update queue set held_by = $2, updated_seq = $3
     where work_item_id = $1 and updated_seq < $3`,
    [workItemId, heldBy, seq.toString()],
  );
}

export interface QueueEntry {
  workItemId: string;
  project: string;
  externalRef: string;
  title: string;
  kind: WorkKind;
  heldBy: string | null;
  discoveredAt: Date;
}

/**
 * What is runnable for a project, in priority order.
 *
 * `kinds` is the recipe's own list and is the priority order — earlier wins.
 * Within a kind, oldest first by issue number, which is the closest thing to
 * "has been waiting longest" that does not depend on when discovery happened to
 * run.
 */
export async function readQueue(
  project: string,
  kinds: readonly WorkKind[],
  options: { includeHeld?: boolean; url?: string } = {},
): Promise<QueueEntry[]> {
  const client = new pg.Client({ connectionString: options.url ?? databaseUrl() });
  await client.connect();
  try {
    const r = await client.query<{
      work_item_id: string;
      project: string;
      external_ref: string;
      title: string;
      kind: string;
      held_by: string | null;
      discovered_at: Date;
    }>(
      `select * from queue
       where project = $1
         and ($3::bool or held_by is null)
         and ($2::text[] = '{}' or kind = any($2::text[]))
       order by
         array_position($2::text[], kind) nulls last,
         -- Oldest first. Numeric so #9 sorts before #10.
         nullif(regexp_replace(external_ref, '\\D', '', 'g'), '')::bigint asc nulls last,
         work_item_id asc`,
      [project, [...kinds], options.includeHeld ?? false],
    );
    return r.rows.map((row) => ({
      workItemId: row.work_item_id,
      project: row.project,
      externalRef: row.external_ref,
      title: row.title,
      kind: row.kind as WorkKind,
      heldBy: row.held_by,
      discoveredAt: row.discovered_at,
    }));
  } finally {
    await client.end();
  }
}
