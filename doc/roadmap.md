# Roadmap

Six phases. Each has an **exit criterion** that is a fact, not a feeling — if it
cannot be demonstrated, the phase is not done.

Two sequencing constraints drive the whole shape:

1. **`agent-loop.sh` keeps working tickets until Phase 2 cuts over.** Phase 1
   proves the machinery on one ticket under supervision; it does not replace
   anything. The old loop is retired only when Escapement has done its job
   unattended for a week.
2. **Escapement manages itself from Phase 3, not before.** Self-hosting is a
   test of the system, so it needs a system that has already passed a real one.

| | Phase | Exit criterion |
|---|---|---|
| 0 | System scaffold | An event round-trips through Postgres and a projection rebuilds from the log |
| 1 | Minimum runnable unit | One real admin ticket goes discovery → merge with `esc run --once`, supervised |
| 2 | Take over admin | Escapement works admin unattended for a week; `agent-loop.sh` is retired |
| 3 | Self-hosting | Escapement lands a change to its own repository, through its own gates |
| 4 | Multi-project | A second repository runs with no code change, only a descriptor |
| 5 | Feedback loop | A gate change is evaluated by replay against history before it ships |

---

## Phase 0 — System scaffold

**Goal.** The parts that need no agent, no GitHub and no judgement: the log, the
projections, and a command that tells you what is broken.

