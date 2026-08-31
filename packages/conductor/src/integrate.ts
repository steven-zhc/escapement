/**
 * The integrator: merge base in, verify, merge out.
 *
 * This is the file that exists because of a specific, expensive silence. The old
 * loop's `integrate()` had six `return 1` paths and not one of them emitted a
 * log line, a comment or a label. #58 and #59 re-ran five times for roughly $29
 * while the actual cause — uncommitted work in the operator's own checkout of
 * `main` — was never reported by anything at all.
 *
 * So there is one rule here, and the code is shaped around it rather than merely
 * observing it: **no path returns without an event.** Every exit goes through
 * `refuse()` or `succeed()`, both of which append before they return, and the
 * only way to leave this function is through one of them. A reason is a typed
 * value from the catalogue, not a string someone wrote at the time.
 *
 * Two structural changes make most of those failures impossible rather than
 * merely reported:
 *
 * **The integrator owns its worktree.** It is cut from the same bare mirror the
 * agent's came from, and the operator's checkout is never read, written or
 * looked at. A dirty working copy somewhere else cannot affect a merge that does
 * not touch it.
 *
 * **The lane is a session-level advisory lock**, not a file. Two integrations
 * against one base serialise in Postgres, and a process that dies holding the
 * lock drops it when its connection closes — there is nothing to unwind.
 */
import { type RefusalReason, parsePayload, reduceIntegration } from "@escapement/core";
import { directDatabaseUrl } from "@escapement/env";
import { ConcurrencyError, type EventStore, eventStore } from "@escapement/store";
import pg from "pg";
import { git, stateDir, worktreePath } from "./worktree.ts";

/** `int-{project}-{base}` — one lane per base branch, forever. */
export function integrationStream(project: string, base: string): string {
  return `int-${project}-${base.replace(/\//g, ".")}`;
}

export interface IntegrateOptions {
  project: string;
  owner: string;
  repo: string;
  base: string;
  branch: string;
  workItemId: string;
  /** The commit the gates gave their verdicts about. */
  headSha: string;
  /** False when a gate refused. The integrator records it and does not merge. */
  gatesPassed: boolean;
  gateDetail?: string;
  token?: string;
  home?: string;
  gitEnv?: NodeJS.ProcessEnv;
  store?: EventStore;
  /** Session-mode connection. The advisory lock needs one; see 0009. */
  url?: string;
  /**
   * Re-run after merging the base in, before merging out. The gates already ran
   * against the agent's head; this is the "does it still work with what landed
   * in the meantime" question, which is a different one.
   */
  verify?: (cwd: string) => Promise<{ ok: boolean; evidence: string }>;
}

export type IntegrateResult =
  | { ok: true; mergeCommit: string }
  | { ok: false; reason: RefusalReason; detail: string };

/** Files whose presence in a diff means a human applies the migration, not the agent. */
const MIGRATION_GLOB = /(^|\/)(prisma\/)?migrations?\//i;

