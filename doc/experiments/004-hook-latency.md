# 004 — Is `esc-hook` fast enough to sit in front of every tool call?

**Run** 2026-08-31, on the development machine · **Result** yes, at 19.0ms p95
against a 20ms budget — with almost no margin

## Question

[0002](../decisions/0002-typescript.md) made the hook the one exception to
"TypeScript everywhere": a Bun-compiled single file with no dependencies,
because `PreToolUse` runs in front of every tool call an agent makes — tens of
thousands across a run. [#11](https://github.com/steven-zhc/escapement/issues/11)
put a number on it: **under 20ms at the 95th percentile, measured, not assumed.**

A budget nobody measures is a budget nobody has.

## Method

`packages/conductor/test/hook.test.ts`, the latency case. The binary is built
with `bun build --compile` and spawned as a process, which is exactly how a
runtime invokes it — so the sample includes everything the runtime pays for:

1. process spawn
2. reading the payload from stdin
3. connecting to the conductor's unix socket
4. one request/response round trip, answered from memory
5. exit

Ten warm-up runs, then 200 samples, against a live conductor with a registered
run and a real guard policy.

## Result

```
esc-hook: p50 16.3ms  p95 19.0ms  p99 20.0ms  (n=200)
```

It passes. It passes by one millisecond.

**Nearly all of that is process startup.** The conductor's side answers from
memory — policy is resolved once when the run is registered, and an allowed call
is a counter increment and a JSON write. The socket round trip is not what costs
16ms; spawning a compiled binary is.

## What follows

- **The hot path has no room in it.** Anything added to `esc-hook` — a
  configuration read, a policy evaluation, a second round trip — comes out of a
  one-millisecond margin. The reason policy lives in the conductor is not
  tidiness; there is no budget for it here.
- **The p99 is already at the limit.** A slower machine, a loaded one, or a
  larger payload would put this over. The number to watch is p99, not p95.
- **A faster hook means a smaller runtime, not faster code.** The remaining cost
  is `execve` plus a runtime's own startup. 0002 already notes the hook could be
  rewritten in Go or Rust behind the same stdin/stdout contract; this is the
  measurement that would justify it, and it is not justified yet.

## Limits

- One machine, unloaded, warm page cache. A CI runner or a machine already
  running an agent will be slower, and neither has been measured.
- macOS on Apple silicon. `execve` cost differs enough between platforms that
  this number should not be quoted for Linux.
- The conductor was answering one hook at a time. Real concurrency is one run
  (`concurrent: 1`), so this matches today — but it is not a measurement of the
  socket under load, and Phase 4 raises concurrency.
- 200 samples is enough for a p95 and thin for a p99. The p99 above is one
  sample.
