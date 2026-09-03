# 0012 — One TaskView, and the queue leaves the log

**Status** accepted · 2026-09-01 · qualifies [0001](0001-event-sourcing.md)

## Context

Three projections existed: `board`, `queue` and `guard_trips`. Every one of them
had to be advanced, checkpointed and rebuilt, and none of them could be advanced
by anything that was actually running — a separate defect, fixed elsewhere, but
one that made the cost of having three of them obvious.

Two of the three were not paying for themselves.

`queue` answers "which issues could be worked next". That is not Lingtai's
state. It is GitHub's, mirrored — one `WorkItemDiscovered` per issue per
discovery pass, appended forever, to reproduce a fact that GitHub will answer
correctly on request and that Lingtai never decided.

`guard_trips` answers "what was the agent stopped from doing". That is real, and
it is *detail*: nobody reads it while scanning a list of cards, and everybody
reads it when looking at one card closely.

Meanwhile the board card had been growing. Gate evidence, review findings with
their failure scenarios, and the diff were all being rendered on the card
itself, because the card was where the projection put them.

## Decision

**One projection: `TaskView`. One row per task Lingtai has touched, holding
the latest state and the metadata a card shows.** The board's list view is a
`select` against this table and nothing else.

**The queue comes from GitHub, not from the log.** No `WorkItemDiscovered`. What
is runnable is whatever GitHub says is open, minus what the log says is claimed.

**Detail is folded on demand from the event stream, by task id.** Gate evidence,
guard trips, the diff, the full history: read when a person opens one task, not
maintained in a table against the possibility that they might.

**Retention is a query, not projection content.** Rows for landed tasks keep a
`closed_at` and the board filters to the last two days by default. The
projection itself keeps everything.

## Why

**The queue was duplicating somebody else's truth.** The line worth drawing is
not "GitHub is external so mirror it" but *did Lingtai decide this?* It did
not decide which issues exist. It did decide which one it claimed — and that
stays in the log, because the claim is the entire mechanism preventing two
conductors from taking the same ticket. `WorkItemClaimed` and its lease are
untouched by this.

The cost is that "what did the queue look like last Tuesday" stops being
answerable. For a scheduler one person runs on one machine, that answer was
never worth an event per issue per pass.

**A list view and a detail view have opposite economics.** The list is read
constantly and needs to be cheap, so it gets a table. A detail view is read
rarely, by one person, about one task — folding a few dozen events on the spot
is imperceptible, and it means the shape of what a detail view shows can change
without a migration or a rebuild. Building a table for it would be paying a
continuous cost for an occasional read.

This also fixes the card. It was heavy because the projection made everything
available, and what is available on a card gets rendered on it. Moving detail
behind a task id makes the card's contents a decision rather than a consequence.

**Retention must not be in the projection, and this is the part that is easy to
get wrong.** A projection whose rows depend on `now()` is not deterministic:
rebuild it in the morning and in the evening and you get two different tables.
That breaks the property `board.test.ts` actually asserts — that a rebuild
reproduces the incremental result — and worse, it makes rebuilding stop being a
safe operation, which is the thing that lets a projection's shape change freely
at all ([0001](0001-event-sourcing.md)). Keeping the row and filtering in the
query costs a `where` clause and keeps both.

## Consequences

The board reads one table. Three checkpoints become one.

A GitHub outage or a rate limit means an empty queue rather than a stale one.
Accepted: an empty queue stops work, a stale queue does the wrong work.

Reading the queue costs a GitHub call, so the board must not make one per
render. The conductor fetches it and writes the runnable set into `TaskView`,
and the board keeps reading only the table. Stated here because the obvious
implementation — the board asking GitHub directly — reintroduces the problem
this avoids in a different place.

`guard_trips` as a standalone projection goes away. The 132 invisible guard
blocks that motivated it are still counted; they are read from the stream when
someone opens the task.
