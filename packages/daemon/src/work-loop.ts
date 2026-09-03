/**
 * What makes the conductor run without anyone asking it to.
 *
 * A completion event — landed, released, blocked, refused — means a task just
 * stopped occupying the conductor, so there may be something else to pick up.
 * Postgres already notifies on append, so this is a subscription and not a
 * timer, the same as everything else in the system.
 *
 * ## Three holes, and they are the whole of this file
 *
 * **Cold start.** With nothing in flight there is no completion event, so an
 * event-driven loop never begins. It runs once at startup.
 *
 * **A new issue appends nothing.** The queue comes from GitHub now (0012), so
 * somebody opening an issue produces no event and nothing here hears about it.
 *
 * This is the one place a timer is right, and it is worth being precise about
 * why. Everywhere else a timer would be substituting for a signal that exists —
 * Postgres notifies on append, so polling the log would be choosing to be slow.
 * There is no such signal for "somebody opened an issue on GitHub". A webhook
 * can supply one, and #28 does, but a webhook needs a public address and this
 * runs on a laptop: it is an optimisation, and an optimisation must not be the
 * only path. So the loop also sweeps on a long interval, and the interval is
 * long because the sweep is a fallback and not the mechanism.
 *
 * **The failure loop.** A failed run *releases* its task, a release is a
 * completion event, and a completion event triggers the next pass — where the
 * top of the queue is the ticket that just failed. That is an infinite loop at
 * agent prices, and it is not hypothetical: the old harness re-ran two tickets
 * five times for roughly $29 because nothing remembered the last attempt. The
 * guard is `last_attempt_at` on `task_view`, applied by `readRunnable`, and it
 * lives in the table rather than in memory precisely so that a daemon crashing
 * on a bad ticket does not come back and spend the money again.
 *
 * ## One pass at a time
 *
 * A pass takes minutes and events arrive during it. Running a second one
 * concurrently would race for the same claim, so an event during a pass sets a
 * flag and the loop goes round again when it finishes — which also collapses a
 * burst of events into one extra pass rather than one each.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { subscribe, type Subscription } from "@lingtai/store";
import pg from "pg";

/**
 * The events that mean the conductor is free to look again.
 *
 * A list rather than "anything": a run appends steadily — touched files, guard
 * trips, gate verdicts — and waking on all of them would start a pass while the
 * previous one is mid-agent, dozens of times per run.
 */
export const COMPLETION_EVENTS = [
  "WorkItemLanded",
  "WorkItemReleased",
  "WorkItemBlocked",
  "WorkItemUnblocked",
  "IntegrationSucceeded",
  "IntegrationRefused",
  // Control, for the same reason: resuming has to start work without anybody
  // restarting the daemon, and asking for a specific ticket has to be answered
  // now rather than at the next completion.
  "ConductorResumed",
  "RunRequested",
  // A webhook said GitHub changed. The sweep would find it eventually; this
  // is what makes "eventually" mean seconds when a webhook can reach us.
  "QueueChanged",
] as const;

export type PassReason = "startup" | "completion" | "sweep";

/**
 * How often to look at GitHub without being told to.
 *
 * Five minutes rather than seconds: this is the fallback for a webhook that
 * did not arrive, not the way work is normally found. Every completion still
 * triggers a pass immediately, so the only thing this bounds is how long a
 * brand-new issue can sit unnoticed on a machine with no webhook.
 */
export const SWEEP_MS = 5 * 60_000;

