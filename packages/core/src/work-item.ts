/**
 * The WorkItem aggregate: `wi-{project}-{n}`, alive for weeks.
 *
 * The failure this replaces is specific. In the old loop a ticket's state was
 * the set of `agent:*` labels on its GitHub issue, and `--add-label` is set
 * union, not a transition — nothing forbade a contradictory pair and nothing
 * reconciled one. #35 carried `agent:blocked` **and** `agent:review` at the same
 * time, and no code was wrong; the model was.
 *
 * So `lifecycle` here is a discriminated union rather than a bag of flags. There
 * is no value of `WorkItemState` in which an item is both claimed and blocked,
 * because there is no way to write one down. The facts that outlive a
 * transition — title, labels, links — sit outside the union, where they belong.
 *
 * One thing this reducer deliberately cannot see: gates, approvals and merges.
 * Those are events on the Run and Integration streams, because a run emits
 * hundreds of events while a work item lives for weeks and one stream would make
 * every read expensive (design.md §4). The lifecycle drawn in design.md §4 spans
 * all three aggregates; assembling it is the board projection's job, not this
 * function's.
 */
import type { Envelope } from "./envelope.ts";
import type { PayloadOf, Tier, WorkKind } from "./events.ts";

export type WorkItemLifecycle =
  | { status: "backlog" }
  | { status: "claimed"; runId: string; worker: string; leaseUntilMs: number }
  | {
      status: "blocked";
      /** The question, not just the fact. `agent:blocked` carried no question. */
      question: string;
      needsFrom: "human" | "schema" | "external";
      runId: string | null;
    }
  | { status: "landed"; mergeCommit: string; base: string };

export type WorkItemStatus = WorkItemLifecycle["status"];

/** How this item is connected to another — a filed bug to the merge that caused it. */
export interface WorkItemLink {
  relation: "caused-by" | "follows-up" | "duplicates";
  otherRef: string;
}

export interface WorkItemState {
  lifecycle: WorkItemLifecycle;

  /** Null until `WorkItemDiscovered`; a stream can be read before it exists. */
  project: string | null;
  source: "github-issue" | "manual" | "agent-followup" | null;
  externalRef: string | null;
  title: string | null;
  kind: WorkKind | null;
  labels: readonly string[];

  links: readonly WorkItemLink[];

  /**
   * Every dispatch the scheduler refused, kept rather than counted. A tier is
   * never silently downgraded, so the refusals are the record of what could not
   * run and why.
   */
  dispatchRefusals: readonly { requiredTier: Tier; runtime: string; missing: readonly string[] }[];

  /** Runs that have held this item, oldest first. A re-run appends. */
  runs: readonly string[];

  /** Version of the last event applied — the `expectedVersion` for the next append. */
  version: number;
  /** Global position of the last event applied. */
  lastSeq: bigint | null;
}

export const emptyWorkItem: WorkItemState = {
  lifecycle: { status: "backlog" },
  project: null,
  source: null,
  externalRef: null,
  title: null,
  kind: null,
  labels: [],
  links: [],
  dispatchRefusals: [],
  runs: [],
  version: 0,
  lastSeq: null,
};

export function applyWorkItem(state: WorkItemState, event: Envelope): WorkItemState {
  const at = { version: event.version, lastSeq: event.seq };

  switch (event.type) {
    case "WorkItemDiscovered": {
      const d = event.data as PayloadOf<"WorkItemDiscovered">;
      return {
        ...state,
        ...at,
        project: d.project,
        source: d.source,
        externalRef: d.externalRef,
        title: d.title,
        kind: d.kind,
        labels: d.labels,
      };
    }

    case "WorkItemClaimed": {
      const d = event.data as PayloadOf<"WorkItemClaimed">;
      return {
        ...state,
        ...at,
        // Replaces whatever lifecycle was there. A claim while blocked is not an
        // error to represent — it is the unblock-and-retry path — and it cannot
        // leave the block behind, because the union has room for only one.
        lifecycle: {
          status: "claimed",
          runId: d.runId,
          worker: d.worker,
          leaseUntilMs: d.leaseUntilMs,
        },
        runs: state.runs.includes(d.runId) ? state.runs : [...state.runs, d.runId],
      };
    }

    case "WorkItemReleased":
      // A lease that expired needs no cleanup — the absence of a heartbeat *is*
      // the expiry — so a release is just a return to the queue.
      return { ...state, ...at, lifecycle: { status: "backlog" } };

    case "WorkItemBlocked": {
      const d = event.data as PayloadOf<"WorkItemBlocked">;
      return {
        ...state,
        ...at,
        lifecycle: {
          status: "blocked",
          question: d.question,
          needsFrom: d.needsFrom,
          runId: d.runId,
        },
      };
    }

    case "WorkItemUnblocked":
      return { ...state, ...at, lifecycle: { status: "backlog" } };

    case "WorkItemLinked": {
      const d = event.data as PayloadOf<"WorkItemLinked">;
      const already = state.links.some(
        (l) => l.relation === d.relation && l.otherRef === d.otherRef,
      );
      return { ...state, ...at, links: already ? state.links : [...state.links, d] };
    }

    case "WorkItemLanded": {
      const d = event.data as PayloadOf<"WorkItemLanded">;
      return {
        ...state,
        ...at,
        lifecycle: { status: "landed", mergeCommit: d.mergeCommit, base: d.base },
      };
    }

    case "DispatchRefused": {
      const d = event.data as PayloadOf<"DispatchRefused">;
      return { ...state, ...at, dispatchRefusals: [...state.dispatchRefusals, d] };
    }

    default:
      // Unknown to this build, or belonging to another aggregate. Ignored rather
      // than rejected: a projection compiled against an older catalogue has to
      // survive a newer conductor's events instead of wedging on the first one.
      //
      // Note where the real forward-compatibility boundary sits. `@escapement/store`
      // currently *throws* on an event type it does not recognise, so in practice
      // it refuses one before a reducer ever sees it. This tolerance is what
      // makes the reducer itself safe to reuse — over a replay, a fixture, or a
      // relaxed reader — not a claim that the whole pipeline is tolerant today.
      return { ...state, ...at };
  }
}

export function reduceWorkItem(events: readonly Envelope[]): WorkItemState {
  return events.reduce(applyWorkItem, emptyWorkItem);
}
