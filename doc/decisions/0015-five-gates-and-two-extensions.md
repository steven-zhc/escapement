# 0015 — Five gates, and the two ways a plugin may extend the loop

**Superseded by [0016](0016-the-settled-model.md),** which folds in the `tools`
rename, `GatesResolved`, presets as the only home for defaults, and the
boundary that keeps `integrate` in the core. Kept as the record.

**2026-09-02. Accepted.** Amends [0014](0014-one-loop-one-log.md), which stopped
the gate set at four and sent everything after the merge to a subscriber. The
reason for the change is in "Why `end` is a gate" below.

## What a gate is now

A gate is **a fixed point in the loop**, not a kind of check. The set is
**closed**: no gate point may ever be added. What runs *at* a point is open, and
is where plugins live.

| Gate | When | May refuse? |
|---|---|---|
| `admit` | the queue offers an item, before it is claimed | yes — the item stays queued |
| `prepared` | after prepare, before the agent starts | yes — refuse before any money is spent |
| `diff` | the agent stopped and there are commits | yes — build, tests, review |
| `merge` | after `diff` passes, before the merge lane | yes — human approval, path holds |
| `end` | the work item reached a terminal outcome | **no** |

The four points were not invented. Each names a branch the loop already had:
tier/dispatch, `PreparationFailed`, the gate pipeline, and `pipeline.heldAt`.

**Gate points closed, actions at a gate open.** Adding a security scan, a second
reviewer or a cost budget is a plugin attached to a point. Adding a *point* is
not possible. This is what lets extension be unbounded while the core stays
finite.

## Unconfigured is skipped, and that is the user's call

A gate with nothing configured is skipped. Escapement does not verify that a
project has configured the gates it "should" have — the workflow is the user's
to define, and a run that merged with no review because none was configured is
the user's decision, not a defect.

The inverse is Escapement's responsibility: **configured and did not run is a
bug here.**

This replaces `requiredGates`, which existed to make "should have happened and
did not" detectable. It is no longer needed, and the argument in
[0014](0014-one-loop-one-log.md) that something must declare requirements is
**withdrawn** — a closed gate set makes absence visible without an external
declaration.

**One condition makes that true, and it is load-bearing:** the board and
`esc status` must render an unconfigured gate as `skipped`, never omit it. A
closed set is only better than a plugin free-for-all because you can *see* the
empty slots. Omit them and this collapses back into the model 0014 rejected.

## Why `end` is a gate, when it cannot refuse

0014 argued that anything after the merge is a subscriber, because a gate is a
point where the loop waits for a verdict and nothing can be refused once a merge
has landed. That is still true of `end` — it cannot refuse anything.

It is a gate anyway, for the same reason the rest of this design works:
**visibility**. Closing the issue, or labelling it, as a subscriber would be
invisible — you could not tell from the recipe whether anything did it. As a
gate point it is a declared, skippable, displayable step. Today nothing closes a
landed issue, and nothing on GitHub shows that Escapement touched it; that gap
was invisible precisely because there was no place it was supposed to be.

`end` fires on **any** terminal outcome, not only a landed one, and the action
is told which. "Close the issue when it lands, label it when it is blocked" is
one configuration rather than two mechanisms.

The honest caveat, recorded rather than smoothed over: four gates can refuse and
one cannot, so "gate" is slightly wrong for `end`. A separate concept would cost
more than that imprecision does.

## The two extensions

A plugin may do exactly two things.

| | gate action | event subscriber |
|---|---|---|
| Runs | synchronously, in the loop | asynchronously, off the log |
| Ordered | yes — recipe array order | no |
| May refuse | yes (except at `end`) | never |
| Blocks the loop | yes, that is the point | **never** |
| Declared in | the recipe, naming its gate | the plugin itself |
| On failure | a verdict, in the log | logged and dropped |

**The rule for choosing:** if the loop must wait for it, it is a gate action. If
it cannot affect the outcome, it is a subscriber.

The gate action interface already exists and does not need designing —
`Gate` in `packages/gates/src/gate.ts` takes a `GateContext` (runId, `onSha`,
cwd, filtered env) and returns a `GateResult` (verdict, evidence, findings).
That is the plugin contract.

Two rules for subscribers, both learned rather than assumed:

- **A subscriber that throws must never stop the log being followed.** This is
  already how the notifier behaves, and it stops mattering as a detail and
  starts mattering as a boundary the moment third-party code is in that path: a
  bad plugin taking down the projection follower would take the board down to
  tell somebody about a merge.
- **A subscriber is not retried.** The outbox is for effects that must survive a
  crash; a subscriber is for effects that are worthless late.

## Ordering at a gate

Recipe array order. The first refusal wins and the actions after it do not run,
and that is recorded — a gate that kept going after a refusal would be spending
money to produce verdicts about a diff that is not going anywhere.

## Consequences

- `requiredGates`, `approvers` and `concurrent` all lose their last reasons.
  `tier` keeps its own (`run-once.ts:145` refuses dispatch on it).
- `prepare` folds into the `prepared` gate. Gate actions may therefore have side
  effects — accepted deliberately, and true of process gates already.
- The board drops the `gates` lane and folds it into `running`: four states,
  `queued` → `running` → `waiting` → `landed`. The per-gate verdict map stays in
  `task_view` for the detail page. The lane goes, the column does not.
- `GateSpec`'s discriminated union by `kind` becomes a map from gate point to an
  ordered list of actions.

## Not yet implemented

Everything above is design. `doc/reference.md` still describes four gate *kinds*
because that is what the code does today, and it will be updated when the code
is, not before — a reference that describes intent rather than behaviour is the
defect this repository has now hit four times in one day.
