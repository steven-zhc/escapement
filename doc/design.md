# Design

How Escapement is meant to work. *Why* each choice was made lives in
[`decisions/`](decisions/); this file describes the system.

---

## 1. A conductor, not a loop

The old model was poll → pick one → work → sleep 3600s. Once there is an event
log, every moment worth acting on already announces itself.

| Moment | Old loop | Escapement |
|---|---|---|
| A work item merged | sleep out the hour | `IntegrationSucceeded` → consider the next one now |
| You approve on the board | invisible until the next pass | `ApprovalGranted` → enter the merge lane now |
| The agent is stuck waiting | burns to the 2h wall clock | `RunAwaitingInput` → the card lights up |
| The agent trips the guard | stderr, unseen | `GuardTripped` → counted on the card |
| Context gets compacted | invisible | `RunContextExhausted` → this item was scoped too large |
| A bug is filed on GitHub | up to an hour later | webhook → `WorkItemDiscovered` → seconds |

`interval` should not exist as a configuration value. What replaces it is a
**concurrency limit** and a **merge lane**: work when there is work, otherwise
wait on events, and never run two integrations against one base branch at once.

---

## 2. One primitive: the gate

Verification, code review and human approval look like three features. They are
one: **a named check that produces a verdict about a specific diff.** Collapsing
them is what makes "configure it for another project" a YAML file rather than a
patch.

| Kind | What it is |
|---|---|
| `process` | Runs a command; the exit code is the verdict. `verify.sh`, unchanged. |
| `agent` | A second agent, cold — only the diff and the issue, never the implementer's context. Structured findings are the verdict. |
| `policy` | Globs against the diff. The migration hold that caught #117, generalised. |
| `human` | Waits for a person. Identical event shape; the verdict arrives from the board. |

All four emit `GatePassed` / `GateFailed` / `GateWaived`, all carry `onSha`, all
are declared in configuration. Adding a CI check, a second reviewer, a security
scan — a configuration line, not a code change.

**`onSha` is load-bearing.** A verdict is about a diff, not about a ticket. Bind
it to the commit and a force-push invalidates the approval automatically. In the
old system approval was a label, and a label survives any amount of rewriting.

### The cold reviewer

The old prompt asked the implementing agent to review its own diff. Measured
result of doing that: see
[experiments/001](experiments/001-cold-review-issue-58.md) — self-review, build,
CI and a human read all passed a change carrying four defects.

Requirements for the gate:

- **Fresh context.** Issue, diff, and the touched files at that commit. Never the
  implementer's plan or transcript.
- **A stated checklist, not "review this."** Concurrency and check-then-write;
  error and null paths; whether it closes the issue as written; anything touching
  a file that appears in the `regressions` projection.
- **Structured findings.** File, line, and a concrete failure scenario — inputs
  through to wrong output. No failure scenario, no finding.
- **A fixed severity rubric.** Left to judgement, the reviewer under-rates silent
  data corruption. Define the levels in the prompt.
- Adversarial verification is designed but **deferred** — it filters false
  positives, and there are not yet any to filter.

Keep the self-review as well. It is cheap and catches different things; it just
stops being the only reviewer.

---

## 3. The board

Not a status page — **the place the backlog gets worked**. The diff, every gate
verdict and the approve/reject controls are on the card. If you still have to
open GitHub to act, nothing has changed.

| Column | Holds |
|---|---|
| Queued | discovered, prioritised, runnable |
| Running | one in flight, with turn count, cost, guard trips, files touched |
| Gates | build, tamper, review, policy — each with its verdict |
| **Waiting on you** | the bottleneck, so it gets its own column and inline actions |
| Landed | merged, each carrying any regression later filed against it |

Three things that column layout argues for. *Waiting on you* is a column, not a
label, because it is where the queue actually stalls. *Guard trips show on the
running card*, because 77% of runs hit them and nobody has ever seen one.
*Landed cards carry their regressions*, so a merge that produced two bugs reads
as what it is.

A card must carry, to be workable without leaving:

- The rendered diff, not a link out.
- Each gate's verdict with its evidence: build log tail, reviewer findings, the
  SQL behind a migration hold.
- The agent's self-review answers, which today are buried in a PR body.
- The run's receipt: cost, turns, wall time, guard trips, whether it compacted.
- Approve · Reject with a reason · Waive with a reason. All three emit events.
  **A waiver is recorded, never silent.**

---

## 4. Domain model

