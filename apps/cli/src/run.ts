/**
 * `esc run --once <project> --issue <n>` — Phase 1's whole shape.
 *
 * One nominated issue, discovery through merge, with a person watching. It is
 * deliberately not "take the queue": `agent-loop.sh` is still working the same
 * repository on an hourly cycle, and the two must never both claim a ticket.
 * Nominating by number is the safety rule, not a limitation of the plumbing.
 */
import { loadProject, runOnce } from "@escapement/conductor";
import { githubApp, hasGitHubApp } from "@escapement/env";
import { createGitHubClient } from "@escapement/github";
import { createClaudeCodeRuntime } from "@escapement/runtime";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface RunOptions {
  project: string;
  issue: number;
  /** Defaults to the compiled hook in `packages/hook/bin`. */
  hookBinary?: string;
  promptPath?: string;
}

export async function run(options: RunOptions, log = console.log): Promise<number> {
  if (!hasGitHubApp()) {
    log("no GitHub App configured — see doc/decisions/0006-github-app.md and .env.example");
    return 1;
  }

  const project = await loadProject(options.project);
  if (!project) {
    log(`no project named "${options.project}" — run esc add <owner>/<repo> first`);
    return 1;
  }
  if (!project.owner) {
    log(`${options.project} has no owner recorded — re-run esc add to record it`);
    return 1;
  }

  const hookBinary = options.hookBinary ?? resolve(root, "packages/hook/bin/esc-hook");
  try {
    await readFile(hookBinary);
  } catch {
    // The hook is a compiled artefact and is not committed. A run without it
    // would be a run with no guard at all, which must not start.
    log(`no esc-hook binary at ${hookBinary} — run: pnpm --filter @escapement/hook build`);
    return 1;
  }

  const promptPath = options.promptPath ?? resolve(root, "prompts/ticket.md");
  let prompt: string;
  try {
    prompt = await readFile(promptPath, "utf8");
  } catch {
    log(`no prompt at ${promptPath}`);
    return 1;
  }

  const client = await createGitHubClient({
    auth: githubApp(),
    owner: project.owner,
    repo: options.project,
  });

  const result = await runOnce({
    project,
    client,
    runtime: createClaudeCodeRuntime(),
    issue: options.issue,
    hookBinary,
    prompt: prompt.replace("{{issue}}", String(options.issue)),
    promptVersion: `ticket@${prompt.length}`,
    log,
  });

  if (result.ok) {
    log(`landed ${result.mergeCommit.slice(0, 7)} — ${result.workItemId}`);
    return 0;
  }
  // Every stage that can refuse names itself, so "why did nothing happen" has
  // an answer at the shell as well as on the board.
  log(`stopped at ${result.stage}: ${result.detail}`);
  return 1;
}
