/**
 * Discovery: GitHub becomes an *input source*, not a database.
 *
 * This is the one place in the system that reads a GitHub label, and it reads
 * them exactly once per work item — to learn that the item exists, what kind of
 * work it is, and whether something else already owns it. After
 * `WorkItemDiscovered` lands, the log is the authority and no label is consulted
 * for state again. That inversion is the whole of
 * doc/decisions/0001-event-sourcing.md: #35 carried `agent:blocked` and
 * `agent:review` at the same time because `--add-label` is set union, not a
 * transition, and nothing could have noticed.
 *
 * Two exclusions, and the second is a Phase 1 safety rule rather than a
 * preference. `agent-loop.sh` is still working the same repository on an hourly
 * cycle, and the two systems must never both claim a ticket. An issue carrying
 * any `agent:*` label is one the old loop has touched, so Escapement does not
 * discover it at all.
 */
import type { Recipe } from "@escapement/config";
import { type WorkKind, WorkKind as WorkKindSchema, parsePayload } from "@escapement/core";
import type { GitHubClient, Issue } from "@escapement/github";
import { type EventStore, eventStore } from "@escapement/store";

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
 * Separated from the appending so `esc status` can explain a queue's *absences*,
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

export interface DiscoveryResult {
  discovered: string[];
  /** Every issue that was not discovered, with the reason. */
  skipped: { ref: number; reason: SkipReason }[];
}

export interface DiscoverOptions {
  project: string;
  client: GitHubClient;
  recipe: Recipe;
  store?: EventStore;
  /**
   * Restricts discovery to specific issue numbers.
   *
   * Phase 1 runs against issues nominated by number rather than against the
   * whole queue, because `agent-loop.sh` is still working the same repository.
   */
  only?: number[];
}

export async function discover(options: DiscoverOptions): Promise<DiscoveryResult> {
  const { project, client, recipe } = options;
  const store = options.store ?? eventStore;

  const issues = options.only
    ? await Promise.all(options.only.map((n) => client.getIssue(n)))
    : await client.listOpenIssues();

  const result: DiscoveryResult = { discovered: [], skipped: [] };

  for (const issue of issues) {
    const { skip } = considerIssue(issue, recipe);
    if (skip) {
      result.skipped.push({ ref: issue.number, reason: skip });
      continue;
    }

    const stream = workItemStream(project, issue.number);
    // Re-discovering is a no-op, not a duplicate event. The check is a read
    // rather than an upsert because a work item's stream is its identity: if it
    // has any history at all, it has been discovered.
    const existing = await store.read(stream);
    if (existing.length > 0) {
      result.skipped.push({ ref: issue.number, reason: "already-discovered" });
      continue;
    }

    await store.append(stream, 0, [
      {
        type: "WorkItemDiscovered",
        actor: "github",
        data: parsePayload("WorkItemDiscovered", {
          project,
          source: "github-issue",
          externalRef: String(issue.number),
          title: issue.title,
          kind: kindOf(issue),
          // The labels as they were at discovery, recorded because they are a
          // fact about that moment — never read back to decide anything.
          labels: issue.labels,
        }),
      },
    ]);
    result.discovered.push(stream);
  }

  return result;
}