Three aggregates. The split matters: a run emits hundreds of events while a work
item lives for weeks, so one stream would make every read expensive.

| Aggregate | Stream | Lifetime | Owns |
|---|---|---|---|
| WorkItem | `wi-{project}-{n}` | weeks | lifecycle, priority, links to other items |
| Run | `run-{ulid}` | hours | one agent attempt: progress, guard trips, diff, receipt |
| Integration | `int-{project}-{base}` | forever | one base branch's merge lane — the serialisation point |

### Lifecycle

```
                    Discovered        Prioritized        Claimed
        [*] ────────────────▶ Backlog ──────────▶ Ready ─────────▶ Running
                                 ▲                  ▲                 │
                                 └──── Released ────┤                 │ ProposedCompletion
                                                    │                 ▼
                                    Unblocked       │              Gating
                                 ┌──────────────────┘              │    │
                                 │                     GateFailed  │    │ ApprovalRequested
                              Blocked ◀────────────────────────────┘    ▼
                                 ▲                                 Waiting on you
                                 │ IntegrationRefused                    │ ApprovalGranted
                                 │                                       ▼
                                 └──────────────────────────────────  Merging
                                                                         │ IntegrationSucceeded
                                                                         ▼
                                                                      Landed
```

Every arrow is an event. Every arrow that used to produce silence — the six
`return 1` paths in `integrate()` — is now `IntegrationRefused` with a typed
reason: `conflict`, `dirty-base`, `unpushed-base`, `pending-migration`,
`gate-failed`, `no-commits`, `lane-busy`.

**That diagram spans all three aggregates, and no single reducer produces it.**
A work item's own stream carries discovery, claims, blocks and the landing;
gating and approval are Run events, and the merge lane is Integration. Composing
them is the board projection's job. Two consequences worth stating rather than
discovering:

- **`Prioritized` has no event.** The catalogue has no `WorkItemPrioritized`, so
  Backlog and Ready are one state today — `reduceWorkItem` calls it `backlog`.
  Priority is a label on the recipe's `priority` list, read at queue time. If
  ordering ever needs to be *decided* rather than derived, that becomes an event
  and this arrow becomes real.
- **A verdict is stale, not revoked.** `gatesOn(run)` returns only the verdicts
  whose `onSha` matches the current head, so a force-push invalidates approval by
  arithmetic rather than by anything remembering to undo it.

The full catalogue is [`packages/core/src/events.ts`](../packages/core/src/events.ts),
which is the authority. Notable additions over what the old loop could express:

| Event | Why it exists |
|---|---|
| `GuardTripped` | 132 of these were invisible; they are how the guard patterns get tuned |
| `RunContextExhausted` | compaction means the item was scoped too large — a metric |
| `WorkItemLinked` | connects a filed bug to the merge that caused it |
| `DispatchRefused` | capability matching said no; never silently downgrade a tier |
| `GateWaived` | the human escape hatch, recorded |
| `ProjectPolicySet` | policy changes are events, with a time and a reason |

### Projections

Ordinary tables, advanced by a subscriber with a row in `checkpoints`. Changing
one is `TRUNCATE` + reset + replay, which is why none are in the schema yet.

| Projection | Answers |
|---|---|
| `board` | columns, cards, gate badges |
| `queue` | what is runnable, in what order |
| `waiting_on_human` | everything stalled on a person, oldest first |
| `run_receipts` | cost/turns/duration p50 and p95; cost per landed item |
| `guard_trips` | which patterns fire most — the false positives to tune |
| `regressions` | landed items with bugs filed against them |
| `github_mirror` | labels to **write out**, never read back |

That last row is the inversion everything else rests on. GitHub stops being the
database and becomes a display surface — one more projection, beside the board.

`regressions` feeding the reviewer's prompt closes the loop on itself: when the
cold reviewer opens a diff touching a file with a history of check-then-write
races, it is told so. No static prompt has that signal.

---

## 5. The hook: observation and control on one channel

A hook is usually thought of as a guard. It is better understood as **the only
channel through which the outside world reports facts to the event log** — and
the same round trip carries the verdict back. One socket, both directions.

```
agent tool call ─▶ esc-hook ─▶ unix socket ─▶ conductor ─▶ postgres
   JSON on stdin    Bun single    verdict from    append +    NOTIFY
                    file, ~10ms   memory          async       ↓
                    ◀────────────────────────────            board
```

