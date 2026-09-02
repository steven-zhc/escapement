# Reference: every term, and everything currently in it

One table per term. Each says where the list lives in code, so a reader can
check rather than trust — the two doc defects found on 2026-09-02 were both a
document asserting a state of the world the code had moved past.

Where a list is open-ended (streams, runs, projects) it says so and gives
examples instead of pretending to be exhaustive.

**Counted 2026-09-02.**

> **This describes the code as it is.** [ADR 0016](decisions/0016-the-settled-model.md)
> has landed in full: the guard is gone, and with it `GuardTripped`, the
> `guard_trips` projection and the `--no-guard` flag; the policy concept is gone,
> with `tier` now the recipe's; gates are five fixed *points* rather than four
> *kinds*; the `end` point closes issues; the board is four lanes with every gate
> point rendered; and `prepare` is no longer a stage of its own — it is whatever
> a recipe puts at the `prepared` point. This file is updated as each step lands, never ahead of it. A
> reference that documents intent instead of behaviour is the defect this
> repository hit four times on 2026-09-02, and it is the one thing this file
> exists not to do.

---

## event — 38 types

One fact that already happened, past tense. Never edited, never deleted.
Source: the registry at the bottom of `packages/core/src/events.ts`.

| Group | Types |
|---|---|
| work item (7) | `WorkItemDiscovered` `WorkItemClaimed` `WorkItemReleased` `WorkItemBlocked` `WorkItemUnblocked` `WorkItemLinked` `WorkItemLanded` |
| dispatch (1) | `DispatchRefused` |
| run (9) | `RunStarted` `RunPrompted` `RunTouchedFile` `RunContextExhausted` `RunAwaitingInput` `RunProducedDiff` `RunProposedCompletion` `RunFinished` `RunFailed` |
| gate (7) | `GatesResolved` `EndActionsResolved` `GateRequested` `GateStarted` `GatePassed` `GateFailed` `GateWaived` |
| approval (3) | `ApprovalRequested` `ApprovalGranted` `ApprovalRevoked` |
| integration (3) | `IntegrationAttempted` `IntegrationRefused` `IntegrationSucceeded` |
| control (2) | `ConductorPaused` `ConductorResumed` |
| outbox (2) | `OutboxDelivered` `OutboxFailed` |
| project & queue (4) | `QueueChanged` `RunRequested` `ProjectConfigured` `Reconciled` |

Every type has a Zod payload schema and an entry in `SCHEMA_VER`. A payload
change means bumping that type's version and adding an upcaster in the same
commit — old events are never rewritten.

## stream — 5 prefixes, unbounded instances

The events about one thing, in order. The **prefixes** are a closed set,
validated by regex in `packages/core/src/envelope.ts`. The streams themselves
are not — one per work item, run, lane and project, forever.

| Prefix | One per | Example |
|---|---|---|
| `wi-` | work item (ticket) | `wi-nextloom-ai-admin-156` |
| `run-` | run (one attempt) | `run-75b80f13-9f88-48cf-b4d2-79b9779f47cf` |
| `int-` | integration lane, per base branch | `int-nextloom-ai-admin-develop` |
| `prj-` | project | `prj-nextloom-ai-admin` |
| `ctl-` | control | `ctl-conductor` (the only one so far) |

## upcaster — 2 chains

A function reading an older event shape and returning the current one.
Source: `UPCASTERS` in `packages/core/src/upcast.ts`.

| Type | Step | What was added, and why null is honest |
|---|---|---|
| `ProjectConfigured` | 1 → 2 | `owner` — the repo name alone could not reach GitHub again. v1 events get `null`, not a guess. |
| `ProjectConfigured` | 2 → 3 | `base` — defaulting to the repo's default branch is only right by convention, and admin's default was a feature branch. `null` means "ask GitHub", which is what those runs did. |
| `Reconciled` | 1 → 2 | see the registry |

Every other type is still at version 1.

## projection — 2

A regular Postgres table built by replaying the log. Holds no truth of its own.
Source: `PROJECTIONS` in `apps/cli/src/esc.ts`.

| Name | Answers | Owns its table? |
|---|---|---|
| `task_view` | what is the current state of every task the board shows | yes — `create`/`reset` build and drop it, along with `task_view_run` |
| `outbox` | what still has to be said to GitHub | **no** — the contract owns `outbox`, so `create`/`reset` are no-ops. Dropping it would take it out from under `db verify`. |

## task state — 5, board lane — 4

Source: `TaskState` in `packages/conductor/src/task-view.ts:50`.

`queued` · `running` · `gates` · `waiting` · `landed`

**The board shows four**: `gates` folds into `running` (ADR 0016 §8). From an
operator's seat "the agent is working" and "the build is running" are the same
fact — the machine is busy and you are not needed. `waiting` is the lane the
board exists for, and it stays its own.

The state survives because it is a real distinction *in the log*; only the
column is merged.

