/**
 * The write side of the event log: append, read, readAll.
 *
 * `UNIQUE (stream_id, version)` is the entire concurrency control of this
 * system. There is no lock table and nothing to unwind after a `kill -9` — an
 * append at an expected version either lands or violates the constraint, and
 * the loser re-reads and retries. The old loop used a `.runtime/loop.lock.d`
 * directory that leaked after every hard kill and needed a manual `rm -rf`; see
 * doc/decisions/0003-postgres-event-store.md.
 *
 * So the interesting behaviour here is not the happy path. It is that a losing
 * writer gets a `ConcurrencyError` and not a Prisma error, and that a batch is
 * all-or-nothing.
 */
import {
  Actor,
  type Envelope,
  MissingUpcasterError,
  SCHEMA_VER,
  StreamId,
  type ToAppend,
  isEventType,
  parsePayload,
  parseStoredPayload,
} from "@lingtai/core";
import { type Db, db } from "./db.ts";
import type { CodecTypes } from "./prisma/contract.d.ts";
import { parseTimestamptz } from "./timestamptz.ts";

// ----------------------------------------------------------------- errors ----
//
// These are written with explicit fields rather than constructor parameter
// properties. Node runs this source directly through strip-only type stripping —
// no transform — and a parameter property is a *transform*, so it fails at load
// with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. The board bundles through Turbopack and
// would not have noticed; the conductor and the CLI would have. Same rule bars
// `enum`, `namespace` and decorators anywhere in these packages.

/**
 * Another writer got there first. Re-read the stream and retry.
 *
 * This is also what a caller sees when it simply passed a stale
 * `expectedVersion` with no competitor involved. The two are indistinguishable
 * from the database's side and — more to the point — the recovery is identical,
 * so they are deliberately one error rather than two.
 */
export class ConcurrencyError extends Error {
  override readonly name = "ConcurrencyError";
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly attemptedVersions: readonly number[];

  constructor(
    streamId: string,
    expectedVersion: number,
    attemptedVersions: readonly number[],
    options?: { cause?: unknown },
  ) {
    super(
      `${streamId} is no longer at version ${expectedVersion}; ` +
        `could not append version${attemptedVersions.length > 1 ? "s" : ""} ` +
        `${attemptedVersions.join(", ")}. Re-read and retry.`,
      options,
    );
    this.streamId = streamId;
    this.expectedVersion = expectedVersion;
    this.attemptedVersions = attemptedVersions;
  }
}

/**
 * A type that is not in `@lingtai/core`'s catalogue. Thrown on the way in so
 * a typo never reaches the log, and on the way out so a reader written against
 * an older catalogue says so instead of quietly skipping rows it does not
 * recognise.
 */
export class UnknownEventTypeError extends Error {
  override readonly name = "UnknownEventTypeError";
  readonly type: string;

  constructor(type: string, where: "append" | "read") {
    super(`"${type}" is not an event type in @lingtai/core (on ${where})`);
    this.type = type;
  }
}

/**
 * A stored payload is in a shape this build cannot read, and no chain of
 * upcasters reaches it — either the payload is older than the oldest upcaster,
 * or it was written by a newer build than this one, which is not recoverable at
 * all.
 *
 * Nothing can produce it yet: every type is at `schemaVer` 1, so every chain has
 * length zero. It exists because the alternative to failing loudly is handing a
 * v2 payload to a v1 zod schema, which is how a year of history gets
 * misinterpreted quietly. Upcasters live in `@lingtai/core`'s registry.
 */
export class SchemaVersionUnsupportedError extends Error {
  override readonly name = "SchemaVersionUnsupportedError";
  readonly type: string;
  readonly stored: number;
  readonly supported: number;
  readonly seq: bigint;

  constructor(type: string, stored: number, supported: number, seq: bigint) {
    super(
      `event ${seq} (${type}) is schemaVer ${stored}; this build reads ` +
        `${supported} and there is no upcaster. See packages/store/src/event-store.ts.`,
    );
    this.type = type;
    this.stored = stored;
    this.supported = supported;
    this.seq = seq;
  }
}

// --------------------------------------------------------------- internals ----

/** The row shape `db.orm.public.Event` hands back. */
interface EventRow {
  seq: bigint;
  streamId: string;
  version: number;
  type: string;
  schemaVer: number;
  data: unknown;
  actor: string;
  causation: bigint | null;
  at: string;
}

/**
 * Postgres reports a unique violation as SQLSTATE 23505. The driver wraps it in
 * a `SqlQueryError` carrying `sqlState` and `constraint`, and that in turn is
 * the `cause` of whatever the ORM throws — so the chain has to be walked rather
 * than the top-level error inspected. Measured against the live database on
 * 2026-08-31; the constraint name is Prisma's, from `@@unique([streamId, version])`.
 *
 * Matching the constraint by name and not merely the SQLSTATE matters: a future
 * unique index on some other column must not be mistaken for a lost race.
 */
const VERSION_CONSTRAINT = "events_stream_id_version_key";

function isVersionConflict(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 8; depth++) {
    const e = cur as { sqlState?: unknown; code?: unknown; constraint?: unknown; cause?: unknown };
    const sqlState = typeof e.sqlState === "string" ? e.sqlState : e.code;
    if (sqlState === "23505" && e.constraint === VERSION_CONSTRAINT) return true;
    cur = e.cause;
  }
  return false;
}

