# 004 — Where does `lingtai-hook`'s latency actually go?

**Run** 2026-08-31, on the development machine · **Result** ~16ms p50, p95
anywhere from 19 to 47ms — and **all of it is Bun's runtime startup**. The 20ms
p95 target is not met.

## Question

[0002](../decisions/0002-typescript.md) made the hook the one exception to
"TypeScript everywhere": a Bun-compiled single file with no dependencies,
because `PreToolUse` runs in front of every tool call — tens of thousands across
a run. [#11](https://github.com/steven-zhc/lingtai/issues/11) put a number on
it: **under 20ms at the 95th percentile, measured, not assumed.**

## Method

Two measurements. The first is the end-to-end one #11 asks for:
`packages/conductor/test/hook.test.ts` builds the binary with `bun build
--compile`, spawns it 200 times against a live conductor with a registered run
and a real guard policy, and times spawn → stdin → connect → round trip → exit.

The first run of it passed at 19.0ms p95. The second, minutes later on the same
machine, gave **23.8ms**. A one-millisecond margin is not a margin, so the
second measurement asks where the time goes: the same binary against a trivial
socket server, compared with a bare process spawn and with Node running the same
source.

## Result

```
/usr/bin/true (bare process spawn)     p50  0.9ms   p95  1.1ms
bun binary, no socket (fails fast)     p50 16.9ms   p95 22.2ms
bun binary, full round trip            p50 15.8ms   p95 19.3ms
node --experimental-strip-types src    p50 55.7ms   p95 59.7ms
```

Three things follow, and the second is the one that matters.

**Spawning a process is nearly free.** 0.9ms. The cost is not `execve`.

**The round trip is free too.** The binary that connects to a socket, sends a
request and reads a reply is *not slower* than the one that fails immediately
because there is no socket — the difference is inside the noise. Lingtai's
own code, the conductor's in-memory decision, and the unix socket together cost
approximately nothing.

**All of it is Bun's runtime startup**: ~16ms before a line of this code runs.

And Bun was the right call anyway: Node running the same source is 55.7ms, three
and a half times worse.

## Conclusion

**The 20ms p95 target is not met.** It is met at the median and misses at the
95th percentile whenever the machine is doing anything else — which, on a machine
also running an agent, is always. Both measurements are honest; the first one
passing was luck of timing.

This does not change the design. The hook is already as thin as a hook can be,
and the remaining cost is not ours to remove. 0002 anticipated this: *"Nothing
prevents a future rewrite of the hook in Go or Rust; it is a few hundred lines
behind a stdin/stdout contract."* This is the measurement that would justify it,
and it identifies the target precisely — **startup time, not the protocol**.

Recorded as [0011](../decisions/0011-hook-latency-is-runtime-startup.md).

## What the test asserts now

Not 20ms, because that would be a test that fails for reasons nobody can fix.
It asserts what Lingtai actually controls and can regress:

- the **marginal** cost of the socket round trip over a fail-fast spawn stays
  small — this is the number that would move if the conductor started doing work
  on the hot path;
- and nothing else. The real distribution is printed on every run so it stays
  visible, but no absolute figure is gated: 19.0, 23.8 and 46.7ms p95 were all
  observed on this machine within an hour, and a gate on a number that noisy
  fails for reasons no change here can fix.

## Limits

- One machine, macOS on Apple silicon. `execve` and runtime startup both differ
  enough between platforms that none of these numbers should be quoted for
  Linux.
- Bun 1.x as installed today. A future Bun with faster startup changes the
  conclusion entirely, and nothing here tracks that.
- The conductor was answering one hook at a time, which matches `concurrent: 1`.
  This is not a measurement of the socket under load.
- 150–200 samples: enough for a p95, thin for a p99.
