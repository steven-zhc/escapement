# 006 — The loop closes unattended

**2026-09-02.** Stage 2a's exit criterion, written in the roadmap and in issue
#40 as: *an issue goes queue → landed and the card moves on its own, with
nobody running a command.* Every part had been tested separately. The whole
circle had never been watched once.

## What was run

A new ticket, `nextloom-ai-admin` #156, written for this: the six `"use
client"` pages that #155 left without a browser-tab title. #155 had called that
a refactor needing each page's data fetching moved into a server wrapper. It is
not — a sibling `layout.tsx` is a server component and its `metadata` applies to
the page it wraps. Six new files, no existing file touched, which makes the
result trivial to check.

    pnpm esc daemon --no-guard          # one process, left alone
    pnpm esc now nextloom-ai-admin --issue 156

Then nothing. No further command was issued.

## What happened

    nextloom-ai-admin: taking #156 — asked for by human:steven
    recipe f4dcbb57e147 from develop, tier guarded
    claimed wi-nextloom-ai-admin-156 as run-75b80f13
    worktree ... at be25a20
    prepare: install ok in 7.2s
    run finished: 15 turns, 0.8267575 usd
    landed 06e8bbe on develop
    pass (completion): 1 project(s), 1 run(s), 2 sent
    pass (completion): 1 project(s), 0 run(s)

`git diff --stat be25a20 06e8bbe` — six files added, 42 insertions, nothing
modified. Exactly the ticket.

The last two lines are the part that matters more than the merge: the
completion event triggered the next pass by itself, and that pass found the
queue empty and stopped. The loop advances on events and comes to rest. That is
2a.

**15 turns, $0.83.** Comparable to #155 (13 turns, $0.86) and far off the
45-turn, $3.35 failure that prompted turning the guard off.

## Two things the run found that no test had

**1. `esc now` did not run the issue you named.** It appended `RunRequested`
and only *woke* the loop; the pass then took whatever was at the top of the
queue. With one item queued the difference is invisible, which is why it
survived. Fixed before the run: a request whose task is still `queued` in
`task_view` jumps the queue. It needs no "consumed" event — claiming the task
stops it being queued, which satisfies the filter.

**2. The outbox deleted every label it did not put there.** `setLabels` on the
client is a whole-set replace, deliberately — `--add-label` is set union rather
than a transition, which is how #35 came to carry `agent:blocked` and
`agent:review` at once. But `labelsFor` returns *only* Escapement's own labels,
and `labelsFor("landed")` returns `[]`. So the first outbox drain stripped
`enhancement` from #120, #155 and #156.

That label is what the recipe selects on. Escapement deleted its own queue's
selection criteria, and the three issues silently became unrunnable — a failure
that reports nothing, because an empty queue looks exactly like no work.

The header comment in `outbox.ts` had asserted that "every other label on the
issue is somebody else's and is left alone by the caller." No caller did that.
The intent was recorded as though it were implemented.

The union is now taken in the deliverer, which is the only layer that can see
GitHub's current state — a projection must be deterministic and what else is on
an issue is not in the log. Read-modify-write, so a label added by a person in
the one-round-trip gap is lost; that is a much smaller wrong than deleting all
of them. Three tests in `apps/cli/test/deliverer.test.ts` pin it, including the
landed case with the empty computed set.

The `unlabeled` events on #120 and #155 confirm only `enhancement` (foreign,
wrongly deleted) and `escapement:working` (Escapement's own, correctly deleted)
were ever removed. All three labels were restored by hand.

## Limits

- **One project, one item, guard off.** Concurrency, a queue deeper than one,
  and a real guard are all unexercised by this.
- **The tier has no mandatory gates,** so it merged without an approval. The
  approval path was exercised separately, by hand, on #120 and #155.
- **The issue is left open** after landing. Nothing closes it. Whether that is
  right is undecided, not implemented and forgotten.
- **The board was not watched during the run.** The card's movement is inferred
  from `task_view` being the board's only source, not from having looked at it.
- **The 12 backlog deliveries** at startup were a genuine first-time backlog:
  those rows had never been delivered, because the outbox worker did not exist
  when their events were appended. This was first written up here as a re-send
  hazard, which was **wrong** — two independent things prevent one. The table is
  never dropped (`reset()` is a no-op, the contract owns it), so `delivered_at`
  survives a rebuild; and even if it were dropped, `OutboxDelivered` is in the
  log, so a replay re-folds delivery state. A snapshot would not help with this
  either: what prevents double-posting is that delivery is itself an event.
