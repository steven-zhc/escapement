/**
 * `lingtai run --once <project> --issue <n>` — Phase 1's whole shape.
 *
 * One nominated issue, discovery through merge, with a person watching. It is
 * deliberately not "take the queue": `agent-loop.sh` is still working the same
 * repository on an hourly cycle, and the two must never both claim a ticket.
 * Nominating by number is the safety rule, not a limitation of the plumbing.
 */
import { currentRecipe, loadProject, runOnce, runQueue, tallyPass } from "@lingtai/conductor";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient } from "@lingtai/github";
import { createClaudeCodeRuntime } from "@lingtai/runtime";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catchUpProjections } from "./projections.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Leaves the board current on the way out.
 *
 * A run appends and returns; the follower lives in the daemon. Without this the
 * command writes a correct log and leaves `task_view` — the only thing the
 * board reads — exactly where it was, which is how nine runs went past with
 * nothing moving on screen and `lingtai projection lag` answering *no
 * projection has a checkpoint yet*.
 *
 * Reported and never fatal. The log is what is authoritative, and a board that
 * could not be advanced is a thing to say out loud rather than a reason to lose
 * the run's own answer. The next daemon catches up from the checkpoint anyway.
 */
async function advanceBoard(log: (line: string) => void): Promise<void> {
  try {
    const lags = await catchUpProjections();
    log(`board current — ${lags.map((l) => `${l.name} ${l.lastSeq}/${l.headSeq}`).join(", ")}`);
  } catch (err) {
    log(`could not advance the projections: ${(err as Error).message}`);
    log("the log is intact; the board is behind until a daemon runs — lingtai daemon --no-conduct");
  }
}

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
    log(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`);
    return 1;
  }
  if (!project.owner) {
    log(`${options.project} has no owner recorded — re-run lingtai add to record it`);
    return 1;
  }

  const hookBinary = options.hookBinary ?? resolve(root, "packages/hook/bin/lingtai-hook");
  try {
    await readFile(hookBinary);
  } catch {
    // The hook is a compiled artefact and is not committed. It refuses nothing
    // now (ADR 0016 §6) but carries every event a run produces, so a run
    // without it is a run that records nothing — which must not start. There is
    // no flag to skip this any more: there is nothing left to skip.
    log(`no lingtai-hook binary at ${hookBinary} — run: pnpm --filter @lingtai/hook build`);
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
    // base recorded at `lingtai add`.
    const resolved = await currentRecipe(project, client).catch(() => null);
    if (!resolved) {
      log(`could not read ${options.project}'s recipe — run lingtai doctor`);
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

    await advanceBoard(log);

    // Read back, not counted up. An item this pass held and somebody approved
    // while the pass carried on has landed, and the log says so — see
    // `tallyPass`. Counting the merges this process performed printed
    // `0 landed` over a merge that had happened, and exited 1 on the count.
    const { landed, held, stopped } = await tallyPass(outcome.ran);
    log(`${outcome.ran.length} run(s): ${landed} landed, ${held} held, ${stopped} stopped (${outcome.stopped})`);
    // Exit 0 unless something actually went wrong. An empty queue is not a
    // failure, neither is a bounded run reaching its bound, and neither is an
    // item waiting on a person.
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

  // One issue leaves the board just as blind as a queue does.
  await advanceBoard(log);

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
