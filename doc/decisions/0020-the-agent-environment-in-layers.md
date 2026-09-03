# 0020 — The agent's environment comes from three named layers

**Status** accepted · 2026-09-03 · qualifies [0007](0007-dual-runtime.md) §the
filtered environment · implemented by [#49](https://github.com/steven-zhc/lingtai/issues/49)

The filtered environment is one of the three real boundaries. This changes its
shape without moving it: what an agent gets is still exactly what was declared,
but *declared* now means "named in the recipe as required", the values come from
a per-project file as well as the machine, and a name that is declared and has
no value **refuses the project before anything is claimed**.

## Why it moved

**An agent ran for ten turns against a database it could not reach, and the only
sign was a log line.** `nextloom-ai-admin` #138 wanted an invariant enforced in
Postgres; `LOCAL_DATABASE_URL` was not set on this machine; `filterEnv` collected
the name into `missing`, `run-once` printed

```
env: LOCAL_DATABASE_URL not set, so not planted
```

and then claimed the ticket and spent $0.97 to produce no commits.

Nothing here was a bug in the sense of a wrong branch taken. `allow` meant "plant
these if they exist", and that is what happened. The defect is the *meaning*: a
recipe naming a variable is a repository saying it needs one, and treating that
as optional is the same class of mistake as a gate that is configured and does
not run, which [0016 §4](0016-the-settled-model.md) calls Lingtai's bug.

The second reason is multi-project. Values came from the conductor's own
`process.env`, which comes from one `.env.local` at the workspace root, shared by
every project. Two projects that want the same variable name with different
values could not be expressed. That blocks Lingtai managing itself: its tests
demand `TEST_DATABASE_URL`, `nextloom-ai-admin` wants `LOCAL_DATABASE_URL`, and
one file cannot hold both meanings.

## The three layers

Merged in order; later wins.

| | source | owner | example |
|---|---|---|---|
| 1 | `process.env`, restricted to `RUNNABLE` | Lingtai, fixed | `PATH` `HOME` `USER` |
| 2 | `process.env`, **only names the recipe declares** | the machine, set once | `OPENAI_API_KEY` |
| 3 | `~/.lingtai/env/<project>.env` | you, per project | `LOCAL_DATABASE_URL` |
| 4 | *(not built)* a secret source | — | `!op read op://…` |

**`allow` becomes `required`.** A recipe stops maintaining an allowlist, which
was work with no owner — the list had to track what the application needed, and
nothing checked that it did. It now declares only what the run cannot proceed
without. A name that is not declared never reaches the agent from `process.env`.

**Layer 2 exists so a machine-wide key is set once.** `OPENAI_API_KEY` for a
Codex runtime is not a fact about a project. Requiring it in every project's file
would be a copy that drifts.

**Layer 3 wins over layer 2**, so one project can differ from the machine.

## `RESERVED`, and why it only blocks layer 2

A recipe is written by the managed repository. Layer 2 therefore lets a
repository name any variable in the conductor's environment — including
`DATABASE_URL`, which *is* Lingtai's log, and `GITHUB_APP_PRIVATE_KEY_PATH`,
which signs the tokens.

So a fixed constant of Lingtai's own credential names is refused at layer 2, no
matter what a recipe declares.

It does **not** block layer 3, and that asymmetry is the whole point: layer 3 is
a file the operator wrote, and Lingtai managing itself needs `TEST_DATABASE_URL`
in `~/.lingtai/env/lingtai.env`. What must not happen is a *managed repository*
reaching for it by writing one line of YAML.

## Failing loudly, and where

A declared name with no value in any layer **refuses the whole project for that
pass, before the work item is claimed.** Not the item: the environment is a fact
about the project, so refusing per item would print the same failure once per
ticket and claim nine of them to do it.

`lingtai doctor` reports, per project, every declared name and **which layer it
resolved from** — `process env`, `<project>.env`, or not set. Names only, never
values. That is the half that costs nothing and answers the question before the
money is spent.

## What was rejected

**A machine-wide file (`~/.lingtai/env/default.env`).** It would duplicate layer
2. Purely additive between 2 and 3 if the copies ever start to hurt.

**Importing the login shell.** OpenClaw solves the same problem —
`OPENCLAW_LOAD_SHELL_ENV`, with `OPENCLAW_SHELL_ENV_TIMEOUT_MS` beside it —
by spawning a login shell and importing what is missing. It works. It also makes
the environment depend on what `.zshrc` did this time, which is why it needs a
timeout, and it means `doctor` can report a value that a later run does not get.

The trade it avoids is real: a daemon under launchd or systemd does not read your
shell profile, so a machine-wide value that works for `lingtai run` can be absent
for `lingtai daemon`. We take that difference and make it **visible** instead:
the run refuses by name, and `doctor` says which layer each value came from, so
running `doctor` in the daemon's own environment shows the discrepancy. A loud
difference beats a clever one.

**Keeping `process.env` out entirely.** Considered, and it is the stricter
reading of 0007. Rejected as configuration for its own sake: it would force every
machine-wide key into every project's file, and the boundary that matters is
*declared versus ambient*, not *file versus environment*.

## Prior art

Both were read before deciding, and both had converged on pieces of this:

- **Hermes** reads `process.env` plus `~/.hermes/.env`, and strips everything from
  its code-execution subprocesses except `PATH HOME USER LANG LC_ALL TERM SHELL
  TMPDIR XDG_*` — which is `RUNNABLE` with two more entries, arrived at
  independently. Its secret-source plugins (1Password, Bitwarden, a command
  helper) resolve into the environment at startup, and are the model for layer 4.
- **OpenClaw** layers `process env → ./.env → ~/.openclaw/.env → config`, and has
  `OPENCLAW_HOME` for running as a service user, which `LINGTAI_HOME` already is.

The distinction that matters: Hermes reads `process.env` *for itself* and strips
it for the subprocess. In Lingtai the agent **is** that subprocess. So layer 2 is
not "inherit the environment" — it is a declared, per-name exception to a strip
that is otherwise total.
