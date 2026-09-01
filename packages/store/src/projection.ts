/**
 * The projection runner: how derived tables stay derived.
 *
 * One rule holds all of it. **A projection's writes and its checkpoint advance
 * happen in the same transaction.** Split them and there is no third option — a
 * crash between the two either loses a batch or applies it twice, and which one
 * depends on which write you put first. Together, the checkpoint is simply part
 * of the projection's state, and recovery is "read the checkpoint, carry on".
 *
 * That is why this file talks to Postgres through `pg` rather than through the
 * ORM. Projections are deliberately **not** in the Prisma contract — their shape
 * will change, and changing one is `TRUNCATE` + reset + replay, not a migration
 * (doc/decisions/0003-postgres-event-store.md). A table the contract does not
 * know about has no ORM surface, and a projection needs DDL, `TRUNCATE` and its
 * own upserts regardless. The same deliberate split as the subscriber.
 *
 * Reads still go through the store, and therefore through Prisma: `readAll` is
 * the only cursor, and its payloads are validated and upcast on the way out.
 */
import type { Envelope } from "@escapement/core";
import pg from "pg";
import { databaseUrl } from "./env.ts";
import { type EventStore, eventStore } from "./event-store.ts";
import { type Subscription, subscribe } from "./subscribe.ts";

/** SQL access inside the projection's transaction. */
export interface ProjectionContext {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<T[]>;
}

export interface Projection {
  /** The `checkpoints.name` this projection advances. */
  readonly name: string;

  /**
   * Idempotent DDL for whatever tables this projection owns. Called before every
   * catch-up, so a fresh database needs no migration step.
   */
  create(ctx: ProjectionContext): Promise<void>;

  /**
   * **Removes** everything `create` made — dropped, not emptied.
   *
   * This used to truncate, and truncating is not enough. `create` is
   * `create table if not exists`, so a projection whose *shape* changed kept
   * the old columns forever and the runner died on the first write to a column
   * that was not there. The error surfaced as "subscription stopped before it
   * caught up", which names the symptom and not one word of the cause.
   *
   * Dropping is what makes the claim in `rebuild` true: a projection's shape is
   * free to change because changing it costs a rebuild rather than a migration.
   */
  reset(ctx: ProjectionContext): Promise<void>;

  /**
   * Folds one batch, in `seq` order.
   *
   * **Must be idempotent.** The checkpoint is transactional, so a clean crash
   * cannot double-apply — but a process killed after Postgres committed and
   * before the runner noticed will re-read the same events, and so will a
   * rebuild. `on conflict do nothing` keyed on `seq` is the cheap way.
   */
  apply(events: readonly Envelope[], ctx: ProjectionContext): Promise<void>;
}

export interface ProjectionLag {
  name: string;
  /** How far this projection has consumed. */
  lastSeq: bigint;
  /** The log's high-water mark. */
  headSeq: bigint;
  /** Events behind. Zero is caught up. */
  lag: bigint;
  updatedAt: Date | null;
}

export interface ProjectionRunner {
  readonly name: string;
  /** Set when a handler threw. The runner is stopped and the checkpoint is intact. */
  readonly failure: unknown;
  readonly running: boolean;

  /** Creates the tables, catches up, then follows the log. Resolves once caught up. */
  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * Truncate, reset the checkpoint, replay from the beginning.
   *
   * This is what makes a projection's shape free to change: it costs a rebuild,
   * not a migration.
   */
  rebuild(): Promise<void>;

  lag(): Promise<ProjectionLag>;

  /** Releases the pool. `stop()` alone leaves the runner restartable. */
  close(): Promise<void>;
}

function ctxFor(client: pg.PoolClient | pg.Client): ProjectionContext {
  return {
    async query(text, values) {
      const r = await client.query(text, values ? [...values] : undefined);
      return r.rows;
    },
  };
}

/**
 * `checkpoints.updated_at` is `NOT NULL` with no database default —
 * `temporal.updatedAtString()` is a Prisma client behaviour, not a trigger — so
 * raw SQL has to supply it. Measured against the live schema; forgetting it
 * fails loudly, which is the good case.
 */
const ADVANCE_CHECKPOINT = `
  insert into checkpoints (name, last_seq, updated_at)
  values ($1, $2, now())
  on conflict (name) do update
    set last_seq = excluded.last_seq, updated_at = now()`;

/**
 * Puts a row down at zero without moving an existing one.
 *
 * A projection with no events yet would otherwise have no checkpoint at all,
 * and `projectionLag` cannot tell that apart from a projection nobody ever
 * started — so `esc doctor` would report "nothing running" about something that
 * is running fine and merely has nothing to do.
 */
const REGISTER_CHECKPOINT = `
  insert into checkpoints (name, last_seq, updated_at)
  values ($1, 0, now())
  on conflict (name) do nothing`;

