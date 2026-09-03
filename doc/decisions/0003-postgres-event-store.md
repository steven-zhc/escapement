# 0003 — PostgreSQL as the event store

**Status** accepted · 2026-08-31 · qualified by [0009](0009-two-connections.md)

## Context

At a few dozen events an hour with a single writer, SQLite would hold the data
comfortably. Volume is not the deciding factor.

## Decision

PostgreSQL, for three primitives that replace three fragile pieces of bash.

| Old | Problem | New |
|---|---|---|
| `.runtime/loop.lock.d` | leaks after `kill -9`; needs a manual `rm -rf` | `UNIQUE (stream_id, version)` optimistic concurrency plus lease events. A dead process's lease expires on its own — the absence of a heartbeat *is* the expiry, so there is nothing to unwind. |
| merging inside the operator's own checkout | uncommitted work made the merge fail **silently**; the cause of ~$29 of wasted re-runs on #58/#59 | `pg_advisory_lock('merge:' || project || ':' || base)` plus a worktree the integrator owns outright |
| calling `gh` inline | a failed call vanished, with no record and no retry | an `outbox` table: the event lands first, delivery is a separate retryable concern |

And one thing SQLite cannot do at all: **`LISTEN/NOTIFY`** — though not through
a transaction pooler, which drops it silently. That cost a second connection
string; see [0009](0009-two-connections.md). With it, "event
driven" stops being a description and becomes a mechanism — the conductor and
the board wake on an append rather than on a timer, and `interval` disappears
from the configuration entirely.

## Consequences

- The event store is **its own database**, never one belonging to a managed
  project. Lingtai has to keep running while a managed project is being
  changed.
- The `NOTIFY` payload is the `seq` only; `NOTIFY` caps at 8000 bytes and an
  event body can exceed it, so listeners read the row they are told about.
- Append-only is enforced by rules on the table, not by convention. A correction
  is a new event.
- Projections are ordinary tables advanced by a subscriber with a row in
  `checkpoints`. Changing a projection's shape is `TRUNCATE` + reset + replay,
  which is why none of them are declared in the schema yet.
- One operational dependency the old loop did not have. Accepted: the board and
  the approval flow need a server anyway.
