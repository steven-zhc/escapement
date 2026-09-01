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
import { githubApp, hasGitHubApp } from "@escapement/env";
import { createGitHubClient } from "@escapement/github";
import { revalidatePath } from "next/cache";
import { userInfo } from "node:os";

export interface ActionResult {
  ok: boolean;
  /** Always said back. A refusal the operator cannot read is a lie by omission. */
  detail: string;
}

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
