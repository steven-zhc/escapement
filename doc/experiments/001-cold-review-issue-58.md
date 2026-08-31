# 001 — Does a cold reviewer catch what four other checks missed?

**Run** 2026-08-31 · **Result** yes, all four known defects, plus two nobody had found

## Why

The most speculative part of the design is the `review` gate: a second agent,
given only the diff and the issue, with none of the implementer's context. The
claim being tested is that self-review after ~89 turns of committed reasoning is
not a second opinion.

The old loop left behind a **test set with a real answer key**. Issue #58 in
`nextloom-ai-admin` added alias-aware skill merging. It passed self-review,
passed `verify.sh`, passed CI, passed a human read, and merged. Hours later the
agent filed #132, #134 and #136 against its own merged code.

So: four known defects, in a known diff, with known locations.

## Setup

- Exported the full diff, `2006a10..d6c1407` — 6 files, 1391 lines.
- Cut a detached worktree at `d6c1407`, so the reviewer saw the code **as it was
  at merge**. The later fixes did not exist for it.
- Spawned a fresh agent with only: issue #58's text, the diff, that worktree,
  and the review brief from the design. Explicitly forbidden from running `gh`
  or reading any other issue.
- **Contamination check:** any mention of #132/#134/#136 in the output voids the
  run. None appeared — it cited line numbers only.

## Answer key

All four are the same shape: a `SELECT` decides something, an `UPDATE` acts on
it, and nothing constrains the row in between. The database is also written by
another service.

| | Location | Defect |
|---|---|---|
| #134 | `repointSkillAlias` guard (a) | "is already an alias" read, not asserted in the write |
| #136 | `repointSkillAlias` guard (b) | the target's ACTIVE-root check never reaches the `UPDATE` |
| #132 | one-hop invariant, guard (c) | not carried into the predicate |
| #134 | audit row | `fromRootId` reported from the stale read |

## Result

**4 / 4, in a single finding.** The reviewer wrote:

> The three guards (`aliasRow` is an alias, `target` is an ACTIVE root, alias has
> no children) are read in three separate statements and the `UPDATE` that acts
> on them is unconditional and outside any transaction

and separately flagged `fromRootId` as never asserted in the `WHERE`. Its
failure scenario named the interleaving concretely, produced the `a1 → B → C`
two-hop chain, observed that nothing in the application enumerates two-hop
chains so the corruption is silent, and noted that both server actions return
`{ ok: true }` while both audit rows claim a legal one-hop move.

### The more valuable half

It reported **two defects not in the answer key**. Both verified by hand, both
still present on `develop`, neither covered by any of ~300 issues:

1. **`resolve-aliases-dialog.tsx`** — `load()` sets `aliases = null` on failure,
   and the render branch is `!aliases || aliases.length === 0`. A failed load
   shows the error banner *and* "No alias rows point at X any more — it can be
   merged now." Worse on the second path: after a successful move whose
   follow-up `load()` fails, the operator is told the remaining alias is gone and
   reports the cluster unblocked. The reviewer also observed that the new
   *"surfaces a load failure"* test asserts only the banner, so it passes with
   this on screen.
2. **`repointSkillAlias`** — the `UPDATE` and `logAudit` are two bare statements.
   If the audit insert fails, the alias has already moved but the operator is
   told the move failed, and no audit row exists. Retrying yields
   "…already points at…", which reads as a different fault. Three other actions
   in the same file use `d.transaction`; this one does not.

Those two passed: agent self-review, `verify.sh`, CI, a full human review, four
days of running, and three later visits by the agent to this same code.

## Limits, stated plainly

1. **The brief named it.** "Concurrency and check-then-write" is item one of the
   design's review checklist, so this tests *the gate as designed*, not a generic
   reviewer. The result supports "this gate works", not "any reviewer finds this".
2. **Its remedy differs from the real one.** It proposed a transaction with
   `SELECT … FOR UPDATE`; the actual fixes put the predicates in the `UPDATE`'s
   `WHERE`, which is cheaper. Not scored — a gate's job is to find, not to
   prescribe.
3. **Severity ran low.** It rated the race `major`. Silent data corruption, two
   actions reporting success, and a lying audit row is a `blocker`. The severity
   rubric must be fixed in the prompt rather than left to judgement.

## Consequences for the design

- **Build the `review` gate.** The claim holds.
- **Defer adversarial verification.** It was designed to filter noise, but all
  three findings here were real — a false-positive rate of zero, with nothing to
  filter, and the filter itself costs an agent call. Add it when false positives
  actually appear.
- Still to do: replay all 31 merged diffs to measure the false-positive rate
  (n=1 says nothing about the distribution), and cluster the 132 guard trips into
  real blocks versus false alarms.
