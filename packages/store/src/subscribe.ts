/**
 * The subscriber: what makes this system event-driven rather than timed.
 *
 * With it, `interval` never has to exist as a configuration value — the
 * conductor and the board wake on an append instead of on a clock. It is also
 * the single reason the store is PostgreSQL and not SQLite
 * (doc/decisions/0003-postgres-event-store.md).
 *
 * Three rules, and each of them is the difference between "works in a demo" and
 * "does not lose events".
 *
 * **`LISTEN` before the catch-up read, never after.** Registering the listener
 * first means an append that happens *during* catch-up is announced rather than
 * dropped into the window between "read the log" and "start listening".
 *
 * **The notification is a nudge, not the payload.** `NOTIFY` carries the `seq`
 * only — the payload caps at 8000 bytes and an event body can exceed it — so a
 * nudge triggers a drain of everything after `lastSeq`, not a fetch of the one
 * row named. That is also what makes a coalesced or duplicated notification
 * harmless: `lastSeq` only ever moves forward, and only after a handler returns.
 *
 * **The connection is `DIRECT_DATABASE_URL`.** Through a transaction pooler the
 * listener's backend is handed to someone else between statements and the
 * registration goes with it. Nothing errors; the notification simply never
 * comes. See doc/decisions/0009-two-connections.md — that is the failure this
 * whole file is shaped around.
 */
import type { Envelope } from "@escapement/core";
import pg from "pg";
import { directDatabaseUrl } from "./env.ts";
import { type EventStore, eventStore } from "./event-store.ts";

/** The channel `sql/notify.sql`'s trigger writes to. */
export const CHANNEL = "escapement";

interface SubscribeBase {
  /**
   * Resume point, exclusive. A checkpoint's `lastSeq`; `0n` reads the log from
   * the beginning.
   */
  fromSeq: bigint;

  /** Reads go through the pooled connection. Defaults to the process-wide store. */
  store?: EventStore;

  /** Session-mode connection string. Defaults to `directDatabaseUrl()`. */
  url?: string;

  /** How many events to read per round trip while catching up. */
  batchSize?: number;

  /**
   * Sets `application_name`, so a listener is identifiable in
   * `pg_stat_activity`.
   *
   * **Supabase overrides it.** `DIRECT_DATABASE_URL` on port 5432 is Supavisor
   * in session mode, not a raw backend, and it reports every connection through
   * it as `Supavisor` — measured 2026-08-31. Session mode is what 0009 requires
   * and this is still that, but it means the name cannot be used to find this
   * connection here. `backendPid` can.
   */
  name?: string;

  /**
   * A connection error is reported and then retried. A handler error is
   * reported and stops the subscription.
   */
  onError?: (error: unknown, phase: "connection" | "handler") => void;

  /** Reconnect backoff, in milliseconds. */
  backoff?: { baseMs?: number; capMs?: number };
}

/**
 * Exactly one of these. Both are called in `seq` order and never concurrently
 * with themselves.
 *
 * If either throws, the subscription **stops** and `lastSeq` is left pointing at
 * the last event that succeeded — the failed event is retried on the next
 * attempt rather than skipped. A projection that cannot handle an event must not
 * quietly carry on without it.
 *
 * `onBatch` exists so a projection can put a whole batch and its checkpoint
 * advance inside one transaction. Per-event, a rebuild of a long history would
 * be one network round trip per row.
 */
type SubscribeHandler =
  | { onEvent: (event: Envelope) => Promise<void> | void; onBatch?: never }
  | { onBatch: (events: readonly Envelope[]) => Promise<void> | void; onEvent?: never };

export type SubscribeOptions = SubscribeBase & SubscribeHandler;

export interface Subscription {
  /** The highest seq handed to `onEvent` and returned from it. */
  readonly lastSeq: bigint;
  /**
   * The Postgres backend currently holding the `LISTEN`, or null while
   * disconnected. The one identifier that survives a session pooler — see
   * `name` — so it is what a diagnostic, or a test that wants to sever this
   * connection on purpose, has to go by.
   */
  readonly backendPid: number | null;
  /** True once the subscription has stopped and will not reconnect. */
  readonly stopped: boolean;
  /**
   * Resolves the first time the subscriber is listening *and* has drained the
   * backlog — the catch-up-to-live handoff. Rejects if it stops first.
   */
  caughtUp(): Promise<void>;
  close(): Promise<void>;
}

/** Wraps a handler failure so the connection loop can tell it from a socket drop. */
class HandlerFailed extends Error {
  override readonly name = "HandlerFailed";
  readonly event: Envelope;

  constructor(event: Envelope, cause: unknown) {
    super(`handler threw on event ${event.seq} (${event.type})`, { cause });
    this.event = event;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => {
      if (!d.settled) {
        d.settled = true;
        resolve(v);
      }
    },
    reject: (e) => {
      if (!d.settled) {
        d.settled = true;
        reject(e);
      }
    },
  };
  // Nothing awaits `caughtUp()` in the common case, and an unobserved rejection
  // takes the process down under Node's default handler.
  promise.catch(() => {});
  return d;
}

