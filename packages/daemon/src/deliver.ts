/**
 * The worker that actually sends what the outbox queued.
 *
 * Kept apart from the projection for the same reason the conductor is kept out
 * of `@escapement/daemon`: deciding *what* to send is a fold over the log, and
 * sending it is I/O that can fail in ways a fold never can. The projection is
 * pure and replayable; this is neither, and the seam between them is where
 * "survives a crash" comes from.
 *
 * ## Every ending is appended
 *
 * A delivery that worked appends `OutboxDelivered`; one that did not appends
 * `OutboxFailed`. There is no third path, and that is deliberate — the old loop
 * called `gh` inline and a failed call left nothing behind at all, so
 * afterwards you could not tell "we never commented" from "we commented and it
 * did not help".
 *
 * ## Permanent means permanent
 *
 * A 404 on an issue somebody deleted, or a 422 on a label that does not exist,
 * will not start working. Retrying it forever is how a queue stops meaning
 * anything: the depth grows, everyone learns to ignore the number, and the one
 * genuine failure in there is invisible. Those are marked and stop.
 */
import { parsePayload } from "@escapement/core";
// The subpath, not the barrel. The board imports this package for one
// constant, and the barrel would drag the gate pipeline into its compilation —
// where `spawn`'s overloads resolve differently under the DOM lib.
import { type OutboxItem, pendingOutbox } from "@escapement/conductor/outbox";
import { type EventStore, eventStore } from "@escapement/store";

/** What the worker needs from GitHub. Narrow, so a test can supply it. */
export interface Deliverer {
  comment(project: string, issue: number, body: string): Promise<string>;
  setLabels(project: string, issue: number, labels: readonly string[]): Promise<void>;
  closeIssue(project: string, issue: number): Promise<void>;
}

export interface DeliverOptions {
  deliverer: Deliverer;
  store?: EventStore;
  now?: Date;
  limit?: number;
  log?: (line: string) => void;
}

export interface DeliverOutcome {
  delivered: number;
  failed: number;
}

/**
 * HTTP statuses that will not improve on their own.
 *
 * 404 — it is gone. 410 — it is gone and GitHub is being explicit. 422 — the
 * request is malformed for this resource, which the next identical request will
 * also be. Everything else, including 403 for a rate limit, is worth waiting on.
 */
const PERMANENT = new Set([404, 410, 422]);

function isPermanent(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return typeof status === "number" && PERMANENT.has(status);
}

export async function deliverOutbox(options: DeliverOptions): Promise<DeliverOutcome> {
  const log = options.log ?? (() => {});
  const store = options.store ?? eventStore;
  const outcome: DeliverOutcome = { delivered: 0, failed: 0 };

  const pending = await pendingOutbox({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  for (const item of pending) {
    try {
      const detail = await send(options.deliverer, item);
      await append(store, item, "OutboxDelivered", {
        ref: item.ref,
        kind: item.kind,
        target: item.target,
        detail,
      });
      outcome.delivered += 1;
      log(`delivered ${item.kind} → ${item.project}#${item.target}`);
    } catch (err) {
      const permanent = isPermanent(err);
      await append(store, item, "OutboxFailed", {
        ref: item.ref,
        kind: item.kind,
        target: item.target,
        error: (err as Error).message.slice(0, 400),
        permanent,
      });
      outcome.failed += 1;
      log(
        `${permanent ? "gave up on" : "will retry"} ${item.kind} → ${item.project}#${item.target}: ${(err as Error).message}`,
      );
    }
  }

  return outcome;
}

async function send(deliverer: Deliverer, item: OutboxItem): Promise<string> {
  const issue = Number(item.target);
  if (!Number.isInteger(issue)) throw new Error(`"${item.target}" is not an issue number`);

  if ("body" in item.payload) {
    return deliverer.comment(item.project, issue, item.payload.body);
  }
  // Discriminated on the payload's own shape rather than on `kind`, so a row
  // whose kind and payload disagree fails to compile rather than at runtime.
  if ("close" in item.payload) {
    await deliverer.closeIssue(item.project, issue);
    return "closed";
  }
  await deliverer.setLabels(item.project, issue, item.payload.labels);
  return item.payload.labels.join(",");
}

/**
 * Appends to the outbox item's own stream.
 *
 * Its own rather than the task's, so a repository that generates a lot of
 * chatter cannot bury a work item's history in delivery receipts — the two are
 * read for different reasons and by different things.
 */
async function append(
  store: EventStore,
  item: OutboxItem,
  type: string,
  data: unknown,
): Promise<void> {
  const stream = `ctl-outbox-${item.project}`;
  const at = (await store.read(stream)).length;
  await store.append(stream, at, [
    { type, actor: "conductor", data: parsePayload(type as never, data) },
  ]);
}
