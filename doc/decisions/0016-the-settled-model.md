# 0016 — The settled model: one loop, five gates, no policy

**Status** accepted · 2026-09-02 · supersedes [0014](0014-one-loop-one-log.md)
and [0015](0015-five-gates-and-two-extensions.md), and supersedes the policy
half of [0005](0005-config-in-target-repo.md)

0014 and 0015 are kept, not deleted: they are the record of how this was
reached, and both contain arguments that were later withdrawn. This file is what
the code is built against. Where it disagrees with them, it wins.

## 1. What the core is

> **Escapement takes a ticket, calls an agent to work on it, and merges the
> result into a base branch. Everything else is declared in the recipe.**

That sentence is the whole of what is not configurable. Concretely the core
owns, and will not delegate:

| | Why it cannot be a plugin |
|---|---|
| the append-only log | it is the truth; see 0014's reasoning, which stands |
| refreshing the queue from GitHub | Escapement never decides which issues exist ([0012](0012-one-task-view.md)) |
| claim, with its lease and uniqueness | `UNIQUE (stream_id, version)` is the concurrency control |
| the worktree lifecycle | the isolation boundary a run actually has |
| dispatching the agent | this is the thing being scheduled |
| **integrate — the merge lane under its advisory lock** | see below |
| stamping every verdict with `onSha` | an action returns a verdict; the core binds it to a commit, so a plugin cannot break the invariant that a verdict is about a diff |

**`integrate` stays in the core, and this is the boundary worth defending.** If
merging were pluggable there is no scheduler left, only a generic event workflow
engine — and the advisory lock that makes concurrent merges safe would become
the plugin author's problem. Escapement is opinionated about exactly one thing:
it merges to a base branch.

## 2. No defaults in the core

The core ships **no gate actions and no tool rules**. A gate with nothing
configured is skipped; a `tools` block that is absent denies nothing.

