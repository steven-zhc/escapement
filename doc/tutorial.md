# Tutorial — from nothing to a merged issue, unattended

The shortest path that ends with Lingtai taking an issue off GitHub, working it,
and merging the result back — with nobody typing anything after the first
`lingtai daemon`.

Everything here is done once except step 5, which is labelling an issue.

---

## 0. What you need first

- **Postgres of its own.** Not a database belonging to a project you manage —
  Lingtai has to keep running while that project is the thing being changed.
- **A GitHub App**, installed on the repository you want managed. Not a personal
  access token: a fine-grained token can be wrong in a way nothing reports.
- **Node 22+**, `pnpm`, and the agent runtime you intend to use signed in
  (`claude` for Claude Code).

Copy `.env.example` to `.env.local` at the repository root and fill in the two
connection strings and the App's ID and key. Then:

```bash
pnpm install
pnpm db:init && pnpm db:bootstrap
pnpm lingtai doctor        # everything checkable, checked
```

`doctor` is the whole of the setup verification. Do not go on while it is red.

---

## 1. Put a recipe in the repository you want managed

`.lingtai/config.yaml`, committed **on the branch work merges into**. This is
the smallest one that runs:

```yaml
version: 1

repo:
  base: main

source:
  # Which issue labels are work, in priority order. An issue with none of these
  # is not picked up.
  kinds: [bug, feature]
  # Labels of yours that keep an agent off a ticket.
  exclude: [blocked]

env:
  # Variable NAMES the run may see. Values come from the machine running
  # Lingtai, never from here — so this file is safe to commit.
  allow: []
  # Where the filtered env file is written inside the agent's worktree.
  plantAt: .env.local

gates:
  # What must pass before anything merges. Its exit code is the verdict.
  proposed:
    - name: build
      run: pnpm test
      timeout: 15m

runtime:
  agent: claude-code
```

**This recipe merges automatically.** There is no `merge:` block, so nothing
holds for a person. That is what "unattended" means, and it is a deliberate
choice — [step 6](#6-if-you-would-rather-approve-first) is the other one.

Commit it and push it to `main`. Lingtai reads it from `origin/main` for every
run and never from an agent's branch, so an agent cannot change the rules of the
run it is part of.

---

## 2. Register the repository

```bash
pnpm lingtai add <owner>/<repo> --base main
```

It checks the App's installation and permissions **before** it writes anything,
then reads the recipe, hashes it, and prints what it found:

```
recipe: .lingtai/config.yaml at main@2595965 — hash 9c63ab61fdd1
  admit     (skipped)
  prepared  (skipped)
  proposed  build
  merge     (skipped)
  end       (skipped)
```

All five points are listed, including the empty ones. A point that is skipped is
your decision; being unable to see that it is skipped would not be.

---

## 3. See what it would take, without taking it

```bash
pnpm lingtai status <repo> --refresh
```

```
from GitHub: 3 runnable, 12 passed over — excluded-label 9, no-kind 3
queue: 3 runnable
  #41  bug      A stale response can overwrite the current query's hits
  ...
```

This costs nothing and claims nothing. The passed-over count is the useful half:
an issue nobody is working on has a reason, and the reason is your recipe's.

---

## 4. Start the daemon

```bash
pnpm lingtai daemon
```

That is the last command you type. It holds the projections current, takes work
as it appears, and runs the merge lane. Leave it running.

In another terminal, for the board:

```bash
pnpm --filter @lingtai/board dev     # http://localhost:3200
```

To install it as a background service on macOS instead:

```bash
./scripts/launchd.sh install
```

---

## 5. Label an issue

On GitHub, put one of your `kinds` labels on an issue — `bug`, or `feature`.

That is the entire trigger. Within a sweep (or seconds, if you have pointed the
App's webhook at `<your tunnel>/api/webhook`) the daemon claims it and the loop
runs:

```
claim              an event, so two schedulers cannot take the same issue
worktree           cut from Lingtai's own mirror, never your checkout
prepared           whatever your recipe puts there — usually the install
agent              writes and commits on agent/<issue>, in that worktree only
proposed           your gates run; the first refusal wins
merge              nothing configured, so it does not stop
integrate          under an advisory lock: merge base in, verify, merge out
end                whatever your recipe puts there
```

The branch lands on `main`. Watch it on the board, or:

```bash
pnpm lingtai status <repo> --all
```

```
  #41  bug  A stale response can overwrite the current query's hits  [landed]
```

**That is the whole loop.** Everything after this is refinement.

---

## 6. If you would rather approve first

Add a `merge` gate and the loop stops there instead of merging:

```yaml
gates:
  merge:
    - name: approval
      human: Merge {branch} into {base}?
```

The run holds, the board shows the card with its diff and its gate evidence, and
you decide:

```bash
pnpm lingtai approve <repo> --issue 41
pnpm lingtai approve <repo> --issue 41 --reject "wrong approach"
```

Approving on the board does the same thing — **as long as the daemon is running**,
because the daemon is what performs the merge once the approval is in the log.

An approval is bound to the commit it was asked about. If the branch moves, the
approval stops counting, by arithmetic rather than by anyone remembering.

---

## 7. Stopping

```bash
pnpm lingtai pause "why"     # take no new work; a run in flight finishes
pnpm lingtai resume
```

The reason is required and it is recorded. `pause` stops work being taken; it
never stops effects that already happened from going out.

---

## What to read next

- [`README.md`](../README.md) — the terms, the five gate points, and what
  Lingtai deliberately does not do
- [`doc/reference.md`](reference.md) — every enum, every gate action, every
  refusal reason, counted
- [`doc/decisions/`](decisions/) — why each of these is the way it is
