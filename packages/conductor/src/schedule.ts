/**
 * Taking the queue, rather than one issue somebody named.
 *
 * This is the difference between "it worked" and "it works", and it is what
 * Phase 2's exit criterion means by **consecutive**: the second item was picked
 * up by the conductor, not by a person typing another number. One run proves
 * the pipeline. Two in a row prove there is nothing in it that only works once
 * — a lock not released, a worktree not removed, a checkpoint not advanced.
 *
 * The loop is small on purpose. design.md §8 refuses a general workflow engine,
 * and this is a `while` over a projection: discover, take the top runnable
 * item, run it, repeat.
 *
 * ## The trap
 *
 * `runOnce` **releases** a work item when a run fails, and a released item goes
 * straight back into the queue — that is what `WorkItemReleased` is for, and it
 * is right, because a run that died should not leave the ticket claimed
 * forever.
 *
 * The consequence is that the obvious loop is an infinite one. Take the top
 * item, fail, release, take the same top item, fail, release — spending an
 * agent's worth of money every pass, forever, on the same broken ticket. The
 * old loop had a version of this: it re-ran #58 and #59 five times for roughly
 * $29 because nothing remembered that the previous attempt had just failed.
 *
 * So a pass remembers what it has attempted and will not attempt it twice.
 * Deliberately in memory and not in the log: "this scheduler has already tried
 * this today" is a fact about *this pass*, not about the work item, and writing
 * it to an append-only log would make a restart inherit a grudge. A new pass
 * starts fresh, which is what you want after a fix.
 */
import type { GitHubClient } from "@escapement/github";
import type { Runtime } from "@escapement/runtime";
import type { EventStore } from "@escapement/store";
import type { ProjectState } from "@escapement/core";
import { readQueue } from "./queue.ts";
import { type RunOnceResult, runOnce } from "./run-once.ts";
import type { TokenSource } from "./worktree.ts";

export interface ScheduleOptions {
  project: ProjectState;
  client: GitHubClient;
  runtime: Runtime;
  hookBinary: string;
  prompt: string;
  promptVersion?: string;
  /** The recipe's priority order. Priority is asked, not stored — see `queue`. */
  kinds: readonly string[];
  /**
   * Stop after this many items. Undefined runs until the queue has nothing
   * runnable left.
   *
   * Phase 2's exit criterion is `max: 2`.
   */
  max?: number;
  /** False holds every item at the merge instead of landing it. */
  merge?: boolean;
  token?: TokenSource;
  home?: string;
  store?: EventStore;
  gitEnv?: NodeJS.ProcessEnv;
  remote?: string;
  /** Aborts between items. A run already in flight finishes. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export type StoppedBecause =
  /** Nothing runnable left. The good ending. */
  | "empty"
  /** `max` reached. Also the good ending, for a bounded run. */
  | "max"
  /** The caller asked. A run in flight was allowed to finish. */
  | "aborted"
  /**
   * Everything still in the queue has already been attempted in this pass.
   * Distinct from `empty` because the queue is *not* empty and saying so
   * matters: it means the passes after this one have work, and a caller that
   * treats it as "all done" would stop too early.
   */
  | "exhausted";

export interface ScheduleResult {
  ran: RunOnceResult[];
  stopped: StoppedBecause;
  /** Work items attempted in this pass, in order. */
  attempted: string[];
}

export async function runQueue(options: ScheduleOptions): Promise<ScheduleResult> {
  const log = options.log ?? (() => {});
  const ran: RunOnceResult[] = [];
  const attempted = new Set<string>();

  const finish = (stopped: StoppedBecause): ScheduleResult => {
    log(`stopped: ${stopped} — ${ran.length} run(s)`);
    return { ran, stopped, attempted: [...attempted] };
  };

  // Null for a project registered before the name was recorded. Refusing here
  // is better than reading an empty queue and reporting "nothing to do".
  const name = options.project.project;
  if (!name) throw new Error("this project has no name recorded — re-run esc add");

  for (;;) {
    if (options.signal?.aborted) return finish("aborted");
    if (options.max !== undefined && ran.length >= options.max) return finish("max");

    const queue = await readQueue(name, options.kinds as never);
    if (queue.length === 0) return finish("empty");

    const next = queue.find((entry) => !attempted.has(entry.workItemId));
    if (!next) {
      // The queue has items and every one of them has already been through this
      // pass. Retrying now would be the $29 loop.
      return finish("exhausted");
    }

    const issue = Number(next.externalRef);
    if (!Number.isInteger(issue)) {
      // A work item whose reference is not a number cannot be run by a path
      // that nominates issues by number. Marked attempted so the loop moves on
      // rather than seeing it at the top of the queue forever.
      attempted.add(next.workItemId);
      log(`skipping ${next.workItemId}: "${next.externalRef}" is not an issue number`);
      continue;
    }

    attempted.add(next.workItemId);
    log(`taking ${next.workItemId} — ${next.title}`);

    const result = await runOnce({
      project: options.project,
      client: options.client,
      runtime: options.runtime,
      issue,
      hookBinary: options.hookBinary,
      // Raw. `runOnce` has the ticket and does the substitution.
      prompt: options.prompt,
      ...(options.promptVersion === undefined ? {} : { promptVersion: options.promptVersion }),
      ...(options.merge === undefined ? {} : { merge: options.merge }),
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.gitEnv === undefined ? {} : { gitEnv: options.gitEnv }),
      ...(options.remote === undefined ? {} : { remote: options.remote }),
      log: options.log,
    });

    ran.push(result);

    // Every ending is reported, including the ones that are nobody's fault.
    // A scheduler that only logs successes is the old loop.
    if (result.ok === true) log(`landed ${result.mergeCommit.slice(0, 7)}`);
    else if (result.ok === "held") log(`held at ${result.gate}`);
    else log(`stopped at ${result.stage}: ${result.detail}`);
  }
}
