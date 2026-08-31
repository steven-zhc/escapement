# Documentation

Three kinds of thing live here, and the distinction matters.

| | |
|---|---|
| [`roadmap.md`](roadmap.md) | Six phases, each with an exit criterion that is a fact. The backlog, with issue numbers. |
| [`design.md`](design.md) | How the system is meant to work, as a whole. Rewritten as it changes. |
| [`decisions/`](decisions/) | One decision per file, with its context and its consequences. **Append-only in spirit** — a decision that turns out wrong gets a new file that supersedes it, not an edit. |
| [`experiments/`](experiments/) | Things actually run against real data, with their results. A design claim backed by one of these is worth more than one backed by argument. |

## Decisions

| | | |
|---|---|---|
| [0001](decisions/0001-event-sourcing.md) | Rebuild the loop as an event-sourced system | accepted |
| [0002](decisions/0002-typescript.md) | TypeScript, with the hook as a Bun single file | accepted |
| [0003](decisions/0003-postgres-event-store.md) | PostgreSQL as the event store | accepted |
| [0004](decisions/0004-prisma.md) | Prisma 8 as the ORM | accepted |
| [0005](decisions/0005-config-in-target-repo.md) | Configuration lives in the managed repository | accepted |
| [0006](decisions/0006-github-app.md) | A GitHub App, not a personal access token | accepted |
| [0007](decisions/0007-dual-runtime.md) | Two runtime interfaces, one implementation | accepted |
| [0008](decisions/0008-nextjs-board.md) | Next.js for the board, SSE for live updates | accepted |

## Experiments

| | | |
|---|---|---|
| [001](experiments/001-cold-review-issue-58.md) | Does a cold reviewer catch what four other checks missed? | yes, plus two nobody had found |

## Open

- **Where to start.** [Phase 0](roadmap.md#phase-0--system-scaffold) —
  [#6](https://github.com/steven-zhc/escapement/issues/6) first, since it unblocks
  the rest.
- **The database.** `DATABASE_URL` is the one outstanding item. Everything in
  `packages/core` and `packages/config` is zero-I/O and can be finished without it.
- **`tier: sandboxed`.** Containerising the whole toolchain is its own piece of
  work; `guarded` is what the first project runs at. See
  [0007](decisions/0007-dual-runtime.md).