export interface WorkLoopOptions {
  /**
   * One pass: refresh the queue, take what is runnable, run it.
   *
   * Kept as a callback so this package needs no GitHub client and no runtime —
   * the daemon hosts the loop, and the CLI knows how to build the world it runs
   * against.
   */
  pass: (reason: PassReason) => Promise<void>;
  /**
   * Whether the conductor is currently allowed to take work.
   *
   * A callback rather than a flag, because the answer lives in the log and can
   * change while a run is in flight — the point of a pause is that it lands
   * without a restart.
   */
  paused?: () => Promise<boolean>;
  /**
   * Run while paused, instead of a full pass.
   *
   * A pause stops the conductor **taking work**. It must not stop delivering
   * what already happened: a "waiting on you" comment sits in the outbox until
   * something sends it, and a pause is exactly when somebody most needs to read
   * one. Found by the 3f verification run, where a landed issue's close sat
   * queued behind a pause and the issue stayed open.
   */
  drain?: () => Promise<void>;
  /**
   * Told about every appended event, subscribed or not — it decides.
   *
   * On the loop's existing subscription rather than a second one: a notifier
   * with its own connection would be another session-mode connection held open
   * for the life of the daemon, for something that is already being read.
   */
  notify?: (event: import("@lingtai/core").Envelope) => Promise<void>;
  /**
   * How often to sweep for work nothing announced. `0` disables it, which is
   * what a test wants and what a machine with a reachable webhook can afford.
   */
  sweepMs?: number;
  /** Defaults to `COMPLETION_EVENTS`. */
  triggers?: readonly string[];
  /** Session-mode connection for the subscription. */
  url?: string;
  log?: (line: string) => void;
}

export interface WorkLoop {
  /** Runs the first pass and then follows the log. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Passes run so far. */
  readonly passes: number;
}

export function createWorkLoop(options: WorkLoopOptions): WorkLoop {
  const log = options.log ?? (() => {});
  const triggers = new Set<string>(options.triggers ?? COMPLETION_EVENTS);

  let subscription: Subscription | null = null;
  let sweep: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let again = false;
  let stopped = false;
  let passes = 0;

  async function pump(reason: PassReason): Promise<void> {
    if (running) {
      // A pass is in flight. Remember to go round again rather than starting a
      // second one into the same queue.
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        if (stopped) break;
        // Asked before every pass, not cached: a pause issued mid-run has to
        // take effect at the next opportunity, and the next opportunity is
        // here.
        if (await options.paused?.()) {
          log("paused — taking no work");
          // Effects still go out. See `drain`.
          await options.drain?.().catch((err: unknown) => {
            log(`outbox while paused: ${(err as Error).message}`);
          });
          break;
        }
        passes += 1;
        try {
          await options.pass(reason);
        } catch (err) {
          // A pass that throws must not take the loop with it: the next
          // completion event is exactly when you want it to try again.
          log(`pass failed: ${(err as Error).message}`);
        }
        reason = "completion";
      } while (again);
    } finally {
      running = false;
    }
  }

  return {
    get passes() {
      return passes;
    },

    async start() {
      // From the head, not from zero. Replaying history would fire a pass for
      // every task that has ever landed.
      const from = await headSeq(options.url);

      subscription = subscribe({
        fromSeq: from,
        name: "lingtai-daemon",
        ...(options.url === undefined ? {} : { url: options.url }),
        onEvent: (event) => {
          // Before the trigger check: the events worth interrupting somebody
          // for are mostly *not* the ones that wake the conductor. A task being
          // blocked is both; a run asking a question is only the first.
          void options.notify?.(event);
          if (!triggers.has(event.type)) return;
          void pump("completion");
        },
        onError: (error, phase) => log(`subscription ${phase}: ${String(error)}`),
      });

      // The cold start. Nothing is in flight, so nothing will tell us to begin.
      await pump("startup");

      const every = options.sweepMs ?? SWEEP_MS;
      if (every > 0) {
        sweep = setInterval(() => void pump("sweep"), every);
        // Never hold the process open on its own account. A daemon whose only
        // remaining reason to live is its own fallback timer is a daemon that
        // cannot exit.
        sweep.unref?.();
      }
    },

    async stop() {
      stopped = true;
      clearInterval(sweep);
      await subscription?.close().catch(() => {});
      subscription = null;
    },
  };
}

/**
 * The log's current end, so the subscription starts there rather than replaying.
 *
 * One query rather than paging the whole log: the answer is a single number and
 * walking a hundred thousand events to find it would make starting the daemon
 * slower the longer it has been useful.
 */
async function headSeq(url?: string): Promise<bigint> {
  const client = new pg.Client({ connectionString: url ?? directDatabaseUrl() });
  await client.connect();
  try {
    const r = await client.query<{ head: string }>("select coalesce(max(seq), 0)::text as head from events");
    return BigInt(r.rows[0]?.head ?? "0");
  } finally {
    await client.end();
  }
}
