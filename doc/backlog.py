# -*- coding: utf-8 -*-
"""Backlog for steven-zhc/escapement, generated in dependency order so each
issue can reference the real number of the ones it depends on."""

REPO = "steven-zhc/escapement"

MILESTONES = [
    ("Phase 0 — System scaffold",      "An event round-trips through Postgres and a projection rebuilds from the log."),
    ("Phase 1 — Minimum runnable unit","One real admin ticket goes discovery to merge with `esc run --once`, supervised."),
    ("Phase 2 — Take over admin",      "Escapement works admin unattended for a week; agent-loop.sh is retired."),
    ("Phase 3 — Self-hosting",         "Escapement lands a change to its own repository, through its own gates."),
    ("Phase 4 — Multi-project",        "A second repository runs with no code change, only a descriptor."),
    ("Phase 5 — Feedback loop",        "A gate change is evaluated by replay against history before it ships."),
]

LABELS = [
    ("feature",     "0E8A16", "New capability"),
    ("enhancement", "1D76DB", "Improves something that exists"),
    ("bug",         "D73A4A", "Something is wrong"),
    ("tech-debt",   "5319E7", "Cleanup, migration, retirement"),
    ("epic",        "C5DEF5", "A phase not yet split into tickets"),
    ("agent:wip",              "FEF2C0", "In flight, not selectable"),
    ("agent:blocked",          "E99695", "Needs a decision from you"),
    ("agent:review",           "BFD4F2", "Merged or ready, awaiting your read"),
    ("agent:hold",             "D4C5F9", "You set this to keep agents off it"),
    ("agent:needs-approval",   "F9D0C4", "Held at a gate that needs a person"),
    ("agent:followup",         "C2E0C6", "Opened by an agent as out-of-scope work"),
]

