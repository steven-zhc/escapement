# Escapement

Event-sourced scheduler for autonomous code agents.

An escapement is the part of a clock that lets the mainspring out one tooth at a
time. Without it the spring releases all at once. That is the job: take a queue
of work, hand each item to an agent, hold it at a series of gates, and release
it only when every gate — including a human one — has passed.

It replaces `agent-loop.sh`, a bash harness that worked 73 tickets against one
repository over four days. That harness kept its state in GitHub labels, its
history in issue comments, and its telemetry in a log file nobody parsed, and
was driven by a timer. It could not answer *what state is this ticket in*, *why
did this not merge*, or *what is waiting on me*. Everything here follows from
making those three the same append-only log.

## Status

**Phase 0 is done.** The event log can be written, read, subscribed to, reduced
to state and projected; `esc doctor` is green. Nothing runs an agent yet — the
conductor, the gates, the runtime adapters and the hook are all Phase 1. See
[`doc/roadmap.md`](doc/roadmap.md) for the phases and
[`doc/README.md`](doc/README.md) for what is settled and what is open.

## Layout

| | |
|---|---|
| `packages/core` | Event catalogue and aggregate reducers. Zero I/O, so it tests without a database. |
| `packages/config` | The recipe schema — what a managed repository puts in its own `.escapement/config.yaml`. |
| `packages/store` | The Postgres event store: append, read, subscribe, and the projection runner. Prisma 8 for reads and writes, `pg` for `LISTEN/NOTIFY` and for projections. |
| `apps/cli` | `esc` — `doctor`, and `projection lag` / `projection rebuild`. |
| `apps/board` | Next.js shell. Real cards are Phase 1. |
| `doc/` | The design, every decision, and the experiments that back them. |

## Getting started

```bash
pnpm install
cp .env.example .env.local        # then paste the connection string
pnpm contract:emit                # offline — no database needed
pnpm typecheck
```

`.env.local` lives at the repo root and is gitignored. A real environment
variable beats it, which is what makes CI and launchd work with no file at all.

**Two connection strings, one database.** `DATABASE_URL` is pooled, for ordinary
queries; `DIRECT_DATABASE_URL` is session mode, for migrations, `LISTEN/NOTIFY`
and advisory locks. A transaction pooler breaks all three, and breaks them
without erroring — see [ADR 0009](doc/decisions/0009-two-connections.md).

The event store must be **its own database**, not one belonging to a managed
project — Escapement has to keep running while a managed project is the thing
being changed.

### Bringing the database up

Prisma 8 splits planning from applying. Planning is offline; only the second
half needs a reachable database.

```bash
pnpm db:init                      # bootstrap the database and sign it
pnpm db:bootstrap                 # apply notify.sql, then prove it worked
```

`db:bootstrap` is not optional and is not Prisma's job. Prisma models tables, not
triggers, so `notify.sql` carries the two things the schema cannot express: the
`NOTIFY` trigger every subscriber wakes on, and the rules that make `events`
append-only in the database rather than by convention. The script then asserts
ten properties, including a **cross-connection** NOTIFY — the check that catches
a transaction pooler, which drops notifications silently.

An initial migration is already planned and committed; `db:plan --name <slug>` is
only needed after the contract changes.

### Checking it

```bash
pnpm esc doctor                   # non-zero exit on any failure
pnpm esc projection lag           # how far each projection is behind the log
```

`esc doctor` never writes to the event log — every check reads the catalogue,
and the one exception is a `NOTIFY`, which touches no table. It holds a listener
open, pauses long enough for a pool to churn, and notifies from a second
connection, because a check that merely opens the direct connection passes
against a transaction pooler and proves nothing
([experiment 003](doc/experiments/003-doctor-catches-a-pooler.md)).

Checks that depend on code Phase 1 has not written yet print as `skip`, naming
the issue that will fill them in.
