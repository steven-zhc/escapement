# 0013 — The daemon holds the work; the UI controls it

**Status** accepted · 2026-09-01 · qualifies [0008](0008-nextjs-board.md)

## Context

Three long-lived things need to exist: the board, something that keeps
projections current, and the conductor. Only the first one had a home.

The conductor was `esc run` — one shot, in a terminal, exits when done. Nothing
advanced projections at all until `esc projection run` was written. So the
question was where those two live, and whether the board could host them.

Hosting both in the board was considered seriously, and it is where this
started. It is genuinely simpler for a tool one person runs on one machine, Next
has a first-class hook for it in `instrumentation.ts`, and it means one command
to start everything.

## Decision

**One daemon holds the projection follower and the conductor. The UI is a
separate server that controls it and watches it, and holds no work of its own.**

**Starting is launchd's job, not the UI's.** The daemon runs under `KeepAlive`,
so it is a thing that is always supposed to be up. The UI never spawns a
process.

**Control goes through the log.** `drain`, `pause`, `stop` and "run this issue
now" are appended as events. The daemon listens and obeys.

**Liveness does not go through the log.** The daemon writes `last_seen_at` to a
`daemon_status` table. The UI shows how long ago that was.

## Why

**The dividing line is not lifetime, it is who holds work in flight.** The
daemon holds agent processes, worktrees and claims; the UI holds a table it
reads. Their failure costs differ by orders of magnitude: a dead UI costs a
screen, and a dead conductor costs a killed agent run that has already been paid
for, an orphaned worktree, and a claim somebody has to wait out.

Hosting the conductor in the UI makes editing a stylesheet a way to kill a $4
run — `next dev` restarts on save. It also makes "unattended", which is the
entire point of the conductor, mean "keep a web server alive", which is a worse
launchd with extra steps.

Keeping the two apart preserves what makes the board trustworthy: it owns
nothing, so it cannot disagree with anything ([0008](0008-nextjs-board.md)). A
board that ran the conductor would hold state nothing else could see.

**You do not need a start button, and noticing that removes the worst part.**
The alternative was a web server spawning and killing a child process, where a
UI crash leaves the child orphaned or takes it down with it. `KeepAlive` deletes
the problem: the daemon is always running, and what an operator actually wants
to control is whether it is *taking work* — which is a fact to record, not a
process to manage.

**Control belongs in the log because it is a decision somebody made.**
`ApprovalGranted` is already exactly this shape: an operator's choice, recorded
as a fact, auditable by the same query as everything else. "Who stopped the
conductor at four o'clock" should not need a different mechanism than "who
approved this merge". It also means a command survives the daemon being down —
a pause issued while it is restarting is waiting when it comes back, which is
the behaviour you want rather than a race to be handled.

Three verbs, not two, because the one you almost always want is the one that is
usually missing: **drain** finishes the run in flight and takes nothing new,
**pause** stops taking work immediately, **stop** kills what is running.

**Liveness must stay out of the log, and this is the mistake worth naming.** A
heartbeat every few seconds, forever, would bury the log in rows that are not
facts anybody will want later. The admission test for the log is *is this worth
remembering* — a beacon fails it. A small mutable table is the right shape for
"is it up right now", and it is not history, so nothing is lost by overwriting
it.

That beacon is also the fix for a real incident. Two work items merged into
`develop` while their cards sat in "waiting on you", because the thing that
advances projections was not running and nothing said so. The operator's
reasonable conclusion was that the button did nothing. A light that says "last
seen 3s ago" turns that from a mystery into a glance.

## Consequences

The daemon takes a Postgres advisory lock, so a second one — a debugging
`esc daemon` while launchd's copy is up — exits quietly instead of racing for
the same ticket. Same mechanism as the merge lane already uses.

The UI can be restarted, reloaded and closed freely. Runs do not notice.

A killed daemon leaves a claim, and the claim's lease expires without anyone
releasing it (`claim.ts`), so the work item returns on its own. It also leaves a
worktree, which does not clean itself up; reconciling those at startup is
tracked separately.

`conductor`, `projection` and `ui` stay three separate modules. Two of them
share a host. Sharing a host is not the same as being coupled, and each stays
independently runnable from `esc` — which is what keeps them testable in
isolation.
