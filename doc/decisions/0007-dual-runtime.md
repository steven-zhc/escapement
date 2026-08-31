# 0007 — Two runtime interfaces, one implementation

**Status** accepted · 2026-08-31

## Context

Claude Code and Codex CLI both need to be drivable. Checked against both:

| | Claude Code | Codex CLI |
|---|---|---|
| Non-interactive entry | `claude -p` | `codex exec` |
| Hook configuration | `settings.json` | `hooks.json` or `[hooks]` in `config.toml` |
| `SessionStart` · `UserPromptSubmit` · `PreToolUse` · `PostToolUse` · `Stop` | yes | yes |
| `SessionEnd` · `SubagentStop` · `Notification` · `PreCompact` | yes | no |
| `PreToolUse` can block | yes | yes, and can rewrite the call |
| Filesystem sandbox | none built in | `sandbox_mode`: read-only / workspace-write / danger-full-access |

The hook models are isomorphic — JSON on stdin, JSON on stdout — so the adapter
needs one contract and a field normaliser, not two code paths.

## Decision

The adapter contract is the **intersection**: those five events. Claude Code's
extra four are treated as bonus signal — better when present (`PreCompact`
reveals a work item that was scoped too large), never required.

Both runtimes are designed for from day one, because retrofitting the interface
later is a refactor. **Only `claude-code` is implemented**; `CodexRuntime` is a
stub with its capability flags declared. Writing the second adapter before the
first interface has survived real use would be guessing at the wrong
abstractions.

## Containment is Escapement's responsibility, not the runtime's

The table above shows Codex with a sandbox and Claude Code without. That must
not make a project's safety level depend on which agent happens to be running
today. A runtime may *provide* a sandbox; Escapement can always *impose* one
(a container, or macOS `sandbox-exec`).

| Tier | Requires | Satisfied by |
|---|---|---|
| `open` | worktree isolation | default |
| `guarded` | + filtered env + `PreToolUse` interception | either runtime. **The first project runs here** — it is what carried the old loop's 73 runs |
| `sandboxed` | + a hard filesystem boundary | Codex's `workspace-write`, or Escapement containerising the agent |

The scheduler matches capabilities before dispatching. If a project requires
`sandboxed` and the current combination cannot provide it, it **does not
dispatch** — it records `DispatchRefused`. Never silently downgrade.

## And a correction worth stating plainly

**A hook is not a security boundary.** Both runtimes' `PreToolUse` does command
pattern matching, and a model can write a script and execute it to step around a
pattern — Codex's own documentation says so. The old loop's README claimed its
guard hook was "the only layer that holds regardless of what an issue body
says". That was overstated.

The real boundaries are three: a **filtered environment** (the agent never holds
production credentials), an **isolated worktree** (that directory is the blast
radius), and a **runtime sandbox** where one exists. The hook's job is policy
enforcement and total observability — not a wall.

## Consequences

- `tier: sandboxed` is roadmap, not v1. Containerising the toolchain — node,
  pnpm, git, gh, psql — with the worktree mounted is its own piece of work and
  should not block the first project.
- The capability flags are visible on the board, so a run's containment level is
  never a guess.