export async function integrate(options: IntegrateOptions): Promise<IntegrateResult> {
  const store = options.store ?? eventStore;
  const home = options.home ?? stateDir();
  const stream = integrationStream(options.project, options.base);
  const run = { token: options.token, env: options.gitEnv };

  // Every exit goes through one of these two. There is no `return` in this
  // function that does not append first.
  //
  // The lane's stream has more than one writer *by design*: whoever holds the
  // lock is appending its attempt and outcome while everyone else appends
  // `lane-busy`. So an append here re-reads and retries on a lost race — which
  // is exactly what `ConcurrencyError` means, and the first version of this
  // function did not do it. The concurrency test found that immediately.
  async function append(
    type: "IntegrationAttempted" | "IntegrationRefused" | "IntegrationSucceeded",
    data: unknown,
  ): Promise<void> {
    const payload = { type, actor: "conductor" as const, data: parsePayload(type, data) };
    for (let attempt = 0; attempt < 8; attempt++) {
      const at = reduceIntegration(await store.read(stream)).version;
      try {
        await store.append(stream, at, [payload]);
        return;
      } catch (err) {
        if (!(err instanceof ConcurrencyError)) throw err;
        // Someone else moved the lane on. Read where it is now and try again.
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
    throw new Error(`could not record ${type} on ${stream} after 8 attempts`);
  }

  async function refuse(reason: RefusalReason, detail: string): Promise<IntegrateResult> {
    await append("IntegrationRefused", {
      workItemId: options.workItemId,
      branch: options.branch,
      reason,
      detail: detail.slice(0, 2_000),
    });
    return { ok: false, reason, detail };
  }

  async function succeed(mergeCommit: string): Promise<IntegrateResult> {
    await append("IntegrationSucceeded", {
      workItemId: options.workItemId,
      branch: options.branch,
      base: options.base,
      mergeCommit,
    });
    return { ok: true, mergeCommit };
  }

  // ---- the lane ------------------------------------------------------------
  // Session mode, because a transaction pooler hands the connection to someone
  // else between statements and the lock goes with it — silently (0009).
  const lock = new pg.Client({
    connectionString: options.url ?? directDatabaseUrl(),
    application_name: `escapement-merge-${options.project}`,
  });
  await lock.connect();

  const key = `merge:${options.project}:${options.base}`;
  const held = await lock.query<{ ok: boolean }>(
    "select pg_try_advisory_lock(hashtext($1)::bigint) as ok",
    [key],
  );
  if (held.rows[0]?.ok !== true) {
    await lock.end();
    // Not a queue: the caller retries. Two integrations against one base must
    // never overlap, and saying so is better than blocking a scheduler thread.
    return refuse("lane-busy", `another integration holds ${key}`);
  }

  try {
    await append("IntegrationAttempted", {
      workItemId: options.workItemId,
      branch: options.branch,
      headSha: options.headSha,
    });

    // The gates' verdict is the integrator's business only in that it refuses.
    if (!options.gatesPassed) {
      return await refuse("gate-failed", options.gateDetail ?? "a gate refused this diff");
    }

    const mirror = `${home}/repos/${options.project}.git`;
    const cwd = worktreePath(home, options.project, `integrator-${options.base.replace(/\//g, ".")}`);

    // The integrator's own worktree, from the mirror Escapement owns. The
    // operator's checkout is not read, written, or consulted.
    await git(["fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"], { ...run, cwd: mirror });
    await git(["worktree", "add", "--force", "-B", `integrate/${options.base}`, cwd, options.base], {
      ...run,
      cwd: mirror,
    });

    try {
      const dirty = await git(["status", "--porcelain"], { ...run, cwd });
      if (dirty.trim()) {
        // Cannot happen with a worktree Escapement just cut, which is the point
        // — the check is here so that if it ever does, it is an event and not a
        // mystery. The old loop merged in a checkout it did not own and this was
        // the failure it could not report.
        return await refuse("dirty-base", `the integrator's worktree is not clean:\n${dirty}`);
      }

      const localBase = await git(["rev-parse", options.base], { ...run, cwd: mirror });
      const remoteBase = await git(["rev-parse", `refs/heads/${options.base}`], { ...run, cwd: mirror });
      if (localBase !== remoteBase) {
        return await refuse("unpushed-base", `${options.base} is ${localBase} locally and ${remoteBase} on origin`);
      }

      const ahead = await git(["rev-list", "--count", `${options.base}..${options.branch}`], {
        ...run,
        cwd: mirror,
      });
      if (Number(ahead) === 0) {
        return await refuse("no-commits", `${options.branch} has nothing ${options.base} does not`);
      }

      const changed = await git(["diff", "--name-only", `${options.base}...${options.branch}`], {
        ...run,
        cwd: mirror,
      });
      const migrations = changed.split("\n").filter((f) => f && MIGRATION_GLOB.test(f));
      if (migrations.length > 0) {
        // The hold that caught #117, generalised. A migration is applied by a
        // person who has looked at it, not by a merge.
        return await refuse(
          "pending-migration",
          `the diff adds migration files, which need applying by hand first:\n${migrations.join("\n")}`,
        );
      }

      // Merge base in first, so a conflict is discovered here rather than
      // halfway through writing to the base branch.
      try {
        await git(["merge", "--no-edit", options.branch], { ...run, cwd });
      } catch (err) {
        const conflicts = await git(["diff", "--name-only", "--diff-filter=U"], { ...run, cwd }).catch(
          () => "",
        );
        await git(["merge", "--abort"], { ...run, cwd }).catch(() => {
          // Nothing to abort; the merge failed before it started one.
        });
        return await refuse(
          "conflict",
          `${options.branch} does not merge into ${options.base}:\n${conflicts || (err as Error).message}`,
        );
      }

      if (options.verify) {
        const verified = await options.verify(cwd);
        if (!verified.ok) {
          // The gates ran against the agent's head. This is the different
          // question of whether it still works beside what landed since.
          return await refuse("gate-failed", `verification after merging ${options.base} in failed:\n${verified.evidence}`);
        }
      }

      const mergeCommit = await git(["rev-parse", "HEAD"], { ...run, cwd });
      await git(["push", "origin", `HEAD:refs/heads/${options.base}`], { ...run, cwd });
      // The mirror is Escapement's own copy of the truth; leaving it stale would
      // make the next integration compute against a base that has moved.
      await git(["fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"], { ...run, cwd: mirror });

      return await succeed(mergeCommit);
    } finally {
      // The worktree is disposable; the mirror is the expensive part.
      await git(["worktree", "remove", "--force", cwd], { ...run, cwd: mirror }).catch(() => {});
    }
  } catch (err) {
    // The catch-all that makes the rule true. Anything unforeseen still leaves
    // an event behind, which is the entire difference from six silent `return 1`s.
    return await refuse("conflict", `the integration failed unexpectedly: ${(err as Error).message}`);
  } finally {
    // Releasing explicitly is tidy; the lock would drop when the connection
    // closes anyway, which is what makes a crash mid-merge recoverable with
    // nothing to clean up.
    await lock.query("select pg_advisory_unlock(hashtext($1)::bigint)", [key]).catch(() => {});
    await lock.end().catch(() => {});
  }
}
