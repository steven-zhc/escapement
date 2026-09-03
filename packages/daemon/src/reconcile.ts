/**
 * What the log said, against what the machine actually has.
 *
 * A daemon that is killed mid-run leaves two things behind, and only one of
 * them cleans itself up. The **claim** has a lease, so it expires without
 * anybody releasing it and the task returns to the queue on its own
 * (`claim.ts`). The **worktree** does not: a directory under
 * `~/.lingtai/worktrees/` outlives every process that knew about it, and it
 * is holding a branch checked out, which stops git updating that ref on the
 * next attempt.
 *
 * ## Recorded, not quietly repaired
 *
 * The removal is an event. A system that silently tidies up after itself cannot
 * tell you it has been crashing — the disk gets cleaner, the symptom
 * disappears, and the fact that something is killing the daemon every night
 * surfaces six weeks later as something else. The old harness's integrate step
 * had six silent `return 1` paths and this is that failure wearing a different
 * hat.
 *
 * A run that found nothing appends nothing. An empty `Reconciled` every startup
 * would be noise in the one place noise is expensive.
 *
 * ## What counts as orphaned
 *
 * A worktree belongs to a run; a run belongs to a task; the task's own stream
 * says whether that run still holds it. So the worktree is orphaned when the
 * task is not claimed at all, or is claimed by a *different* run, or is claimed
 * by this one on a lease that has expired.
 *
 * Deliberately not "no process has it open". That would be true of a run whose
 * agent is between tool calls, and deleting a live worktree is a worse outcome
 * than leaving a dead one.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { reduceWorkItem, parsePayload } from "@lingtai/core";
import { type EventStore, eventStore } from "@lingtai/store";
import { CONTROL_STREAM } from "./control.ts";

export interface Finding {
  /** The run whose worktree this is. */
  stream: string;
  expected: string;
  actual: string;
  action: "removed" | "reported";
  /** Absolute path, so somebody can go and look. */
  path: string;
}

export interface ReconcileOptions {
  /** Defaults to `LINGTAI_HOME`, as the conductor uses it. */
  home?: string;
  /**
   * True reports without touching anything. `lingtai doctor` uses this — a check
   * that changed the thing it was checking would be a bad check.
   */
  dryRun?: boolean;
  store?: EventStore;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Finds every worktree the log says should not exist.
 *
 * Reads only. `reconcile` is what acts, and `lingtai doctor` calls this on its own
 * so it can say what would happen without making it happen.
 */
export async function findOrphans(options: ReconcileOptions = {}): Promise<Finding[]> {
  const store = options.store ?? eventStore;
  const now = options.now ?? Date.now;
  const home = options.home ?? defaultHome();
  const root = join(home, "worktrees");

  let projects: string[];
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // No worktrees directory means nothing has ever run here, which is not a
    // divergence.
    return [];
  }

  const findings: Finding[] = [];

  for (const project of projects) {
    let runs: string[];
    try {
      runs = (await readdir(join(root, project), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const runId of runs) {
      const path = join(root, project, runId);

      // Which task does this run belong to? The run's own stream says, at
      // `PreparationStarted` or `RunStarted`. Read from the log rather than a
      // projection: reconciliation has to work when a projection is the thing
      // that is broken.
      const run = await store.read(runId).catch(() => []);
      const taskId = run
        .map((e) => (e.data as { workItemId?: string } | undefined)?.workItemId)
        .find((id): id is string => typeof id === "string");

      if (!taskId) {
        findings.push({
          stream: runId,
          expected: "a run that named its task",
          actual: `worktree at ${path} for a run with no RunStarted`,
          // Not removed. A worktree whose run never got as far as saying what
          // it was for is a mystery, and deleting mysteries is how you stop
          // being able to explain them.
          action: "reported",
          path,
        });
        continue;
      }

      const task = reduceWorkItem(await store.read(taskId).catch(() => []));
      const life = task.lifecycle;
      const live =
        life.status === "claimed" && life.runId === runId && life.leaseUntilMs > now();

      if (live) continue;

      findings.push({
        stream: runId,
        expected: `no worktree — ${taskId} is ${life.status}`,
        actual: `worktree at ${path}`,
        action: options.dryRun ? "reported" : "removed",
        path,
      });
    }
  }

  return findings;
}

export async function reconcile(options: ReconcileOptions = {}): Promise<Finding[]> {
  const log = options.log ?? (() => {});
  const store = options.store ?? eventStore;
  const findings = await findOrphans(options);

  if (findings.length === 0) return [];

  for (const f of findings) {
    if (f.action !== "removed") continue;
    try {
      await rm(f.path, { recursive: true, force: true });
      log(`reconciled: removed ${f.path}`);
    } catch (err) {
      // Report the failure rather than the intention. An event saying
      // "removed" about a directory that is still there is worse than no
      // event, because it is the kind of wrong you only find by going to look.
      f.action = "reported";
      f.actual = `${f.actual} (could not remove: ${(err as Error).message})`;
      log(`reconcile could not remove ${f.path}: ${(err as Error).message}`);
    }
  }

  const at = (await store.read(CONTROL_STREAM)).length;
  await store.append(CONTROL_STREAM, at, [
    {
      type: "Reconciled",
      actor: "conductor",
      data: parsePayload("Reconciled", {
        findings: findings.map((f) => ({
          stream: f.stream,
          expected: f.expected,
          actual: f.actual,
          action: f.action,
        })),
      }),
    },
  ]);

  return findings;
}

function defaultHome(): string {
  return process.env["LINGTAI_HOME"] ?? join(process.env["HOME"] ?? ".", ".lingtai");
}

/** Exported for a test that wants to know the directory really went. */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
