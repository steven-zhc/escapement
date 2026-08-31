export { createDb, db, type Db } from "./db.ts";
export {
  ConcurrencyError,
  createEventStore,
  eventStore,
  SchemaVersionUnsupportedError,
  UnknownEventTypeError,
  type EventStore,
} from "./event-store.ts";
export { parseTimestamptz } from "./timestamptz.ts";

/**
 * Still missing, and next:
 *
 *   subscribe(onSeq)   pg LISTEN 'escapement'  — issue #2
 *
 * It is the one part that cannot go through Prisma, which has no LISTEN/NOTIFY,
 * so it takes a dedicated `pg` connection alongside. That split is deliberate,
 * not an oversight — see doc/decisions/0004-prisma.md. It must use
 * `directDatabaseUrl()`: through a transaction pooler a cross-connection NOTIFY
 * never arrives and never errors (doc/decisions/0009-two-connections.md).
 */
