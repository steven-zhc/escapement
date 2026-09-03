/**
 * Claiming a work item.
 *
 * This replaces `.runtime/loop.lock.d`, a directory the old loop created to hold
 * a lock and which leaked after every `kill -9` — recovering meant noticing and
 * running `rm -rf` by hand. There is nothing to unwind here, and that is not a
 * tidier implementation of the same idea but a different one:
 *
 *   - **The claim is an append at an expected version.** `UNIQUE (stream_id,
 *     version)` decides the race. The loser gets a `ConcurrencyError`, re-reads,
 *     and finds the item already held. No lock table, no lock file.
 *   - **The absence of a heartbeat is the expiry.** A lease is a timestamp
 *     inside an event. A process that dies holding one leaves an event that
 *     stops being true, which needs no cleanup because nothing was allocated.
 *
 * A crash therefore costs a wait, not an intervention.
 */
import { ConcurrencyError, type EventStore, eventStore } from "@lingtai/store";
import { parsePayload, reduceWorkItem } from "@lingtai/core";

/** Long enough to outlive a slow gate, short enough that a crash is not an outage. */
export const DEFAULT_LEASE_MS = 30 * 60_000;

export interface ClaimOptions {
  runId: string;
  /** Who holds it — host and pid, so a stuck lease can be traced to a process. */
  worker?: string;
  /**
   * What the task is, if the caller knows.
   *
   * Recorded on the claim because the queue left the log (0012): this is now
   * the only place a title enters it, and without one a rebuilt projection has
   * nothing to show for work that has already merged — GitHub only lists what
   * is still open. Null is honest when the caller genuinely does not know.
   */
  title?: string | null;
  kind?: string | null;
  leaseMs?: number;
  store?: EventStore;
  now?: () => number;
}

export interface Claim {
  workItemId: string;
  runId: string;
  worker: string;
  leaseUntilMs: number;
  /** The stream version the claim landed at; the next append expects this. */
  version: number;
}

export type ClaimRefusal =
  /** Someone else holds a lease that has not expired. */
  | { reason: "held"; by: string; runId: string; expiresInMs: number }
  /** Another claimant won the append. Re-read and look again. */
  | { reason: "lost-race" }
  /** Not in a state that can be claimed — landed, or blocked on a person. */
  | { reason: "not-claimable"; status: string };

export type ClaimResult = { ok: true; claim: Claim } | { ok: false; refusal: ClaimRefusal };

function defaultWorker(): string {
  return `${process.env["HOSTNAME"] ?? "local"}:${process.pid}`;
}

/**
 * Takes the work item, or says why not.
 *
 * Never throws on a lost race: losing is an ordinary outcome of two schedulers
 * looking at the same queue, and a caller that has to catch an exception to
 * discover it will eventually forget to.
 */
export async function claimWorkItem(
  workItemId: string,
  options: ClaimOptions,
): Promise<ClaimResult> {
  const store = options.store ?? eventStore;
  const now = options.now ?? Date.now;
  const worker = options.worker ?? defaultWorker();
  const leaseUntilMs = now() + (options.leaseMs ?? DEFAULT_LEASE_MS);

  const events = await store.read(workItemId);
  const state = reduceWorkItem(events);

  if (state.lifecycle.status === "claimed") {
    const held = state.lifecycle;
    // An expired lease is not held. Nothing had to release it and nothing had to
    // notice — the timestamp simply stopped being in the future.
    if (held.leaseUntilMs > now()) {
      return {
        ok: false,
        refusal: {
          reason: "held",
          by: held.worker,
          runId: held.runId,
          expiresInMs: held.leaseUntilMs - now(),
        },
      };
    }
  } else if (state.lifecycle.status !== "backlog") {
    return { ok: false, refusal: { reason: "not-claimable", status: state.lifecycle.status } };
  }

  try {
    const [written] = await store.append(workItemId, state.version, [
      {
        type: "WorkItemClaimed",
        actor: "conductor",
        data: parsePayload("WorkItemClaimed", {
          runId: options.runId,
          worker,
          leaseUntilMs,
          title: options.title ?? null,
          kind: options.kind ?? null,
        }),
      },
    ]);
    return {
      ok: true,
      claim: { workItemId, runId: options.runId, worker, leaseUntilMs, version: written!.version },
    };
  } catch (err) {
    // The other claimant appended first. The constraint is the whole of the
    // mutual exclusion; this is what losing it looks like.
    if (err instanceof ConcurrencyError) return { ok: false, refusal: { reason: "lost-race" } };
    throw err;
  }
}

/** Hands the item back. A release is explicit; an expiry is not. */
export async function releaseWorkItem(
  workItemId: string,
  runId: string,
  reason: string,
  store: EventStore = eventStore,
): Promise<void> {
  const events = await store.read(workItemId);
  const state = reduceWorkItem(events);
  await store.append(workItemId, state.version, [
    { type: "WorkItemReleased", actor: "conductor", data: parsePayload("WorkItemReleased", { runId, reason }) },
  ]);
}
