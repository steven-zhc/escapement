# 0018 — The gate point called `diff` is called `proposed`

**Status** accepted · 2026-09-03

The third of the five gate points was `diff`. It is `proposed` from this commit.
The point itself is unchanged — same moment, same actions, same authority to
refuse. Only the name moved, and this file exists because the name is stored:
it is a value in nine event payloads and a key in every managed repository's
recipe.

## Why the old name was wrong

Not because it was inaccurate. `diff` was true — a diff exists at that point and
nowhere earlier, which is exactly the property a point's name should have.

It was wrong because **`diff` was already taken, three times over**, in the same
files:

| Also called `diff` | Where |
|---|---|
| the git subcommand | `git(["diff", "--numstat", …])`, `run-once.ts` |
| the artifact the gates read | `RunProducedDiff`, `artifacts: ["diff"]`, the board's `DiffView` |
| the stage a run can stop at | `stage: "diff"`, meaning *there were no commits* |

So `point: "diff"` sat six lines from `git(["diff", …])` and meant something
else, and `stopped at diff` named the stage where a run failed **before** the
gate point of the same name could run at all. A reader had to know which `diff`
was meant from context every time.

## Why `proposed`, and not `review` or `implemented`

Three names were weighed against what the point actually is.

**`review`** was rejected because it names *an activity*, and the one thing
[0015](0015-five-gates-and-two-extensions.md) and
[0016](0016-the-settled-model.md) insist on is that a gate is a **place, not a
kind of check** — points closed, actions open. `review` is also already an
action name at that very point, so the log would have read
`gate: "review", action: "review"`, and the recipe that runs
`pnpm typecheck && pnpm lint && pnpm test` there would have called a build a
review.

**`implemented`** was rejected because it asserts the conclusion the point
exists to test. What is true on arrival is that the agent stopped and there are
commits; whether anything was *implemented* is what the gates are about to
decide. It also assumes the kind of work — a revert or a deletion is not an
implementation, and both are ordinary work items.

**`proposed`** is what survived. It names the state the run has reached, it is
true on arrival and false nowhere, it is silent about what runs there, and it
pairs with `prepared`: two participles naming two points the loop passes
through.

It was also, it turned out, already the log's own word for that exact moment.
`RunProposedCompletion` — "the moment the gate pipeline fires" — has been the
event immediately before this point since the pipeline existed. The rename
makes the point agree with the event that triggers it, rather than introducing
a word.

## What had to move with it

**Nine event types** carry a `GatePoint`: `GatesResolved`, the four `Gate*`
verdict events, `GateWaived`, and the three `Approval*` events. All nine bump to
`schemaVer` 2 with an upcaster, which is the first real use of the mechanism
[0001](0001-event-sourcing.md) put in place.

Keeping `diff` in the enum as a second accepted spelling would have avoided the
upcasters. It was rejected: the enum is what a reader is shown, two spellings of
one point would have to be understood by the board, `status` and every recipe
forever, and a run that wrote `diff` would look like a different kind of run
from one that wrote `proposed`.

**Every recipe's `gates:` key.** This is the part with a second party, and
[0017](0017-the-project-is-called-lingtai.md) is the reason it is handled the
way it is: a rename that half-lands is only survivable when the half-landed
state is *loud*. Zod strips unknown keys by default, so a recipe still saying
`diff:` would have resolved cleanly to a point with nothing at it — the build
and the tests silently stopping, with the board reporting `skipped`, which is
indistinguishable from a deliberate choice not to configure them.

So `GateMap` is **strict** now. An unknown gate key fails recipe resolution and
names itself, which is what `nextloom-ai-admin` would have hit had its recipe
not moved in the same sitting. Strictness is a real change beyond the rename and
it earns its place independently: the point set is closed, so a key that is not
one of the five is a typo or a stale name, and neither should be dropped in
silence.

## What was deliberately not renamed

**`stage: "diff"` in `run-once.ts`.** It is not the gate point and never was —
it is where a run stopped, and the stop it names is *computing the diff and
finding no commits*, which happens before the `proposed` point is reached. It
stays `diff` because that is what failed. `doc/reference.md` now says so at the
place a reader would otherwise conflate them.

**Every other use of the word.** `RunProducedDiff`, `artifacts: ["diff"]`, the
board's diff view, `git diff` itself. The point of this change is that those
keep the word and the gate point stops competing for it.
