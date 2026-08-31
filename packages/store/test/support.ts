/**
 * Shared plumbing for the tests that hit the real database.
 *
 * They hit it on purpose: `UNIQUE (stream_id, version)` and `LISTEN/NOTIFY` are
 * the two things this store is built on, and neither can be demonstrated by a
 * mock — nor by a single connection, which is the mistake
 * doc/decisions/0009-two-connections.md exists to record.
 */
import pg from "pg";
import { directDatabaseUrl } from "../src/env.ts";

/** Streams created by the current file, so cleanup can name them exactly. */
export const created = new Set<string>();

export function streamId(prefix = "wi-test"): string {
  const id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  created.add(id);
  return id;
}

/** A valid `WorkItemDiscovered` with a distinguishable title. */
export const discovered = (title: string) => ({
  type: "WorkItemDiscovered",
  actor: "conductor",
  data: {
    project: "escapement",
    source: "manual" as const,
    externalRef: "test",
    title,
    kind: "tech-debt" as const,
    labels: [],
  },
});

async function direct<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** The log's high-water mark, so a subscriber can start from "now". */
export function currentMaxSeq(): Promise<bigint> {
  return direct(async (c) => {
    const r = await c.query("select coalesce(max(seq), 0)::text s from events");
    return BigInt(r.rows[0].s as string);
  });
}

/**
 * Ends one backend by pid. This is how a mid-stream disconnect gets tested
 * without waiting for one to happen.
 *
 * By pid and not by `application_name`, because `DIRECT_DATABASE_URL` is
 * Supavisor in session mode and it reports every connection through it as
 * `Supavisor` — the name is not ours to filter on. A session-mode pooler does
 * pin one client to one backend, so terminating the pid the listener reports
 * genuinely severs the listener.
 */
export function killBackend(pid: number): Promise<boolean> {
  return direct(async (c) => {
    const r = await c.query<{ ok: boolean }>("select pg_terminate_backend($1) as ok", [pid]);
    return r.rows[0]?.ok === true;
  });
}

/**
 * Removes every stream the file created.
 *
 * The append-only rules block DELETE, which is the point of them, so this has to
 * disable one — a global `ALTER TABLE`. Do not run these tests against a
 * database a conductor is writing to. The rule is re-enabled even if the delete
 * throws: a live database left without its append-only guarantee is far worse
 * than a failing test.
 */
export async function cleanupStreams(): Promise<void> {
  if (created.size === 0) return;
  await direct(async (c) => {
    try {
      await c.query("alter table events disable rule escapement_events_no_delete");
      await c.query("delete from events where stream_id = any($1::text[])", [[...created]]);
    } finally {
      await c.query("alter table events enable rule escapement_events_no_delete");
    }
  });
  created.clear();
}

/** Polls until `predicate` holds, or fails with what it last saw. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  describe: () => string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting: ${describe()}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
