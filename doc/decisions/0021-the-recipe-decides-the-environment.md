# 0021 — The recipe decides the environment; the machine only holds it

**Status** accepted · 2026-09-04 · supersedes the mechanism in
[0020](0020-the-agent-environment-in-layers.md), which was accepted the day
before and implemented in `0bf7454`

Two files hold values. The recipe decides which of them a run may see. There is
no list in Lingtai's source that overrides either.

```
data     process.env  ⊕  ~/.lingtai/env/<project>.env      the file wins
policy   the recipe's  allow / deny
check    the recipe's  required
```

## What is deleted

`RESERVED` — the constant naming `DATABASE_URL`, `TEST_*`, `GITHUB_APP_*` and
refusing them from the process environment however a recipe declared them.

0020 argued for it in one line: *a recipe is written by the managed repository,
so a repository could reach the conductor's own credentials by naming them.* The
argument is sound and the answer was in the wrong place.

**It was a policy baked into the core, about a repository the core cannot see.**
That is the same shape as `FOREIGN_LABEL_PREFIX` — the rule that skipped any
issue labelled `agent:*` — which was deleted earlier on the same day, for the
same reason, and its removal note said so:

> a guess about a namespace, made in the core, about a repository it cannot see —
> exactly the shape of thing 0016 §7 removed everywhere else.

[0016 §7](0016-the-settled-model.md) says nothing sits above a repository's own
recipe. `RESERVED` sat above it. Writing that sentence twice in one day about two
different constants is the signal that the rule is real and was not being
applied.

## What the three fields mean

**`allow` and `deny` decide what reaches an agent**, and nothing else does.

| `allow` | `deny` | what passes |
|---|---|---|
| — | — | everything the two files hold |
| set | — | only what `allow` names |
| — | set | everything except `deny` |
| set | set | `allow` minus `deny` |

**`required` is a check, not a filter.** It names what must have a value in the
merged data, and a run refuses the project when one does not — before anything
is claimed, which is the part of 0020 that stands unchanged and is the reason
that ADR exists at all.

It is evaluated against the **data**, not against what survives `allow`/`deny`.
So a name that is required and also denied is not a contradiction to be rejected:
it says *this machine must be configured with it, and this run does not need to
see it.* Those are different questions and there is no reason to make one of them
answer for the other.

## Whose risk this is

The operator's, deliberately — and this is not a concession made to get rid of a
constant. It is the third time this system has answered the same question the
same way:

- [0016 §6](0016-the-settled-model.md) — Lingtai restricts no tool call. Tool
  limits are the runtime's own configuration.
- [0016 §7](0016-the-settled-model.md) — nothing sits above a repository's
  recipe. A recipe may be as permissive as its repository chooses.
- **Here** — what an agent may see is the operator's to decide, with the recipe
  as the instrument.

`RESERVED` was the one place the system reached past that and decided for you.

**The obligation this creates is the interesting half.** "The operator is
responsible" is only true where the operator can see what is happening and the
instruments do what they claim. Two things follow, and both are load-bearing
rather than nice:

- **`doctor` reports every declared name and which file answered for it, per
  project, names only.** A responsibility nobody can inspect is not one they
  hold.
- **An instrument that is advertised and inert is worse than none.** The
  production tripwire is currently that: it refuses a host with a `prod`
  segment, and the databases this system actually connects to are named
  `db.<random-ref>.supabase.co`, so it has never fired and would not. Under a
  design where Lingtai catches things, that is a gap in a backstop. Under this
  one it is a false assurance, and it is why that fix stops being cosmetic.

## What would change it



A repository whose recipe the operator does not control is the case `RESERVED`
imagined. It does not exist today — every managed recipe is written by the
operator or reaches `main` through their approval — but the principle above does
not depend on that staying true, and the answer when it changes is still not a
list in the core:

- the operator's machine should not hold, in `process.env`, a credential that a
  managed repository could name and use, and
- the file layer already gives per-project values, so a project can be given
  exactly what it should have and nothing else.

Written down so that the next person to feel the pull toward a denylist in the
source can see that it was considered, tried for a day, and put back where it
belongs.

## Consequences

- `worktree.ts` loses `RESERVED` and `isReserved`, and `filterEnv` stops
  reporting a `reserved` list.
- `env.allow` returns to the schema beside `env.deny` — but with the meaning it
  never had before: a filter over data that already exists, not a list of names
  to go looking for in the process environment.
- `env.required` keeps the refusal 0020 introduced, and loses the interaction
  with the other two.
- Lingtai's own recipe stops depending on the asymmetry that let it name
  `TEST_DATABASE_URL` while a managed repository could not. It names it because
  it needs it, and the value is in `~/.lingtai/env/lingtai.env` because that is
  where the operator put it.
