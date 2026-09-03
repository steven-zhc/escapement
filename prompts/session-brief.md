You are continuing work on **Lingtai**, at `~/workspace/nextloom-ai/lingtai`
(GitHub: `steven-zhc/lingtai`, private). Work from that directory.

Lingtai is an event-sourced scheduler for autonomous code agents. It replaces
`agent-loop.sh`, a bash harness that worked 73 tickets over four days and could
not answer *what state is this ticket in*, *why did this not merge*, or *what is
waiting on me* — because state lived in GitHub labels, history in issue comments,
and telemetry in a log nobody parsed. All three become one append-only log here.

## Read these first, in this order

1. `doc/README.md` — the index, and what is still open
2. `doc/roadmap.md` — six phases with exit criteria, and the full backlog with issue numbers
3. `doc/design.md` — how the system works
4. `doc/decisions/*.md` — nine ADRs. **0004 and 0009 will save you hours.**

Do not skip these. Most of what looks like an arbitrary choice in this codebase
has a measured reason behind it, and the reasons are written down.

## Where things stand

Phase 0, in progress. The database is live and issue #6 is closed.

| | |
|---|---|
| `packages/core` | Event catalogue and envelope. 32 events, zod schemas. Zero I/O. |
| `packages/config` | Recipe schema for a managed repo's `.lingtai/config.yaml`. |
| `packages/store` | Prisma 8 contract, initial migration applied, `notify.sql` applied. **No read/write API yet — that is #1.** |
| `apps/board` | Next.js 16 shell. Five columns, real palette, SSE endpoint stubbed. `loadBoard()` returns empty columns. |

**Nothing executes yet.** No conductor, no gates, no runtime adapter, no CLI.

Next task is **#1 — Store: append and read, with optimistic concurrency**, then
#2, #3, #4, #5. Read the issue body; the acceptance criteria are specific and
some were amended after #6 closed.

## Five things that will waste your time if you assume otherwise

**1. Prisma 8 is not Prisma 7.** It is a re-architected product.

- There is no `prisma generate`. It is `prisma contract emit`.
- The runtime package is `@prisma/orm-postgres`, **not `@prisma/client`** — which has no 8.x release at all. Searching for one is a dead end.
- The schema is `src/prisma/contract.prisma` with a `// use prisma-next` pragma, no `generator` or `datasource` blocks, and scalars like `TimestamptzString`, `Jsonb`, `temporal.updatedAtString()`.
- Config is `prisma.config.ts`. Migrations are `prisma migration plan` (offline) then `prisma db init` / `prisma db migrate`.
- Query API: `db.orm.public.Event.where({...}).first()`.
- Versions are pinned to exact prereleases on purpose. Do not widen them to ranges.

**2. There are two connection strings, and using the wrong one fails silently.**

`DATABASE_URL` is a pooled transaction-mode connection. `DIRECT_DATABASE_URL` is
session mode against the same database.

Migrations, `LISTEN/NOTIFY` and session-level advisory locks **all require the
direct one**. Through a transaction pooler a cross-connection `NOTIFY` never
arrives *and never errors* — the system would look merely slow. Read
`doc/decisions/0009-two-connections.md` before you touch the store.

A corollary that matters for tests: **a LISTEN/NOTIFY test that uses one
connection for both proves nothing.** It passes against a transaction pooler. The
check must hold a listener open and notify from a second connection, with a pause
long enough for a pool to churn.

**3. pnpm 11 spells it `allowBuilds`,** not `onlyBuiltDependencies`. It is already
set in `pnpm-workspace.yaml` for esbuild, workerd and msgpackr-extract, which
Prisma's CLI engine needs.

**4. Environment loads from the repo root.** `packages/store/src/env.ts` resolves
`.env.local` then `.env` from the workspace root, not from the current directory.
A real environment variable beats both. Use `databaseUrl()` and
`directDatabaseUrl()` — never read `process.env` directly.

**5. `lingtai` does not exist yet.** Scripts are `pnpm contract:emit`, `pnpm db:init`,
`pnpm db:bootstrap`, `pnpm typecheck`. The CLI is #5.

## Verify before every commit

```bash
pnpm install
pnpm contract:emit                              # offline
pnpm typecheck                                  # all four packages
pnpm --filter @lingtai/store db:bootstrap    # 10 assertions against the live database
```

`db:bootstrap` is the one that catches real breakage — it asserts the append-only
rules, the unique constraint and the cross-connection NOTIFY.

## Hard constraints

- **`agent-loop.sh` is still running** against `nextloom-ai-admin`, on an hourly
  cycle, and will be until Lingtai's Phase 2. Do not stop it, do not modify it,
  and **do not touch the `~/workspace/nextloom-ai/nextloom-ai-admin` working
  checkout** — the old loop merges inside it, and uncommitted changes there make
  its merges fail silently. See `loop/README.md` § Known hazards.
- **Never commit `.env.local`**, and never print a connection string, a password
  or a token. Mask them when you need to show structure.
- **Do not invent data.** `loadBoard()` returns empty columns deliberately; a board
  showing fictional work is worse than one showing none. Same for tests: no
  fixtures standing in for a projection that does not exist.
- Do not add dependencies without a reason you can state. `doc/design.md` §8 lists
  what is deliberately not being built — check it before reaching for a library.

## How this codebase is written

- **Comments explain why, and cite the incident.** `// 132 of these were invisible
  in the old loop` is worth more than `// count guard trips`. The evidence is in
  `doc/decisions/` and `doc/experiments/`.
- **One decision per file in `doc/decisions/`, append-only in spirit.** A decision
  that turns out wrong gets a new file that supersedes it — 0005 and 0009 both do
  this. Do not quietly edit an old one.
- **`doc/experiments/` is for things actually run**, with their result and their
  limits stated. A design claim backed by an experiment beats one backed by
  argument. If you make a claim you cannot demonstrate, say so.
- **Commit messages are prose that says what changed and why**, including what you
  got wrong on the way. Look at the existing log.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## What good looks like for #1

The unique constraint on `(stream_id, version)` is the entire concurrency control
of this system — no lock table, nothing to clean up after a `kill -9`. If it does
not hold, two workers can claim the same work item. So the test that matters is
two real connections racing, not a mock.

Report honestly: if something does not work, say so with the output. If you skip
part of a task, say which part and why.
