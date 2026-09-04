/**
 * The `end` point, resolved against the outcome a work item actually reached.
 *
 * `end` is the one point that cannot refuse: its actions run for effect. They
 * are declared in a recipe and carried out by the outbox, and the outbox is a
 * *projection* — it may read the log and nothing else. So the plan has to cross
 * that line as an event, which is what `EndActionsResolved` is for.
 *
 * ## Why this is its own file
 *
 * It used to be a private function in `run-once.ts`, with one call site: the
 * line where that same run merged the branch. Everything that landed by any
 * other route — `lingtai approve`, the board's approve button — integrated,
 * appended `WorkItemLanded`, and stopped. The point was configured, the log
 * said so in `GatesResolved`, and it silently did not run. That is exactly the
 * half of the responsibility [ADR 0016](../../../doc/decisions/0016-the-settled-model.md)
 * §4 calls Lingtai's bug, and it went unnoticed for as long as it did because
 * every item that had ever landed had landed inline.
 *
 * A point that fires on *any* terminal outcome cannot live on one of the paths
 * that reaches one. It lives here, and every path calls it.
 *
 * ## An empty resolution is still a resolution
 *
 * When a recipe declares `end` actions and none of them match the outcome, this
 * appends the event anyway, with an empty list. That reverses the original
 * decision — "an empty list would be a row saying no effects, which is the same
 * as no row and costs a write" — and the reason is the distinction the whole
 * model rests on: *nothing was configured* and *something was configured and
 * did not run* must not look the same from the log. With no row, an item that
 * landed under a recipe whose only `end` action was `when: blocked` is
 * indistinguishable from one whose `end` point was never reached, and the
 * comparison [ADR 0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md)
 * promised — `GatesResolved` says `end` had actions, the item landed, nothing
 * resolved — cannot be computed without guessing.
 *
 * A project that configures no `end` at all still writes nothing. There the
 * skip is the user's decision, and `GatesResolved` already records it.
 */
import type { GateAction } from "@lingtai/config";
import { type Envelope, type PayloadOf, type ToAppend, parsePayload } from "@lingtai/core";
import { databaseUrl } from "@lingtai/env";
import type { EventStore } from "@lingtai/store";
import pg from "pg";

/**
 * The outcomes `end` fires on. The recipe's `when:` is one of these or `any`.
 *
 * `failed` is a run that ended without a diff worth merging and put the item
 * back in the queue; `blocked` is a question a person now holds, including the
 * hold that `--no-merge` and the human gate produce.
 */
export type TerminalOutcome = "landed" | "blocked" | "failed";

/**
 * The event the `end` point resolves to, or nothing.
 *
 * Pure, and takes the work item's stream rather than a store, so a caller can
 * fold it into the very append that records the outcome:
 *
 * ```ts
 * const item = await store.read(workItemId);
 * await store.append(workItemId, item.length, [
 *   { type: "WorkItemLanded", ... },
 *   ...resolveEndActions(item, recipe.gates.end, "landed"),
 * ]);
 * ```
 *
 * One transaction, so the outcome and its resolution cannot come apart — a
 * crash between two appends is the shape of failure this system exists to make
 * impossible, and the version check that guards the outcome guards both.
 *
 * **It resolves once per outcome**, and the item's own stream is where that is
 * checked. An item that was blocked, unblocked and then landed resolves `end`
 * twice, for two different outcomes, which is correct: those are two different
 * things to have done to an issue. Reaching the same outcome twice appends
 * nothing the second time.
 */
