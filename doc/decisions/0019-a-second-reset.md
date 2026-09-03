# 0019 — The log is reset a second time, and this is what makes it the last

**Status** accepted · 2026-09-03 · overrides [0016 §9](0016-the-settled-model.md)
and the restatement in [0018](0018-the-proposed-point.md)

The log is emptied again — `events`, `checkpoints`, `outbox` and the projections
— and `nextloom-ai-admin` is re-registered. Everything that was in it is in
[experiment 010](../experiments/010-the-log-before-the-second-reset.md), 56
events, verbatim.

0016 §9 said a reset was "legitimate exactly once", and 0018 repeated that the
allowance was spent. This file overrides both, which needs a better reason than
convenience — and needs to say what stops the next one.

## What forced the question

3c′ deleted three event types — `PreparationStarted`, `PreparationPassed`,
`PreparationFailed` — when `prepare` became the `prepared` gate point. The log
held **six rows** of the first two: `version` 1 and 2 of every run stream in it.

`toEnvelope` throws `UnknownEventTypeError` on a type the catalogue does not
know, so all three run streams were unreadable from their first row.
`store.read(runId)` threw, `readAll(0n)` threw, and therefore
`lingtai projection rebuild` — which resets the checkpoint and replays from zero
— could not run at all. Nothing had noticed, because both projections were at
`seq` 65 and the follower never looks back.

0016 §9's own argument for deleting `GuardTripped` was that **there were zero of
them**, so no permanent alias was needed in the read path. That argument was not
re-run for the three `Preparation*` types. It would have failed.

## The two ways out, and why this one

**Retire the types instead.** Put the two that have rows back in the catalogue,
readable for ever, and refuse to append them. It is maybe forty lines, it needs
no data change, and it is the right answer *for a system with history worth
keeping*. Skipping the rows on read is not an option at any price: `run-once`
computes `expectedVersion` as `(await store.read(id)).length`, so a read that
drops two rows makes every subsequent append fail a concurrency check.

**Reset.** Cheaper here, and the reason is a fact about this system rather than
a preference: **Lingtai has never been in production.** The log's entire content
was three runs from one sitting on 2026-09-02, all of them already archived, on
two issues already merged and closed on GitHub. There is no operator whose
history is being taken, no dashboard whose numbers change, nobody replaying a
year of anything. Carrying a permanent special case in the read path for six
rows from three archived runs is a cost paid for ever against a benefit that
expires the moment those runs stop being interesting.

The rule in 0016 §9 exists to stop a reset being reached for whenever a rename
is inconvenient. That is a real risk and this file does not pretend otherwise —
it is the second reset in two days. What distinguishes it is not that the reason
felt good; it is that the precondition is checkable and was checked.

## What "the last one" has to mean

An allowance cited twice and overridden twice is not an allowance. So this is
recorded as a **precondition, not a permission**:

> A reset is legitimate only while the log contains no run that anybody outside
> this repository depends on, and every run in it is archived under
> `doc/experiments/` first. From the moment Lingtai is working somebody's
> repository unattended — Phase 2's exit criterion — that is false, and stays
> false.

That criterion has an owner already: #29. It is not far away.

## What stops it silently recurring

The defect was not the deletion. It was that **nothing said the log had become
unreadable** — no error, no check, no red light, until somebody happened to try
a rebuild months later.

So `lingtai doctor` gains a check: *the log holds no event type this build
cannot read*. One query against `events`, compared against the catalogue. It
turns "a type was deleted while its rows were still in the log" from a defect
discovered by accident into a failed check, which is the difference this whole
system is built on.

## Consequences

- `ProjectConfigured` goes with everything else, so `nextloom-ai-admin` is
  **re-registered** — `lingtai add steven-zhc/nextloom-ai-admin --base develop`.
  Its recipe and its GitHub state are untouched; only Lingtai's memory of it is.
- The nine upcasters added by [0018](0018-the-proposed-point.md) now have no
  rows to act on. They are kept: `schemaVer` is written on every row from the
  first, and a build that reads a v1 `GatePassed` has to be able to, whether or
  not one exists today.
- The `escapement:working` labels in the archived outbox rows are history now.
  Nothing on GitHub still carries them; the runs that set them also cleared
  them.
