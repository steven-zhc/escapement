# 009 — The end gate closes its own issue

**2026-09-02.** Stage 3f. The first run on the model [ADR 0016](../decisions/0016-the-settled-model.md)
describes: five gate points, no policy, no guard, and an `end` point whose
actions are effects rather than verdicts.

## What was run

`nextloom-ai-admin` #157 — give the eight pages that can export `metadata` a
`description` of their own, instead of all fifteen sharing the root's. Eight
files, one line each, so the result is trivial to check.

    pnpm lingtai daemon
    pnpm lingtai now nextloom-ai-admin --issue 157

## What happened

    claimed wi-nextloom-ai-admin-157 as run-24ed2f65
    worktree ... at 8f3fb5b
    prepare: install ok in 6.9s
    run finished: 8 turns, 0.633727 usd
    gates: build=passed
    landed c488abe on develop

`git diff --stat 8f3fb5b c488abe` — exactly the eight files named in the ticket,
32 insertions, nothing else touched.

Then, the part this stage existed for:

    CLOSED  labels=[enhancement]

**The `end` gate closed its own issue**, and `enhancement` survived. That second
half matters as much as the first: the label-deleting bug found in
[experiment 006](006-the-loop-closes-unattended.md) had stripped `enhancement`
off three issues, and this is the first real run proving the fix holds.

The recipe said it, in the managed repository:

```yaml
  end:
    - name: close the ticket
      when: landed
      close: true
```

`lingtai add` had already shown the same shape at onboarding, with the empty points
named rather than omitted:

    admit     (skipped)
    prepared  (skipped)
    diff      build
    merge     (skipped)
    end       close the ticket

## Three defects the run found

**1. An orphaned SQL join, and the tests could not have caught it.** 3b removed
the `tier` column from `readTasks`'s select but left `left join
task_view_project` — whitespace the edit did not match. Every pass refused with
`relation "task_view_project" does not exist`. 3b's suite passed because the
table still existed *in the database* at the time; only dropping it and running
made the query fail. A schema change verified against a database that still has
the old shape is not verified.

**2. A pause stopped delivery, not just work.** #157 landed, `EndActionsResolved`
was appended, the `issue-close` row was enqueued — and it sat there, because the
outbox drains inside the conductor pass and the pass is skipped while paused.
The issue stayed open with `lingtai:working` on it.

That is backwards. A pause stops the conductor **taking work**; it must not stop
delivering what already happened. A "waiting on you" comment sits in that same
queue, and a pause is exactly when somebody most needs to read one. The loop now
drains while paused (`drain` in `work-loop.ts`), using `conductorPass({ max: 0 })`
— which builds the per-project clients and takes nothing, including nothing
nominated.

**3. The log reset made finished work look runnable.** After 3a wiped the log,
`lingtai status` listed #120, #155 and #156 as runnable: they had landed, but
Lingtai no longer remembered it. The daemon would have re-run merged work and
spent real money doing it. Paused before it could, with the reason on the record.

This is the cost of §9's reset, and it was not written down there. A queue is
`what GitHub lists, minus what the log says is claimed` — reset the log and the
subtraction has nothing to subtract. Anything that closes its own issues is
immune, because GitHub itself then carries the state; #157 closed and is gone
from the queue. The three that predate the `end` gate are not.

## Limits

- **One project, one item, and the daemon paused for most of it.** The unattended
  circle was proven in experiment 006 on the old model; this run proves the new
  model's pieces, not that they run unattended together.
- **`admit` and `prepared` are still empty**, so three of the five points have
  never executed an action. `merge` held only via `--no-merge` in tests, never
  from a `human:` action in a real recipe.
- **`labels:` at `end` is untested against real GitHub.** Only `close:` ran.
- **#120, #155 and #156 stay open.** The `end` action fires on a landing, and
  theirs already happened. Closing them by hand would make the queue look right
  and prove nothing, so they are left as they are.
