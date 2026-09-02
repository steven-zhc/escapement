# 0014 — One loop, one log; everything else is a projection or a subscriber

**Superseded by [0016](0016-the-settled-model.md).** Its framing stands; the
argument that something must externally declare what is *required* was withdrawn
once the gate set became closed. Kept as the record of how that was reached.

**2026-09-02. Accepted.**

## The sentence

> One agent loop, driven by an append-only event log. Everything else is a
> projection of that log or a subscriber to it.

This is the description of the system, and any part that cannot be placed in
one of those three slots — the loop, a projection, a subscriber — should be
questioned before it is built.

## Why not "event-driven agent loop"

That was the phrasing first proposed, and it is nearly right. The reason it was
not taken is one word.

Event-**driven** describes how things are triggered. Plenty of event-driven
systems keep authoritative mutable state and use events only as notification.
Event-**sourced** describes where truth lives: the log is the record, and every
readable table is derived from it.

The properties actually relied on here all come from the second, not the first:

- **`UNIQUE (stream_id, version)` is the whole of the concurrency control.** Two
  writers racing for version 7 means one loses at the database rather than at a
  lock somebody remembered to take.
- **The board and the CLI cannot disagree**, because neither holds state; they
  read the same log.
- **A projection can be dropped and rebuilt to exactly what it was**, which is
  what makes it safe to change how a question is answered.
- **A crash between an event and its side effect loses nothing**, because the
  pending row is derived (the outbox).

Called "event-driven", the first person to add a table holding authoritative
state will not feel they have broken any rule. Called what it is, they will.

So the slogan keeps the log in it. `append-only` is doing real work in that
sentence and is not decoration.

## What this rules in

Three slots, and the test for anything new is which one it goes in.

| Slot | What it may do | Examples today |
|---|---|---|
| **the loop** | append events; take one item at a time | conductor pass, claim, run, integrate |
| **a projection** | read the log, write a derived table, hold no truth | `task_view`, `outbox`, `guard_trips` |
| **a subscriber** | read the log, act outside the system, never block it | notifier, outbox worker |

A gate is already all three in the right order: the loop runs it, its verdict is
an event, the board reads it through a projection. That it *looks* like a
separate concept is a fact about the vocabulary, not about the architecture.

## What this rules out

**A component that keeps authoritative state of its own.** If a fact cannot be
recovered by replaying the log, it is not a fact this system has.

**A side effect whose record lives only outside the log.** This is why
`OutboxDelivered` is appended rather than a `delivered_at` column being the only
record: if delivery lived only in the table, rebuilding it would forget
everything already sent and post every comment a second time.

**A projection that reads `now()`.** Replay must produce the same table. Every
timestamp comes from `event.at`.

## The one thing a pure subscriber model cannot do, and why it constrains this

The tempting next step from this sentence is: make *everything* a subscriber, so
gates, approvals and checks are plugins that react to events and the core keeps
nothing.

That does not work in one specific place, and it is worth writing down before
someone tries it.

**A log records what happened. It cannot record what should have happened and
did not.** If a human-approval gate is purely a subscriber, then when it crashes,
is misconfigured, or was never installed, the merge step sees no
`needs-approval` event, finds nothing blocking, and merges. That outcome is
byte-for-byte identical in the log to "correctly configured, no approval
required".

This is not hypothetical. Two defects found on 2026-09-02 were both of exactly
this shape — a declaration and the behaviour drifting apart with nothing able to
notice:

- `outbox.ts` asserted foreign labels were preserved by the caller. No caller
  did. It stripped `enhancement` off three issues, and the symptom was an empty
  queue, which looks exactly like no work.
- `README` and `gate.ts` asserted `agent`, `policy` and `human` gates were
  unimplemented and would be refused. All three had shipped.

So **something must declare what is required**, and it must live where a
subscriber cannot remove it — otherwise it is not a check, it is a suggestion.
That declaration is small: a list of gate names. It does not need to be called a
policy, and it does not need the other three fields currently sitting beside it.

A second, narrower reason the declaration cannot live in the managed
repository: the agent writes code there. Reading the recipe from `origin/<base>`
stops a branch changing its own rules mid-flight ([ADR
0005](0005-config-in-target-repo.md)), but a merged change still takes effect
next run. Protecting the workflow file with a gate defined *in* the workflow
file is circular — self-amending configuration cannot protect itself, so some
irreducible part sits outside.

## Open, not decided here

This ADR records the framing only. The subtraction it suggests has been argued
but **not agreed**, and is listed so the next person knows it is live rather
than settled:

- `concurrent` is stored, plumbed and displayed, and never compared against
  anything. It looks like a dead field.
- `approvers` is `[]`, and `[]` short-circuits the check, so it currently means
  "anyone".
- `agent` and `policy` gate kinds have never run against a real repository here
  and are the most plugin-shaped things in the codebase.
- `sandboxed` is a tier no runtime provides, so it can only ever refuse.
- If the declaration shrinks to one field, "policy" may not deserve to be a
  concept, as opposed to part of project registration.

`tier` is **not** on that list: `run-once.ts:145` refuses dispatch when the
runtime cannot meet it, so it is enforced rather than decorative.

## Consequences

The board keeps `gates` and `waiting` as separate lanes. They are disjoint by
construction — `gates` is set by `RunProposedCompletion`, `waiting` by
`ApprovalRequested`, `WorkItemBlocked`, `RunAwaitingInput` and
`PreparationFailed` — and they mean opposite things: one is "the machine is
busy, you are not needed", the other is "nothing moves until you act". Merging
them produces a lane that has to be triaged card by card, which is the
`agent:blocked`-with-no-question failure the whole system exists to leave
behind.
