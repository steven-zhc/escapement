/**
 * The Integration aggregate: `int-{project}-{base}`, one per base branch,
 * forever. It is the serialisation point — never two integrations against one
 * base at once.
 *
 * This is the aggregate that exists because of a specific, expensive silence.
 * The old loop's `integrate()` had six `return 1` paths, and not one of them
 * emitted a log line, a comment or a label. #58 and #59 re-ran five times for
 * roughly $29 while the actual cause — a dirty checkout of `main` on the
 * operator's own machine — was never reported by anything.
 *
 * So every refusal here is typed and counted. `refusalsByReason` is the query
 * that could not be written before: *why does this project fail to merge?*
 */
import type { Envelope } from "./envelope.ts";
import type { PayloadOf, RefusalReason } from "./events.ts";

export type IntegrationLifecycle =
  | { status: "idle" }
  /** The lane is held. Anything else attempting this base is `lane-busy`. */
  | { status: "attempting"; workItemId: string; branch: string; headSha: string };

export type IntegrationStatus = IntegrationLifecycle["status"];

export interface Refusal {
  workItemId: string;
  branch: string;
  reason: RefusalReason;
  detail: string;
}

export interface Landed {
  workItemId: string;
  branch: string;
  mergeCommit: string;
}

export interface IntegrationState {
  lifecycle: IntegrationLifecycle;

  /** Set by the first success; the lane's base branch. */
  base: string | null;

  attempts: number;
  /** Merges, oldest first. */
  landed: readonly Landed[];
  /** Refusals, oldest first — each one a `return 1` that used to be silent. */
  refusals: readonly Refusal[];
  /** The same, tallied. The answer to "why does this project fail to merge?" */
  refusalsByReason: Readonly<Partial<Record<RefusalReason, number>>>;

  version: number;
  lastSeq: bigint | null;
}

export const emptyIntegration: IntegrationState = {
  lifecycle: { status: "idle" },
  base: null,
  attempts: 0,
  landed: [],
  refusals: [],
  refusalsByReason: {},
  version: 0,
  lastSeq: null,
};

export function applyIntegration(state: IntegrationState, event: Envelope): IntegrationState {
  const at = { version: event.version, lastSeq: event.seq };

  switch (event.type) {
    case "IntegrationAttempted": {
      const d = event.data as PayloadOf<"IntegrationAttempted">;
      return {
        ...state,
        ...at,
        lifecycle: {
          status: "attempting",
          workItemId: d.workItemId,
          branch: d.branch,
          headSha: d.headSha,
        },
        attempts: state.attempts + 1,
      };
    }

    case "IntegrationRefused": {
      const d = event.data as PayloadOf<"IntegrationRefused">;
      return {
        ...state,
        ...at,
        // The lane is released. A refusal that left it held would turn one bad
        // merge into a permanently stuck base branch.
        lifecycle: { status: "idle" },
        refusals: [...state.refusals, d],
        refusalsByReason: {
          ...state.refusalsByReason,
          [d.reason]: (state.refusalsByReason[d.reason] ?? 0) + 1,
        },
      };
    }

    case "IntegrationSucceeded": {
      const d = event.data as PayloadOf<"IntegrationSucceeded">;
      return {
        ...state,
        ...at,
        lifecycle: { status: "idle" },
        base: d.base,
        landed: [
          ...state.landed,
          { workItemId: d.workItemId, branch: d.branch, mergeCommit: d.mergeCommit },
        ],
      };
    }

    default:
      // See the note in work-item.ts: ignored, not rejected.
      return { ...state, ...at };
  }
}

export function reduceIntegration(events: readonly Envelope[]): IntegrationState {
  return events.reduce(applyIntegration, emptyIntegration);
}

/** Whether a new attempt on this lane would be refused as `lane-busy`. */
export function laneIsBusy(state: IntegrationState): boolean {
  return state.lifecycle.status === "attempting";
}
