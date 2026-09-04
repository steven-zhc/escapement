/**
 * `lingtai doctor` — the old `preflight()`, generalised.
 *
 * The old loop refused to start when its guard hook failed a smoke test. That
 * instinct was right and this applies it to everything: a doctor that is green
 * is the precondition for a restart, so a merge that breaks the scheduler is
 * found *before* the scheduler fails to start (roadmap, Phase 3).
 *
 * Two rules shape what is in here.
 *
 * **It never writes.** `scripts/bootstrap.mjs` applies `notify.sql` and proves
 * the append-only rules by trying to break them, which means writing probe rows
 * to the event log. A diagnostic that appends to the system of record is the
 * wrong shape; every check below reads the catalogue instead. Bootstrap stays as
 * the write-side setup step. The one exception is `NOTIFY`, which is a
 * transient signal and touches no table.
 *
 * **A check that cannot run yet says so.** The checks for the recipe, the
 * repository, the hook and GitHub are listed as `skip` rather than omitted — a
 * check you cannot see is a check you will forget you never had. Each carries
 * the reason it is not a startup check, which is a fact about the design and
 * not about what happened to be installed the day it was written: see
 * `DEFERRED`.
 */
import {
  currentRecipe,
  deadOutbox,
  landedWithoutEndActions,
  loadProjects,
  pendingOutbox,
  resolveAgentEnv,
  runnableEnv,
} from "@lingtai/conductor";
import { createGitHubClient } from "@lingtai/github";
import { isEventType } from "@lingtai/core";
import { STALE_AFTER_MS, findOrphans, readControl, readStatus } from "@lingtai/daemon";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { REQUIRED_PERMISSIONS } from "@lingtai/github";
import { createClaudeCodeRuntime } from "@lingtai/runtime";
import { projectionLag } from "@lingtai/store";
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import pg from "pg";

/**
 * `warn` is not a weak `fail`. It means **nothing is wrong and you should know
 * anyway** — the case the vocabulary had no room for until something needed to
 * report what it could see but not control (`settings: other sources`, ADR 0016
 * §6). Folding that into `ok` hides it in a wall of green; folding it into
 * `fail` makes doctor red for a file everybody has, and a check that is always
 * red is a check nobody reads.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** What it found — never just a tick. */
  detail: string;
  /**
   * True for a check that is *not implemented here*, as opposed to one skipped
   * because something earlier failed. Its detail says why — in terms of the
   * design, naming where the property is proved instead, so that the reason
   * cannot go stale. See `DEFERRED`.
   */
  deferred?: boolean;
}

/**
 * Everything about a connection string that is safe to print.
 *
 * Never the string itself, never the user, never the password, and not the host
 * either — on a hosted Postgres the project identifier lives in the hostname.
 * Port, database and the pooler flag are what actually distinguish the two, and
 * "same host" is the one relation worth knowing.
 */
function describeUrl(raw: string): { port: string; database: string; pgbouncer: boolean; host: string } {
  const u = new URL(raw);
  return {
    port: u.port || "5432",
    database: u.pathname.replace(/^\//, "") || "(default)",
    pgbouncer: u.searchParams.get("pgbouncer") === "true",
    host: u.hostname,
  };
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, application_name: "lingtai-doctor" });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function environment(pooled: string | undefined, direct: string | undefined): CheckResult {
  if (!pooled || !direct) {
    const missing = [!pooled && "DATABASE_URL", !direct && "DIRECT_DATABASE_URL"].filter(Boolean);
    return {
      name: "environment",
      status: "fail",
      detail: `${missing.join(" and ")} not set — copy .env.example to .env.local at the repo root`,
    };
  }

  const p = describeUrl(pooled);
  const d = describeUrl(direct);
  const sameHost = p.host === d.host;
  const detail =
    `DATABASE_URL :${p.port} db=${p.database} pgbouncer=${p.pgbouncer} · ` +
    `DIRECT_DATABASE_URL :${d.port} db=${d.database} pgbouncer=${d.pgbouncer} · ` +
    `same host: ${sameHost ? "yes" : "NO"}`;

  // Two URLs against different databases is not a configuration this system has
  // any meaning for: the subscriber would be listening to one log while the
  // writer appended to another.
  if (!sameHost || p.database !== d.database) {
    return { name: "environment", status: "fail", detail: `${detail} — they must be one database` };
  }
  if (d.pgbouncer) {
    return {
      name: "environment",
      status: "fail",
      detail: `${detail} — DIRECT_DATABASE_URL still carries pgbouncer=true`,
    };
  }
  return { name: "environment", status: "ok", detail };
}

