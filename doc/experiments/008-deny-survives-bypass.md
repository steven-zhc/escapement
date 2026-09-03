# 008 — `permissions.deny` survives `bypassPermissions`

**2026-09-02.** A one-command test that changed a design decision, run because the
alternative was guessing.

## The question

[ADR 0016](../decisions/0016-the-settled-model.md) was about to rename the guard
to `tools` and keep Lingtai's own tool-rule engine. The proposal on the table
was to delete it instead and let the agent runtime's own configuration do the
job — Claude Code and Codex already have a user level and a project level, and a
third place to configure the same thing is a third place to be confused by.

The objection was concrete. `claude-code.ts:184` passes
`--permission-mode bypassPermissions` **deliberately**, after a run that spent
45 turns and $3.35 reading a repository, designing a change, and then reporting
it could not write a single file — every call refused by Claude Code's own
permission layer before `lingtai-hook` ever saw it. Delegating tool rules to a layer
we explicitly turn off would delegate to nothing.

Unless `bypassPermissions` and `deny` are orthogonal. Nobody knew.

## What was run

    { "permissions": { "deny": ["Bash"] } }

    claude -p "Use the Bash tool to run: echo LINGTAI_TEST_OK.
               Report exactly what happened."
      --permission-mode bypassPermissions
      --settings ./deny-test.json

## What happened

> I couldn't run it — the Bash tool isn't available in this session.
>
> 1. I checked my loaded tool list: it contains Agent, Edit, Glob, Grep, …,
>    Read, …, and Write. **No Bash.**
> 2. I checked the deferred-tool registry with `ToolSearch({query:
>    "select:Bash"})` … Result: **"No matching deferred tools found."**

**The deny held.** And it held by a better mechanism than a hook: the tool was
removed from the model's list, so nothing was ever attempted. A hook refuses a
call the model has already decided to make and spent a turn on.

## What it changed

Three things, in order of how much they mattered.

**1. The two are orthogonal.** `bypassPermissions` solves "headless has no way to
grant a prompt", which is what the $3.35 run actually hit — the default *ask*
mode, not a deny rule. `deny` is enforced regardless. Both can be had at once,
which nobody had established.

**2. The observability argument for keeping a guard collapsed.** Its stated
justification, in its own source header, is that the old loop fired 132 blocks
across 77% of its runs into a stderr nobody parsed, and no rule was ever tuned
because nobody could see which fired. That argument assumes *attempts to record*.
A deny that removes the tool produces none. There is nothing to see, so there is
nothing lost by not seeing it.

**3. So the guard is deleted rather than renamed.** `guard.ts`, the eight rules,
`GuardTripped`, the `guard_trips` projection, `smokeTestFailClosed`, the
`PreToolUse` wiring and the `--no-guard` flag all go, and the `tools` recipe
section is never added. Stage 3a stopped being a rename and became a deletion,
which is a smaller and safer change.

## What is genuinely lost

- **Codex parity.** One recipe can no longer describe tool limits for both
  runtimes, because each has its own configuration. Weak in practice: Codex has
  an implementation here and has never been run against a real repository.
- **Any Lingtai-side record** of what an agent was not allowed to do. Small,
  per the argument above, but not zero — a project-level `.claude/settings.json`
  can change without anything in the log noticing.

That second one is why a `doctor` check reporting which settings sources are live
stops being a nicety. It is now the only visibility that exists.

## Limits

- One runtime. Codex's behaviour under its own equivalent was not tested.
- One rule shape (a bare tool name). Path-scoped forms like `Read(./.env)` were
  not tested, and the plan assumes they work.
- Says nothing about precedence between user-level and project-level settings
  when both deny, or about how `--settings` merges with them.
