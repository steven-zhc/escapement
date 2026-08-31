# 0009 — Two connection strings, not one

**Status** accepted · 2026-08-31 · qualifies [0003](0003-postgres-event-store.md)

## Context

The event store was pointed at a Supabase database through its pooler on port
6543 with `?pgbouncer=true` — transaction mode.

A first probe looked fine: `LISTEN` then `NOTIFY` on one connection, and the
notification arrived. That probe was wrong. It ran both statements on the same
client inside a short window, so pgbouncer happened to hand them the same
backend. It tested nothing.

The real shape is a long-lived listener in the conductor and a *separate* writer
appending. Measured:

| Connection | Cross-connection NOTIFY | Advisory lock across statements |
|---|---|---|
| Pooler `:6543`, transaction mode | **silent — never arrives** | unreliable |
| Pooler `:5432`, session mode | delivered | held |

In transaction pooling the listener's backend is handed to someone else between
statements, and the `LISTEN` registration goes with it. Nothing errors. The
notification simply never comes.

**That failure mode is the dangerous part.** LISTEN/NOTIFY is the reason this
store is PostgreSQL rather than SQLite ([0003](0003-postgres-event-store.md)).
Had this shipped, the board would have looked slow, the conductor would have
looked idle, and nothing would have pointed at the connection string.

## Decision

Two variables, one database.

| | Used for |
|---|---|
| `DATABASE_URL` | pooled, transaction mode — ordinary reads and writes |
| `DIRECT_DATABASE_URL` | session mode — **migrations, `LISTEN/NOTIFY`, and session-level advisory locks** |

On Supabase the second is the same host and credentials on port 5432 with the
`pgbouncer` flag dropped. On a plain Postgres the two may be identical.

`prisma.config.ts` uses the direct URL: migrations hold locks across statements.
The subscriber and the merge lane's `pg_advisory_lock` use it too.

## Consequences

- **`esc doctor` must assert the direct connection is genuinely session mode**,
  by holding a listener open and notifying from a second connection. A check that
  only opens a connection would pass against a transaction pooler and prove
  nothing. This is now issue
  [#5](https://github.com/steven-zhc/escapement/issues/5)'s job.
- `packages/store/scripts/bootstrap.mjs` runs that check, along with the
  append-only rules and the unique constraint. Ten assertions, all passing.
- A deployment that can only offer a transaction pooler cannot run Escapement.
  Worth knowing before choosing a host, not after.
- Generalises past Supabase: PgBouncer, RDS Proxy and Neon's pooled endpoint all
  behave this way.

## Note on method

The first probe passing is the interesting part. A test that shares a connection
between the actor and the observer will confirm almost anything. The check that
matters is the one shaped like the real caller — two connections, and a pause
long enough for the pool to churn.