async function pooledConnection(url: string): Promise<CheckResult> {
  try {
    const version = await withClient(url, async (c) => {
      const r = await c.query<{ v: string }>("select version() as v");
      return (r.rows[0]?.v ?? "").split(" on ")[0];
    });
    return { name: "postgres: pooled connection", status: "ok", detail: version ?? "connected" };
  } catch (err) {
    return {
      name: "postgres: pooled connection",
      status: "fail",
      detail: (err as Error).message,
    };
  }
}

/**
 * The check ADR 0009 exists to demand.
 *
 * Opening the direct connection and running `select 1` proves nothing — that
 * passes against a transaction pooler, where `LISTEN/NOTIFY` and session-level
 * advisory locks both fail **silently**. So this holds a listener open, waits
 * long enough for a pool to churn, and notifies from a second connection; then
 * takes an advisory lock and asks a *separate statement* whether it is still
 * held.
 *
 * Both halves matter. The merge lane depends on the lock, and the whole
 * event-driven design depends on the notification.
 */
async function directIsSessionMode(url: string): Promise<CheckResult> {
  const name = "postgres: direct connection is session mode";
  const listener = new pg.Client({ connectionString: url, application_name: "lingtai-doctor" });
  const notifier = new pg.Client({ connectionString: url, application_name: "lingtai-doctor" });

  try {
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (m) => void heard.push(m.payload ?? ""));
    await listener.query("LISTEN lingtai_doctor");

    // Long enough that a transaction pooler would have handed the listener's
    // backend to someone else, taking the LISTEN registration with it.
    await new Promise((r) => setTimeout(r, 1_500));

    await notifier.connect();
    await notifier.query("NOTIFY lingtai_doctor, 'lingtai doctor'");

    const deadline = Date.now() + 5_000;
    while (heard.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (heard.length === 0) {
      return {
        name,
        status: "fail",
        detail:
          "a NOTIFY from a second connection never arrived — DIRECT_DATABASE_URL is not session mode. " +
          "LISTEN/NOTIFY and advisory locks will both fail silently through it (doc/decisions/0009).",
      };
    }

    // Advisory lock, held across two statements rather than within one.
    const key = "hashtext('lingtai:doctor')::bigint";
    await notifier.query(`select pg_advisory_lock(${key})`);
    const held = await notifier.query<{ n: string }>(
      `select count(*)::text as n from pg_locks
       where locktype = 'advisory' and pid = pg_backend_pid() and objid = (${key})::int`,
    );
    await notifier.query(`select pg_advisory_unlock(${key})`);

    if (Number(held.rows[0]?.n ?? "0") === 0) {
      return {
        name,
        status: "fail",
        detail:
          "an advisory lock was not still held by the next statement — the merge lane cannot serialise on this connection",
      };
    }

    return {
      name,
      status: "ok",
      detail: "cross-connection NOTIFY delivered after a 1.5s pause, and an advisory lock survived a second statement",
    };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  } finally {
    await listener.end().catch(() => {});
    await notifier.end().catch(() => {});
  }
}