Already done and committed: repository, `@escapement/core` event catalogue,
`@escapement/config` recipe schema, the Postgres contract under Prisma 8 with
its migration applied, the Next.js board shell, the decision records, and the
log's write side — `append` / `read` / `readAll` with optimistic concurrency
(#1) — and the subscriber, which reconnects and resumes without gap or duplicate
(#2, [experiment 002](experiments/002-subscriber-survives-a-kill.md)).

What remains is what turns a log into state: the reducers (#3), the projection
runner (#4), and a command that says what is broken (#5).

**Exit criterion.** `esc doctor` is green, an event round-trips, and a projection
can be dropped and rebuilt from the log with an identical result.

## Phase 1 — Minimum runnable unit

**Goal.** One ticket, end to end, with a person watching. `esc run --once` picks
a real admin issue, provisions a worktree, runs Claude Code under the guard hook,
runs the build gate, and merges — or refuses with a typed reason.

This is the proof of value. It is deliberately narrow: one project, one runtime,
one gate, one work item at a time, and no approval flow. Every gate kind, the
board's write actions, and unattended operation are all Phase 2.

**`agent-loop.sh` keeps running throughout.** Nothing here competes with it, and
the two must not both hold `agent:wip` on the same issue — Phase 1 runs against
`agent:hold`-free tickets you nominate by number, not against the queue.

**Exit criterion.** A real admin issue is merged into `develop` by Escapement,
and the board shows it in Landed with its receipt.

## Phase 2 — Take over admin

**Goal.** Everything that turns one supervised run into an unattended system: the
remaining three gate kinds, human approval from the board, GitHub write-back
through the outbox, notifications, crash recovery, and webhooks.

This is where the board stops being a status page. The old loop's review queue
reached 45 items growing at 14 a day against zero processed, because working it
meant leaving the tool. If Phase 2 ships and that number does not move, the
bottleneck was never tooling — which is worth knowing.

**Cutover.** `agent-loop.sh` is retired at the end, not the start. Both systems
run in parallel first, with Escapement on a subset of labels, so a failure has
somewhere to fall back to.

**Exit criterion.** Escapement works admin for seven consecutive days with no
manual intervention beyond approving on the board, and `agent-loop.sh` is off.

## Phase 3 — Self-hosting

**Goal.** Escapement manages its own repository.

This is not a victory lap, it is the hardest correctness problem in the project:
**an agent editing the conductor that is running it.** Three rules follow.

- **Escapement's own policy is the strictest one.** Every gate required, human
  approval on everything, no waivers configured. It gets no benefit of the doubt
  it would extend to a business repository.
- **The conductor never restarts itself.** A merge to `main` lands; the running
  daemon keeps executing the old code until a person runs `esc restart`. That is
  the escapement principle applied to the escapement: energy released one tooth
  at a time, deliberately.
- **`esc doctor` runs against the new code before the restart, not after.** A
  merge that breaks the scheduler must not be discovered by the scheduler failing
  to start.

**Exit criterion.** A change to Escapement's own code is implemented by an agent,
passes its own gates, is approved on the board, merges, and is running after a
deliberate restart.

## Phase 4 — Multi-project

**Goal.** The claim that a second repository costs a descriptor and nothing else,
tested by doing it. Plus the Codex adapter, real concurrency, and the containment
tier that Phase 0–3 deferred.

Concurrency is last on purpose. The old loop landed seven tickets in a night
while the review backlog grew by fourteen; throughput was never the constraint.
Raising it before the board demonstrably draws the queue down would make the
problem worse, faster.

**Exit criterion.** `nextloom-ai-press` runs with a descriptor under twenty lines
and no change to any package.

## Phase 5 — Feedback loop

**Goal.** Make the system able to evaluate changes to itself against history.

The material already exists: 73 runs, 132 guard trips, 31 merged diffs, and a
labelled defect set. [Experiment 001](experiments/001-cold-review-issue-58.md)
used one of them by hand. This phase makes that a command.

**Exit criterion.** A change to the gate pipeline is replayed against historical
runs, and the comparison is what decides whether it ships.

---

## Backlog

Thirty-five issues, created in dependency order so each one references the
real number of what it needs. Phases 4 and 5 are single epics on purpose —
their shape depends on what Phases 1–3 teach, and pre-writing tickets that
will be rewritten is exactly the noise this system exists to remove.

Milestones on GitHub match the phases here.


**Phase 0 — System scaffold**

| | |
|---|---|
| [#1](https://github.com/steven-zhc/escapement/issues/1) | Store: append and read, with optimistic concurrency |
| [#2](https://github.com/steven-zhc/escapement/issues/2) | Store: subscribe over LISTEN/NOTIFY, with reconnect |
| [#3](https://github.com/steven-zhc/escapement/issues/3) | Core: aggregate reducers for WorkItem, Run and Integration |
| [#4](https://github.com/steven-zhc/escapement/issues/4) | Store: projection runner with checkpoints and rebuild |
| [#5](https://github.com/steven-zhc/escapement/issues/5) | CLI: the `esc` skeleton and `esc doctor` |
| [#6](https://github.com/steven-zhc/escapement/issues/6) | Bring the database up: initial migration and notify.sql |

**Phase 1 — Minimum runnable unit**

| | |
|---|---|
| [#7](https://github.com/steven-zhc/escapement/issues/7) | GitHub: the App client and `esc add` |
| [#8](https://github.com/steven-zhc/escapement/issues/8) | Config: resolve the recipe from `origin/<base>` and hash it |
| [#9](https://github.com/steven-zhc/escapement/issues/9) | Conductor: discover work items and build the queue |
| [#10](https://github.com/steven-zhc/escapement/issues/10) | Conductor: claim with a lease, and provision the worktree |
| [#11](https://github.com/steven-zhc/escapement/issues/11) | Hook: the `esc-hook` binary and the conductor socket |
| [#12](https://github.com/steven-zhc/escapement/issues/12) | Hook: guard policy and `GuardTripped` |
| [#13](https://github.com/steven-zhc/escapement/issues/13) | Runtime: the Claude Code adapter |
| [#14](https://github.com/steven-zhc/escapement/issues/14) | Gates: the process gate |
| [#15](https://github.com/steven-zhc/escapement/issues/15) | Conductor: the integrator |
| [#16](https://github.com/steven-zhc/escapement/issues/16) | Board: the board projection and real cards |
| [#17](https://github.com/steven-zhc/escapement/issues/17) | CLI: `esc run --once`, end to end |

**Phase 2 — Take over admin**

| | |
|---|---|
| [#18](https://github.com/steven-zhc/escapement/issues/18) | Gates: the agent gate — cold review |
| [#19](https://github.com/steven-zhc/escapement/issues/19) | Gates: the policy gate — tamper and migration holds |
| [#20](https://github.com/steven-zhc/escapement/issues/20) | Gates: the human gate and the approval lifecycle |
| [#21](https://github.com/steven-zhc/escapement/issues/21) | Board: approve, reject and waive |
| [#22](https://github.com/steven-zhc/escapement/issues/22) | Board: render the diff and the gate evidence on the card |
| [#23](https://github.com/steven-zhc/escapement/issues/23) | Board: live updates over SSE |
| [#24](https://github.com/steven-zhc/escapement/issues/24) | Conductor: the outbox and its delivery worker |
| [#25](https://github.com/steven-zhc/escapement/issues/25) | Conductor: the `github_mirror` projection and label reconciliation |
| [#26](https://github.com/steven-zhc/escapement/issues/26) | Conductor: macOS notifications |
| [#27](https://github.com/steven-zhc/escapement/issues/27) | Conductor: run as a daemon, and recover from a crash |
| [#28](https://github.com/steven-zhc/escapement/issues/28) | GitHub: webhook receiver for issues and push |
| [#29](https://github.com/steven-zhc/escapement/issues/29) | Retire `agent-loop.sh` |

**Phase 3 — Self-hosting**

| | |
|---|---|
| [#30](https://github.com/steven-zhc/escapement/issues/30) | Self-hosting: Escapement's own recipe and its strictest policy |
| [#31](https://github.com/steven-zhc/escapement/issues/31) | Self-hosting: tamper must cover Escapement's own source |
| [#32](https://github.com/steven-zhc/escapement/issues/32) | Self-hosting: never restart into unverified code |
| [#33](https://github.com/steven-zhc/escapement/issues/33) | Self-hosting: the first self-hosted change, supervised |

**Phase 4 — Multi-project**

| | |
|---|---|
| [#34](https://github.com/steven-zhc/escapement/issues/34) | Phase 4 — multi-project, Codex, concurrency, sandboxed tier |

**Phase 5 — Feedback loop**

| | |
|---|---|
| [#35](https://github.com/steven-zhc/escapement/issues/35) | Phase 5 — replay, regression feedback, receipts and guard tuning |

---

## Not on this roadmap

Deliberately, and for the reasons in [design.md §8](design.md#8-deliberately-not-building):
no message broker, no separate read database, no snapshots, no general workflow
engine, no configuration UI, no authentication, no work-item DAG. Each of those
becomes worth revisiting only when a specific failure demands it, and none has
yet.
