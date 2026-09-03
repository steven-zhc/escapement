# 0008 — Next.js for the board

**Status** accepted · 2026-08-31

## Context

The board is the point of the project. The old loop's review queue grew to 45
items against zero processed, because working it meant leaving the tool and
going to GitHub. If the diff, the gate verdicts and the approve/reject controls
are not on the card, nothing about that changes.

So the board is an application, not a report: server-rendered data, live
updates, and write actions that append events.

## Decision

Next.js 16, App Router, React 19 — matching `nextloom-ai-admin`, so patterns and
muscle memory carry across.

| Need | How |
|---|---|
| Read projections without an API layer | Server Components query the store directly. The board and the store share a process and a type. |
| Live updates | **SSE** at `/api/stream`. Postgres already broadcasts every append on the `lingtai` channel; this bridges it. One direction, plain text, reconnects on its own. |
| Approve / reject / waive | Server Actions appending events. Every one is recorded — a waiver is never silent. |
| Types shared with the scheduler | `@lingtai/core` via `transpilePackages`. Changing an event definition breaks both sides at compile time. |

SSE rather than WebSockets because nothing flows upward: the client reads, and
writes go through Server Actions. SSE rather than polling because polling is the
thing this whole design exists to remove — `interval` should not appear anywhere.

## Consequences

- The board needs a Node runtime; it cannot be a static export. Fine — it is a
  local daemon's front end, not a deployed site.
- **`apps/board` is a separate application, not a page inside
  `nextloom-ai-admin`.** The admin is production-adjacent, and Lingtai has to
  keep running while the admin is the thing being changed.
- Port 3200, localhost, **no authentication**. It runs on one machine for one
  person. Before that stops being true, three things need doing: authentication,
  an authorisation model for `approvers`, and a review of the Server Actions,
  which currently trust their caller completely.
- Rendering is deferred where it should be. `loadBoard` returns empty columns
  today rather than invented rows — a board showing fictional work is worse than
  one showing none.
