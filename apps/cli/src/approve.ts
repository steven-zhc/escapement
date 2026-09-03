/**
 * `lingtai approve <project> --issue <n>` — merge what a held run actually produced.
 *
 * The counterpart to `lingtai run --once --no-merge`. Without it that flag is half a
 * feature: the only other way to finish a held run is to run it again without
 * the flag, which starts a new run with a new worktree and a new diff — so the
 * thing that merges is not the thing anyone looked at.
 */
import { approve as approveRun, loadProject } from "@lingtai/conductor";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient } from "@lingtai/github";
import { userInfo } from "node:os";

export interface ApproveCommandOptions {
  project: string;
  issue: number;
  note?: string;
  by?: string;
  /** Withdraws instead of granting. The item goes back to the gate. */
  reject?: string;
}

export async function approveCommand(
  options: ApproveCommandOptions,
  log = console.log,
): Promise<number> {
  if (!hasGitHubApp()) {
    log("no GitHub App configured — see doc/decisions/0006-github-app.md and .env.example");
    return 1;
  }

  const project = await loadProject(options.project);
  if (!project?.owner) {
    log(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`);
    return 1;
  }

  const client = await createGitHubClient({
    auth: githubApp(),
    owner: project.owner,
    repo: options.project,
  });

  const by = options.by ?? `human:${userInfo().username}`;

  if (options.reject !== undefined) {
    const { reject } = await import("@lingtai/conductor");
    const outcome = await reject({
      project: options.project,
      issue: options.issue,
      base: project.base ?? (await client.defaultBranch()),
      client,
      by,
      reason: options.reject,
      log,
    });
    log(outcome.detail);
    return outcome.ok ? 0 : 1;
  }

  const result = await approveRun({
    project: options.project,
    issue: options.issue,
    base: project.base ?? (await client.defaultBranch()),
    client,
    // An approval is never anonymous. The local account is a weak claim, but it
    // is a true one, and it is what a single-machine deployment has (0007).
    by,
    note: options.note,
    token: () => client.token(),
    log,
  });

  if (result.ok) {
    log(`landed ${result.mergeCommit.slice(0, 7)} — ${result.workItemId}`);
    return 0;
  }
  log(`did not merge (${result.reason}): ${result.detail}`);
  return 1;
}