export function subscribe(options: SubscribeOptions): Subscription {
  const store = options.store ?? eventStore;
  const url = options.url ?? directDatabaseUrl();
  const batchSize = options.batchSize ?? 500;
  const baseMs = options.backoff?.baseMs ?? 100;
  const capMs = options.backoff?.capMs ?? 10_000;
  const applicationName = options.name ?? "escapement-subscriber";

  let lastSeq = options.fromSeq;
  let closed = false;
  let stopped = false;
  let current: pg.Client | null = null;
  let backendPid: number | null = null;
  const ready = deferred<void>();
  /**
   * Raised by `close()`. Exists because `pg` gives no way to abort a connect
   * that is in flight: `end()` returns a promise that settles on an 'end' event
   * an unestablished socket never emits, `connectionTimeoutMillis` was measured
   * not to fire once `end()` had been called, and destroying the underlying
   * stream did not help either. Racing is what works.
   */
  const closing = deferred<void>();

  /** Serialises draining. A nudge that arrives mid-drain sets `again` instead. */
  let draining = false;
  let again = false;

  async function drain(): Promise<void> {
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    try {
      for (;;) {
        again = false;
        const batch = await store.readAll(lastSeq, batchSize);
        if (options.onBatch) {
          if (batch.length > 0) {
            try {
              await options.onBatch(batch);
            } catch (err) {
              // Deliberately before the advance: the whole batch is retried
              // rather than any of it skipped.
              throw new HandlerFailed(batch[0]!, err);
            }
            lastSeq = batch[batch.length - 1]!.seq;
          }
        } else {
          for (const event of batch) {
            try {
              await options.onEvent(event);
            } catch (err) {
              throw new HandlerFailed(event, err);
            }
            lastSeq = event.seq;
          }
        }
        // A short batch means the log is drained — unless a nudge arrived while
        // this one was in flight.
        if (batch.length < batchSize && !again) return;
      }
    } finally {
      draining = false;
    }
  }

  /** One connection's life. Resolves when it is time to reconnect, or to stop. */
  async function session(): Promise<{ outcome: "reconnect" | "stop"; served: boolean }> {
    const ended = deferred<void>();
    let fatal: unknown = null;

    const client = new pg.Client({
      connectionString: url,
      application_name: applicationName,
      // A backstop, not the mechanism. `close()` destroys the socket to make a
      // hanging connect fail fast; this bounds the case where nobody is
      // closing and the network simply never answers, which would otherwise
      // leave a subscriber wedged with no backoff and no error.
      connectionTimeoutMillis: 15_000,
    });
    current = client;
    // Whether this connection ever got as far as listening and draining. A
    // session that served resets the backoff; one that died connecting does not.
    let served = false;

    // `pg` emits 'error' on a Client for a dropped backend. Without a listener
    // that is an unhandled event and takes the process down — which is how a
    // subscriber turns a survivable disconnect into an outage.
    client.on("error", (err: unknown) => {
      options.onError?.(err, "connection");
      ended.resolve();
    });
    client.on("end", () => ended.resolve());
    client.on("notification", () => {
      void drain().catch((err: unknown) => {
        fatal = err;
        ended.resolve();
      });
    });

    try {
      // Raced rather than awaited. A `close()` arriving mid-connect is
      // otherwise invisible until the connect finishes, and it may never:
      // `subscribe()` followed immediately by `close()` hung indefinitely, and
      // the daemon inherited it. A daemon that cannot be stopped in its first
      // second is one launchd has to SIGKILL, which is the ungraceful exit the
      // advisory lock and the checkpoints exist to make unnecessary.
      const outcome = await Promise.race([
        client.connect().then(() => "connected" as const),
        closing.promise.then(() => "closing" as const),
      ]);
      if (outcome === "closing") return { outcome: "stop", served: false };

      // Before the catch-up read, always. See the module header.
      await client.query(`LISTEN ${CHANNEL}`);
      const pid = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      backendPid = pid.rows[0]?.pid ?? null;
      await drain();
      served = true;
      ready.resolve();
      await ended.promise;
    } catch (err) {
      if (err instanceof HandlerFailed) fatal = err;
      else options.onError?.(err, "connection");
    } finally {
      current = null;
      backendPid = null;
      // Fired, never awaited: on a client that never finished connecting this
      // settles on an event that is not coming, and awaiting it here would put
      // the hang back one level down.
      void client.end().catch(() => {});
    }

    if (fatal instanceof HandlerFailed) {
      options.onError?.(fatal.cause, "handler");
      return { outcome: "stop", served };
    }
    return { outcome: closed ? "stop" : "reconnect", served };
  }

  /** Exponential with jitter, so a database restart is not met by a thundering herd. */
  function backoffMs(attempt: number): number {
    const flat = Math.min(capMs, baseMs * 2 ** attempt);
    return flat * (0.8 + Math.random() * 0.4);
  }

  const sleeping = deferred<void>();
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      // close() during a backoff should not wait the backoff out.
      void sleeping.promise.then(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async function run(): Promise<void> {
    let attempt = 0;
    while (!closed) {
      const { outcome, served } = await session();
      if (outcome === "stop") break;
      attempt = served ? 0 : attempt + 1;
      await sleep(backoffMs(attempt));
    }
    stopped = true;
    ready.reject(new Error("subscription stopped before it caught up"));
  }

  const running = run();

  return {
    get lastSeq() {
      return lastSeq;
    },
    get backendPid() {
      return backendPid;
    },
    get stopped() {
      return stopped;
    },
    caughtUp: () => ready.promise,
    async close() {
      closed = true;
      sleeping.resolve();
      closing.resolve();
      // Fired, never awaited — see the `finally` in `session`.
      void current?.end().catch(() => {});
      await running;
    },
  };
}