function toEnvelope(row: EventRow): Envelope {
  if (!isEventType(row.type)) throw new UnknownEventTypeError(row.type, "read");

  let data: unknown;
  try {
    // Upcast, then validate. Validated on the way out as well as in: the store
    // never hands out unvalidated data, because a projection reading a malformed
    // payload would be wrong silently — the whole failure mode this system
    // exists to end.
    data = parseStoredPayload(row.type, row.schemaVer, row.data);
  } catch (err) {
    if (err instanceof MissingUpcasterError) {
      throw new SchemaVersionUnsupportedError(row.type, row.schemaVer, SCHEMA_VER[row.type], row.seq);
    }
    throw err;
  }

  return {
    seq: row.seq,
    streamId: row.streamId,
    version: row.version,
    type: row.type,
    schemaVer: row.schemaVer,
    data,
    actor: row.actor,
    causation: row.causation,
    at: parseTimestamptz(row.at),
  };
}

// ------------------------------------------------------------------- store ----

export interface EventStore {
  /**
   * Append `events` to `streamId`, which the caller believes is at
   * `expectedVersion`. A new stream is version 0. Events are written at
   * `expectedVersion + 1 …`, in the order given.
   *
   * All of them land or none do — one transaction, so a conflict on the last
   * event of a batch rolls back the ones before it.
   *
   * Throws `ConcurrencyError` if the stream moved.
   */
  append(
    streamId: string,
    expectedVersion: number,
    events: readonly ToAppend[],
  ): Promise<Envelope[]>;

  /** One stream, in version order, from `fromVersion` (inclusive, default 1). */
  read(streamId: string, fromVersion?: number): Promise<Envelope[]>;

  /**
   * The global log after `fromSeq` (exclusive), in `seq` order. This is the
   * projection catch-up read; `fromSeq` is a checkpoint's `lastSeq`, and 0n
   * starts from the beginning.
   */
  readAll(fromSeq: bigint, limit: number): Promise<Envelope[]>;
}

export function createEventStore(client: Db): EventStore {
  return {
    async append(streamId, expectedVersion, events) {
      StreamId.parse(streamId);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw new RangeError(
          `expectedVersion must be a non-negative integer, got ${expectedVersion}`,
        );
      }
      if (events.length === 0) return [];

      // Validate everything before opening a transaction. A rejected payload
      // should cost nothing and, more importantly, a batch must not be able to
      // fail halfway through validation with rows already written.
      const rows = events.map((e, i) => {
        if (!isEventType(e.type)) throw new UnknownEventTypeError(e.type, "append");
        Actor.parse(e.actor);
        return {
          streamId,
          version: expectedVersion + 1 + i,
          type: e.type,
          schemaVer: e.schemaVer ?? SCHEMA_VER[e.type],
          // The payload column's own input type, taken from the emitted
          // contract rather than hand-written, so a codec change breaks here
          // rather than at runtime. A zod-parsed payload is plain JSON.
          data: parsePayload(e.type, e.data) as CodecTypes["pg/jsonb@1"]["input"],
          actor: e.actor,
          causation: e.causation ?? null,
        };
      });

      try {
        return await client.transaction(async (tx) => {
          const written: Envelope[] = [];
          // Sequentially, not in parallel: the versions inside a batch are
          // ordered, and one transaction has one connection anyway.
          for (const row of rows) {
            written.push(toEnvelope((await tx.orm.public.Event.create(row)) as EventRow));
          }
          return written;
        });
      } catch (err) {
        if (isVersionConflict(err)) {
          throw new ConcurrencyError(
            streamId,
            expectedVersion,
            rows.map((r) => r.version),
            { cause: err },
          );
        }
        throw err;
      }
    },

    async read(streamId, fromVersion = 1) {
      const rows = await client.orm.public.Event.where({ streamId })
        .where((e) => e.version.gte(fromVersion))
        .orderBy((e) => e.version.asc())
        .all();
      return rows.map((r) => toEnvelope(r as EventRow));
    },

    async readAll(fromSeq, limit) {
      // `seq` is a Postgres sequence, so a value is claimed when the INSERT runs
      // and becomes visible when the transaction commits. Under concurrent
      // writers those two orders can differ: a reader can see seq 6 committed
      // while seq 5 is still in flight, and a checkpoint advanced to 6 would
      // skip 5 forever.
      //
      // It does not bite today — the conductor is the single writer, and #1 is
      // the whole of the store. It is #4's problem to solve, and it must not be
      // solved by pretending seq is gapless. The usual fix is to hold the
      // subscriber back to the oldest still-open transaction
      // (`pg_snapshot_xmin(pg_current_snapshot())`) rather than to `max(seq)`.
      const rows = await client.orm.public.Event.where((e) => e.seq.gt(fromSeq))
        .orderBy((e) => e.seq.asc())
        .limit(limit)
        .all();
      return rows.map((r) => toEnvelope(r as EventRow));
    },
  };
}

/** Bound to the process-wide client. */
export const eventStore = createEventStore(db);
