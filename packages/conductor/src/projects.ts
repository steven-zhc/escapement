/**
 * The registered projects, read from the log.
 *
 * There is no `projects` table: a handful of projects, each with a handful of
 * events, is a stream to fold rather than a projection to maintain. If that ever
 * stops being true it becomes one, which costs a truncate and a replay.
 */
import { type ResolvedRecipe, resolveRecipe } from "@lingtai/config";
import { type ProjectState, isRegistered, reduceProject } from "@lingtai/core";
import { databaseUrl } from "@lingtai/env";
import type { GitHubClient } from "@lingtai/github";
import { type EventStore, eventStore } from "@lingtai/store";
import pg from "pg";

export const PROJECT_STREAM_PREFIX = "prj-";

export function projectStream(project: string): string {
  return `${PROJECT_STREAM_PREFIX}${project}`;
}

/** Every project stream that has ever been written to. */
export async function listProjectStreams(url = databaseUrl()): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query<{ stream_id: string }>(
      "select distinct stream_id from events where stream_id like $1 order by stream_id",
      [`${PROJECT_STREAM_PREFIX}%`],
    );
    return r.rows.map((x) => x.stream_id);
  } finally {
    await client.end();
  }
}

export async function loadProject(
  project: string,
  store: EventStore = eventStore,
): Promise<ProjectState | null> {
  const events = await store.read(projectStream(project));
  if (events.length === 0) return null;
  const state = reduceProject(events);
  return isRegistered(state) ? state : null;
}

export async function loadProjects(store: EventStore = eventStore): Promise<ProjectState[]> {
  const streams = await listProjectStreams();
  const states = await Promise.all(streams.map((s) => store.read(s).then(reduceProject)));
  return states.filter(isRegistered);
}


/**
 * The recipe governing this project's next run.
 *
 * Read from `origin/<base>` every time rather than from anything stored: a
 * snapshot in Lingtai's database would be a second source of truth, and the
 * repository's copy is the one its own commits change.
 */
export async function currentRecipe(
  state: ProjectState,
  client: GitHubClient,
  base?: string,
): Promise<ResolvedRecipe> {
  // Recorded base first; GitHub's default branch only when a project predates
  // it being recorded.
  const ref = base ?? state.base ?? (await client.defaultBranch());
  return resolveRecipe((path, r) => client.fileAt(path, r), ref);
}
