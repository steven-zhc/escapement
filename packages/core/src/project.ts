/**
 * The Project aggregate: `prj-{project}`, alive as long as the project is
 * managed.
 *
 * It holds the two things that are Escapement's rather than the repository's:
 * the **policy**, which is what is not negotiable, and the last **resolved
 * configuration**, which is what the recipe came out as. The recipe itself is
 * not here — it lives in the managed repository and is re-read from
 * `origin/<base>` for every run, because a snapshot of it would be a second
 * source of truth (doc/decisions/0005-config-in-target-repo.md).
 *
 * A policy change is an event with a time and a reason, so "did results change
 * after I tightened the gates?" is answerable by replay rather than by memory.
 */
import type { Envelope } from "./envelope.ts";
import type { PayloadOf, Tier } from "./events.ts";

export interface ProjectState {
  /** Null until the first event; a stream can be read before it exists. */
  project: string | null;
  /**
   * The GitHub owner. Null for a project registered before `ProjectConfigured`
   * carried one — re-run `esc add` to record it.
   */
  owner: string | null;
  /**
   * The branch this project's recipe is read from and merged into. Null for a
   * project registered before it was recorded — re-run `esc add` to record it.
   */
  base: string | null;

  /** The last resolved recipe hash, and the commit it was resolved from. */
  configHash: string | null;
  fromSha: string | null;

  version: number;
  lastSeq: bigint | null;
}

export const emptyProject: ProjectState = {
  project: null,
  owner: null,
  base: null,
  configHash: null,
  fromSha: null,
  version: 0,
  lastSeq: null,
};

export function applyProject(state: ProjectState, event: Envelope): ProjectState {
  const at = { version: event.version, lastSeq: event.seq };

  switch (event.type) {

    case "ProjectConfigured": {
      const d = event.data as PayloadOf<"ProjectConfigured">;
      return {
        ...state,
        ...at,
        project: d.project,
        owner: d.owner ?? state.owner,
        base: d.base ?? state.base,
        configHash: d.configHash,
        fromSha: d.fromSha,
      };
    }

    default:
      // See the note in work-item.ts: ignored, not rejected.
      return { ...state, ...at };
  }
}

export function reduceProject(events: readonly Envelope[]): ProjectState {
  return events.reduce(applyProject, emptyProject);
}

/** Whether this stream has ever been configured. */
export function isRegistered(state: ProjectState): boolean {
  return state.project !== null && state.configHash !== null;
}
