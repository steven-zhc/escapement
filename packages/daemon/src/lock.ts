/**
 * Exactly one daemon, decided by Postgres rather than by a pid file.
 *
 * A second daemon is not a hypothetical: launchd keeps one alive, and the
 * obvious way to debug it is to run `lingtai daemon` in a terminal while that one
 * is still up. Two conductors racing for the same ticket is the failure that
 * makes the whole claim mechanism pointless — and it would present as an
 * expensive mystery rather than an error.
 *
 * A session-level advisory lock is the right shape because it is held by the
 * *connection*: a killed daemon releases it when its socket closes, with
 * nothing to clean up and no stale file to explain. Same mechanism the merge
 * lane already uses, for the same reason.
 *
 * Losing is not an error. The second process exits 0 saying who holds it —
 * `lingtai daemon` while launchd's copy is running is a reasonable thing to do,
 * and greeting it with a stack trace would teach people to ignore stack traces.
 */
import { directDatabaseUrl } from "@lingtai/env";
import pg from "pg";

/** One lock for the whole daemon, per database. Hashed to the bigint the API takes. */
export const DAEMON_LOCK_KEY = "lingtai:daemon";

export interface DaemonLock {
  /** Releases the lock and closes the connection that held it. */
  release(): Promise<void>;
}

export type LockResult =
  | { ok: true; lock: DaemonLock }
  /** Somebody else holds it. `holder` is their pid and host, when they recorded one. */
  | { ok: false; holder: string | null };

export interface AcquireOptions {
  /**
   * Session mode, not the pooler. A transaction-mode connection can hand the
   * next statement a different backend, and a session lock held by a backend
   * you no longer have is a lock you cannot release — see ADR 0009.
   */
  url?: string;
  key?: string;
}

export async function acquireDaemonLock(options: AcquireOptions = {}): Promise<LockResult> {
  const client = new pg.Client({ connectionString: options.url ?? directDatabaseUrl() });
  await client.connect();

  try {
    const key = options.key ?? DAEMON_LOCK_KEY;
    const got = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)::bigint) as locked",
      [key],
    );

    if (!got.rows[0]?.locked) {
      // Best effort. `pg_locks` says a lock is held but not by whom in any
      // useful sense, so this reports the backend's own description rather
      // than inventing a name.
      const who = await client
        .query<{ holder: string }>(
          `select coalesce(a.application_name, '') || ' pid ' || a.pid::text as holder
           from pg_locks l
           join pg_stat_activity a on a.pid = l.pid
           where l.locktype = 'advisory' and l.objid = (hashtext($1)::bigint & 4294967295)
           limit 1`,
          [key],
        )
        .catch(() => null);
      await client.end();
      return { ok: false, holder: who?.rows[0]?.holder?.trim() ?? null };
    }

    return {
      ok: true,
      lock: {
        async release() {
          // Ending the connection would release it anyway. Unlocking first
          // means a daemon that is shutting down cleanly does not depend on
          // socket teardown timing to let the next one start.
          await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [key]).catch(() => {});
          await client.end().catch(() => {});
        },
      },
    };
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
}
