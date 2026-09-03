# 0016 — The settled model: one loop, five gates, no policy

**Status** accepted · 2026-09-02 · supersedes [0014](0014-one-loop-one-log.md)
and [0015](0015-five-gates-and-two-extensions.md), and supersedes the policy
half of [0005](0005-config-in-target-repo.md)

0014 and 0015 are kept, not deleted: they are the record of how this was
reached, and both contain arguments that were later withdrawn. This file is what
the code is built against. Where it disagrees with them, it wins.

## 1. What the core is

> **Lingtai takes a ticket, calls an agent to work on it, and merges the
> result into a base branch. Everything else is declared in the recipe.**

That sentence is the whole of what is not configurable. Concretely the core
owns, and will not delegate:

| | Why it cannot be a plugin |
|---|---|
| the append-only log | it is the truth; see 0014's reasoning, which stands |
| refreshing the queue from GitHub | Lingtai never decides which issues exist ([0012](0012-one-task-view.md)) |
| claim, with its lease and uniqueness | `UNIQUE (stream_id, version)` is the concurrency control |
| the worktree lifecycle | the isolation boundary a run actually has |
| dispatching the agent | this is the thing being scheduled |
| **integrate — the merge lane under its advisory lock** | see below |
| stamping every verdict with `onSha` | an action returns a verdict; the core binds it to a commit, so a plugin cannot break the invariant that a verdict is about a diff |

**`integrate` stays in the core, and this is the boundary worth defending.** If
merging were pluggable there is no scheduler left, only a generic event workflow
engine — and the advisory lock that makes concurrent merges safe would become
the plugin author's problem. Lingtai is opinionated about exactly one thing:
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
defect. Lingtai does not check that a project configured the gates it
"should" have. **Configured and did not run is Lingtai's bug.**

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

## 6. Lingtai does not restrict tool calls

This section previously renamed the guard to `tools` and kept Lingtai's own
rule engine. **The guard is deleted instead**, and the reasoning is worth keeping
because it is a case of a measurement removing a subsystem.

Both runtimes already have two configuration levels, and the second one is
already where a run reads it from: the managed repository's own
`.claude/settings.json`, which is in the worktree because the worktree is a
checkout of that repository. A third level in the recipe is a third answer to
"where do I configure this?", and the question is common enough that three
answers is the wrong number.

The objection was that Lingtai passes `--permission-mode bypassPermissions`
deliberately — a run once spent 45 turns and $3.35 unable to write a file
because Claude Code's permission layer refused everything before `lingtai-hook` saw
it. Delegating to a layer we turn off would delegate to nothing.

[Experiment 008](../experiments/008-deny-survives-bypass.md) settled it:
**`permissions.deny` is enforced under `bypassPermissions`**, and it is enforced
by *removing the tool from the model's list* rather than refusing a call. The
two are orthogonal — `bypassPermissions` fixes "headless cannot grant a prompt",
which is what the expensive run actually hit, and `deny` still holds.

That also collapses the argument for keeping a guard at all. Its justification,
in its own header, is observability: the old loop fired 132 blocks across 77% of
runs into a stderr nobody read, and no rule was ever tuned because nobody could
see which fired. **That argument presumes attempts to record.** A deny that
removes the tool produces none — the agent never tries. There is nothing to see,
so nothing is lost by not seeing it.

So the honest statement is:

> **Lingtai does not restrict tool calls.** Containment is the filtered
> environment and the disposable worktree. Tool restrictions belong to the agent
> runtime's own configuration, at its user or project level.

Deleted: `conductor/src/guard.ts` and the eight rules, the deny path in
`hook-socket.ts`, the `GuardTripped` event, the `guard_trips` projection,
`smokeTestFailClosed`, the `--no-guard` flag, and the `PreToolUse` wiring, which
has no remaining job. The `tools` recipe section is never added, and
`ToolCallRefused` and `tool_refusals` are never created.

**Seven hooks remain, and the channel is untouched.** `PostToolUse` carries
`RunTouchedFile`, `Stop` carries the completion proposal, `PreCompact` carries
`RunContextExhausted`, and `SessionStart`, `UserPromptSubmit`, `SessionEnd` and
`Notification` carry the rest. Deleting the guard removes one hook's job, not
the mechanism.

**What is lost, recorded rather than waved away.** One recipe can no longer
describe tool limits for both runtimes, since each has its own configuration —
weak today, because Codex has never run against a real repository. And nothing
on Lingtai's side records what an agent was not allowed to do: a project's
`.claude/settings.json` can change with nothing in the log noticing.

That second cost makes one thing mandatory rather than nice: **`lingtai doctor` must
report which settings sources are live** for a run — whether
`~/.claude/settings.json` exists and whether it carries `permissions`, `hooks`
or MCP servers. Lingtai does not set `HOME`, so the operator's personal
configuration is in scope for every run, and the recipe is therefore *not* a
complete description of one. Being unable to control that is acceptable. Being
unable to see it is not.

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
- **The whole guard**, per §6: `guard.ts`, the eight rules, `GuardTripped`, the
  `guard_trips` projection, `smokeTestFailClosed`, `--no-guard`, and the
  `PreToolUse` wiring.

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
events, and **there are zero `GuardTripped` events**, so deleting that type
costs nothing where it would otherwise need a permanent alias in the read path.

The three real runs (admin #120, #155, #156) are archived in
`doc/experiments/` before the reset. After it, the append-only rule resumes with
no exceptions.