| Hook | Becomes | Worth it because |
|---|---|---|
| `SessionStart` | `RunStarted` | binds the runtime's session id to the run id, so everything after is attributable |
| `UserPromptSubmit` | `RunPrompted` | records the prompt version — later, "which prompt produced better work" |
| `PreToolUse` *(on deny)* | `GuardTripped` | 132 of these were invisible in the old loop |
| `PostToolUse` *(edit/write)* | `RunTouchedFile` | the card shows what the agent is changing, live |
| `Stop` | `RunProposedCompletion` | **the moment the gate pipeline fires** |
| `SessionEnd` *(CC only)* | `RunFinished` | cost, turns, duration |
| `PreCompact` *(CC only)* | `RunContextExhausted` | this item should have been split |
| `Notification` *(CC only)* | `RunAwaitingInput` | the board lights up instead of waiting out the clock |

### Three rules on the hot path

- **Verdict synchronous, persistence asynchronous.** Allowed calls are counted in
  memory and queued; only denials persist synchronously, and by then the decision
  is already made. *The event store's availability must never gate an agent's
  tool call.*
- **Fail closed.** Socket unreachable, timeout, unparseable payload — exit 2, with
  a startup smoke test that proves it, the way `test-guard.sh` did.
- **The conductor generates the hook configuration.** Each worktree's
  `settings.json` / `config.toml` is rendered with that run's id and socket path,
  and lives outside the worktree. The agent cannot edit its own hook wiring.

### The reverse direction

`UserPromptSubmit` can return added context. When the agent is about to work on
a file the `regressions` projection knows about, the conductor injects that fact.
See [decisions/0007](decisions/0007-dual-runtime.md) for what a hook is *not* —
it is not a security boundary.

---

## 6. Configuration

Recipe in `<repo>/.escapement/config.yaml`, policy in Escapement's database, and
a run's recipe read from `origin/<base>` rather than from the agent's branch.
Full reasoning and the recipe/policy split: [decisions/0005](decisions/0005-config-in-target-repo.md).
The schema is [`packages/config/src/recipe.ts`](../packages/config/src/recipe.ts).

Onboarding is `esc add <owner>/<repo>`, and `esc doctor <project>` is the old
`preflight()` generalised — its value is not the first run but every time
afterwards you change something and want to know what you broke.

---

## 7. Layout

```
escapement/
├── packages/
│   ├── core/        events, aggregates, reducers   ← zero I/O, tests without a database
│   ├── config/      recipe schema, presets, doctor checks
│   ├── store/       Postgres: append / read / subscribe
│   ├── runtime/     ClaudeCodeRuntime · CodexRuntime (stub)
│   ├── gates/       process · agent · policy · human
│   ├── conductor/   scheduler, dispatch, gate pipeline, integrator, hook socket
│   └── hook/        the only hot path — Bun single file, no dependencies
├── apps/
│   ├── board/       Next.js 16, App Router — projections + SSE  ← scaffolded
│   └── cli/         esc doctor / status / policy / replay
├── prompts/         ticket.md · cold-review.md   (versioned, recorded in events)
└── doc/
```

`core` being zero-I/O is deliberate. The old loop's least testable code — the six
branches of `integrate()` — is a pure function here.

**Running shape.** The conductor is a launchd daemon; on restart it rebuilds
state from the log, reconciles against reality (worktrees, branches, live
processes) and records the difference as `Reconciled`. No `caffeinate` patch. The
board is localhost, unauthenticated, single user. Postgres is separate from every
managed project.

---

## 8. Deliberately not building

Event sourcing attracts ceremony. This system handles a few dozen events an hour,
single writer, one machine. It is worth building for the board, the approvals and
multi-project — **not for scale**. So:

- **No message broker.** A Postgres table with a global `seq` plus `NOTIFY` is the bus.
- **No separate read database.** CQRS here means two sets of tables in one database.
- **No snapshots.** Streams are short. Add them when a replay exceeds a second, which will not happen.
- **No sagas or process managers.** The scheduler is a loop over the `queue` projection.
- **No general workflow engine.** Gates are one ordered list per project. Branching waits for a second project that needs it.
- **No configuration UI.** YAML plus `esc doctor`. Configuration changes when a project is onboarded, not daily.
- **No auth, no multi-user.** It runs on one machine.
- **No work-item DAG.** The agent filing follow-up issues is the manual version and it is sufficient — but `WorkItemLinked` leaves the door open.

**The two things worth over-building** are the event schema and the configuration
schema. Everything else is derived and costs an afternoon to replace; those two
are what a year of history is written against.