/**
 * The write model, read from the catalogue rather than exercised.
 *
 * `UNIQUE (stream_id, version)` is the entire concurrency control; the rules are
 * what make the log append-only by the database rather than by convention; the
 * trigger is what makes the system event-driven at all. Each one missing is a
 * different silent failure.
 */
async function schema(url: string): Promise<CheckResult[]> {
  try {
    return await withClient(url, async (c) => {
      const out: CheckResult[] = [];

      const tables = await c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_name in ('events','checkpoints','outbox')`,
      );
      const found = tables.rows.map((r) => r.table_name).sort();
      out.push({
        name: "schema: tables",
        status: found.length === 3 ? "ok" : "fail",
        detail: found.length === 3 ? found.join(", ") : `found ${found.join(", ") || "none"} — expected all three`,
      });

      const uq = await c.query(
        `select 1 from pg_indexes where tablename = 'events'
         and indexdef like '%UNIQUE%stream_id%version%'`,
      );
      out.push({
        name: "schema: optimistic concurrency",
        status: uq.rowCount === 1 ? "ok" : "fail",
        detail:
          uq.rowCount === 1
            ? "UNIQUE (stream_id, version) present — the whole of the concurrency control"
            : "UNIQUE (stream_id, version) is MISSING; two workers can claim one work item",
      });

      const rules = await c.query<{ rulename: string }>(
        `select rulename from pg_rules where tablename = 'events'
         and rulename in ('lingtai_events_no_update','lingtai_events_no_delete')`,
      );
      const ruleNames = rules.rows.map((r) => r.rulename).sort();
      out.push({
        name: "schema: append-only",
        status: ruleNames.length === 2 ? "ok" : "fail",
        detail:
          ruleNames.length === 2
            ? "UPDATE and DELETE on events do nothing"
            : `only ${ruleNames.join(", ") || "no"} rule(s) present — run pnpm --filter @lingtai/store db:bootstrap`,
      });

      const trig = await c.query(
        `select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where c.relname = 'events' and t.tgname = 'lingtai_events_notify' and not t.tgisinternal`,
      );
      out.push({
        name: "schema: notify trigger",
        status: trig.rowCount === 1 ? "ok" : "fail",
        detail:
          trig.rowCount === 1
            ? "every append announces itself on the lingtai channel"
            : "lingtai_events_notify is MISSING; nothing would wake on an append — run db:bootstrap",
      });

      const jsonb = await c.query<{ table_name: string; column_name: string; data_type: string }>(
        `select table_name, column_name, data_type from information_schema.columns
         where table_schema = 'public'
           and (table_name, column_name) in (('events','data'), ('outbox','payload'))`,
      );
      const wrong = jsonb.rows.filter((r) => r.data_type !== "jsonb");
      out.push({
        name: "schema: payload columns",
        status: jsonb.rows.length === 2 && wrong.length === 0 ? "ok" : "fail",
        detail:
          wrong.length === 0
            ? "events.data and outbox.payload are jsonb"
            : wrong.map((r) => `${r.table_name}.${r.column_name} is ${r.data_type}`).join(", "),
      });

      return out;
    });
  } catch (err) {
    return [{ name: "schema", status: "fail", detail: (err as Error).message }];
  }
}

async function projections(url: string): Promise<CheckResult> {
  try {
    const lags = await projectionLag(url);
    if (lags.length === 0) {
      return {
        name: "projections: lag",
        status: "ok",
        detail: "no projection has a checkpoint yet — nothing is running to fall behind",
      };
    }
    const detail = lags
      .map((l) => `${l.name} at ${l.lastSeq}/${l.headSeq} (${l.lag} behind)`)
      .join(" · ");
    // Reported, not failed. With no daemon yet, every projection is behind
    // whenever nothing is running it — that is expected, not broken. Once the
    // conductor runs as a daemon (#27), lag plus a stale `updatedAt` becomes a
    // real failure and this is where it belongs.
    return { name: "projections: lag", status: "ok", detail };
  } catch (err) {
    return { name: "projections: lag", status: "fail", detail: (err as Error).message };
  }
}

/**
 * Checks that belong here and cannot run yet.
 *
 * Listed rather than omitted. A doctor whose output silently shrinks to what
 * happens to be implemented is how a missing check becomes invisible — which is
 * the exact failure mode of the system this replaces.
 */
/**
 * The App's credentials, without contacting GitHub.
 *
 * Whether an installation actually grants the four permissions is a per-repository
 * question, and `lingtai add` answers it before it writes anything. What can be
 * answered here is the one that costs an hour to diagnose otherwise: is a key
 * configured at all, and is it a key.
 */
/**
 * Whether the agent runtime can sign in **in the environment a run gets**.
 *
 * That qualifier is the entire check. The operator being signed in tells you
 * nothing: the first real run against a repository died on "Not logged in ·
 * Please run /login" while the operator was signed in perfectly well, because
 * a run's environment is filtered and had no `USER` — and macOS finds a
 * keychain item by who is asking. A check that probed `process.env` would have
 * been green throughout.
 *
 * `claude auth status` is free; it reads the credential and does not call the
 * API. Its exit code is 0 whether or not you are signed in, so the field is the
 * answer.
 */
/**
 * What else is configuring the agent, besides the recipe.
 *
 * Reports rather than enforces, and that is the whole point. Lingtai does not
 * set `HOME` — it cannot, because the runtime's credentials live under it — so
 * the operator's own `~/.claude/settings.json` is in scope for every run, along
 * with any `.claude/settings.json` the managed repository has committed. Both
 * merge with the settings Lingtai writes; hooks from every source run, and
 * `permissions.deny` from any of them holds.
 *
 * That means **the recipe is not a complete description of a run**, and since
 * deleting the guard (ADR 0016 §6) this is the only visibility that exists into
 * the difference. Being unable to control it is acceptable. Being unable to see
 * it is not — which is exactly the failure the old loop's 132 invisible blocks
 * were.
 *
 * Never a `fail`: none of this is wrong, and a check that goes red for a
 * `settings.json` everyone has is a check people learn to skip.
 */
async function settingsSources(): Promise<CheckResult> {
  const name = "runtime: other settings in scope";
  const path = join(homedir(), ".claude", "settings.json");

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { name, status: "ok", detail: "no ~/.claude/settings.json — the recipe is the whole story" };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return { name, status: "warn", detail: `~/.claude/settings.json does not parse: ${(err as Error).message}` };
  }

  // Only the keys that change what a run does. Everything else there is the
  // operator's business and is not worth naming.
  const carries: string[] = [];
  if (parsed["hooks"]) carries.push("hooks");
  if (parsed["permissions"]) carries.push("permissions");
  if (parsed["mcpServers"] || parsed["enabledMcpjsonServers"]) carries.push("MCP servers");
  if (parsed["env"]) carries.push("env");

  if (carries.length === 0) {
    return { name, status: "ok", detail: "~/.claude/settings.json carries nothing that changes a run" };
  }
  return {
    name,
    status: "warn",
    detail:
      `~/.claude/settings.json carries ${carries.join(", ")}, and every run sees it. ` +
      "Lingtai cannot set HOME (the runtime's credentials live there), so this is " +
      "reported rather than removed — the recipe alone does not describe a run on this machine.",
  };
}

async function runtimeAuth(): Promise<CheckResult> {
  const name = "runtime: signed in";
  const runtime = createClaudeCodeRuntime();
  if (!runtime.checkAuth) {
    return { name, status: "skip", detail: `${runtime.capabilities.id} cannot be asked cheaply` };
  }

  // Exactly what a run gets. Not `process.env`.
  const env = runnableEnv({});
  const status = await runtime.checkAuth(env);

  if (status.loggedIn) {
    return { name, status: "ok", detail: `${runtime.capabilities.id} — ${status.detail}` };
  }
  return {
    name,
    status: "fail",
    detail:
      `${runtime.capabilities.id} reports ${status.detail}, in the filtered environment a run gets ` +
      `(${Object.keys(env).sort().join(", ")}). ` +
      "If you are signed in yourself, the run's environment is missing something the credential " +
      "store needs — on macOS that is USER, because a keychain item is found by who is asking.",
  };
}

function githubCredentials(env: NodeJS.ProcessEnv): CheckResult {
  const name = "github: app credentials";
  if (!hasGitHubApp(env)) {
    return {
      name,
      status: "skip",
      detail:
        "GITHUB_APP_ID and a private key are not set — no repository can be onboarded yet. " +
        "See doc/decisions/0006-github-app.md.",
    };
  }
  try {
    const app = githubApp(env);
    // Parsing it proves it is a key rather than a path typo or a truncated
    // paste, and does so without the key going anywhere.
    createPublicKey(app.privateKey);
    return {
      name,
      status: "ok",
      detail:
        `app ${app.appId}, key from ${app.keySource} · ` +
        `requires ${REQUIRED_PERMISSIONS.map((p) => `${p.name}:${p.level}`).join(", ")} ` +
        "(verified per repository by lingtai add)",
    };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

/**
 * The checks that are listed but not run, each with the reason it is not one.
 *
 * These details are literals, and a literal cannot re-read the world: whatever
 * one asserts about this installation goes on being asserted long after it
 * stops being true. Two of them said no project was onboarded while two were,
 * and a reader who took that at face value went and re-ran `lingtai add`.
 *
 * So the rule, enforced by a test rather than remembered: **a deferred detail
 * says why the check is not a startup check — of the design, and where the
 * property is proved instead — and claims nothing about the state of this
 * machine.** State worth reporting is a check that reads it, next to the ones
 * above. Issue numbers are the same trap one step removed, because an issue
 * closes; a reason that stands on its own does not carry one.
 */
const DEFERRED: { name: string; detail: string }[] = [
  {
    name: "recipe: schema",
    detail:
      "a recipe governs one project and is read from origin/<base> through the API as a run starts; " +
      "resolveRecipe validates it there and refuses the run when it does not parse, so a copy read " +
      "here would be a different commit's (doc/decisions/0005-config-in-target-repo.md)",
  },
  {
    name: "repository, base branch, submodules",
    detail:
      "only a clone settles these: every run cuts its branch from origin/<base> in the mirror and " +
      "initialises submodules from it, and stops there when it cannot. Doctor reads — it does not " +
      "fetch, clone or check out",
  },
  {
    name: "hook: fail closed",
    detail:
      "every run proves it immediately before dispatching, which is the check that matters; " +
      "proving it once at daemon startup as well would only surface a missing binary earlier (#48)",
  },
  {
    name: "github: installation and labels",
    detail:
      "per repository: lingtai add checks the App's permissions before it records anything, so the " +
      "gap a startup check would look for stops the one command that can act on it. Labels are " +
      "written out by the github_mirror projection and never read back, so there is no drift to find",
  },
];

export interface DoctorReport {
  results: CheckResult[];
  ok: number;
  failed: number;
  skipped: number;
  /** Reported, not wrong. See `CheckStatus`. */
  warned: number;
}

/**
 * Is the daemon up, and is it taking work?
 *
 * This is the check that would have turned an hour of confusion into a glance.
 * Two work items merged into `develop` for real while their cards sat in
 * "waiting on you", because nothing was advancing the projections and nothing
 * said so — from outside, a button that did nothing.
 *
 * A daemon that is down is **not a failure here**. Not running one is a
 * legitimate state, and `lingtai run` still works by hand. What would be a failure
 * is not being able to tell.
 */
async function daemonLiveness(): Promise<CheckResult> {
  const status = await readStatus().catch(() => null);
  // Read before the early return. A pause is in force whether or not a daemon
  // has ever run, and it is exactly the thing somebody will forget they set —
  // reporting liveness without it would be the same silence this check exists
  // to break.
  const control = await readControl().catch(() => null);
  const paused = control?.paused ? `, paused by ${control.by} (${control.reason})` : "";

  if (!status) {
    return {
      name: "daemon: liveness",
      status: "ok",
      detail: `no daemon has run — lingtai run works by hand; lingtai daemon takes the queue${paused}`,
    };
  }

  const age = Date.now() - status.lastSeenAt.getTime();

  if (age > STALE_AFTER_MS) {
    return {
      name: "daemon: liveness",
      status: "ok",
      // Reported, not failed: a stopped daemon is a choice as often as a
      // crash, and doctor exiting non-zero on it would make the command
      // useless as a restart gate.
      detail: `last seen ${Math.round(age / 1000)}s ago (pid ${status.pid}) — not running${paused}`,
    };
  }
  return {
    name: "daemon: liveness",
    status: "ok",
    detail: `${status.state}, last beat ${Math.round(age / 1000)}s ago${paused}`,
  };
}

/**
 * What a restart would tidy up, without tidying it up.
 *
 * `dryRun` is the whole point: a check that changed the thing it was checking
 * would tell you about a state that no longer exists by the time you read it.
 */
async function orphans(): Promise<CheckResult> {
  const found = await findOrphans({ dryRun: true }).catch(() => null);
  if (found === null) {
    return { name: "worktrees: reconciliation", status: "ok", detail: "could not read the worktree directory" };
  }
  if (found.length === 0) {
    return { name: "worktrees: reconciliation", status: "ok", detail: "nothing left over" };
  }
  return {
    name: "worktrees: reconciliation",
    status: "ok",
    // Reported, not failed. Leftovers are a normal consequence of a kill, and
    // starting the daemon clears them — a red doctor here would train people
    // to ignore a red doctor.
    detail: `${found.length} left over; lingtai daemon removes them on startup: ${found
      .map((f) => f.stream)
      .join(", ")}`,
  };
}

/**
 * Whether the log holds an event type this build cannot read.
 *
 * The check that would have caught the defect [ADR 0019](../../../doc/decisions/0019-a-second-reset.md)
 * is about. 3c′ deleted three event types while the log held six rows of two of
 * them, and `toEnvelope` throws on a type the catalogue does not know — so every
 * run stream in the log was unreadable from its first row and
 * `lingtai projection rebuild` could not run at all. **Nothing said so.** Both
 * projections were past those rows, and a follower never looks back.
 *
 * A failure here means one of two things, and the detail says which is not
 * knowable from here: a type was deleted while its rows were still in the log,
 * or this build is older than the writer. Either way the log is not fully
 * replayable, which is the one property the whole system rests on.
 */
async function readableTypes(url: string): Promise<CheckResult> {
  const name = "log: every type is readable";
  const rows = await withClient(url, (c) =>
    c.query<{ type: string; n: number }>(
      `select type, count(*)::int as n from events group by type order by type`,
    ),
  ).catch(() => null);
  if (rows === null) return { name, status: "ok", detail: "no log to read yet" };

  const orphaned = rows.rows.filter((r) => !isEventType(r.type));
  if (orphaned.length === 0) {
    return { name, status: "ok", detail: `${rows.rows.length} types, all in the catalogue` };
  }
  return {
    name,
    status: "fail",
    detail:
      `${orphaned.reduce((n, r) => n + r.n, 0)} row(s) of ${orphaned.length} type(s) this build cannot read — ` +
      `${orphaned.map((r) => `${r.type} ×${r.n}`).join(", ")}. ` +
      "Reading any stream that holds one throws, and a projection rebuild cannot run.",
  };
}

/**
 * Items that landed with an `end` point that was configured and did not run.
 *
 * The comparison [ADR 0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md)
 * promised, and the one that would have found #55 the day it happened.
 * `GatesResolved` names all five points and the actions resolved for each, so
 * "the recipe asked for something at `end`" is in the log; `EndActionsResolved`
 * is the record that the point ran. An item that landed, whose run planned
 * actions at `end`, and whose stream holds no resolution, is a gate that was
 * configured and did not run — which [0016](../../../doc/decisions/0016-the-settled-model.md)
 * §4 calls Lingtai's bug rather than the operator's.
 *
 * **A failure, not a note.** Nothing on the issue shows that Lingtai touched
 * it, and the gap is invisible from GitHub: the ticket stays open and looks
 * exactly like one nothing ever ran on. That invisibility is why two issues sat
 * merged and open for a day with no signal anywhere.
 *
 * From the log alone, and from the *item's own stream* for the second half, so
 * it says nothing about what the recipe happens to contain today.
 */
async function endPointRan(url: string): Promise<CheckResult> {
  const name = "gates: end ran on what landed";
  const found = await landedWithoutEndActions(url).catch(() => null);
  if (found === null) return { name, status: "ok", detail: "no log to read yet" };

  if (found.length === 0) {
    return { name, status: "ok", detail: "every landed item with end actions resolved them" };
  }
  return {
    name,
    status: "fail",
    detail:
      `${found.length} item(s) landed with actions planned at end and none resolved — ` +
      `${found.map((f) => `${f.project}#${f.issue}`).join(", ")}. ` +
      "Their issues were never closed or labelled, and nothing on GitHub says Lingtai " +
      "touched them: lingtai end replay resolves the point as it should have been.",
  };
}

/**
 * How much is queued to go out, and how much never will.
 *
 * Depth is reported; **dead letters fail**. That asymmetry is the point. A
 * backlog is usually a daemon that has been down and will drain on its own; a
 * permanently failed delivery is a thing somebody has to look at, and it is
 * exactly what the old loop lost — a `gh` call that failed inline left no trace
 * at all, so nobody could tell "we never commented" from "we commented and it
 * did not help".
 */
async function outbox(): Promise<CheckResult> {
  const pending = await pendingOutbox({ limit: 1000 }).catch(() => null);
  if (pending === null) {
    return { name: "outbox: depth", status: "ok", detail: "no outbox yet — nothing has been queued" };
  }
  const dead = await deadOutbox().catch(() => []);

  if (dead.length > 0) {
    return {
      name: "outbox: depth",
      status: "fail",
      detail:
        `${dead.length} will never be delivered — ` +
        dead.slice(0, 3).map((d) => `${d.project}#${d.target}: ${d.lastError}`).join("; "),
    };
  }
  return {
    name: "outbox: depth",
    status: "ok",
    detail: pending.length === 0 ? "empty" : `${pending.length} waiting to go out`,
  };
}

/**
 * Per project: every name its recipe requires, and **which layer answered**.
 *
 * The half of [ADR 0020](../../../doc/decisions/0020-the-agent-environment-in-layers.md)
 * that costs nothing. The other half — refusing the project — happens in
 * `runOnce`, after a pass has already been started and a recipe fetched; this
 * answers the same question before anyone spends anything, which is what makes
 * the difference between `lingtai run` in your shell and `lingtai daemon` under
 * launchd visible rather than guessed at. Run doctor in the daemon's own
 * environment and the discrepancy is in the output.
 *
 * **Names only, never values.** A `.env` file's whole point is that its contents
 * do not appear in a terminal, a screenshot or a paste.
 *
 * A missing name is a `fail` here, because the run it describes cannot happen.
 * That is the one place doctor is allowed to be red about a project rather than
 * about the installation: a red that names the file to write is a red somebody
 * can clear.
 */
async function declaredEnvironment(env: NodeJS.ProcessEnv): Promise<CheckResult[]> {
  const name = "env: declared names, and which layer";
  if (!hasGitHubApp(env)) {
    return [
      {
        name,
        status: "skip",
        detail: "no App configured, so no recipe can be read — the required names are the recipe's",
      },
    ];
  }

  const projects = await loadProjects().catch(() => null);
  if (projects === null) {
    return [{ name, status: "skip", detail: "the project streams could not be read" }];
  }
  if (projects.length === 0) {
    return [{ name, status: "ok", detail: "no project has a recipe to declare anything yet" }];
  }

  const results: CheckResult[] = [];
  for (const project of projects) {
    if (!project.project || !project.owner) continue;
    const label = `env: ${project.project}`;
    try {
      const client = await createGitHubClient({
        auth: githubApp(env),
        owner: project.owner,
        repo: project.project,
      });
      const resolved = await currentRecipe(project, client);
      const agentEnv = await resolveAgentEnv({
        project: project.project,
        required: resolved.recipe.env.required,
      });

      if (agentEnv.names.length === 0) {
        results.push({
          name: label,
          status: "ok",
          detail: `nothing required · ${basename(agentEnv.file)} is where a value would go`,
        });
        continue;
      }
      const detail = agentEnv.names
        .map(
          (n) =>
            `${n.name} ← ${n.layer === "project file" ? basename(agentEnv.file) : n.layer}`,
        )
        .join(" · ");
      results.push({
        name: label,
        status: agentEnv.missing.length > 0 ? "fail" : "ok",
        detail: agentEnv.refusal ? `${detail}\n${agentEnv.refusal}` : detail,
      });
    } catch (err) {
      // Includes `ProductionValueError`, which names the variable and the
      // pattern it matched and no part of the value.
      results.push({ name: label, status: "fail", detail: (err as Error).message });
    }
  }
  return results;
}

export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const results: CheckResult[] = [];

  results.push({
    name: "packages load under Node",
    status: "ok",
    // Not a freebie: this process imported @lingtai/core, /config and /store
    // through Node's type stripping to get here. A `.js` specifier in a barrel or
    // a constructor parameter property would have stopped it, and neither `tsc`
    // nor a board build notices either. See doc/decisions/0010.
    detail: "core, config and store imported by this process",
  });

  const pooled = env["DATABASE_URL"];
  const direct = env["DIRECT_DATABASE_URL"];
  const envResult = environment(pooled, direct);
  results.push(envResult);

  if (envResult.status === "ok" && pooled && direct) {
    results.push(await pooledConnection(pooled));
    results.push(await directIsSessionMode(direct));
    results.push(...(await schema(direct)));
    results.push(await projections(pooled));
    results.push(await daemonLiveness());
    results.push(await readableTypes(direct));
    results.push(await orphans());
    results.push(await outbox());
    results.push(await endPointRan(direct));
  } else {
    results.push({
      name: "postgres",
      status: "skip",
      detail: "not attempted — the environment check failed first",
    });
  }

  results.push(githubCredentials(env));
  results.push(...(await declaredEnvironment(env)));
  results.push(await settingsSources());
  results.push(await runtimeAuth());
  for (const d of DEFERRED) results.push({ ...d, status: "skip", deferred: true });

  return {
    results,
    ok: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skip").length,
    warned: results.filter((r) => r.status === "warn").length,
  };
}

export function formatReport(report: DoctorReport): string {
  const notes = report.warned > 0 ? `, ${report.warned} to note` : "";
  const lines = report.results.map((r) => {
    const tag =
      r.status === "ok" ? "  ok  " : r.status === "fail" ? " FAIL " : r.status === "warn" ? " note " : " skip ";
    return `${tag} ${r.name}\n         ${r.detail}`;
  });
  lines.push("");
  lines.push(
    report.failed === 0
      ? `${report.ok} ok${notes}, ${report.skipped} not implemented yet, 0 failed`
      : `${report.failed} check(s) FAILED — ${report.ok} ok${notes}, ${report.skipped} not implemented yet`,
  );
  return lines.join("\n");
}
