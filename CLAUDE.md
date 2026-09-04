# Lingtai

An event-sourced scheduler for autonomous code agents, which runs on itself:
tickets here are worked by agents Lingtai dispatched.

**[doc/architecture.html](doc/architecture.html)** answers *which process am I
in* — four diagrams: the processes that exist, who appends to the log, who is
told when it changes, and where each piece of state lives. Read it before
changing anything that crosses a process boundary.
[doc/README.md](doc/README.md) indexes the ADRs, which are append-only in
spirit: a decision that turns out wrong gets a superseding file, not an edit.

## The log settles it

Behavioural claims are settled by reading `events`, not by reasoning about the
code. A finding that cites a seq number is worth more than one that argues.

`task_view` and `outbox` are projections, and the way to correct one is
`lingtai projection rebuild <name>` — replay, never a repair by hand.

## Opening an issue

An issue needs a **kind** label or the queue never sees it. The recipe's
`source.kinds` in `.lingtai/config.yaml` decides which — currently `bug`,
`tech-debt`, `feature`. The other labels in this repo (`enhancement`,
`documentation`, …) are invisible to the conductor.

Add **`agent:hold`** unless you mean an agent to take it now. Self-hosting runs
one unheld ticket at a time, so an unheld ticket is one you are asking the next
queue pass to claim.

The body becomes the agent's prompt, so it is written to be worked from rather
than filed. House style, as in #52, #55, #58:

- Lead with the evidence — the seq numbers, the log excerpt, the exact output.
- Say **why it stayed hidden**, when it did. That is usually the real finding.
- Cite `file.ts:line`, and quote the comment or doc that makes the claim.
- `## Done when`, as checkboxes each of which a person or a test can check.
- `## Related`, saying what the related ticket *decided* — not just its number.

## Running Lingtai on Lingtai

Pass `--no-merge`, by hand, every time. The `merge` gate point does not execute
(#58), so a run without the flag merges itself into `main` unapproved.

The board reads `task_view` and nothing else, and the follower that advances it
lives in the daemon — so a bare `lingtai run` leaves the board frozen for the
whole run and catches it up on the way out (expected; #64). To watch a run live,
in a second terminal:

    pnpm lingtai daemon --no-conduct

It takes no work, and is safe beside a pass already in flight.

The suite appends real events and refuses to run without `TEST_DATABASE_URL`.
`DATABASE_URL` is this system's own log, and an agent is never given it.

## Commits

One line, lower case, stating what is now true rather than what was done —
`fix(end): the point runs on every outcome, not just an inline merge`. An ADR
lands as `NNNN: <the decision, as a sentence>`. `git log` is the reference.
