# 005 — Rung 1 reaches a real repository

**2026-08-31.** `nextloom-ai-admin`, `develop` at `ed87fb3`. Escapement at
`d0c4020` plus the fixes this experiment forced.

## What this was for

Seven seams had never touched reality, and a full `esc run --once` would light
all seven at once. If it failed, nobody would know which one, and every retry
would cost agent money. So: rungs, each isolating a group (#39).

Rung 1 lights four of them and costs nothing — **no agent starts, and nothing is
written to GitHub**:

1. GitHub App authentication → an installation token
2. git over https with that token injected
3. a cross-repository submodule fetch with the same token
4. the prepare stage, against a real dependency tree

Harness: `apps/cli/scripts/rung-1.ts`.

## Result

**Pass, on the third attempt.** 10.3s.

```
rung 1 against steven-zhc/nextloom-ai-admin

  ok  app → installation token — installation 158078268, token ghs_4786…  (475ms)
  ok  recipe — f4dcbb57e1474e65 from develop, 1 prepare step(s)  (166ms)
  --  env not set, so not planted: LOCAL_DATABASE_URL
  ok  worktree — …/run-rung1-3edc7139 at ed87fb3  (1696ms)
  ..  prepare: install
  ..  prepare: install ok in 7.9s

PASS — four seams reached reality in 10.3s
events: PreparationStarted, PreparationPassed
```

The two failures before it are the point of the exercise, and both were real
defects in Escapement rather than in the harness.

## Failure 1 — no token ever reached git

Found by reading rather than by running, while wiring the harness up.

`GitHubClient` held an installation token source and never exposed it, and
`apps/cli/src/run.ts` never passed a token to `runOnce`. So `provisionWorktree`
got `token: undefined` and every git command in a real run would have been an
anonymous one. **Both managed repositories are private**, so the very first
fetch would have failed — before any other seam had a chance to.

A second defect sat behind it. `token` was typed `string`: a snapshot taken once
at the start of a run. An installation token lasts an hour and the recipe's wall
limit is two, so the integrator's push at the end of a long run would have used
an expired one. Fixed together, because they share an edit surface:
`TokenSource = string | (() => Promise<string>)`, resolved per git invocation.

## Failure 2 — `/bin/sh: pnpm: command not found`

The first actual run got three seams in and died here, 0.0s into prepare.

`filterEnv` answers *which of the project's variables may this run see*. Nothing
answered the different question *what does a process need in order to be a
process*, so three call sites had answered it three separate ways:

| call site | got |
|---|---|
| the agent | `PATH`, `HOME` |
| the gates | `PATH` — **no `HOME`**, which `pnpm` needs for its store and config |
| prepare | neither |

Only one was right, and the one that was right was right by accident. This would
not have shown up as "Escapement is broken"; the gate variant would have shown up
on the board as *the agent broke the build*, which is the failure mode this whole
system exists to remove.

Fixed as `runnableEnv()` in `worktree.ts` — computed once, used by all three.
`PATH`, `HOME`, `TMPDIR`, `LANG`, and deliberately not `NODE_OPTIONS`, which
would inject behaviour into every child; anything a project genuinely needs
belongs in `env.allow` where a person wrote it down.

## What this did not prove

Three seams remain untouched, and they are the expensive ones: a real Claude Code
process, the hook wired into a real session, and a push to `origin/develop`.
Rungs 2 and 3 (#39), and rung 2 needs `--no-merge` (#38) first.

`LOCAL_DATABASE_URL` was not set in the operator's environment, so the env file
was not planted. The plant path is therefore still unexercised against a real
repository — the harness reported it rather than passing quietly, which is the
only reason it is written down here.

## Numbers, for later comparison

| step | wall |
|---|---|
| app → installation token | 475ms |
| recipe from `develop` | 166ms |
| worktree + submodule, over https | 1696ms |
| `pnpm install --frozen-lockfile` | 7.9s |

The install is warm — it shares the operator's pnpm store through `HOME`. A cold
one on a fresh machine will be much slower, and if prepare ever needs a timeout
larger than the 10m default, this is the number that moved.
