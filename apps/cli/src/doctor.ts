/**
 * `esc doctor` — the old `preflight()`, generalised.
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
 * repository, the environment allowlist, the hook and GitHub all depend on
 * Phase 1 code that does not exist. They are listed as `skip` with the issue
 * that will fill them in, rather than omitted — a check you cannot see is a
 * check you will forget you never had.
 */
import { githubApp, hasGitHubApp } from "@escapement/env";
import { REQUIRED_PERMISSIONS } from "@escapement/github";
import { projectionLag } from "@escapement/store";
import { createPublicKey } from "node:crypto";
import pg from "pg";

export type CheckStatus = "ok" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  /** What it found — never just a tick. */
  detail: string;
  /**
   * True for a check that is *not implemented yet*, as opposed to one skipped
   * because something earlier failed. Every one of these names the issue that
   * will fill it in; a skip with no forward pointer is a skip nobody chases.
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
  const c = new pg.Client({ connectionString: url, application_name: "escapement-doctor" });
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
  const listener = new pg.Client({ connectionString: url, application_name: "escapement-doctor" });
  const notifier = new pg.Client({ connectionString: url, application_name: "escapement-doctor" });

  try {
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (m) => void heard.push(m.payload ?? ""));
    await listener.query("LISTEN escapement_doctor");

    // Long enough that a transaction pooler would have handed the listener's
    // backend to someone else, taking the LISTEN registration with it.
    await new Promise((r) => setTimeout(r, 1_500));

    await notifier.connect();
    await notifier.query("NOTIFY escapement_doctor, 'esc doctor'");

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
    const key = "hashtext('escapement:doctor')::bigint";
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
         and rulename in ('escapement_events_no_update','escapement_events_no_delete')`,
      );
      const ruleNames = rules.rows.map((r) => r.rulename).sort();
      out.push({
        name: "schema: append-only",
        status: ruleNames.length === 2 ? "ok" : "fail",
        detail:
          ruleNames.length === 2
            ? "UPDATE and DELETE on events do nothing"
            : `only ${ruleNames.join(", ") || "no"} rule(s) present — run pnpm --filter @escapement/store db:bootstrap`,
      });

      const trig = await c.query(
        `select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where c.relname = 'events' and t.tgname = 'escapement_events_notify' and not t.tgisinternal`,
      );
      out.push({
        name: "schema: notify trigger",
        status: trig.rowCount === 1 ? "ok" : "fail",
        detail:
          trig.rowCount === 1
            ? "every append announces itself on the escapement channel"
            : "escapement_events_notify is MISSING; nothing would wake on an append — run db:bootstrap",
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
 * question, and `esc add` answers it before it writes anything. What can be
 * answered here is the one that costs an hour to diagnose otherwise: is a key
 * configured at all, and is it a key.
 */
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
        "(verified per repository by esc add)",
    };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

const DEFERRED: { name: string; detail: string }[] = [
  { name: "recipe: schema", detail: "no project is onboarded yet — run esc add <owner>/<repo> (#9)" },
  { name: "recipe vs policy conflict", detail: "no project has a policy yet — esc add writes the first one (#9)" },
  { name: "repository, base branch, submodules", detail: "needs a registered project and its worktree (#10)" },
  { name: "environment allowlist and production tripwire", detail: "needs the recipe's env block (#8)" },
  {
    name: "hook: fail closed",
    detail:
      "esc run --once proves it before dispatching anything; running it at conductor startup " +
      "belongs with the daemon (#27)",
  },
  { name: "github: installation and labels", detail: "per repository, and no project is registered yet — esc add checks it (#9)" },
];

export interface DoctorReport {
  results: CheckResult[];
  ok: number;
  failed: number;
  skipped: number;
}

export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const results: CheckResult[] = [];

  results.push({
    name: "packages load under Node",
    status: "ok",
    // Not a freebie: this process imported @escapement/core, /config and /store
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
  } else {
    results.push({
      name: "postgres",
      status: "skip",
      detail: "not attempted — the environment check failed first",
    });
  }

  results.push(githubCredentials(env));
  for (const d of DEFERRED) results.push({ ...d, status: "skip", deferred: true });

  return {
    results,
    ok: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skip").length,
  };
}

export function formatReport(report: DoctorReport): string {
  const lines = report.results.map((r) => {
    const tag = r.status === "ok" ? "  ok  " : r.status === "fail" ? " FAIL " : " skip ";
    return `${tag} ${r.name}\n         ${r.detail}`;
  });
  lines.push("");
  lines.push(
    report.failed === 0
      ? `${report.ok} ok, ${report.skipped} not implemented yet, 0 failed`
      : `${report.failed} check(s) FAILED — ${report.ok} ok, ${report.skipped} not implemented yet`,
  );
  return lines.join("\n");
}
