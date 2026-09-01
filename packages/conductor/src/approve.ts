/**
 * Granting the approval a held run is waiting for, and merging what was
 * actually looked at.
 *
 * `--no-merge` on its own is half a feature. The obvious way to finish a held
 * run — run it again without the flag — starts a *new* run: a new worktree, the
 * agent again, and a different diff. The thing that merges is then not the thing
 * anyone approved, which defeats the entire point of stopping to look.
 *
 * So this takes the held run's own `headSha` and merges that. `onSha` does the
 * work it was designed for: the approval was recorded against a commit, and if
 * the branch has moved since, this refuses rather than merging something nobody
 * agreed to.
 *
 * This is a stopgap with a known shape. It is the CLI half of #21 — approve and
 * reject on the board — and when that lands the two must become one path rather
 * than two vocabularies for one idea. What is here is what makes `--no-merge`
 * mean something before then.
 */
import { parsePayload, reduceRun, reduceWorkItem } from "@escapement/core";
import type { GitHubClient } from "@escapement/github";
import { type EventStore, eventStore } from "@escapement/store";
import { workItemStream } from "./discover.ts";
import { integrate } from "./integrate.ts";
import type { TokenSource } from "./worktree.ts";

export interface ApproveOptions {
  project: string;
  issue: number;
  base: string;
  client: GitHubClient;
  /** Recorded on the approval. A waiver is never anonymous, and neither is this. */
  by: string;
  /**
   * Who may answer, from the project's **policy** — Escapement's own log, never
   * the managed repository. A recipe that could name its own approvers could
   * approve itself, which is the same hole as a recipe that could lower its own
   * containment tier.
   *
   * Empty means nobody has been named yet, and anyone may approve. That is the
   * state a project is in before someone decides, and refusing every approval
   * until then would make onboarding a chicken-and-egg problem.
   */
  approvers?: readonly string[];
  note?: string;
  /** Withdraws an approval instead of granting one. See `reject` below. */
  revoke?: { reason: string };
  token?: TokenSource;
  home?: string;
  gitEnv?: NodeJS.ProcessEnv;
  store?: EventStore;
  log?: (line: string) => void;
}

export type ApproveResult =
  | { ok: true; workItemId: string; runId: string; mergeCommit: string }
  | { ok: false; workItemId: string; reason: string; detail: string };

