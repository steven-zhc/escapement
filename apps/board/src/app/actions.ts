"use server";

/**
 * The three things a person can do from the board.
 *
 * This is the ticket the whole project is a bet on. The old review queue
 * reached 45 items growing at 14 a day against zero processed, and the reason
 * was not that nobody cared — it was that working an item meant leaving the
 * tool, finding the branch, reading the diff somewhere else, and coming back.
 * If these three actions ship and that number does not move, the bottleneck was
 * never tooling, which is worth knowing.
 *
 * Each one appends an event and nothing else. There is no board-specific state
 * and no second write path: `approve` here is the same `approve` that
 * `esc approve` calls, which is what stops the two from drifting into two
 * systems that disagree about what happened.
 *
 * **Every action carries the sha the card was showing.** A person approves a
 * diff, not a ticket, and between the card rendering and the click the branch
 * can move. The server compares and refuses rather than acting on something
 * nobody looked at — the same reason `onSha` exists on every verdict.
 */
// Subpaths, not the barrel. The root export pulls in `run-once`, which pulls
// in the gates and the runtime, which the board has no business compiling —
// the same reason `./board` and `./projects` exist.
import { approve, reject, waive } from "@escapement/conductor/decide";
import { loadProject } from "@escapement/conductor/projects";
import { git, stateDir } from "@escapement/conductor/worktree";
import { githubApp, hasGitHubApp } from "@escapement/env";
import { createGitHubClient } from "@escapement/github";
import { revalidatePath } from "next/cache";
// A "use server" module may only export async functions, so the shapes and the
// limit live next door.
import { DIFF_FILE_LIMIT, type ActionResult, type DiffFile, type DiffResult } from "@/lib/diff";
import { userInfo } from "node:os";

/**
 * Who is acting.
 *
 * The local account, because the board runs on one machine for one person
 * (0007). A weak claim, but a true one, and an approval that recorded nobody
 * would be the silent waiver this system exists to remove.
 */
function actor(): string {
  return `human:${userInfo().username}`;
}

async function project(name: string) {
  const state = await loadProject(name);
  if (!state?.owner) throw new Error(`no project named "${name}" — run esc add first`);
  return state;
}

export async function approveCard(input: {
  project: string;
  issue: number;
  onSha: string;
  note?: string;
}): Promise<ActionResult> {
  try {
    if (!hasGitHubApp()) return { ok: false, detail: "no GitHub App configured" };
    const state = await project(input.project);
    const client = await createGitHubClient({
      auth: githubApp(),
      owner: state.owner!,
      repo: input.project,
    });

    const result = await approve({
      project: input.project,
      issue: input.issue,
      base: state.base ?? (await client.defaultBranch()),
      client,
      by: actor(),
      approvers: state.approvers,
      // What the card was showing. Checked server-side against what the run is
      // actually asking about, so a click on a stale card refuses instead of
      // approving a diff nobody read.
      onSha: input.onSha,
      note: input.note,
      token: () => client.token(),
    });

    revalidatePath("/");
    return result.ok
      ? { ok: true, detail: `landed ${result.mergeCommit.slice(0, 7)}` }
      : { ok: false, detail: `${result.reason}: ${result.detail}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export async function rejectCard(input: {
  project: string;
  issue: number;
  onSha: string;
  reason: string;
}): Promise<ActionResult> {
  try {
    if (!input.reason.trim()) return { ok: false, detail: "a rejection needs a reason" };
    const state = await project(input.project);
    const client = await createGitHubClient({
      auth: githubApp(),
      owner: state.owner!,
      repo: input.project,
    });

    const result = await reject({
      project: input.project,
      issue: input.issue,
      base: state.base ?? (await client.defaultBranch()),
      client,
      by: actor(),
      approvers: state.approvers,
      onSha: input.onSha,
      reason: input.reason,
    });

    revalidatePath("/");
    return { ok: result.ok, detail: result.detail };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

export async function waiveGate(input: {
  project: string;
  issue: number;
  gate: string;
  onSha: string;
  reason: string;
}): Promise<ActionResult> {
  try {
    const state = await project(input.project);
    const result = await waive({
      project: input.project,
      issue: input.issue,
      gate: input.gate,
      by: actor(),
      approvers: state.approvers,
      reason: input.reason,
      // Checked server-side: the branch may have moved since the card rendered.
      onSha: input.onSha,
    });

    revalidatePath("/");
    return { ok: result.ok, detail: result.detail };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * The diff, read from Escapement's own mirror.
 *
 * On demand rather than in the projection: a diff can be megabytes, projections
 * are rebuilt by replaying everything, and a card that is never expanded should
 * cost nothing. The mirror is already on this machine — the conductor cloned it
 * — so this is a local `git diff`, not a network call.
 *
 * Split per file here, on the server, because the alternative is shipping one
 * giant string and making the browser parse it on the main thread.
 */
export async function loadDiff(input: {
  project: string;
  baseSha: string;
  headSha: string;
}): Promise<DiffResult> {
  try {
    const mirror = `${stateDir()}/repos/${input.project}.git`;
    const raw = await git(["diff", `${input.baseSha}...${input.headSha}`], { cwd: mirror });

    const files: DiffFile[] = [];
    let current: DiffFile | null = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("diff --git ")) {
        // `diff --git a/x b/x` — the b-side is the path after a rename.
        const path = line.slice(line.lastIndexOf(" b/") + 3) || line.slice(11);
        current = { path, added: 0, removed: 0, lines: [] };
        files.push(current);
        continue;
      }
      if (!current) continue;
      current.lines.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
      if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
    }

    // Bounded, and honest about it. A run that changed 300 files is a work item
    // that was scoped too large, which the card says elsewhere.
    const truncated = files.length > DIFF_FILE_LIMIT;
    return { ok: true, files: files.slice(0, DIFF_FILE_LIMIT), truncated };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
