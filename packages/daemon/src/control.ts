/**
 * Telling the conductor what to do, and knowing whether it is listening.
 *
 * Two mechanisms, deliberately different, because they are answering different
 * kinds of question ([0013](../../../doc/decisions/0013-daemon-hosts-the-work.md)):
 *
 * **Control goes through the log.** Pausing is a decision somebody made, and
 * `ApprovalGranted` is already that shape — "who stopped the conductor at four
 * o'clock" should not need a different mechanism than "who approved this
 * merge". It also means a command issued while the daemon is down is waiting
 * when it comes back, which is the behaviour you want rather than a race.
 *
 * **Liveness does not.** A heartbeat every few seconds, forever, fails the
 * log's admission test — *is this worth remembering later* — and would bury
 * everything that passes it. `daemon_status` is one mutable row, and it is the
 * only mutable operational state in the system.
 *
 * ## What "pause" means, precisely
 *
 * It stops the conductor **taking new work**. A run already in flight keeps
 * going. 0013 promised three verbs — drain, pause, stop — and two of them
 * turned out to be the same thing: a pass takes one item, so "finish what you
 * have and take nothing new" and "take nothing new" are one behaviour. The
 * third, killing a running agent, needs a capability the runtime does not
 * expose; until it does, a run you want gone ends when its lease expires and
 * the claim returns. Saying so is better than shipping a Stop button that
 * quietly means Pause.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { type EventStore, eventStore } from "@lingtai/store";
import { parsePayload } from "@lingtai/core";
import pg from "pg";

/** One stream for the whole installation. Control is not per-project. */
export const CONTROL_STREAM = "ctl-conductor";

export interface ControlState {
  paused: boolean;
  /** Who paused it and why, when it is paused. */
  by: string | null;
  reason: string | null;
  /** Tasks somebody asked for by hand, oldest first, not yet taken. */
  requested: { project: string; issue: string; by: string }[];
}

/** Folds the control stream. Cheap: it is a handful of events, not a history. */
export async function readControl(store: EventStore = eventStore): Promise<ControlState> {
  const events = await store.read(CONTROL_STREAM);
  const state: ControlState = { paused: false, by: null, reason: null, requested: [] };

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, string>;
    switch (e.type) {
      case "ConductorPaused":
        state.paused = true;
        state.by = d["by"] ?? null;
        state.reason = d["reason"] ?? null;
        break;
      case "ConductorResumed":
        state.paused = false;
        state.by = null;
        state.reason = null;
        break;
      case "RunRequested":
        state.requested.push({
          project: d["project"] ?? "",
          issue: d["issue"] ?? "",
          by: d["by"] ?? "",
        });
        break;
      default:
        break;
    }
  }
  return state;
}

async function append(type: string, data: unknown, store: EventStore): Promise<void> {
  const at = (await store.read(CONTROL_STREAM)).length;
  await store.append(CONTROL_STREAM, at, [
    { type, actor: (data as { by: string }).by, data: parsePayload(type as never, data) },
  ]);
}

export async function pauseConductor(
  by: string,
  reason: string,
  store: EventStore = eventStore,
): Promise<void> {
  await append("ConductorPaused", { by, reason }, store);
}

export async function resumeConductor(by: string, store: EventStore = eventStore): Promise<void> {
  await append("ConductorResumed", { by }, store);
}

export async function requestRun(
  project: string,
  issue: string,
  by: string,
  store: EventStore = eventStore,
): Promise<void> {
  await append("RunRequested", { project, issue, by }, store);
}

// ------------------------------------------------------------- liveness ----

export interface DaemonStatus {
  pid: number;
  host: string;
  startedAt: Date;
  lastSeenAt: Date;
  state: string;
  currentRunId: string | null;
}

/**
 * How often the beacon is refreshed.
 *
 * The one timer in the system, and it is not driving any decision — it says
 * "still here". Everything that *decides* still wakes on an append.
 */
export const HEARTBEAT_MS = 5_000;

/** Considered down after this long without a beat. Three missed beats. */
export const STALE_AFTER_MS = HEARTBEAT_MS * 3;

export async function createStatusTable(url = directDatabaseUrl()): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Single row, enforced by the primary key. Two daemons cannot both be up —
    // the advisory lock sees to that — so a second row would be a lie.
    await client.query(`
      create table if not exists daemon_status (
        id             int primary key default 1 check (id = 1),
        pid            int not null,
        host           text not null,
        started_at     timestamptz not null,
        last_seen_at   timestamptz not null,
        state          text not null,
        current_run_id text
      )`);
  } finally {
    await client.end();
  }
}

export async function beat(
  state: string,
  currentRunId: string | null = null,
  url = directDatabaseUrl(),
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `insert into daemon_status (id, pid, host, started_at, last_seen_at, state, current_run_id)
       values (1, $1, $2, now(), now(), $3, $4)
       on conflict (id) do update
         set pid = excluded.pid,
             host = excluded.host,
             last_seen_at = excluded.last_seen_at,
             state = excluded.state,
             current_run_id = excluded.current_run_id`,
      [process.pid, hostname(), state, currentRunId],
    );
  } finally {
    await client.end();
  }
}

/** Null when no daemon has ever run. Stale is reported, never hidden. */
export async function readStatus(url = directDatabaseUrl()): Promise<DaemonStatus | null> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query("select * from daemon_status where id = 1");
    const row = r.rows[0];
    if (!row) return null;
    return {
      pid: row.pid,
      host: row.host,
      startedAt: row.started_at,
      lastSeenAt: row.last_seen_at,
      state: row.state,
      currentRunId: row.current_run_id,
    };
  } catch (err) {
    // The table not existing means no daemon has ever started, which is a
    // state the system can be in and not an error to show a person.
    if (/does not exist/i.test((err as Error).message)) return null;
    throw err;
  } finally {
    await client.end();
  }
}

function hostname(): string {
  try {
    // Imported lazily: this file is also loaded by the board, where `os` is
    // available but the import would run on every render for one string.
    return process.env["HOSTNAME"] ?? "local";
  } catch {
    return "local";
  }
}