`queued` is the only one not driven by an event — it comes from GitHub, because
Escapement never decided which issues exist ([ADR 0012](decisions/0012-one-task-view.md)).

## tool restriction — none

Escapement restricts no tool call. There were eight rules; they are gone (ADR
0016 §6), and so is the `PreToolUse` wiring that evaluated them.

Tool limits belong to the agent runtime's own configuration — `permissions.deny`
in `~/.claude/settings.json` or a managed repository's `.claude/settings.json`.
It holds even under `--permission-mode bypassPermissions`, and it holds by
**removing the tool from the model's list**, so the agent never attempts it
([experiment 008](experiments/008-deny-survives-bypass.md)).

Containment is the filtered environment and the disposable worktree. Neither was
ever the guard's.

## hook — 7

What the runtime calls, and the only channel between a run and the log.
Source: `INTERSECTION_HOOKS` and `CLAUDE_ONLY_HOOKS` in `packages/conductor/src/hook-config.ts`.

| Hook | What Escapement does with it |
|---|---|
| `SessionStart` | lifecycle; the event is `RunStarted`, written by the conductor |
| `UserPromptSubmit` | `RunPrompted`, with the prompt version |
| `PostToolUse` | `RunTouchedFile`, for the four mutating tools only |
| `Stop` | hands back to the conductor, which fires the gates |
| `SessionEnd` | Claude-only; `RunFinished` comes from the process outcome |
| `PreCompact` | Claude-only; `RunContextExhausted` |
| `Notification` | Claude-only; `RunAwaitingInput` |

`PreToolUse` was the eighth and is gone with the guard. It was the only hook on
the hot path — one round trip per tool call, against a 20ms budget of which
process startup alone was 17ms.

**Four tools count as mutations** (`hook-socket.ts`), and only these produce
`RunTouchedFile`: `Write` · `Edit` · `MultiEdit` · `NotebookEdit`.

## gate point — 5, closed forever

A gate is a **place in the loop**, not a kind of check. The set may never grow.
Source: `GatePoint` and `GATE_POINTS` in `packages/core/src/events.ts`.

| Point | When | May refuse? |
|---|---|---|
| `admit` | the queue offers an item, before it is claimed | yes |
| `prepared` | after the worktree exists, before the agent starts | yes |
| `diff` | the agent stopped and there are commits | yes |
| `merge` | after `diff` passes, before the merge lane | yes |
| `end` | the work item reached any terminal outcome | **no** |

Today only `diff` and `merge` have anything wired: `diff` runs the recipe's
actions, `merge` holds when a `human` action asks or when `--no-merge` does.
`end` now runs too: its actions are effects rather than verdicts, and they go
through the outbox so they survive a crash. `admit` and `prepared` are declared
and empty, which is what an unconfigured point *is* rather than a gap.

## gate action — 4 kinds

What runs at a point. Source: `GateAction` in `packages/config/src/recipe.ts`.

| Key | Verdict comes from | Needs |
|---|---|---|
| `run:` | a command's exit code | nothing |
| `agent:` | a cold reviewer reading the diff, given this prompt | a reviewer runtime |
| `watch:` | globs against the diff's file list, then `request-approval` or `fail` | the diff's file list |
| `human:` | a person, later, on the same stream; the string is the question | nothing |
| `close:` | — it is an effect, not a verdict. `end` only | the outbox |
| `labels:` | — same | the outbox |

The last two carry `when:` (`landed` / `blocked` / `failed` / `any`), because
`end` fires on *every* terminal outcome. "Close it when it lands, label it when
it is blocked" is one configuration rather than two mechanisms. Putting either
at a gating point is refused by name — a gate that silently did nothing would be
worse.

The shape is GitHub Actions': a `name`, exactly one of the keys above, and its
parameters beside it. Order within a point is the array's, the first refusal
wins, and the actions after it do not run.

Verdicts: `passed` · `failed` · `needs-approval`. The third is not a flavour of
failure — nothing is wrong, and nothing may proceed until a person says so.

**Verdicts are keyed `point:action`** in `task_view`, the board and `reduceRun`.
Two points may run an action of the same name, and a bare name would let the
second silently overwrite the first.

`onSha` is load-bearing: a verdict is about a diff, so a force-push invalidates
it by arithmetic rather than by anybody noticing.

## what the log says was *supposed* to happen

`GatesResolved`, one per run, appended before anything is claimed. It names all
five points and the ordered actions resolved for each — empty arrays included.

Without it the log could not distinguish "nothing was configured here" from
"this point does not exist", because `ProjectConfigured` carries a config *hash*
and not the configuration. That distinction is what [ADR 0016](decisions/0016-the-settled-model.md)
§4 rests on: an unconfigured gate is skipped and that is the user's call; a gate
that *was* configured and did not run is Escapement's bug, and comparing this
event to the verdicts that follow is how the second becomes detectable.

## tier — 3

`open` · `guarded` · `sandboxed`. Source: `Tier` in `packages/core/src/events.ts:26`.