# key, milestone index, kind label, title, body
ISSUES = [
# ---------------------------------------------------------------- phase 0 ----
("st-append", 0, "feature", "Store: append and read, with optimistic concurrency", """
**Phase 0** · The write side of the event log.

## What
`append(streamId, expectedVersion, events)` and `read(streamId, fromVersion?)` over
Prisma 8. A unique violation on `(stream_id, version)` means another writer won —
surface it as a typed `ConcurrencyError`, not a Prisma error, so callers re-read and
retry without knowing what an ORM is.

That constraint is the entire concurrency control. There is no lock table and nothing
to clean up after a `kill -9`.

## Done when
- [ ] `append` is atomic across a batch: all events in one call land or none do
- [ ] A concurrent append at the same expected version raises `ConcurrencyError`
- [ ] Payloads are validated through `parsePayload` on the way in and out
- [ ] `readAll(fromSeq, limit)` exists for projection catch-up
- [ ] Tests cover the race with two real connections, not mocks
"""),

("st-listen", 0, "feature", "Store: subscribe over LISTEN/NOTIFY, with reconnect", """
**Phase 0** · What makes the system event-driven rather than timed.

## What
`subscribe(onSeq)` on a dedicated `pg` connection listening to the `escapement`
channel. Prisma has no LISTEN/NOTIFY, so this sits alongside it — see
[ADR 0004](../blob/main/doc/decisions/0004-prisma.md).

The payload is the seq only, so a listener reads the row it is told about.

## Done when
- [ ] A dropped connection reconnects with backoff and resumes from the last seq
- [ ] Nothing is missed across a reconnect: catch-up by `readAll` before going live
- [ ] The trigger from `packages/store/sql/notify.sql` is applied and verified
- [ ] A test kills the connection mid-stream and asserts no gap and no duplicate

## Notes
This is the reason the store is Postgres and not SQLite. If it works, `interval`
never has to exist as a configuration value.

Depends on {{st-append}}.
"""),

("core-reduce", 0, "feature", "Core: aggregate reducers for WorkItem, Run and Integration", """
**Phase 0** · The state machine, as a pure function.

## What
`reduce(events) -> state` for each of the three aggregates. Zero I/O — this is the
part of the old loop that was untestable (`integrate()`'s six branches) becoming a
function you can call with a list.

## Done when
- [ ] Every transition in [design.md §4](../blob/main/doc/design.md) is covered
- [ ] Contradictory state is unrepresentable — the old `agent:blocked` + `agent:review`
      pair cannot be constructed
- [ ] Unknown event types are ignored rather than throwing, so an old projection
      survives a new event
- [ ] `schemaVer` upcasting has a hook, exercised by at least one test fixture
"""),

("st-proj", 0, "feature", "Store: projection runner with checkpoints and rebuild", """
**Phase 0** · How derived tables stay derived.

## What
A runner that advances a named projection through the log by `seq`, recording
progress in `checkpoints`. Plus `rebuild(name)`: truncate, reset the checkpoint,
replay.

## Done when
- [ ] Catch-up and live modes, with the handoff losing nothing
- [ ] A handler that throws stops that projection and leaves its checkpoint intact
- [ ] `rebuild` produces a byte-identical table to the incremental path
- [ ] Lag per projection is queryable — `esc doctor` reports it

## Notes
This property is why no projection is declared in the Prisma contract yet: changing
one costs a truncate, not a migration.

Depends on {{st-append}}, {{st-listen}}.
"""),

("cli-doctor", 0, "feature", "CLI: the `esc` skeleton and `esc doctor`", """
**Phase 0** · The old `preflight()`, generalised.

## What
The `esc` entry point, and `doctor` as its first real command. The old loop refused
to start when its guard hook failed a smoke test; that instinct was right and should
apply to every check.

## Done when
- [ ] Checks: config schema, recipe vs policy conflict, repo and base branch,
      submodules, env allowlist with the production tripwire, hook fail-closed,
      Postgres connectivity, projection lag, GitHub auth and labels
- [ ] Each check prints what it found, not just a tick
- [ ] Non-zero exit on any failure, so it can gate a restart
- [ ] A conflict names the offending clause

## Notes
Its value is not the first run. It is every time afterwards you change something and
want to know what you broke.

Depends on {{core-reduce}}, {{st-proj}}.
"""),

("db-up", 0, "tech-debt", "Bring the database up: initial migration and notify.sql", """
**Phase 0** · The one task that needs a human first.

## What
Point `DATABASE_URL` at Escapement's own database — not one belonging to a managed
project — and bring the schema up.

```
pnpm db:init
pnpm db:verify
psql "$DATABASE_URL" -f packages/store/sql/notify.sql
```

## Done when
- [ ] `events`, `checkpoints` and `outbox` exist, with `data` and `payload` as `jsonb`
- [ ] The `escapement` NOTIFY trigger fires on insert
- [ ] The append-only rules reject an `UPDATE` and a `DELETE` against `events`
- [ ] `.env.local` is filled in and still untracked

## Notes
The last step is not Prisma's job and is not optional — Prisma models tables, not
triggers or rules.
"""),

# ---------------------------------------------------------------- phase 1 ----
("gh-app", 1, "feature", "GitHub: the App client and `esc add`", """
**Phase 1** · Onboarding is a repo slug plus permissions, and nothing else.

## What
A GitHub App client (installation tokens, not a PAT — see
[ADR 0006](../blob/main/doc/decisions/0006-github-app.md)) and `esc add <owner>/<repo>`,
which reads `.escapement/config.yaml` from the base branch, applies a default policy,
and registers the project.

## Done when
- [ ] Issues, contents, pull requests and metadata permissions verified at add time
- [ ] A repository the App is not installed on fails with that as the message
- [ ] `ProjectPolicySet` and `ProjectConfigured` land as events
- [ ] Token refresh is transparent to callers

## Notes
A fine-grained PAT covering the submodule but not the main repo cost a day of 403s on
admin CI. The App makes that visible at install time.

Depends on {{cli-doctor}}.
"""),

("cfg-resolve", 1, "feature", "Config: resolve the recipe from `origin/<base>` and hash it", """
**Phase 1** · The governance rule, in code.

## What
Read `.escapement/config.yaml` from `origin/<base>` — **never from the agent's
branch** — merge the preset, validate against the schema, check it does not violate
policy, and hash the result into `RunStarted`.

## Done when
- [ ] The recipe used by a run is provably the base-branch version
- [ ] An agent editing the file changes nothing about the run in flight
- [ ] A recipe that removes a mandatory gate or lowers the tier is rejected, naming
      the clause
- [ ] The resolved hash is recorded and reproducible

## Notes
Borrowed from GitHub Actions: definition may live in the repo, enforcement may not.
[ADR 0005](../blob/main/doc/decisions/0005-config-in-target-repo.md).

Depends on {{gh-app}}.
"""),

("discover", 1, "feature", "Conductor: discover work items and build the queue", """
**Phase 1** · GitHub becomes an input source, not a database.

## What
Poll issues into `WorkItemDiscovered`, and a `queue` projection that answers what is
runnable and in what order — replacing `pick_ticket`'s search. Priority is the
recipe's `kinds` order, oldest first.

## Done when
- [ ] Labels are read once at discovery and never consulted again for state
- [ ] Your own `blocked` label and the `agent:*` namespace are both excluded
- [ ] Re-discovering an existing item is a no-op, not a duplicate event
- [ ] `esc status` prints the queue

## Notes
Phase 1 runs against issue numbers you nominate, not the queue — `agent-loop.sh` is
still working the same repository and the two must not both claim a ticket.

Depends on {{cfg-resolve}}, {{st-proj}}.
"""),

("claim-wt", 1, "feature", "Conductor: claim with a lease, and provision the worktree", """
**Phase 1** · Replaces the lock directory and everything it leaked.

## What
`WorkItemClaimed` appended at an expected version — the loser of a race gets a
constraint violation and backs off. Then a worktree cut from `origin/<base>`, with
submodules initialised and the filtered env planted at the recipe's `plantAt`.

## Done when
- [ ] Two claimants racing produce exactly one winner
- [ ] A lease that expires needs no cleanup — absence of a heartbeat is the expiry
- [ ] Submodules are initialised; skipping this makes every test importing one fail
      and reads as the agent breaking them
- [ ] The env file holds only allowlisted names, and a production-looking value
      aborts the run
- [ ] `kill -9` mid-claim leaves nothing to `rm -rf`

Depends on {{discover}}.
"""),

("hook-bin", 1, "feature", "Hook: the `esc-hook` binary and the conductor socket", """
**Phase 1** · One channel, both directions.

## What
A Bun-compiled single file with no dependencies: read stdin, connect to a unix
socket, return the verdict, exit. Policy and persistence live in the conductor.

## Done when
- [ ] Under 20ms at the 95th percentile, measured, not assumed
- [ ] **Fails closed**: unreachable socket, timeout or unparseable payload all exit 2
- [ ] A startup smoke test proves the fail-closed path, and the conductor refuses to
      start if it does not
- [ ] Hook configuration is rendered by the conductor **outside the worktree**, so an
      agent cannot edit its own wiring
- [ ] Verdict is synchronous; persistence of an allowed call is not, so the event
      store's availability never gates a tool call

Depends on {{claim-wt}}.
"""),

("hook-guard", 1, "feature", "Hook: guard policy and `GuardTripped`", """
**Phase 1** · Make 132 invisible events visible.

## What
Evaluate the project's deny list and production host patterns against each tool call,
and append `GuardTripped` on a denial with the command redacted.

## Done when
- [ ] Blocks: production hosts, DDL, `db push`, `pr merge`, pushing to base,
      force-push, `rm -rf`, reading `.env`
- [ ] Allows: dev-database reads and writes, tests, pushing `agent/*`, `pr create`,
      reading `.env.local`, writing migration files
- [ ] A test matrix covers both lists and runs in CI
- [ ] Trips are counted per run and visible on the board card

## Notes
This is policy enforcement and observation, **not a security boundary** — a model can
write a script to step around a pattern. The real boundaries are the filtered env, the
worktree, and a sandbox. [ADR 0007](../blob/main/doc/decisions/0007-dual-runtime.md).

Depends on {{hook-bin}}.
"""),

("rt-cc", 1, "feature", "Runtime: the Claude Code adapter", """
**Phase 1** · The first of two implementations behind one interface.

## What
Spawn `claude -p` in the worktree with rendered settings, map its lifecycle hooks
onto events, and report a receipt when it exits.

## Done when
- [ ] `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` — the
      five-event intersection both runtimes share — are mapped
- [ ] `SessionEnd`, `PreCompact` and `Notification` are mapped as bonus signal, with
      the adapter working without them
- [ ] Capabilities are declared as flags and visible on the board
- [ ] Timeout and crash both produce `RunFailed` with a kind, never silence
- [ ] `RunFinished` carries cost, turns and duration

Depends on {{hook-guard}}.
"""),

("gate-process", 1, "feature", "Gates: the process gate", """
**Phase 1** · The first gate kind, and the shape the other three follow.

## What
Run a command from the recipe, with a timeout; the exit code is the verdict. Emit
`GateRequested` / `Started` / `Passed` / `Failed`, all carrying `onSha`.

## Done when
- [ ] `onSha` is on every verdict — a force-push must invalidate, not inherit
- [ ] A failure captures enough log tail to be actionable from the board
- [ ] A timeout is a `GateFailed`, distinguishable from a non-zero exit
- [ ] The gate pipeline runs in recipe order and stops at the first failure

Depends on {{rt-cc}}.
"""),

("integrate", 1, "feature", "Conductor: the integrator", """
**Phase 1** · Where the old loop failed silently six different ways.

## What
Merge base in, verify, then merge out — in a worktree the integrator owns, under
`pg_advisory_lock('merge:' || project || ':' || base)`. **Never in your checkout.**

## Done when
- [ ] Every refusal is an `IntegrationRefused` with a typed reason: `conflict`,
      `dirty-base`, `unpushed-base`, `pending-migration`, `gate-failed`,
      `no-commits`, `lane-busy`
- [ ] **No code path returns without an event.** This is the whole point of the ticket
- [ ] Your working checkout is never read from or written to
- [ ] Two integrations against one base serialise
- [ ] A crash mid-merge leaves the lane recoverable

## Notes
Uncommitted work in the operator's checkout made the old merge fail with no log, no
comment and no label — five re-runs and about $29 before anyone noticed.

Depends on {{gate-process}}.
"""),

("board-proj", 1, "feature", "Board: the board projection and real cards", """
**Phase 1** · The board stops being empty.

## What
The `board` projection, and cards rendered from it. `loadBoard` stops being a
placeholder.

## Done when
- [ ] Five columns fed from the projection, not from fixtures
- [ ] A running card shows turn, cost, **guard trips**, and containment tier
- [ ] A landed card shows its receipt and any regression filed against it
- [ ] A refused card shows the typed reason
- [ ] Rebuilding the projection changes nothing on screen

Depends on {{integrate}}.
"""),

("run-once", 1, "feature", "CLI: `esc run --once`, end to end", """
**Phase 1** · The exit criterion for the phase.

## What
Wire everything together: one nominated issue, discovery through merge, with a person
watching.

## Done when
- [ ] A real `nextloom-ai-admin` issue is merged into `develop` by Escapement
- [ ] The board shows it in Landed with its receipt
- [ ] The full event stream for that run reads as a coherent story with no gaps
- [ ] `agent-loop.sh` is unaffected throughout and neither system claimed the same
      ticket

Depends on {{board-proj}}.
"""),

# ---------------------------------------------------------------- phase 2 ----
("gate-agent", 2, "feature", "Gates: the agent gate — cold review", """
**Phase 2** · The gate that
[experiment 001](../blob/main/doc/experiments/001-cold-review-issue-58.md) validated.

## What
A second agent given only the issue, the diff and the touched files — never the
implementer's plan or transcript. Structured findings are the verdict.

## Done when
- [ ] Fresh context, verifiable: the reviewer's prompt contains no implementer output
- [ ] Findings carry file, line, claim, **and a concrete failure scenario**. No
      failure scenario, no finding
- [ ] The severity rubric is fixed in the prompt — left to judgement, the reviewer
      under-rated silent data corruption as `major`
- [ ] The checklist names concurrency and check-then-write explicitly
- [ ] Adversarial verification is **not** built yet: the measured false-positive rate
      is zero and there is nothing to filter

Depends on {{run-once}}.
"""),

("gate-policy", 2, "feature", "Gates: the policy gate — tamper and migration holds", """
**Phase 2** · Watch the surface the agent can reach.

## What
Glob the diff's file list; on a match, request approval. Two instances ship together:
the migration hold, and `tamper`.

## Done when
- [ ] `tamper` watches `.escapement/**`, `package.json#scripts`, test configuration
      and `.github/workflows/**`
- [ ] The migration hold catches an unapplied migration and holds the branch unmerged
- [ ] A held branch says which file and what to do about it
- [ ] Globs are compiled at `esc doctor` time, so a broken pattern fails early

## Notes
`package.json` scripts and test config decide what the build gate actually verifies,
and the agent can edit them. The old loop had no defence here at all.

Depends on {{gate-agent}}.
"""),

("gate-human", 2, "feature", "Gates: the human gate and the approval lifecycle", """
**Phase 2** · A person, with the same event shape as a process.

## What
`ApprovalRequested` / `Granted` / `Revoked`, bound to `onSha`.

## Done when
- [ ] An approval is bound to a commit; a force-push invalidates it automatically
- [ ] `approvers` comes from policy, never from the managed repository
- [ ] A revoked approval returns the item to the gate, not to the queue
- [ ] Waiting items are ordered oldest first

Depends on {{gate-policy}}.
"""),

("board-actions", 2, "feature", "Board: approve, reject and waive", """
**Phase 2** · The board becomes a place you work, not a place you look.

## What
Three Server Actions that append events. This is the ticket that decides whether the
whole project pays off.

## Done when
- [ ] Approve, reject-with-reason and waive-with-reason all land as events
- [ ] **A waiver is never silent** — it records who and why
- [ ] The action is bound to the sha shown, and refuses if the branch moved
- [ ] Optimistic UI reverts on server refusal rather than lying about the result

## Notes
The old review queue reached 45 items growing at 14 a day against zero processed,
because working it meant leaving the tool. If this ships and that number does not
move, the bottleneck was never tooling.

Depends on {{gate-human}}.
"""),

("board-diff", 2, "feature", "Board: render the diff and the gate evidence on the card", """
**Phase 2** · If you have to open GitHub to decide, nothing changed.

## What
The rendered diff, each gate's verdict with its evidence, and the agent's self-review
answers — all on the card.

## Done when
- [ ] Syntax-highlighted diff, collapsible per file, no link out required
- [ ] Build failures show the log tail; review failures show findings with their
      failure scenarios; a migration hold shows the SQL
- [ ] The self-review answers are surfaced, not buried in a PR body
- [ ] Large diffs stay usable — virtualised or paged, and never scroll the page
      sideways

Depends on {{board-actions}}.
"""),

("board-sse", 2, "feature", "Board: live updates over SSE", """
**Phase 2** · Finish the wire that `/api/stream` already stubs.

## What
Bridge the store's `subscribe` to the SSE endpoint, and update the board in place.

## Done when
- [ ] An append reaches an open board within a second, without a refresh
- [ ] The client reconnects and resumes from its last seq with no gap
- [ ] Multiple open tabs all update
- [ ] No polling anywhere in the path

Depends on {{board-diff}}.
"""),

("outbox", 2, "feature", "Conductor: the outbox and its delivery worker", """
**Phase 2** · Side effects that survive a crash.

## What
Events produce outbox rows; a worker delivers them with retry and backoff. The old
loop called `gh` inline, so a failed call vanished with no record and no retry.

## Done when
- [ ] Delivery is idempotent — a retry cannot double-post a comment
- [ ] Permanent failures are visible, not silently retried forever
- [ ] A crash between event and delivery loses nothing
- [ ] Undelivered depth is a `esc doctor` check

Depends on {{board-sse}}.
"""),

("mirror", 2, "feature", "Conductor: the `github_mirror` projection and label reconciliation", """
**Phase 2** · The inversion that makes everything else work.

## What
Labels become an **output**. The projection computes what the labels should be, the
outbox writes them, and nothing ever reads a label back for state.

## Done when
- [ ] Contradictory pairs are structurally impossible — the old `agent:blocked` plus
      `agent:review` on the same issue cannot occur
- [ ] Reconciliation is idempotent and converges after a manual edit on GitHub
- [ ] A comment is posted for every state a person needs to know about, carrying the
      question, not just the fact
- [ ] Removing every `agent:*` label and re-running restores them exactly

Depends on {{outbox}}.
"""),

("notify", 2, "feature", "Conductor: macOS notifications", """
**Phase 2** · Tell the human when the human is the bottleneck.

## What
Subscriptions by event type, delivered locally. `ApprovalRequested`,
`IntegrationRefused` and `RunAwaitingInput` to start.

## Done when
- [ ] Subscriptions are declared per project by event type
- [ ] Clicking a notification opens that card on the board
- [ ] Notification failure never blocks the event
- [ ] The channel is swappable without touching the subscription model

Depends on {{mirror}}.
"""),

("daemon", 2, "feature", "Conductor: run as a daemon, and recover from a crash", """
**Phase 2** · Unattended means surviving things nobody is watching.

## What
launchd, and a boot sequence that rebuilds state from the log, reconciles it against
reality — worktrees, branches, live processes — and records the difference.

## Done when
- [ ] Restart mid-run recovers without a stuck claim or an orphaned worktree
- [ ] Divergence between log and reality is recorded as `Reconciled`, not silently
      fixed
- [ ] Machine sleep no longer needs a `caffeinate` wrapper
- [ ] Logs are structured and the daemon's own health is on the board

Depends on {{notify}}.
"""),

("webhook", 2, "feature", "GitHub: webhook receiver for issues and push", """
**Phase 2** · Discovery in seconds, not up to an hour.

## What
Receive `issues` and `push`, verify the signature, append events.

## Done when
- [ ] Signatures are verified; an unverified delivery is dropped and counted
- [ ] Delivery is idempotent — GitHub retries must not duplicate work items
- [ ] A missed window is repaired by a reconciling poll, so webhooks are an
      optimisation and not a dependency
- [ ] `interval` is gone from the configuration entirely

Depends on {{daemon}}.
"""),

("retire-loop", 2, "tech-debt", "Retire `agent-loop.sh`", """
**Phase 2** · The cutover, at the end and not the start.

## What
Run both systems in parallel, Escapement on a subset first, then stop the old loop
and migrate what it left behind.

## Done when
- [ ] Seven consecutive days unattended, with no intervention beyond approving on the
      board
- [ ] The 45 items in `agent:review` are imported as work items with their history
- [ ] The old loop is stopped, its lock released and its worktrees accounted for
- [ ] `loop/` is archived with a README pointing here
- [ ] A written rollback: what to do if Escapement has to be turned off in week two

Depends on {{webhook}}.
"""),

# ---------------------------------------------------------------- phase 3 ----
("self-recipe", 3, "feature", "Self-hosting: Escapement's own recipe and its strictest policy", """
**Phase 3** · Escapement gets no benefit of the doubt it extends to others.

## What
`.escapement/config.yaml` in this repository, and a policy that is the tightest in
the system.

## Done when
- [ ] Every gate required: build, tamper, review, accept
- [ ] **No waivers configured.** The escape hatch other projects get, this one does not
- [ ] Tier is at least `guarded`, and the reason is written down
- [ ] `esc doctor escapement` is green

Depends on {{retire-loop}}.
"""),

("self-tamper", 3, "feature", "Self-hosting: tamper must cover Escapement's own source", """
**Phase 3** · The gate cannot be allowed to edit the gate.

## What
Extend `tamper` so a diff touching the conductor, the store, the hook, the gate
implementations or the policy code requires approval — for this project, always.

## Done when
- [ ] `packages/conductor/**`, `packages/store/**`, `packages/hook/**`,
      `packages/gates/**` are watched
- [ ] A change to the tamper gate itself is caught by the tamper gate
- [ ] The watch list lives in policy, out of this repository's reach
- [ ] A test asserts an agent cannot weaken its own gates in one merge

Depends on {{self-recipe}}.
"""),

("self-restart", 3, "feature", "Self-hosting: never restart into unverified code", """
**Phase 3** · The escapement principle, applied to the escapement.

## What
A merge to `main` lands; the running daemon **keeps executing the old code** until a
person runs `esc restart`. Before it swaps, `esc doctor` runs against the new code.

## Done when
- [ ] The conductor never restarts itself, under any condition
- [ ] `esc restart` refuses if `doctor` fails against the new build
- [ ] The version running is on the board, alongside the version merged
- [ ] A merge that would break the scheduler is caught before the swap, not by the
      scheduler failing to start
- [ ] Rolling back to the previous build is one command

## Notes
The hardest correctness problem in the project: an agent editing the conductor that is
running it. Energy released one tooth at a time, deliberately.

Depends on {{self-tamper}}.
"""),

("self-first", 3, "tech-debt", "Self-hosting: the first self-hosted change, supervised", """
**Phase 3** · The exit criterion for the phase.

## What
Pick a small, real ticket in this repository. Let Escapement work it.

## Done when
- [ ] An agent implements it, all four gates pass, you approve on the board, it merges
- [ ] `esc restart` brings the new code up after `doctor` passes
- [ ] The event stream for that run is complete and legible end to end
- [ ] Anything the run taught us is written into `doc/decisions/` before Phase 4

Depends on {{self-restart}}.
"""),

# ------------------------------------------------------------- phase 4 & 5 ----
("epic-4", 4, "epic", "Phase 4 — multi-project, Codex, concurrency, sandboxed tier", """
**Phase 4 epic.** Not split into tickets yet, deliberately: the shape of this work
depends on what Phases 1–3 teach, and pre-writing tickets that will be rewritten is
the kind of noise this system exists to avoid.

Split this when Phase 3 closes.

## Scope
- [ ] Multi-project scheduler, with per-project policy and isolation
- [ ] Presets — `nextjs-pnpm` and friends — so a descriptor stays short
- [ ] Onboard `nextloom-ai-press`: **under twenty lines, no package changes**
- [ ] `CodexRuntime`, against the five-event intersection already designed
- [ ] Concurrency above one: parallel claims, one merge lane per base branch
- [ ] `tier: sandboxed` — containerise node, pnpm, git, gh and psql with the worktree
      mounted

## Note on ordering
Concurrency is last on purpose. The old loop landed seven tickets in a night while the
review backlog grew by fourteen. Throughput was never the constraint, and raising it
before the board demonstrably draws the queue down makes the problem worse, faster.
"""),

("epic-5", 5, "epic", "Phase 5 — replay, regression feedback, receipts and guard tuning", """
**Phase 5 epic.** Not split into tickets yet, for the same reason as Phase 4.

The material already exists: 73 runs, 132 guard trips, 31 merged diffs, and a labelled
defect set. [Experiment 001](../blob/main/doc/experiments/001-cold-review-issue-58.md)
used one of them by hand — this phase makes that a command.

## Scope
- [ ] `esc replay` — run a gate pipeline against historical diffs
- [ ] False-positive rate for the review gate across all 31 merged diffs. **n=1 says
      nothing about the distribution**
- [ ] `regressions` projection, injected into the reviewer's prompt: when a diff
      touches a file with a history of check-then-write races, say so
- [ ] `run_receipts` on the board — cost and duration percentiles, cost per landed item
- [ ] Cluster the 132 guard trips into real blocks and false alarms, and tune
- [ ] Prompt comparison keyed on `promptVersion`
- [ ] Adversarial verification for the review gate — **only once false positives
      actually appear**
"""),
]

# Kept so the backlog and doc/roadmap.md cannot drift: this file is the source
# both were generated from. Re-running the creation script is idempotent for
# labels and milestones but NOT for issues — it would duplicate them.
