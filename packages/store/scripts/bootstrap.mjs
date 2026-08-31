/**
 * Applies sql/notify.sql and proves the four properties the schema alone cannot
 * express. Run after `pnpm db:init`, and again any time you doubt the database.
 *
 *   pnpm --filter @escapement/store db:bootstrap
 *
 * Everything here uses DIRECT_DATABASE_URL. Through a transaction pooler the
 * cross-connection NOTIFY check below fails silently, which is the whole reason
 * that variable exists — see doc/decisions/0009-two-connections.md.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import "../src/env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env["DIRECT_DATABASE_URL"];
if (!url) throw new Error("DIRECT_DATABASE_URL is not set");

const c = new pg.Client({ connectionString: url });
await c.connect();

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });

// ---- apply -----------------------------------------------------------------
await c.query(await readFile(resolve(here, "../sql/notify.sql"), "utf8"));
check("notify.sql applied", true);

// ---- shape -----------------------------------------------------------------
const cols = await c.query(`
  select table_name, column_name, data_type
  from information_schema.columns
  where table_schema = 'public' and table_name in ('events','checkpoints','outbox')
`);
const type = (t, col) =>
  cols.rows.find((r) => r.table_name === t && r.column_name === col)?.data_type;

check("events.data is jsonb", type("events", "data") === "jsonb", type("events", "data"));
check("outbox.payload is jsonb", type("outbox", "payload") === "jsonb", type("outbox", "payload"));
check("three tables exist", new Set(cols.rows.map((r) => r.table_name)).size === 3);

const uq = await c.query(`
  select indexdef from pg_indexes
  where tablename = 'events' and indexdef like '%UNIQUE%stream_id%version%'
`);
check("unique (stream_id, version)", uq.rowCount === 1);

// ---- optimistic concurrency ------------------------------------------------
// This constraint is the entire concurrency control. If it does not hold, two
// workers can claim the same work item.
const ev = (v) => [`wi-probe-1`, v, "WorkItemDiscovered", JSON.stringify({ probe: true }), "conductor"];
const INS = `insert into events (stream_id, version, type, data, actor)
             values ($1,$2,$3,$4::jsonb,$5) returning seq`;
const first = await c.query(INS, ev(1));
let rejected = false;
try { await c.query(INS, ev(1)); } catch (e) { rejected = e.code === "23505"; }
check("a duplicate version is rejected", rejected);

// ---- append-only -----------------------------------------------------------
// Enforced by rules, not by convention. A correction is a new event.
await c.query(`update events set actor = 'tampered' where seq = $1`, [first.rows[0].seq]);
const afterU = await c.query(`select actor from events where seq = $1`, [first.rows[0].seq]);
check("UPDATE does nothing", afterU.rows[0]?.actor === "conductor", afterU.rows[0]?.actor);

await c.query(`delete from events where seq = $1`, [first.rows[0].seq]);
const afterD = await c.query(`select count(*)::int n from events where seq = $1`, [first.rows[0].seq]);
check("DELETE does nothing", afterD.rows[0].n === 1);

// ---- the trigger, across connections ---------------------------------------
// The listener and the writer must be different connections: that is how the
// conductor and an appending worker actually relate.
const listener = new pg.Client({ connectionString: url });
await listener.connect();
const heard = [];
listener.on("notification", (m) => heard.push(m.payload));
await listener.query("LISTEN escapement");
await new Promise((r) => setTimeout(r, 500));

const second = await c.query(INS, ev(2));
await new Promise((r) => setTimeout(r, 1500));
check(
  "NOTIFY fires on insert, cross-connection",
  heard.includes(String(second.rows[0].seq)),
  heard.length ? `heard ${heard.join(",")}` : "nothing heard",
);
await listener.end();

// ---- clean up the probe rows ----------------------------------------------
// The rules block DELETE, so drop them the only way left. Real events are never
// removed; these were never real.
await c.query("alter table events disable rule escapement_events_no_delete");
await c.query("delete from events where stream_id = 'wi-probe-1'");
await c.query("alter table events enable rule escapement_events_no_delete");
const left = await c.query("select count(*)::int n from events");
check("probe rows removed", left.rows[0].n === 0, `${left.rows[0].n} rows remain`);

await c.end();

for (const { name, ok, detail } of checks) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? "  — " + detail : ""}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