**It is the recipe's** — `runtime.tier`, defaulting to `guarded` — since the
policy that used to set a floor under it was deleted (ADR 0016 §7). There is no
comparison left to make: `run-once.ts` refuses to dispatch when the runtime
cannot meet what the recipe asks, and that is the whole of the enforcement.

`sandboxed` remains a value no runtime provides, so asking for it can only ever
refuse.

## work kind — 4

What the recipe's `source.kinds` selects on, read from an issue's labels.
Source: `WorkKind` in `packages/core/src/events.ts:22`.

`bug` · `feature` · `enhancement` · `tech-debt`

An issue with no matching label has no kind and is **not runnable** — which is
why admin #156 sat invisible until it was labelled.

## runtime — 2

Source: `RuntimeId` in `packages/core/src/events.ts:29`.

`claude-code` · `codex`

## integration refusal reason — 7

Why a merge did not happen. Source: `RefusalReason` in `packages/core/src/events.ts:37`.

`conflict` · `dirty-base` · `unpushed-base` · `pending-migration` ·
`gate-failed` · `no-commits` · `lane-busy`

## run stage — 10

Where a failed run stopped, as `stopped at <stage>`. Source: the `stage:`
returns in `packages/conductor/src/run-once.ts`.

`recipe` · `dispatch` · `discover` · `claim` · `hook` · `prepare` · `run` ·
`diff` · `integrate` · `unexpected`

`diff: no commits` is the one worth recognising — the agent finished and wrote
nothing.

## outbox kind — 3

Everything that leaves this machine and is not git. Source:
`OutboxKind` in `packages/conductor/src/outbox.ts:74`.

`issue-comment` · `issue-labels` · `issue-close`

### where `skipped` is rendered

The task page lists **all five points**, always, marking an empty one `skipped`
rather than leaving it out — `PointView` in `apps/board/src/lib/task.ts`, built
by folding `GatesResolved` against the verdicts that followed. A point with more
planned actions than verdicts shows a `pending` count, which is where
"configured but did not run" becomes visible.

`esc add` prints the same five at onboarding. Neither surface omits a point.

## outbox, continued

`issue-close` comes from `EndActionsResolved`, which is how a recipe's `end`
plan reaches a projection. The conductor reads the recipe and writes down what
it resolved; the projection only folds. **A projection may never read a
recipe** — that division is why a rebuild produces the same rows years later
even if the recipe has changed since.

Nothing that changes *code* goes through here — that is git's job, under the
merge lane's lock.

## notification subscription — 4 by default

What is worth interrupting somebody for. All four mean the same thing: nothing
moves until a person acts. Source: `DEFAULT_SUBSCRIPTIONS` in
`packages/daemon/src/notify.ts`.

`ApprovalRequested` · `IntegrationRefused` · `RunAwaitingInput` · `WorkItemBlocked`

A landed task is good news that needed nobody, and is deliberately not here.

## esc subcommand — 11

Source: the switch in `apps/cli/src/esc.ts`.

`add` · `run` · `approve` · `status` · `doctor` · `daemon` · `pause` ·
`resume` · `now` · `projection` · `version`

## doctor check — 16 live, 5 deferred

Source: `apps/cli/src/doctor.ts`. This list is `pnpm esc doctor`'s own output,
not a reading of the file — grepping the constructors missed six of them.

| Group | Checks |
|---|---|
| load (1) | `packages load under Node` |
| environment (1) | `environment` |
| connections (2) | `postgres: pooled connection` · `postgres: direct connection is session mode` |
| schema (5) | `schema: tables` · `schema: optimistic concurrency` · `schema: append-only` · `schema: notify trigger` · `schema: payload columns` |
| running system (4) | `projections: lag` · `daemon: liveness` · `worktrees: reconciliation` · `outbox: depth` |
| credentials (2) | `github: app credentials` · `runtime: signed in` |
| visibility (1) | `runtime: other settings in scope` — reports what configures a run besides the recipe |

Four statuses: `ok`, **`warn`** (nothing is wrong and you should know anyway),
`fail`, `skip`. `warn` was added with the check above: folding it into `ok`
hides it in a wall of green, and into `fail` makes doctor red for a file
everybody has.

Deferred checks each name the issue that will implement them, and are reported
rather than hidden — a check quietly dropped is indistinguishable from one that
passes.

## preset — 1

Source: `packages/config/src/presets.ts`.

`pnpm-workspace` — a `pnpm install --frozen-lockfile` action at `prepared` and a
`build` action at `diff`. A preset's *name* is not part of the recipe hash, because
it is not part of what a run does.

## package — 9, plus 2 apps

`core` · `config` · `store` · `github` · `runtime` · `gates` · `conductor` ·
`daemon` · `hook`, and `apps/cli` · `apps/board`.

## doc — 14 decisions, 6 experiments

`doc/decisions/` is append-only in spirit: a decision that turns out wrong gets
a new file that supersedes it, never an edit. `doc/experiments/` holds things
actually run, each with its limits.