export function resolveEndActions(
  events: readonly Envelope[],
  actions: readonly GateAction[],
  outcome: TerminalOutcome,
): ToAppend[] {
  // Nothing declared is not this point's business: the skip is the user's
  // decision, and `GatesResolved` already says the point was empty.
  if (actions.length === 0) return [];

  const already = events.some(
    (e) =>
      e.type === "EndActionsResolved" &&
      (e.data as PayloadOf<"EndActionsResolved">).outcome === outcome,
  );
  if (already) return [];

  type Resolved = { name: string; close: true } | { name: string; labels: string[] };
  const resolved: Resolved[] = [];
  for (const a of actions) {
    // `when` is only on the two kinds that run for effect. Anything else at
    // `end` is a misconfiguration the recipe cannot express a verdict for, and
    // skipping it here is what the pipeline does with it too.
    if (!("when" in a)) continue;
    if (a.when !== outcome && a.when !== "any") continue;
    resolved.push("close" in a ? { name: a.name, close: true } : { name: a.name, labels: a.labels });
  }

  return [
    {
      type: "EndActionsResolved",
      actor: "conductor",
      data: parsePayload("EndActionsResolved", { outcome, actions: resolved }),
    },
  ];
}

/**
 * The same thing, on its own append.
 *
 * For the one caller that cannot batch: a release is appended by
 * `releaseWorkItem`, which owns its own read and version. Everything else
 * should use `resolveEndActions` and keep the two facts in one transaction.
 */
export async function appendEndActions(
  store: EventStore,
  workItemId: string,
  actions: readonly GateAction[],
  outcome: TerminalOutcome,
): Promise<void> {
  if (actions.length === 0) return;
  const events = await store.read(workItemId);
  const toAppend = resolveEndActions(events, actions, outcome);
  if (toAppend.length === 0) return;
  await store.append(workItemId, events.length, toAppend);
}

// ------------------------------------------------------- what did not run ----

/** A work item that landed with a plan at `end` and no record of it running. */
export interface UnresolvedEnd {
  workItemId: string;
  project: string;
  issue: number;
}

/**
 * `wi-lingtai-52` → the project and the issue.
 *
 * The last hyphen, which is what keeps a project name containing one intact.
 * Safe because the same code writes the id — `workItemStream` in `discover.ts`.
 */
function splitWorkItem(streamId: string): { project: string; issue: number } | null {
  const body = streamId.startsWith("wi-") ? streamId.slice(3) : streamId;
  const cut = body.lastIndexOf("-");
  if (cut < 0) return null;
  const issue = Number(body.slice(cut + 1));
  if (!Number.isInteger(issue)) return null;
  return { project: body.slice(0, cut), issue };
}

/**
 * Every item that landed whose `end` point was configured and did not run.
 *
 * **The comparison [0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md)
 * promised, computed from the log alone.** `GatesResolved` names all five
 * points and the actions planned for each, so "the recipe asked for something
 * at `end`" is a fact in the log rather than in a recipe that may have changed
 * since; `EndActionsResolved` on the item's own stream is the record that the
 * point ran. An item with the first and not the second is a gate that was
 * configured and did not run, which
 * [0016](../../../doc/decisions/0016-the-settled-model.md) §4 calls Lingtai's
 * bug rather than the operator's.
 *
 * Read by `lingtai doctor`, which reports it, and by `lingtai end replay`,
 * which repairs it by appending what should have been appended at the time.
 */
export async function landedWithoutEndActions(url = databaseUrl()): Promise<UnresolvedEnd[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query<{ stream_id: string }>(
      `with landed as (
         select distinct stream_id from events where type = 'WorkItemLanded'
       ),
       planned as (
         select distinct started.data->>'workItemId' as work_item
         from events started
         join events plan
           on plan.stream_id = started.stream_id and plan.type = 'GatesResolved'
         where started.type = 'RunStarted'
           and exists (
             select 1 from jsonb_array_elements(plan.data->'points') point
             where point->>'gate' = 'end' and jsonb_array_length(point->'actions') > 0
           )
       )
       select landed.stream_id
       from landed
       join planned on planned.work_item = landed.stream_id
       where not exists (
         select 1 from events resolved
         where resolved.stream_id = landed.stream_id
           and resolved.type = 'EndActionsResolved'
       )
       order by landed.stream_id`,
    );
    return r.rows.flatMap((row) => {
      const split = splitWorkItem(row.stream_id);
      return split === null ? [] : [{ workItemId: row.stream_id, ...split }];
    });
  } finally {
    await client.end();
  }
}
