# 0002 — TypeScript, with the hook as a Bun single file

**Status** accepted · 2026-08-31

## Context

The old loop was bash, and bash was the right choice for what it did: string a
few CLIs together. The new system has five requirements bash cannot meet.

## Decision

TypeScript throughout, except the hook binary.

| Requirement | Why not bash | In TypeScript |
|---|---|---|
| Event schemas with versioned upgrades | `jq` string-assembly; one field change breaks everything downstream silently | zod schemas plus upcasters, checked at compile time |
| Postgres `LISTEN/NOTIFY` | a long-lived `psql` is not maintainable | the `pg` client, with reconnect and cursor resume |
| Board and scheduler sharing types | impossible | one `@lingtai/core`; changing an event definition breaks both at compile time |
| Two agent runtimes | branching everywhere | one interface, two implementations, capabilities as flags |
| Hook answering in under 20 ms | fork per call, and failure modes are hard to control | a compiled single-file binary |

The third row is the one that matters most. In the old system the concept of
"state" existed separately in bash, in GitHub labels, and in a person's head —
which is how #35 ended up in two contradictory states at once. Here it exists
only as a type in `@lingtai/core`, and both the scheduler and the board read
it from there.

## The exception: the hook

`PreToolUse` sits in front of every tool call the agent makes — tens of
thousands across a run. It is a **thin client**: a Bun-compiled single file with
no dependencies that reads stdin, connects to a local unix socket, returns the
verdict, and exits. Policy evaluation and event persistence happen in the
long-running conductor. If the socket is unreachable it exits 2 and the tool
call is refused: fail closed, with a startup smoke test to prove it, the same
discipline `test-guard.sh` had.

## Consequences

- Node 22+ and pnpm workspaces; Bun only for compiling the hook.
- The hook's latency budget is a real constraint on the conductor's socket
  handler, which must answer from memory and persist asynchronously.
- Nothing prevents a future rewrite of the hook in Go or Rust; it is a few
  hundred lines behind a stdin/stdout contract.