export async function approve(options: ApproveOptions): Promise<ApproveResult> {
  const store = options.store ?? eventStore;
  const log = options.log ?? (() => {});
  const workItemId = workItemStream(options.project, options.issue);

  const item = reduceWorkItem(await store.read(workItemId));
  const runId = item.runs[item.runs.length - 1];
  if (!runId) {
    return { ok: false, workItemId, reason: "no-run", detail: `${workItemId} has never been run` };
  }

  const run = reduceRun(await store.read(runId));
  if (run.lifecycle.status !== "awaiting-approval") {
    // Including "already merged". Saying which state it is in is more useful
    // than saying it is not the right one.
    return {
      ok: false,
      workItemId,
      reason: "not-awaiting-approval",
      detail: `${runId} is ${run.lifecycle.status}, not waiting for approval`,
    };
  }

  const { gate, onSha } = run.lifecycle;
  const branch = `agent/${options.issue}`;

  if (options.approvers && options.approvers.length > 0 && !options.approvers.includes(options.by)) {
    return {
      ok: false,
      workItemId,
      reason: "not-an-approver",
      detail: `${options.by} is not in this project's approvers (${options.approvers.join(", ")})`,
    };
  }

  // The check that makes the approval mean anything. A verdict is about a diff,
  // and between the hold and now someone may have pushed to this branch —
  // including the agent, on a re-run. Merging then would land something no
  // person ever looked at, which is exactly what the old label-based approval
  // did and why `onSha` exists.
  const remoteHead = await options.client.refSha(`heads/${branch}`).catch(() => null);
  if (remoteHead !== onSha) {
    return {
      ok: false,
      workItemId,
      reason: "stale",
      detail:
        `the approval is for ${onSha.slice(0, 7)} and ${branch} is now ` +
        `${remoteHead?.slice(0, 7) ?? "gone"}. Nothing was merged.`,
    };
  }

  await store.append(runId, run.version, [
    {
      type: "ApprovalGranted",
      // The approver *is* the actor. `by` is already `human:<id>`, which is the
      // shape the envelope demands, and recording it in both places keeps the
      // payload readable without the two ever disagreeing.
      actor: options.by,
      data: parsePayload("ApprovalGranted", {
        gate,
        runId,
        onSha,
        by: options.by,
        note: options.note ?? "",
      }),
    },
  ]);
  log(`approved ${onSha.slice(0, 7)} by ${options.by}`);

  const merged = await integrate({
    project: options.project,
    owner: options.client.owner,
    repo: options.client.repo,
    base: options.base,
    branch,
    workItemId,
    headSha: onSha,
    // The gates already ran and their verdicts are on the log against this same
    // sha. A person approving a red build is granting a waiver, and the log
    // shows both the failure and the approval rather than one hiding the other.
    gatesPassed: true,
    token: options.token,
    home: options.home,
    gitEnv: options.gitEnv,
    store,
  });

  if (!merged.ok) {
    const at = (await store.read(workItemId)).length;
    await store.append(workItemId, at, [
      {
        type: "WorkItemBlocked",
        actor: "conductor",
        data: parsePayload("WorkItemBlocked", {
          question: `${merged.reason}: ${merged.detail.slice(0, 500)}`,
          needsFrom: "human",
          runId,
        }),
      },
    ]);
    return { ok: false, workItemId, reason: merged.reason, detail: merged.detail };
  }

  const at = (await store.read(workItemId)).length;
  await store.append(workItemId, at, [
    {
      type: "WorkItemLanded",
      actor: "conductor",
      data: parsePayload("WorkItemLanded", { mergeCommit: merged.mergeCommit, base: options.base }),
    },
  ]);
  log(`landed ${merged.mergeCommit.slice(0, 7)} on ${options.base}`);
  return { ok: true, workItemId, runId, mergeCommit: merged.mergeCommit };
}

/**
 * Withdrawing an approval, or refusing to give one.
 *
 * The item goes **back to the gate**, not back to the queue. The question is
 * open again and the answer is still a person's; returning it to the queue
 * would let another run claim it and throw the question away.
 *
 * Nothing is merged and nothing is deleted. The branch stays where it is, and
 * the log carries both the request and the withdrawal — which is the whole
 * reason a rejection is an event rather than a label being removed.
 */
export async function reject(
  options: Omit<ApproveOptions, "revoke"> & { reason: string },
): Promise<{ ok: boolean; workItemId: string; detail: string }> {
  const store = options.store ?? eventStore;
  const workItemId = workItemStream(options.project, options.issue);

  const item = reduceWorkItem(await store.read(workItemId));
  const runId = item.runs[item.runs.length - 1];
  if (!runId) return { ok: false, workItemId, detail: `${workItemId} has never been run` };

  const run = reduceRun(await store.read(runId));
  if (run.lifecycle.status !== "awaiting-approval") {
    return {
      ok: false,
      workItemId,
      detail: `${runId} is ${run.lifecycle.status}, not waiting for approval`,
    };
  }

  if (options.approvers && options.approvers.length > 0 && !options.approvers.includes(options.by)) {
    return {
      ok: false,
      workItemId,
      detail: `${options.by} is not in this project's approvers`,
    };
  }

  const { gate, onSha } = run.lifecycle;
  await store.append(runId, run.version, [
    {
      type: "ApprovalRevoked",
      actor: options.by,
      data: parsePayload("ApprovalRevoked", { gate, runId, onSha, by: options.by, reason: options.reason }),
    },
  ]);

  return { ok: true, workItemId, detail: `${gate} on ${onSha.slice(0, 7)} was withdrawn by ${options.by}` };
}
