/**
 * The prepare stage: make the worktree workable, or refuse before spending
 * anything.
 *
 * `git worktree add` copies no `node_modules`. Every run before this existed
 * handed the agent a checkout where `pnpm test` did not work, so the agent could
 * not reproduce the bug it was sent to fix, could not check its own edit, and
 * found out nothing was right only when a gate failed at the very end — after
 * the whole cost of the run. The old harness burned roughly $29 re-running two
 * tickets against an environment that could not build.
 *
 * So the rule here is the same one the integrator has, for the same reason:
 * **failing costs nothing if you fail before starting the agent.**
 *
 * Two things this deliberately is not.
 *
 * **It is not a gate.** A gate produces a verdict about a commit, bound to
 * `onSha`, and a force-push invalidates it by arithmetic. A prepare step runs
 * before the agent has written anything; it holds no verdict about any commit,
 * and giving it an `onSha` would be giving it a lie. It shares the *runner* with
 * the process gate and nothing else.
 *
 * **It does not emit `RunFailed`.** A run whose install refused is not a run
 * that failed — it is a run that never began. Recording it as a failure would
 * put "the agent broke it" on a card where no agent ever ran, which is the exact
 * category of thing this system exists to stop doing.
 */
import { parseDuration, type Recipe } from "@escapement/config";
import { parsePayload } from "@escapement/core";
import { runCommand } from "@escapement/gates";
import type { EventStore } from "@escapement/store";

export interface PrepareOptions {
  runId: string;
  /** On the first event, so the board can find the card before `RunStarted`. */
  workItemId: string;
  /** The worktree. Steps run where the agent will work, never anywhere else. */
  cwd: string;
  /** Filtered, exactly as the agent's will be. */
  env: Record<string, string>;
  steps: Recipe["prepare"];
  store: EventStore;
  /** The run stream's version before this stage. Prepare appends from here. */
  at: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export type PrepareResult =
  | { ok: true; version: number }
  | { ok: false; version: number; step: string; detail: string; timedOut: boolean };

/**
 * Runs the steps in recipe order, stopping at the first refusal.
 *
 * Stopping is not an optimisation. Running the rest after one has already failed
 * produces a cascade of secondary failures whose only effect is to bury the one
 * that mattered — the second command fails *because* the first did, and a person
 * reading the card has to work out which.
 *
 * Returns the stream version it reached so the caller can append `RunStarted`
 * without re-reading. Before this stage existed, `RunStarted` was appended at
 * version 0 because nothing could precede it. That is no longer true.
 */
export async function prepareWorktree(options: PrepareOptions): Promise<PrepareResult> {
  const log = options.log ?? (() => {});
  let version = options.at;

  const append = async (type: "PreparationStarted" | "PreparationPassed" | "PreparationFailed", data: unknown) => {
    await options.store.append(options.runId, version, [
      { type, actor: "conductor", data: parsePayload(type, data) },
    ]);
    version += 1;
  };

  for (const step of options.steps) {
    await append("PreparationStarted", {
      workItemId: options.workItemId,
      step: step.name,
      run: step.run,
    });
    log(`prepare: ${step.name}`);

    const outcome = await runCommand({
      run: step.run,
      timeoutMs: parseDuration(step.timeout),
      timeoutLabel: step.timeout,
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
    });

    if (!outcome.ok) {
      await append("PreparationFailed", {
        step: step.name,
        evidence: outcome.evidence,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
      });
      log(`prepare: ${step.name} ${outcome.timedOut ? "timed out" : "refused"} — the agent will not start`);
      return {
        ok: false,
        version,
        step: step.name,
        detail: outcome.evidence,
        timedOut: outcome.timedOut,
      };
    }

    await append("PreparationPassed", { step: step.name, durationMs: outcome.durationMs });
    log(`prepare: ${step.name} ok in ${(outcome.durationMs / 1000).toFixed(1)}s`);
  }

  return { ok: true, version };
}
