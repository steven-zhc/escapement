/**
 * Discovery: GitHub becomes an *input source*, not a database.
 *
 * This is the one place in the system that reads a GitHub label — to learn that
 * an item exists, what kind of work it is, and whether something else already
 * owns it. Once a task is claimed the log is the authority and no label is
 * consulted for state again.
 *
 * Since 0012 this appends nothing at all. The runnable set is written into
 * `task_view` and the queue is simply what GitHub currently says, minus what
 * the log says is claimed. That inversion is the whole of
 * doc/decisions/0001-event-sourcing.md: #35 carried `agent:blocked` and
 * `agent:review` at the same time because `--add-label` is set union, not a
 * transition, and nothing could have noticed.
 *
 * Two exclusions, and the second is a Phase 1 safety rule rather than a
 * preference. `agent-loop.sh` is still working the same repository on an hourly
 * cycle, and the two systems must never both claim a ticket. An issue carrying
 * any `agent:*` label is one the old loop has touched, so Lingtai does not
 * discover it at all.
 */
import type { Recipe } from "@lingtai/config";
import { type WorkKind, WorkKind as WorkKindSchema } from "@lingtai/core";
import type { GitHubClient, Issue } from "@lingtai/github";
import { syncQueued } from "./task-view.ts";

/** `wi-{project}-{n}`, the work item's own stream. */
export function workItemStream(project: string, externalRef: string | number): string {
  return `wi-${project}-${externalRef}`;
}

/**
 * The namespace the old loop writes its state into. Any label in it means that
 * issue is already owned by something else.
 */
export const FOREIGN_LABEL_PREFIX = "agent:";

const KINDS = new Set<string>(WorkKindSchema.options);

/**
 * Which kind of work an issue is, from its labels.
 *
 * Null when nothing says. That is not a defaulting opportunity: an issue nobody
 * has classified is not work the scheduler can prioritise, and guessing `bug`
 * would put unclassified issues at the front of the queue.
 */
export function kindOf(issue: Issue): WorkKind | null {
  for (const label of issue.labels) {
    const normalised = label.toLowerCase().replace(/\s+/g, "-");
    if (KINDS.has(normalised)) return normalised as WorkKind;
  }
  return null;
}

export type SkipReason =
  | "closed"
  | "no-kind"
  | "kind-not-wanted"
  | "excluded-label"
  | "owned-by-another-agent"
  | "already-discovered";

export interface Considered {
  issue: Issue;
  /** Null when the issue should be discovered. */
  skip: SkipReason | null;
}

/**
 * Whether an issue is eligible, and if not, why — without touching the log.
 *
 * Separated from the appending so `lingtai status` can explain a queue's *absences*,
 * which is the question the old loop's `pick_ticket` could never answer.
 */
export function considerIssue(issue: Issue, recipe: Recipe): Considered {
  if (issue.state === "closed") return { issue, skip: "closed" };

  const labels = issue.labels.map((l) => l.toLowerCase());

  if (labels.some((l) => l.startsWith(FOREIGN_LABEL_PREFIX))) {
    return { issue, skip: "owned-by-another-agent" };
  }
  const excluded = new Set(recipe.source.exclude.map((l) => l.toLowerCase()));
  if (labels.some((l) => excluded.has(l))) return { issue, skip: "excluded-label" };

  const kind = kindOf(issue);
  if (kind === null) return { issue, skip: "no-kind" };
  if (!recipe.source.kinds.includes(kind)) return { issue, skip: "kind-not-wanted" };

  return { issue, skip: null };
}

export interface QueueRefresh {
  /** Issues GitHub lists that the recipe will take. */
  runnable: { ref: string; title: string; kind: string }[];
  /** Every issue that was not runnable, with the reason. */
  skipped: { ref: number; reason: SkipReason }[];
}

export interface RefreshQueueOptions {
  project: string;
  client: GitHubClient;
  recipe: Recipe;
  /** Restricts the refresh to specific issue numbers. */
  only?: number[];
  /** Injectable so a test does not need a database. */
  sync?: typeof syncQueued;
}

/**
 * Ask GitHub what is runnable and write it into `task_view`.
 *
 * **Nothing is appended.** Which issues exist is GitHub's state, not
 * Lingtai's, and mirroring it into an append-only log meant one event per
 * issue per pass to reproduce a fact that GitHub answers correctly on request
 * ([0012](../../../doc/decisions/0012-one-task-view.md)). What Lingtai
 * decides — which one it claimed — is still an event, and still the whole of
 * the mutual exclusion.
 *
 * The conductor calls this, never the board. A board that asked GitHub per
 * render would exhaust the rate limit with a few tabs open and an event stream
 * refreshing them; going through the projection means the board keeps reading
 * one table and this stays the only caller that needs a token.
 */
export async function refreshQueue(options: RefreshQueueOptions): Promise<QueueRefresh> {
  const { project, client, recipe } = options;

  const issues = options.only
    ? await Promise.all(options.only.map((n) => client.getIssue(n)))
    : await client.listOpenIssues();

  const result: QueueRefresh = { runnable: [], skipped: [] };

  for (const issue of issues) {
    const { skip } = considerIssue(issue, recipe);
    if (skip) {
      result.skipped.push({ ref: issue.number, reason: skip });
      continue;
    }
    result.runnable.push({
      ref: String(issue.number),
      title: issue.title,
      // `considerIssue` already refused a null kind, so this is a string.
      kind: kindOf(issue)!,
    });
  }

  // A partial refresh must not delete the rest of the queue: `only` means "look
  // at these", not "these are all there is".
  if (!options.only) await (options.sync ?? syncQueued)(project, result.runnable);

  return result;
}
