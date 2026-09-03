# 0004 — Prisma 8 as the ORM

**Status** accepted · 2026-08-31

## Context

Prisma 8 is not a version bump on Prisma 7. It is a re-architecture. Verified
against npm and by running the CLI:

- `prisma`'s `latest` dist-tag is **8.0.0-rc.12** — a release candidate. There
  is no stable 8.0.0.
- **`@prisma/client` has no 8.0.x release at all.** Searching for one is a dead
  end, because the runtime package was renamed: Prisma 8 ships
  **`@prisma/orm-postgres`** instead.
- The CLI has no `generate` command. It is now the Prisma Developer Platform —
  `auth`, `project`, `postgres`, `bucket`, `deploy`, `service`, `contract`,
  `db`, `migration` — with the classic ORM behind `prisma orm init`.
- Schemas are "contracts". `prisma contract emit` replaces `prisma generate`,
  producing `contract.json` and `contract.d.ts` next to the schema.
- The PSL changed: a `// use prisma-next` pragma at the top, no `generator` or
  `datasource` blocks (they moved to `prisma.config.ts`), and new scalars —
  `TimestamptzString`, `temporal.updatedAtString()`.

## Decision

Prisma 8, pinned to exact prerelease versions:

```
prisma                8.0.0-rc.10   (dev)
@prisma/cli-engine    0.2.3         (dev)
@prisma/orm-postgres  8.0.0-rc.8
```

Exact, not caret. These are prereleases; a range would let a nightly drift into
the foundation of the project.

Verified working: `prisma contract emit` succeeds on the event-store schema and
all three packages typecheck.

## Consequences

- **`pg` sits alongside Prisma, permanently.** Prisma has no `LISTEN/NOTIFY`, and
  that is the single reason the store is PostgreSQL ([0003](0003-postgres-event-store.md)).
  Reads and writes go through Prisma; the subscriber takes its own `pg`
  connection. This split is deliberate, not an oversight.
- **Triggers and rules are raw SQL.** Prisma models tables. The `NOTIFY` trigger
  and the append-only rules live in `packages/store/sql/notify.sql`, applied
  after the first migration.
- **This is a prerelease under the foundation.** The RC could change shape before
  8.0.0 ships. Mitigated by exact pins and by the fact that everything in
  `@lingtai/core` — the part worth protecting — has no Prisma dependency at
  all and would survive swapping the ORM entirely.
- `pnpm` must allow build scripts for `esbuild`, `workerd` and
  `msgpackr-extract`, which the CLI engine bundles. Declared in
  `pnpm-workspace.yaml` under `allowBuilds` (pnpm 11's spelling; it was
  `onlyBuiltDependencies` in 10).
- Prisma 8's CLI is designed to be scripted by agents — `prisma orm init
  --target postgres --authoring psl` is documented for exactly that. Convenient
  here, given what this project is.
