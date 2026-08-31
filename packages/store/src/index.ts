export { db } from "./db.js";

/**
 * The append/read/subscribe surface is not written yet — it needs a live
 * DATABASE_URL, which is the one outstanding item (see doc/README.md).
 *
 * The shape it has to have:
 *
 *   append(streamId, expectedVersion, events)  a unique violation on
 *                                              (stream_id, version) means
 *                                              another writer won; re-read and
 *                                              retry. That constraint is the
 *                                              entire concurrency control.
 *   read(streamId, fromVersion?)               ordered events for one stream
 *   readAll(fromSeq, limit)                    projection catch-up
 *   subscribe(onSeq)                           pg LISTEN 'escapement'
 *
 * `subscribe` is the one part that cannot go through Prisma: it has no
 * LISTEN/NOTIFY, so it takes a dedicated `pg` connection alongside. That split
 * is deliberate, not an oversight — see doc/decisions/0004-prisma.md.
 */