/** Same, but forces an existing row back to zero. Used by `rebuild`. */
const RESET_CHECKPOINT = `
  insert into checkpoints (name, last_seq, updated_at)
  values ($1, 0, now())
  on conflict (name) do update
    set last_seq = 0, updated_at = now()`;

export interface ProjectionRunnerOptions {
  projection: Projection;
  store?: EventStore;
  /** Pooled connection. Transaction mode is fine: a transaction is one checkout. */
  url?: string;
  batchSize?: number;
  onError?: (error: unknown, phase: "connection" | "handler") => void;
}

export function createProjectionRunner(options: ProjectionRunnerOptions): ProjectionRunner {
  const { projection } = options;
  const store = options.store ?? eventStore;
  const pool = new pg.Pool({ connectionString: options.url ?? databaseUrl(), max: 2 });

  let subscription: Subscription | null = null;
  let failure: unknown = null;

  async function inTransaction<T>(fn: (ctx: ProjectionContext) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await fn(ctxFor(client));
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => {
        // The connection is already gone; the transaction died with it.
      });
      throw err;
    } finally {
      client.release();
    }
  }

  async function readCheckpoint(): Promise<bigint> {
    const r = await pool.query<{ last_seq: string }>(
      "select last_seq::text as last_seq from checkpoints where name = $1",
      [projection.name],
    );
    return BigInt(r.rows[0]?.last_seq ?? "0");
  }

  async function commitBatch(events: readonly Envelope[]): Promise<void> {
    const last = events[events.length - 1];
    if (!last) return;
    await inTransaction(async (ctx) => {
      await projection.apply(events, ctx);
      // The whole point: this is not a separate write.
      await ctx.query(ADVANCE_CHECKPOINT, [projection.name, last.seq.toString()]);
    });
  }

  async function follow(): Promise<void> {
    const fromSeq = await readCheckpoint();
    const sub = subscribe({
      fromSeq,
      store,
      name: `escapement-projection-${projection.name}`,
      onBatch: commitBatch,
      batchSize: options.batchSize ?? 500,
      onError: (error, phase) => {
        if (phase === "handler") failure = error;
        options.onError?.(error, phase);
      },
    });
    subscription = sub;
    await sub.caughtUp();
  }

  return {
    name: projection.name,

    get failure() {
      return failure;
    },
    get running() {
      return subscription !== null && !subscription.stopped;
    },

    async start() {
      failure = null;
      await inTransaction(async (ctx) => {
        await projection.create(ctx);
        await ctx.query(REGISTER_CHECKPOINT, [projection.name]);
      });
      await follow();
    },

    async stop() {
      const sub = subscription;
      subscription = null;
      await sub?.close();
    },

    async rebuild() {
      // Stop first. A runner still applying events into a table being truncated
      // would produce a result that depends on timing, which is the one thing a
      // rebuild must not do.
      await this.stop();

      await inTransaction(async (ctx) => {
        // Remove first, then recreate. The other order drops what was just
        // built and leaves nothing behind.
        await projection.reset(ctx);
        await projection.create(ctx);
        // Zeroed rather than deleted: the projection still exists and is still
        // being run, and a missing row would make it look like one nobody had
        // ever started.
        await ctx.query(RESET_CHECKPOINT, [projection.name]);
      });

      failure = null;
      await follow();
    },

    async close() {
      await this.stop();
      await pool.end();
    },

    async lag() {
      const r = await pool.query<{ last_seq: string; head_seq: string; updated_at: Date | null }>(
        `select coalesce(c.last_seq, 0)::text as last_seq,
                (select coalesce(max(seq), 0) from events)::text as head_seq,
                c.updated_at
         from (select 1) one
         left join checkpoints c on c.name = $1`,
        [projection.name],
      );
      const row = r.rows[0];
      const lastSeq = BigInt(row?.last_seq ?? "0");
      const headSeq = BigInt(row?.head_seq ?? "0");
      return {
        name: projection.name,
        lastSeq,
        headSeq,
        lag: headSeq - lastSeq,
        updatedAt: row?.updated_at ?? null,
      };
    },
  };
}

/**
 * Lag for every projection with a checkpoint, without starting a runner.
 *
 * This is what `esc doctor` reports. A projection that is far behind and whose
 * `updatedAt` is old is a stopped subscriber, and the old loop had no way to
 * notice the equivalent at all.
 */
export async function projectionLag(url = databaseUrl()): Promise<ProjectionLag[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query<{
      name: string;
      last_seq: string;
      head_seq: string;
      updated_at: Date | null;
    }>(
      `select c.name,
              c.last_seq::text as last_seq,
              (select coalesce(max(seq), 0) from events)::text as head_seq,
              c.updated_at
       from checkpoints c
       order by c.name`,
    );
    return r.rows.map((row) => {
      const lastSeq = BigInt(row.last_seq);
      const headSeq = BigInt(row.head_seq);
      return { name: row.name, lastSeq, headSeq, lag: headSeq - lastSeq, updatedAt: row.updated_at };
    });
  } finally {
    await client.end();
  }
}
