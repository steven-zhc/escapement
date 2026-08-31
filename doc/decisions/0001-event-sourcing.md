# 0001 — Rebuild the loop as an event-sourced system

**Status** accepted · 2026-08-31

## Context

`agent-loop.sh` worked 73 tickets over four days. It was not badly implemented;
it had the wrong model. State lived in GitHub labels, history in issue comments,
telemetry in a `.jsonl` file, and a timer drove the whole thing. Measured on the
real logs, that model could not answer:

| Question | Why not | Evidence |
|---|---|---|
| What state is this ticket in? | `--add-label` is set union, not a transition. Nothing forbids contradictory pairs and nothing reconciles them. | #35 carried `agent:blocked` **and** `agent:review` at once |
| Why did this not merge? | Six `return 1` paths in `integrate()` emitted no log line, no comment, no label. | #58/#59 re-ran five times for ~$29 while the real cause — a dirty main checkout — was never reported |
| How often does the guard fire? | Blocks went to stderr inside a log file nobody parsed. | 132 blocks across 56 of 73 runs — 77% of runs tripped it |
| What does a merged ticket cost? | The cost record sits in a `.jsonl` that also contains raw `pnpm build` output, so it does not parse. | 9,555 of 42,147 lines are not JSON |
| Which merges generate bugs? | Nothing links a filed bug to the ticket whose code caused it. | #134 and #136 are races in code #58 had merged, having passed verify, CI and human review |
| What is waiting on me? | `agent:review` is a queue with no consumer and no UI. | 45 open, growing ~14/day against 0 processed |

The loop was already event-sourced — badly. It wrote its events to three
incompatible places and had no reader.

## Decision

One append-only event log is the system of record. State, history and telemetry
are the same stream. Projections — the board, the queue, what is waiting on a
human, cost receipts, guard trips, regressions — are derived and rebuildable.
**GitHub labels become an output, never an input.**

## Consequences

- Every silent `return 1` becomes a typed `IntegrationRefused` with a reason.
- Contradictory state is structurally impossible; labels are reconciled to match
  the log.
- The board is a projection, so it costs nothing extra once the log exists.
- The scheduler stops being a timer. Events wake it; `interval` disappears as a
  configuration value.
- Schema evolution becomes the one piece of ceremony that is genuinely not
  optional. Every event carries `schemaVer` from the first row.
- This is over-engineering for the volume alone — roughly a few dozen events an
  hour, single writer, one machine. It is justified by the board, the approvals
  and multi-project support, not by scale. See
  [design.md](../design.md) for what is deliberately *not* being built.
