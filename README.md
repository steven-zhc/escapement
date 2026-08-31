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

Skeleton. The event and configuration schemas are written and typecheck; the
store, conductor, gates, runtimes and board are not. See
[`doc/README.md`](doc/README.md) for what is settled and what is next.

## Layout

| | |
|---|---|
| `packages/core` | Event catalogue and aggregate reducers. Zero I/O, so it tests without a database. |
| `packages/config` | The recipe schema — what a managed repository puts in its own `.escapement/config.yaml`. |
| `packages/store` | The Postgres event store. Prisma 8 for reads and writes, `pg` for `LISTEN/NOTIFY`. |
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

The event store must be **its own database**, not one belonging to a managed
project — Escapement has to keep running while a managed project is the thing
being changed.

### Bringing the database up

Prisma 8 splits planning from applying. Planning is offline; only the second
half needs a reachable database.

```bash
pnpm db:plan --name initial       # contract -> migrations/, offline
pnpm db:init                      # bootstrap the database and sign it
pnpm db:verify                    # marker and live schema match the contract

psql "$DATABASE_URL" -f packages/store/sql/notify.sql
```

That last step is not optional and is not Prisma's job. Prisma models tables,
not triggers, and `notify.sql` carries two things the schema cannot express: the
`NOTIFY` trigger every subscriber wakes on, and the rules that make `events`
append-only in the database rather than by convention.

An initial migration is already planned and committed, so `db:plan` is only
needed after the contract changes.
