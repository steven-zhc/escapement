# 0011 — The hook's 20ms budget is Bun's startup, and is not met

**Status** accepted · 2026-08-31 · qualifies [0002](0002-typescript.md)

## Context

[0002](0002-typescript.md) listed "hook answering in under 20 ms" as one of the
five requirements bash could not meet, and made the hook a Bun-compiled single
file to meet it. [#11](https://github.com/steven-zhc/escapement/issues/11) asked
for that to be measured rather than assumed.

It was, twice, and the two runs disagreed: 19.0ms p95, then 23.8ms p95 on the
same machine minutes later. So the third measurement asked where the time goes
([experiment 004](../experiments/004-hook-latency.md)):

```
/usr/bin/true (bare process spawn)     p50  0.9ms
bun binary, no socket (fails fast)     p50 16.9ms
bun binary, full round trip            p50 15.8ms
node --experimental-strip-types src    p50 55.7ms
```

The binary that does nothing costs the same as the binary that does the work.
**Every millisecond is Bun's runtime startup**, before a line of this code runs.
Spawning is 0.9ms. The socket round trip, the JSON, the conductor's in-memory
policy decision — together they are inside the noise.

## Decision

Accept ~16ms p50 and a p95 that crosses 20ms under load, and stop treating 20ms
as a gate.

The test asserts one thing: the **marginal** cost of the round trip over a
fail-fast spawn of the same binary. That is what Escapement owns and what would
move if the conductor started doing work on the hot path.

It asserts nothing about the absolute number, not even a loose ceiling. 19.0,
23.8 and 46.7ms p95 were all observed on this machine within an hour; a gate on
a figure that noisy is a test that fails for reasons no change here can fix,
which is how a suite stops being trusted. The distribution is printed on every
run instead, so the number stays visible rather than asserted away.

Bun stays. Node running the same source is 55.7ms, three and a half times worse,
so the choice 0002 made was right even though the number it promised is not.

## Consequences

- **The hot path has no room in it, and now that is a measured fact rather than
  a caution.** Anything added to `esc-hook` is pure addition to a budget already
  over. This is why policy lives in the conductor, and the reason is now
  quantitative.
- **The rewrite target is startup time, not the protocol.** 0002 already noted
  the hook could be rewritten in Go or Rust behind the same stdin/stdout
  contract. That would take ~16ms to ~1ms. It is not justified yet: at tens of
  thousands of calls per run, 16ms each is minutes of wall time against runs
  measured in hours, and no observed failure is attributable to it.
- **The trigger for revisiting is stated**: if hook latency ever appears in a
  run's receipt as a material share of wall time, or if concurrency (Phase 4)
  multiplies it, rewrite the binary. Not before.
- A future Bun with faster startup makes this decision moot without anyone
  doing anything, which is worth knowing before spending a week on Rust.

## Note on method

The first measurement passed at 19.0ms and would have been recorded as "meets
the budget". It was luck of timing, and the only reason that was caught is that
one millisecond of margin looked wrong and got a second run. A benchmark with a
margin that thin is a benchmark that has not concluded anything yet.
