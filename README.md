# Escapement

Event-sourced scheduler for autonomous code agents.

An escapement is the part of a clock that lets the mainspring out one tooth at a
time. Without it the spring releases all at once. That is the job: take a queue
of work, hand each item to an agent, hold it at a series of gates, and release
it only when every gate — including a human one — has passed.

It replaces `agent-loop.sh`, a bash harness that worked 73 tickets against one
repository over four days. That harness kept its state in GitHub labels, its
history in issue comments, and its telemetry in a log file nobody parsed, and
was driven by a timer. It could not answer *what state is this ticket in*, *why
did this not merge*, or *what is waiting on me*. Everything here follows from
making those three the same append-only log.

## Status

**Phases 0 and 1 are built.** The event log can be written, read, subscribed to,
reduced to state and projected; `esc run --once` takes one nominated issue from
discovery through claim, worktree, guard, agent, gates and the merge lane, and
the board shows the landed card with its receipt.

**Phase 1's exit criterion is not met.** It requires a real `nextloom-ai-admin`
issue merged into `develop`, and nothing has run against a real repository yet —
that needs a **GitHub App**, which is a human step. See
[Connecting GitHub](#connecting-github) below, then
[`doc/roadmap.md`](doc/roadmap.md) for the phases and
[`doc/README.md`](doc/README.md) for what is settled and what is open.

## Layout

| | |
|---|---|
| `packages/core` | Event catalogue and aggregate reducers. Zero I/O, so it tests without a database. |
| `packages/config` | The recipe schema — what a managed repository puts in its own `.escapement/config.yaml`. |
| `packages/store` | The Postgres event store: append, read, subscribe, and the projection runner. Prisma 8 for reads and writes, `pg` for `LISTEN/NOTIFY` and for projections. |
| `apps/cli` | `esc` — `doctor`, and `projection lag` / `projection rebuild`. |
| `apps/board` | Next.js shell. Real cards are Phase 1. |
| `doc/` | The design, every decision, and the experiments that back them. |

## Getting started

```bash
pnpm install
cp .env.example .env.local        # then paste the connection string
pnpm contract:emit                # offline — no database needed
pnpm typecheck
```

`.env.local` lives at the repo root and is gitignored. A real environment
variable beats it, which is what makes CI and launchd work with no file at all.

**Two connection strings, one database.** `DATABASE_URL` is pooled, for ordinary
queries; `DIRECT_DATABASE_URL` is session mode, for migrations, `LISTEN/NOTIFY`
and advisory locks. A transaction pooler breaks all three, and breaks them
without erroring — see [ADR 0009](doc/decisions/0009-two-connections.md).

The event store must be **its own database**, not one belonging to a managed
project — Escapement has to keep running while a managed project is the thing
being changed.

### Bringing the database up

Prisma 8 splits planning from applying. Planning is offline; only the second
half needs a reachable database.

```bash
pnpm db:init                      # bootstrap the database and sign it
pnpm db:bootstrap                 # apply notify.sql, then prove it worked
```

`db:bootstrap` is not optional and is not Prisma's job. Prisma models tables, not
triggers, so `notify.sql` carries the two things the schema cannot express: the
`NOTIFY` trigger every subscriber wakes on, and the rules that make `events`
append-only in the database rather than by convention. The script then asserts
ten properties, including a **cross-connection** NOTIFY — the check that catches
a transaction pooler, which drops notifications silently.

An initial migration is already planned and committed; `db:plan --name <slug>` is
only needed after the contract changes.

### Checking it

```bash
pnpm esc doctor                   # non-zero exit on any failure
pnpm esc projection lag           # how far each projection is behind the log
```

`esc doctor` never writes to the event log — every check reads the catalogue,
and the one exception is a `NOTIFY`, which touches no table. It holds a listener
open, pauses long enough for a pool to churn, and notifies from a second
connection, because a check that merely opens the direct connection passes
against a transaction pooler and proves nothing
([experiment 003](doc/experiments/003-doctor-catches-a-pooler.md)).

Checks that depend on code Phase 1 has not written yet print as `skip`, naming
the issue that will fill them in.

## Connecting GitHub

Escapement talks to GitHub as a **GitHub App**, not as a personal access token.
The reason is a measured failure: on 2026-08-30 a fine-grained PAT covered the
admin repository's *submodule* but not the repository itself, and every CI run
failed with a 403 that said nothing about scope. An App's reach is explicit in
its installation, so `esc add` can ask and answer that question at onboarding
time instead of a day later. See
[ADR 0006](doc/decisions/0006-github-app.md).

This part cannot be automated: creating an App is a browser step, and the
private key it hands you is a real secret.

### 1. Create the App

Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
(<https://github.com/settings/apps/new> for a personal account).

| Field | What to put |
|---|---|
| **GitHub App name** | Anything free — it is globally unique. `escapement-<your-handle>` works. |
| **Homepage URL** | Required by the form and otherwise unused. The repository URL is fine. |
| **Webhook → Active** | **Uncheck it.** Webhooks arrive with [#28](https://github.com/steven-zhc/escapement/issues/28); until then there is nothing listening and a failing delivery is noise. |
| **Where can this App be installed** | *Only on this account.* |

Then, under **Repository permissions**, set exactly these four:

| Permission | Level | What Escapement does with it |
|---|---|---|
| **Issues** | Read and write | reading work items, writing `agent:*` labels and comments |
| **Contents** | Read and write | cloning, pushing `agent/*`, merging into the base branch |
| **Pull requests** | Read and write | opening and reading pull requests |
| **Metadata** | Read-only | mandatory; GitHub selects it for you |

Leave every other permission at *No access*. `esc add` checks these four by name
and refuses to onboard a repository that is missing one, so a gap becomes a
message at onboarding rather than a 403 in the middle of a merge.

Click **Create GitHub App**.

### 2. Take the App ID and a private key

On the App's **General** page:

- **App ID** — a number near the top. This is `GITHUB_APP_ID`.
- **Private keys → Generate a private key** — this downloads a `.pem` file, and
  GitHub will not show it to you again.

Move the `.pem` somewhere **outside this repository**. It is the one credential
that is not short-lived, and `.gitignore` is not a place to rely on for it:

```bash
mv ~/Downloads/escapement-*.private-key.pem ~/.escapement-app.pem
chmod 600 ~/.escapement-app.pem
```

### 3. Install it on the repositories it should manage

**Install App** in the left sidebar → your account → **Only select
repositories** → pick each repository Escapement will manage.

An App that exists but is not installed on a repository is the exact failure
0006 is about, and `esc add` reports it as such:

```
the GitHub App is not installed on steven-zhc/nextloom-ai-admin. Install it on
that repository (Settings → GitHub Apps → Configure), then run esc add again.
```

### 4. Point Escapement at it

In `.env.local` at the repository root:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=~/.escapement-app.pem
```

`~` is expanded, and a relative path is relative to *this repository's root* —
not to whichever directory you ran the command from. Where only a single-line
value can be carried, `GITHUB_APP_PRIVATE_KEY` takes the PEM itself with `\n`
escapes instead.

No installation id is needed. It is looked up per repository, which is what
turns "the App is not installed there" into a sentence rather than a 404.

Check it:

```bash
pnpm esc doctor
```

```
  ok   github: app credentials
       app 123456, key from ~/.escapement-app.pem · requires issues:write,
       contents:write, pull_requests:write, metadata:read (verified per
       repository by esc add)
```

That check parses the key to prove it is a key rather than a path typo or a
truncated paste. It does **not** contact GitHub — whether an installation
actually grants those four permissions is a per-repository question, and
`esc add` is what asks it.

## Onboarding a repository

### 1. Give the repository a recipe

Escapement reads `<repo>/.escapement/config.yaml` **from the base branch**,
never from the branch an agent is working on. An agent that edits this file
changes nothing about the run in flight; the edit shows up in the diff and takes
effect from the next work item. That rule is borrowed from GitHub Actions and is
[ADR 0005](doc/decisions/0005-config-in-target-repo.md).

Commit this to the base branch of the repository being managed — not to
Escapement:

```yaml
version: 1

repo:
  base: develop
  # `git worktree add` does not populate submodules, and a worktree without them
  # fails every test that imports one — which reads on the board as though the
  # agent broke them.
  submodules: true

source:
  # Also the priority order: earlier wins.
  kinds: [bug, tech-debt]
  # Labels of yours that keep the agent off a ticket.
  exclude: [blocked, needs-design]

env:
  # Variable NAMES only, never values. Values resolve at runtime from the
  # conductor's environment, which the agent cannot see — so this file is safe
  # to commit.
  allow:
    - DATABASE_URL
    - CLERK_SECRET_KEY
  # Rarely the repository root: Next, Prisma and vitest read it from the app
  # directory.
  plantAt: apps/web/.env.local

gates:
  - kind: process
    name: build
    run: pnpm verify
    timeout: 15m

runtime:
  agent: claude-code
  limits:
    turns: 300
    wall: 2h
```

A shorter form, if the project is an ordinary pnpm workspace:

```yaml
version: 1
extends: pnpm-workspace
repo:
  base: develop
source:
  kinds: [bug]
env:
  allow: [DATABASE_URL]
  plantAt: apps/web/.env.local
```

`extends` fills in the submodule default, a `pnpm verify` build gate and the
runtime. It resolves to the same run as spelling all of it out, and hashes the
same — a preset's *name* is not part of what a run does, so it is not part of
the hash.

Only `process` gates run today. A recipe naming an `agent`, `policy` or `human`
gate is **refused**, naming the issue that implements it
([#18](https://github.com/steven-zhc/escapement/issues/18),
[#19](https://github.com/steven-zhc/escapement/issues/19),
[#20](https://github.com/steven-zhc/escapement/issues/20)) — a pipeline that
silently skipped a human approval would put a green board on a change nobody
approved.

### 2. Register it

```bash
pnpm esc add steven-zhc/nextloom-ai-admin
```

It checks the installation and its permissions **before** it writes anything, so
a half-onboarded project is not a state that exists. Then it reads the recipe
from the base branch, hashes it, and records `ProjectConfigured` and
`ProjectPolicySet`.

Policy is Escapement's, not the repository's — the tier floor and which gates are
mandatory live in Escapement's own log, where the agent cannot reach them:

```bash
pnpm esc add steven-zhc/nextloom-ai-admin --tier guarded --require build
```

A recipe may **add** strictness and can never remove it. One that drops a
mandatory gate, or asks for a tier below the floor, is rejected by name:

```
gates: recipe says build, policy requires a gate named "review"
       — the policy marks it mandatory, and a recipe cannot remove one
```

### 3. Run one ticket

```bash
pnpm --filter @escapement/hook build     # the guard binary is not committed
pnpm esc status nextloom-ai-admin        # what is runnable, and what is holding the rest
pnpm esc run --once nextloom-ai-admin --issue 117
```

**Nominate a ticket carrying no `agent:*` label.** `agent-loop.sh` is still
working the same repository on an hourly cycle until Phase 2, and that namespace
is where it keeps its state — discovery refuses anything in it precisely so the
two systems cannot both claim one ticket.

### When something refuses

Every refusal names itself. The common ones:

| What you see | What it means |
|---|---|
| `the GitHub App is not installed on …` | Step 3 above — install it on that repository. |
| `the installation is missing permissions:` | Step 1's table; each gap is listed with what it has, what it needs and what it is for. |
| `no .escapement/config.yaml on develop` | The recipe is missing from the **base branch**. A copy on the agent's branch is not read, by design. |
| `no esc-hook binary at …` | `pnpm --filter @escapement/hook build`. A run without the guard must not start. |
| `ENOENT … escapement-app.pem` | The key path is wrong. `~` and relative paths both work; relative is from this repository's root. |
| `stopped at recipe: … policy requires …` | The recipe would weaken the run. Every conflicting clause is listed at once. |
| `stopped at discover: owned-by-another-agent` | That issue carries an `agent:*` label. Pick one the old loop has not touched. |
