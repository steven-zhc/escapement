# 003 — Does `lingtai doctor` actually catch a transaction pooler?

**Run** 2026-08-31, against the live database · **Result** yes, including the
case the cheap check cannot see

## Question

[0009](../decisions/0009-two-connections.md) closes with a requirement rather
than a claim: *`lingtai doctor` must assert the direct connection is genuinely
session mode, by holding a listener open and notifying from a second connection.
A check that only opens a connection would pass against a transaction pooler and
prove nothing.*

A check written to catch a specific failure is worth nothing until it has been
shown to catch it. So `DIRECT_DATABASE_URL` was pointed at the transaction
pooler on purpose, and the doctor run.

## Method

Two runs, both spawning `lingtai doctor` with `DIRECT_DATABASE_URL` overridden in the
child's environment. The pooled URL is never printed; it is read through
`databaseUrl()` and passed straight into the child.

1. **The pooled URL as-is** — `:6543`, carrying `?pgbouncer=true`.
2. **The pooled URL with `pgbouncer` stripped** — still the transaction pooler,
   but now indistinguishable from a session-mode URL by inspection alone. This
   is the case that matters: a deployment can offer a transaction pooler on a URL
   with no flag at all, and several do.

## Result

**Run 1** failed on the environment check, before any connection was opened:

```
 FAIL  environment
       DATABASE_URL :6543 db=postgres pgbouncer=true · DIRECT_DATABASE_URL :6543
       db=postgres pgbouncer=true · same host: yes — DIRECT_DATABASE_URL still
       carries pgbouncer=true
 skip  postgres
       not attempted — the environment check failed first
```

Exit code 1. Correct, but cheap — and it short-circuits the check 0009 asked for,
which is exactly why the second run exists.

**Run 2** passed the environment check and was caught by the probe:

```
  ok   environment
       DATABASE_URL :6543 … · DIRECT_DATABASE_URL :6543 db=postgres
       pgbouncer=false · same host: yes
  ok   postgres: pooled connection
       PostgreSQL 17.6
 FAIL  postgres: direct connection is session mode
       a NOTIFY from a second connection never arrived — DIRECT_DATABASE_URL is
       not session mode. LISTEN/NOTIFY and advisory locks will both fail
       silently through it (doc/decisions/0009).
```

Exit code 1. Every schema check still passed, because the schema is fine — the
connection is the problem, and only the probe says so.

The correctly configured run is 10 ok, 6 not implemented yet, 0 failed.

## Limits

- Only the `NOTIFY` half fired. The advisory-lock assertion runs after it and was
  never reached in run 2, so it is *written* but not yet *demonstrated* against a
  pooler that drops locks. A pooler that delivers notifications but not
  session-level locks would be caught by an untested branch.
- One pooler (Supavisor). PgBouncer, RDS Proxy and Neon's pooled endpoint are
  claimed to behave the same way by 0009 and are still not measured here.
- The probe costs a fixed 1.5s pause on every `lingtai doctor` run. That is the pause
  that makes it meaningful — a shorter one can be answered by the same backend
  that registered the `LISTEN` — but it is a real cost on a command intended to
  gate a restart.
