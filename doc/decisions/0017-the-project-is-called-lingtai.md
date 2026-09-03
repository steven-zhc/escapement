# 0017 — The project is called Lingtai

**Status** accepted · 2026-09-02

The system was called Escapement. It is called **Lingtai** (灵台) from this
commit. Nothing about how it works changed; this file exists so that a reader
who finds the old name — in git history, in a stale clone, in a database
bootstrapped last week — knows what happened and can tell it apart from a bug.

## Why record a rename at all

A rename is not a decision about the system's behaviour, so it would normally
not earn an ADR. This one does, because it moved four things that are not text:

| Moved | From | To |
|---|---|---|
| NOTIFY channel | `escapement` | `lingtai` |
| trigger, function, both rules | `escapement_*` | `lingtai_*` |
| config directory in a target repo | `.escapement/config.yaml` | `.lingtai/config.yaml` |
| runtime home | `~/.escapement` | `~/.lingtai` |

Each of those has a counterpart somewhere else that has to move with it, and in
three of the four cases a half-move **fails silently rather than loudly** —
which is the only reason this is worth a page.

The channel is the sharpest: the trigger writes to one name and `subscribe.ts`
listens on another. Nothing errors. Appends keep working, the log stays correct,
and the loop simply never wakes — the exact failure that `interval` was removed
to prevent ([0003](0003-postgres-event-store.md)). So `sql/notify.sql` now ends by
dropping the old trigger, function and rules by their old names. It is applied
by `db:bootstrap`, which is idempotent, and the drops come *after* the creates so
the events table is never briefly without its no-delete rule.

The config directory is the one with a second party. A recipe is read from the
target repository's default branch, over the API — so `nextloom-ai-admin` had to
move its own file, and until that landed the loop would refuse every run there
with a recipe-stage error. Loud, at least, and it was pushed in the same sitting.

## What was renamed, and what was not

Everything: package scope (`@lingtai/*`), the CLI (`lingtai`, was `esc`), the
hook binary (`lingtai-hook`), environment variables (`LINGTAI_*`), the GitHub
label prefix (`lingtai:`), advisory-lock keys, the session-id seed, temp-dir
prefixes, test table names, the GitHub repository, and every document.

Two things were deliberately left:

**`const esc` in `notify.ts`** is an AppleScript-quoting helper. It never had
anything to do with the product name, and a mechanical rename that caught it
would have been a rename that was not reading.

**The old names inside this file, and in `sql/notify.sql`'s drops.** They have
to survive: they are how the old objects are found.

The experiment write-ups in `doc/experiments/` *were* renamed, including the
terminal transcripts inside them, which is worth being honest about: those runs
happened under the old name and printed the old name. The alternative — a
document set half in each name — is the failure this repository has hit
repeatedly, and the original text is one `git show` away, in the commit before
this one. A transcript is evidence of behaviour, not of spelling.

## The old repository

There was an earlier, unrelated project also called Lingtai — a local
Claude Code mission-control UI, nine commits, last touched 2026-05-19. It was
renamed to `lingtai-legacy` and archived rather than deleted, so this name could
be taken while its history stays reachable. A verified bundle of it also sits
at `~/workspace/lingtai-archive-2026-09-02.bundle`.

## What this does not license

The log was **not** reset for this. The rename touches no event type, no payload
and no stream id — the `wi-` / `run-` / `int-` / `prj-` / `ctl-` prefixes are
unchanged, and every event written under the old name replays identically under
the new one. The reset allowance in [0016 §9](0016-the-settled-model.md) was
spent on the model change and is not available again.
