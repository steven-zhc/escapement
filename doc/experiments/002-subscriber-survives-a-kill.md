# 002 — Does the subscriber survive its connection being killed?

**Run** 2026-08-31, against the live database · **Result** yes, with no gap and
no duplicate · four consecutive runs, no flake

## Question

[#2](https://github.com/steven-zhc/escapement/issues/2) claims a subscriber
"reconnects with backoff and resumes from the last seq" and that "nothing is
missed across a reconnect". Both are easy to write and easy to be wrong about,
because the failure is invisible: a listener that quietly stops hearing looks
exactly like a system with nothing to do. [0009](../decisions/0009-two-connections.md)
is the record of that already happening once.

So the claim needed a disconnect that actually happens, not one that is
simulated by calling `close()`.

## Method

`packages/store/test/subscribe.test.ts`, third test:

1. Subscribe from the log's high-water mark; wait for `caughtUp()`.
2. Append one event **from the pooled connection**; wait until it is delivered.
   Without this the kill would prove nothing — a listener that never worked also
   passes a test that only checks it recovers.
3. `pg_terminate_backend(pid)` from a third connection, on the pid the
   subscriber reports.
4. Append two more events **immediately**, while it is down. Their `NOTIFY`s go
   to a backend that no longer exists and are lost.
5. Wait for all three, then assert the sequence delivered is exactly
   `[one, two, three]` — in order, complete, and with no value seen twice.

## Result

All three arrive. The two appended during the outage are recovered by the
catch-up read the reconnect performs *before* going live, not by a notification —
the notifications for them were genuinely lost. `onError` reports the
`connection` phase once; the subscription does not stop.

Reconnect took under a second at `baseMs: 50`. Four runs, four passes.

## What it also turned up

**`DIRECT_DATABASE_URL` on port 5432 is Supavisor in session mode, not a raw
backend.** The first version of this test identified the listener by
`application_name` and killed it that way. It matched nothing:

```
as seen by itself: { application_name: 'Supavisor', pid: 17172, user: 'postgres' }
pg_stat_activity:  17169 "Supavisor" idle
                   17170 "Supavisor" idle
                   17172 "Supavisor" idle
```

Supavisor overwrites `application_name` on every connection through it. This
does not contradict [0009](../decisions/0009-two-connections.md) — session mode
is what 0009 requires, and cross-connection `NOTIFY` and advisory locks both
work through it, which is the whole point. But two things follow:

- `application_name` cannot be used to find a connection on this deployment.
  `Subscription.backendPid` exists because of this, and is what the test kills.
- "Direct" in `DIRECT_DATABASE_URL` means *session mode*, not *unpooled*. Anyone
  reading it as a raw connection to Postgres will be wrong in ways that only
  show up under a pooler's own behaviour.

## Limits

- One deployment, one pooler. Supavisor session mode pins a client to a backend,
  which is why killing the reported pid severs the listener; a different pooler
  may not, and the test would then be killing something else.
- The outage is instantaneous. A backend killed cleanly is not the same as a
  network partition, where the client has no error to react to until a TCP
  timeout. The backoff loop is untested against that, and it is the case where
  `capMs` actually matters.
- Delivery is exactly-once only within a process. `lastSeq` lives in memory; a
  handler that succeeds and a process that dies before the checkpoint is written
  will redeliver. That is [#4](https://github.com/steven-zhc/escapement/issues/4)'s
  problem, and its handlers have to be idempotent regardless.