Defaults live in **presets** — named, readable, opted into with `extends:`. This
is not a new mechanism: `applyPreset` already replaces arrays rather than
concatenating them, with the reason already written in its source ("a recipe
that lists its own steps means *those* steps; silently appending the preset's
would be a way to acquire work nobody wrote down").

**The rule is per-key wholesale replacement.** A recipe that names a gate owns
that gate entirely. There is no per-action merge, no precedence table, and no
question of how to remove something inherited.

This is why "append or replace" never needed answering: with no defaults there
is nothing to append to.

## 3. Five gates, closed forever

A gate is a **fixed point in the loop**, not a kind of check.

| Gate | When | May refuse? |
|---|---|---|
| `admit` | the queue offers an item, before it is claimed | yes — it stays queued |
| `prepared` | after the worktree exists, before the agent starts | yes — refuse before money is spent |
| `diff` | the agent stopped and there are commits | yes |
| `merge` | after `diff` passes, before the merge lane | yes |
| `end` | the work item reached any terminal outcome | **no** |

Four name branches the loop already had. `end` cannot refuse — recorded as an
imprecision rather than smoothed over; a separate concept would cost more.

`end` fires on **every** terminal outcome and the action is told which, so
"close it when it lands, label it when it is blocked" is one configuration.

**Gate points closed, actions open.** A security scan, a second reviewer, a cost
budget: all are actions attached to a point. Adding a point is not possible.

## 4. Unconfigured is skipped, and skipped is visible

A gate nobody configured does not run, and that is the user's decision, not a
defect. Escapement does not check that a project configured the gates it
"should" have. **Configured and did not run is Escapement's bug.**

This is what removed `requiredGates`, and with it the last reason for a policy
concept. The argument in 0014 — that something must declare requirements
because a log cannot record what should have happened and did not — is
**withdrawn**: a closed set of points makes absence expressible.

It only works if absence is actually *shown*, and the log as it stood could not
show it. `ProjectConfigured` carries a `configHash`, not the configuration, so
nothing in the log said how many points there were or which were empty.

**`GatesResolved`** closes that. One event per run, appended before `admit`,
listing all five points and the ordered actions resolved for each — an empty
array where nothing is configured. It buys two things:

1. The board renders all five points, marking the empty ones `skipped`. Omitting
   them would collapse this design back into the plugin free-for-all 0014
   rejected.
2. **"Configured but did not run" becomes detectable** by comparing the plan to
   the verdicts that followed — which is exactly the half of the responsibility
   that is ours.

## 5. Two extensions, and only two

| | gate action | event subscriber |
|---|---|---|
| Runs | synchronously, in the loop | asynchronously, off the log |
| Ordered | yes, recipe array order | no |
| May refuse | yes, except at `end` | never |
| Blocks the loop | yes — that is the point | **never** |
| Declared in | the recipe, naming its gate | the plugin |
| On failure | a verdict, in the log | logged and dropped |

**The rule:** if the loop must wait for it, it is a gate action; if it cannot
affect the outcome, it is a subscriber.

The gate action contract already exists and needs no design — `Gate` in
`packages/gates/src/gate.ts`, taking a `GateContext` (runId, `onSha`, cwd,
filtered env) and returning a `GateResult`.

At a gate, **the first refusal wins and later actions do not run**, and that is
recorded. Continuing would spend money producing verdicts about a diff that is
not going anywhere.

Two rules for subscribers: **one that throws must never stop the log being
followed** (a bad plugin would otherwise take the board down to announce a
merge), and **a subscriber is never retried** (the outbox is for effects that
must survive a crash; a subscriber is for effects that are worthless late).

**Plugins are trusted code. There is no plugin sandbox.** They run in the
daemon's process with the daemon's credentials, including the GitHub App key.
Said plainly here so nobody later assumes otherwise — that assumption is exactly
the mistake the old README made about the guard hook.

## 6. Dispatch parameters, and the end of "guard"

`guard` was never a peer of `gate`. It is one of the parameters describing the
box the agent is handed, and naming it as a system made it sound like a boundary
it never was.

| recipe key | governs |
|---|---|
| `env.allow` | which environment variables the agent can see |
| `repo` | which checkout it gets |
| `runtime.limits` | how long and how many turns |
| **`tools.deny`** | which tool calls it may make |

**`guard` is renamed `tools`.** `env` governs environment variables, `tools`
governs tool calls: both name what is governed and neither claims a strength.
`permissions` was rejected for implying a security boundary — the documented sin
— and `sandbox` and `boundary` for the same reason at higher volume.

The eight built-in rules move into a preset. Nothing is hard-coded.

**Only refusals become events.** An allowed call is counted in memory and
answered immediately: *the event store's availability must never gate an agent's
tool call*, because a database blip would otherwise stall every tool use in every
run. This corrects a proposal made during the discussion that every decision be
evented; it would have broken the hot path, where process startup alone already
consumes 17ms of a 20ms budget ([0011](0011-hook-latency-is-runtime-startup.md)).

For the same reason **there is no plugin extension point per tool call.** There
is no room — and it is the worst possible place to run third-party code, being
synchronous and on every action the agent takes.

`GuardTripped` becomes `ToolCallRefused`, matching `DispatchRefused` and
`IntegrationRefused`; `guard_trips` becomes `tool_refusals`. `packages/hook` and
`esc-hook` keep their names: "hook" names the runtime mechanism and stays
accurate.

## 7. What is deleted

- **The policy concept entirely** — `packages/config/src/policy.ts`,
  `policyConflicts`, `PolicyConflictError`, and the `ProjectPolicySet` event.
- `requiredGates` (replaced by §4), `approvers` (`[]` short-circuits to
  "anyone", so it has never done anything), `concurrent` (stored, plumbed,
  displayed, never compared against anything).
- `labelsFor` in `outbox.ts` — becomes an action at `admit` and `end`. It is
  also the code that deleted three issues' `enhancement` labels, and under this
  model there is no place for it to live in the core.
- `prepare` as a separate concept: it folds into the `prepared` gate. Gate
  actions may therefore have side effects, accepted deliberately and already
  true of process gates.

**`tier` survives** and moves into the recipe as `runtime.tier`, which already
exists as an optional field. It is enforced — `run-once.ts:145` refuses dispatch
when the runtime cannot meet it — and a recipe asking for `open` is now the
user's call like everything else. `sandboxed` remains a value no runtime
provides and can therefore only refuse.

## 8. The board

Four states: `queued` → `running` → `waiting` → `landed`. The `gates` lane folds
into `running`, because from an operator's seat "the agent is working" and "the
build is running" are the same fact: the machine is busy and you are not needed.
`waiting` is the lane the board exists for.

The per-gate verdict map stays as a column in `task_view` for the detail page.
**The lane goes; the column does not.**

## 9. Migration: a reset, once

The log is reset — `events`, `checkpoints`, `outbox` truncated, projections
rebuilt. There are no upcasters for any of this, no data backfill, and renames
are plain renames.

This is legitimate exactly once, and the conditions are recorded so nobody cites
this ADR later as precedent: nothing is in production, the whole log is 106
events, and **there are zero `GuardTripped` events**, so the rename that would
otherwise need a permanent alias in the read path costs nothing.

The three real runs (admin #120, #155, #156) are archived in
`doc/experiments/` before the reset. After it, the append-only rule resumes with
no exceptions.
