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
import type { GitHubClient } from "@lingtai/github";
import type { Runtime } from "@lingtai/runtime";
import { type EventStore, eventStore } from "@lingtai/store";
import { type ProjectState, reduceWorkItem } from "@lingtai/core";
import { readRunnable } from "./task-view.ts";
import { type RunOnceResult, runOnce } from "./run-once.ts";
import type { TokenSource } from "./worktree.ts";

export interface ScheduleOptions {
  project: ProjectState;
  client: GitHubClient;
  runtime: Runtime;
  hookBinary: string;
  /** False wires no hooks and skips the smoke test. See `RenderOptions.guard`. */
  guard?: boolean;
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
  | "exhausted"
  /**
   * A name the recipe requires has no value, so nothing in this project can
   * run ([ADR 0020](../../../doc/decisions/0020-the-agent-environment-in-layers.md)).
   *
   * The whole pass rather than the item, because the environment is a fact
   * about the *project*: the same refusal applies to every ticket in the queue,
   * and going round the loop to say so once per ticket would print nine
   * identical failures and resolve the recipe nine times to do it.
   */
  | "env";

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
  if (!name) throw new Error("this project has no name recorded — re-run lingtai add");

  for (;;) {
    if (options.signal?.aborted) return finish("aborted");
    if (options.max !== undefined && ran.length >= options.max) return finish("max");

    // Reads `task_view`: what GitHub last reported, minus what the log says is
    // claimed, minus anything inside the backoff window. The backoff is the
    // part that survives a restart, which the in-memory set below does not.
    const queue = await readRunnable({ project: name, kinds: options.kinds });
    if (queue.length === 0) return finish("empty");

    const next = queue.find((entry) => !attempted.has(entry.taskId));
    if (!next) {
      // The queue has items and every one of them has already been through this
      // pass. Retrying now would be the $29 loop.
      return finish("exhausted");
    }

    const issue = Number(next.issue);
    if (!Number.isInteger(issue)) {
      // A work item whose reference is not a number cannot be run by a path
      // that nominates issues by number. Marked attempted so the loop moves on
      // rather than seeing it at the top of the queue forever.
      attempted.add(next.taskId);
      log(`skipping ${next.taskId}: "${next.issue}" is not an issue number`);
      continue;
    }

    attempted.add(next.taskId);
    log(`taking ${next.taskId} — ${next.title}`);

    const result = await runOnce({
      project: options.project,
      client: options.client,
      runtime: options.runtime,
      issue,
      hookBinary: options.hookBinary,
      ...(options.guard === undefined ? {} : { guard: options.guard }),
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

    // The environment is the project's, not the item's. `runOnce` refused
    // before claiming anything, and the next ticket would be refused for the
    // same reason — so the pass ends here rather than saying it nine times.
    if (result.ok === false && result.stage === "env") return finish("env");
  }
}

/**
 * What the items a pass touched are now, rather than what the process did to
 * them.
 *
 * The difference is not pedantry. On 2026-09-03 a whole-queue pass printed
 * `9 run(s): 0 landed, 8 held, 1 stopped` and exited 1, while #154 — held at
 * the merge gate, approved on the board *during* the pass, and merged by the
 * integrate lane a few seconds later — had landed. Nothing was wrong with the
 * log: `IntegrationSucceeded` and `WorkItemLanded` are both in it. The summary
 * counted merges this process performed, and that is a smaller thing than the
 * state of the work.
 *
 * So the counts are read back from the work item's own stream, where the
 * lifecycle already is:
 *
 *   landed   `WorkItemLanded` — by this run or by anyone else, since
 *   held     `WorkItemBlocked` — a question a person now holds
 *   stopped  neither: released back into the queue, or never claimed at all
 *
 * A run that held at a gate and a run that a merge conflict blocked both end
 * `blocked` and both count as held, which is what the board says about them
 * too. "Stopped" is left meaning what it should: it ended, nothing landed, and
 * nobody was asked anything.
 */
export interface PassTally {
  landed: number;
  held: number;
  stopped: number;
}

export async function tallyPass(
  ran: readonly RunOnceResult[],
  store: EventStore = eventStore,
): Promise<PassTally> {
  const tally: PassTally = { landed: 0, held: 0, stopped: 0 };

  for (const result of ran) {
    // A refusal before anything was claimed — an unreadable recipe — has no
    // stream to read. It stopped, and there is nowhere else to check.
    const events = result.workItemId ? await store.read(result.workItemId).catch(() => null) : null;
    if (events === null) {
      // Either no work item, or the log could not be read. Fall back to what
      // this process saw rather than lose the summary to a failing read.
      if (result.ok === true) tally.landed += 1;
      else if (result.ok === "held") tally.held += 1;
      else tally.stopped += 1;
      continue;
    }

    const status = reduceWorkItem(events).lifecycle.status;
    if (status === "landed") tally.landed += 1;
    else if (status === "blocked") tally.held += 1;
    else tally.stopped += 1;
  }

  return tally;
}
