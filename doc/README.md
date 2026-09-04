# Documentation

**[architecture.html](architecture.html)** — one page, four diagrams: which
processes exist, who appends to the log, who is told when it changes, and
where every piece of state lives. Open it in a browser.

Three kinds of thing live here, and the distinction matters.

| | |
|---|---|
| [`roadmap.md`](roadmap.md) | Six phases, each with an exit criterion that is a fact. The backlog, with issue numbers. |
| [`design.md`](design.md) | How the system is meant to work, as a whole. Rewritten as it changes. |
| [`decisions/`](decisions/) | One decision per file, with its context and its consequences. **Append-only in spirit** — a decision that turns out wrong gets a new file that supersedes it, not an edit. |
| [`experiments/`](experiments/) | Things actually run against real data, with their results. A design claim backed by one of these is worth more than one backed by argument. |

## Decisions

| | | |
|---|---|---|
| [0001](decisions/0001-event-sourcing.md) | Rebuild the loop as an event-sourced system | accepted |
| [0002](decisions/0002-typescript.md) | TypeScript, with the hook as a Bun single file | accepted |
| [0003](decisions/0003-postgres-event-store.md) | PostgreSQL as the event store | accepted |
| [0004](decisions/0004-prisma.md) | Prisma 8 as the ORM | accepted |
| [0005](decisions/0005-config-in-target-repo.md) | Configuration lives in the managed repository | accepted |
| [0006](decisions/0006-github-app.md) | A GitHub App, not a personal access token | accepted |
| [0007](decisions/0007-dual-runtime.md) | Two runtime interfaces, one implementation | accepted |
| [0008](decisions/0008-nextjs-board.md) | Next.js for the board, SSE for live updates | accepted |
| [0009](decisions/0009-two-connections.md) | Two connection strings: pooled, and session mode | accepted |
| [0010](decisions/0010-source-runs-unbuilt.md) | The source runs unbuilt, so it obeys strip-only rules | accepted |
| [0011](decisions/0011-hook-latency-is-runtime-startup.md) | The hook's 20ms budget is Bun's startup, and is not met | accepted |
| [0012](decisions/0012-one-task-view.md) | One `TaskView`, and the queue leaves the log | accepted |
| [0013](decisions/0013-daemon-hosts-the-work.md) | The daemon holds the work; the UI controls it | accepted |
| [0014](decisions/0014-one-loop-one-log.md) | One loop, one log; everything else is a projection or a subscriber | superseded by 0016 |
| [0015](decisions/0015-five-gates-and-two-extensions.md) | Five gates, and the two ways a plugin may extend the loop | superseded by 0016 |
| [0016](decisions/0016-the-settled-model.md) | **The settled model: one loop, five gates, no policy** | accepted |
| [0017](decisions/0017-the-project-is-called-lingtai.md) | The project is called Lingtai | accepted |
| [0018](decisions/0018-the-proposed-point.md) | The gate point called `diff` is called `proposed` | accepted |
| [0019](decisions/0019-a-second-reset.md) | The log is reset a second time, and what makes it the last | accepted |
| [0020](decisions/0020-the-agent-environment-in-layers.md) | The agent's environment comes from three named layers | superseded by 0021 |
| [0021](decisions/0021-the-recipe-decides-the-environment.md) | The recipe decides the environment; the machine only holds it | accepted |

## Experiments

| | | |
|---|---|---|
| [001](experiments/001-cold-review-issue-58.md) | Does a cold reviewer catch what four other checks missed? | yes, plus two nobody had found |
| [002](experiments/002-subscriber-survives-a-kill.md) | Does the subscriber survive its connection being killed? | yes, no gap and no duplicate |
| [003](experiments/003-doctor-catches-a-pooler.md) | Does `lingtai doctor` actually catch a transaction pooler? | yes, including the flagless case |
| [004](experiments/004-hook-latency.md) | Where does `lingtai-hook`'s latency actually go? | all of it is Bun's startup; 20ms p95 not met |
| [005](experiments/005-rung-1-reaches-a-real-repository.md) | Does a run reach a real repository end to end? | yes, after four attempts, each buying a defect |
| [006](experiments/006-the-loop-closes-unattended.md) | Does the loop close with nobody running a command? | yes — admin #156, 15 turns, $0.83 |
| [007](experiments/007-the-log-before-the-reset.md) | What was in the log before ADR 0016 reset it? | 106 events, Phase 0 through 2a, kept because it is the only copy |
| [008](experiments/008-deny-survives-bypass.md) | Does `permissions.deny` survive `bypassPermissions`? | yes, by removing the tool — so the guard is deleted, not renamed |
| [009](experiments/009-the-end-gate-closes-its-own-issue.md) | Does the new model land and close a ticket by itself? | yes — admin #157, 8 turns, $0.63, closed with its label intact |

## Open

- **[ADR 0016](decisions/0016-the-settled-model.md) is built.** Phase 3 landed
  in six steps between 2026-09-01 and 2026-09-02: the guard deleted, the policy
  concept deleted, five gate points with `GatesResolved`, the `end` point closing
  its own issue, the board reduced to four lanes with every point rendered, and a
  real admin ticket run end to end on the new model. `prepare` folded into the
  `prepared` point last (`3c'`), which is why the event count fell from 41 to 38.
  What is *not* proven is listed under experiment 009.

- **The condition 0016 §4 rests on is the one to watch.** An unconfigured gate
  must render as `skipped` on the board and in `lingtai status`, never be omitted.
  Skip that and the design collapses back into the plugin free-for-all
  [0014](decisions/0014-one-loop-one-log.md) rejected — which is why
  `GatesResolved` is an event and not a convention.
- **Phase 1's exit criterion is met** (admin #155 and #120 landed on
  2026-09-01) and **2a's is too** (#156, 2026-09-02, unattended). What has *not*
  been proven: more than one project, a queue deeper than one item, a run with
  the guard on, and the launchd install. See
  [experiment 006](experiments/006-the-loop-closes-unattended.md) for the full
  list of limits.
- **Six of `lingtai doctor`'s checks are not implemented.** They print as `skip` with
  the issue that fills them in — recipe, repository, environment allowlist, hook
  fail-closed, GitHub auth — rather than being omitted. A check you cannot see is
  a check you will forget you never had.
- **`seq` is not gapless.** A Postgres sequence claims a value when the `INSERT`
  runs and publishes it when the transaction commits, so under concurrent
  writers a subscriber can see `seq` 6 while 5 is still in flight, and a
  checkpoint advanced to 6 skips 5 forever. It cannot bite while the conductor
  is the single writer. [#4](https://github.com/steven-zhc/lingtai/issues/4)
  has to solve it rather than assume it away; the note is in `readAll`.
- **Forward compatibility stops at the store.** The reducers ignore an event
  type they do not know, so an older projection survives a newer conductor. The
  store does not — it throws `UnknownEventTypeError` on read, so in practice it
  refuses the event first. That is deliberate for now (a type nobody models is
  more likely a bug than a newer writer), but it means the tolerance is only real
  once the two agree.
- **`tier: sandboxed`.** Containerising the whole toolchain is its own piece of
  work; `guarded` is what the first project runs at. See
  [0007](decisions/0007-dual-runtime.md).
