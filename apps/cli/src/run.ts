/**
 * `esc run --once <project> --issue <n>` — Phase 1's whole shape.
 *
 * One nominated issue, discovery through merge, with a person watching. It is
 * deliberately not "take the queue": `agent-loop.sh` is still working the same
 * repository on an hourly cycle, and the two must never both claim a ticket.
 * Nominating by number is the safety rule, not a limitation of the plumbing.
 */
import { currentRecipe, loadProject, runOnce, runQueue } from "@escapement/conductor";
import { githubApp, hasGitHubApp } from "@escapement/env";
import { createGitHubClient } from "@escapement/github";
import { createClaudeCodeRuntime } from "@escapement/runtime";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface RunOptions {
  project: string;
  /**
   * One nominated issue. Undefined takes the queue instead, which is what
   * "consecutive" in Phase 2's exit criterion means: the conductor picked the
   * next one up, not a person typing another number.
   */
  issue?: number;
  /** Stop after this many. `--max 2` is the exit criterion. */
  max?: number;
  /** False for `--no-merge`: stop after the gates and ask before writing. */
  merge?: boolean;
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
    // The hook is a compiled artefact and is not committed. It refuses nothing
    // now (ADR 0016 §6) but carries every event a run produces, so a run
    // without it is a run that records nothing — which must not start. There is
    // no flag to skip this any more: there is nothing left to skip.
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

  const common = {
    project,
    client,
    runtime: createClaudeCodeRuntime(),
    // Both managed repositories are private. Without this every git command in
    // the run is an anonymous one, and the clone fails before anything else
    // gets a chance to. Passed as the client's token *function*, not a string:
    // an installation token lasts an hour and a run's wall limit is two.
    token: () => client.token(),
    merge: options.merge,
    hookBinary,
    promptVersion: `ticket@${prompt.length}`,
    log,
  };

  // ---- the queue -----------------------------------------------------------
  if (options.issue === undefined) {
    // The project's *state*, not its name — the recipe is resolved from the
    // base recorded at `esc add`.
    const resolved = await currentRecipe(project, client).catch(() => null);
    if (!resolved) {
      log(`could not read ${options.project}'s recipe — run esc doctor`);
      return 1;
    }

    const outcome = await runQueue({
      ...common,
      prompt,
      // The recipe's order, asked rather than stored: a project that reorders
      // its kinds must not need a projection rebuild.
      kinds: resolved.recipe.source.kinds,
      ...(options.max === undefined ? {} : { max: options.max }),
    });

    const landed = outcome.ran.filter((r) => r.ok === true).length;
    const held = outcome.ran.filter((r) => r.ok === "held").length;
    const stopped = outcome.ran.length - landed - held;
    log(`${outcome.ran.length} run(s): ${landed} landed, ${held} held, ${stopped} stopped (${outcome.stopped})`);
    // Exit 0 unless something actually went wrong. An empty queue is not a
    // failure, and neither is a bounded run reaching its bound.
    return stopped > 0 ? 1 : 0;
  }

  // ---- one nominated issue -------------------------------------------------
  const result = await runOnce({
    ...common,
    issue: options.issue,
    // The raw template. `runOnce` fetches the ticket and fills it in — it is
    // the only place that has the title and the body.
    prompt,
  });

  if (result.ok === true) {
    log(`landed ${result.mergeCommit.slice(0, 7)} — ${result.workItemId}`);
    return 0;
  }
  if (result.ok === "held") {
    // Exit 0: holding is what was asked for, and a non-zero code here would
    // teach a person to ignore it.
    log(`held at ${result.headSha.slice(0, 7)} — ${result.workItemId} is waiting on you`);
    log(`nothing was merged. Re-run without --no-merge to merge it.`);
    return 0;
  }
  // Every stage that can refuse names itself, so "why did nothing happen" has
  // an answer at the shell as well as on the board.
  log(`stopped at ${result.stage}: ${result.detail}`);
  return 1;
}
