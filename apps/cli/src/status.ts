/**
 * `lingtai status` — what is runnable, and what is not.
 *
 * The old loop's equivalent was `pick_ticket`, a GitHub issue search re-run every
 * hour whose result nobody could see. The important half of this command is
 * therefore not the queue but the **absences**: an issue that is not being
 * worked has a reason, and until now the reason was never written down anywhere.
 */
import { hasGitHubApp, githubApp } from "@lingtai/env";
import { currentRecipe, loadProjects, readRunnable, readTasks, refreshQueue } from "@lingtai/conductor";
import { createGitHubClient } from "@lingtai/github";
import type { WorkKind } from "@lingtai/core";

export interface StatusOptions {
  /** Restrict to one project. */
  project?: string;
  /** Show items that have left the queue, and what holds them. */
  all?: boolean;
  /**
   * Ask GitHub before reporting, instead of reading whatever the last pass saw.
   *
   * Without it this command answers from `task_view`, which nothing writes to
   * until a run or the daemon has taken a pass — so on a log that has never
   * conducted, the honest answer and the useless answer are the same words:
   * `queue: empty`. That was the state after [0019](../../../doc/decisions/0019-a-second-reset.md),
   * with nine issues plainly runnable on GitHub.
   *
   * It takes nothing, claims nothing and appends no event. It writes the queue
   * projection and reports what GitHub offered — including, and this is the
   * half that matters, every issue it passed over and why.
   */
  refresh?: boolean;
}

export async function status(options: StatusOptions = {}, log = console.log): Promise<number> {
  const projects = (await loadProjects()).filter(
    (p) => !options.project || p.project === options.project,
  );

  if (projects.length === 0) {
    log(
      options.project
        ? `no project named "${options.project}" — run lingtai add <owner>/<repo> first`
        : "no projects registered — run lingtai add <owner>/<repo>",
    );
    return 0;
  }

  for (const project of projects) {
    const name = project.project!;
    log(`${name}  base=${project.base ?? "(unrecorded)"}`);

    // Priority order is the recipe's `kinds`, and the recipe lives in the
    // managed repository — so without GitHub the queue can still be listed, just
    // not prioritised. Saying so beats printing an order that is not the real one.
    let kinds: readonly WorkKind[] = [];
    const why = !hasGitHubApp()
      ? "no GitHub App configured, so the recipe cannot be read"
      : !project.owner
        // Registered before ProjectConfigured carried an owner. Saying so beats
        // guessing at one.
        ? "no owner recorded — re-run lingtai add to record it"
        : null;
    if (why !== null) {
      log(`  (priority order unavailable: ${why})`);
      // Asked for and not done is never silent. A refresh that quietly did not
      // happen would leave a stale queue looking current.
      if (options.refresh) log(`  (--refresh could not run: ${why})`);
    } else {
      try {
        const client = await createGitHubClient({
          auth: githubApp(),
          owner: project.owner!,
          repo: name,
        });
        const recipe = (await currentRecipe(project, client)).recipe;
        kinds = recipe.source.kinds;

        if (options.refresh) {
          const found = await refreshQueue({ project: name, client, recipe });
          const reasons = new Map<string, number>();
          for (const s of found.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
          const passed = [...reasons]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([reason, n]) => `${reason} ${n}`)
            .join(", ");
          log(
            `  from GitHub: ${found.runnable.length} runnable` +
              (found.skipped.length > 0 ? `, ${found.skipped.length} passed over — ${passed}` : ""),
          );
        }
      } catch (err) {
        log(`  (priority order unavailable: ${(err as Error).message})`);
        if (options.refresh) log(`  (--refresh failed: ${(err as Error).message})`);
      }
    }

    // Runnable now, from `task_view`. `--all` widens it to everything the
    // project has a row for, which is how you see what is running, held or
    // landed rather than only what could start next.
    const runnable = await readRunnable({ project: name, kinds });
    const rows = options.all ? await readTasks({ project: name }) : runnable;

    if (rows.length === 0) {
      log("  queue: empty");
      continue;
    }

    log(`  queue: ${runnable.length} runnable`);
    for (const t of rows) {
      // A task inside the backoff window is runnable-but-not-yet, and saying so
      // is the difference between "nothing to do" and "not for a while".
      const waiting = t.state === "queued" && !runnable.some((r) => r.taskId === t.taskId);
      const note = t.state === "queued" ? (waiting ? "  [backing off]" : "") : `  [${t.state}]`;
      log(`    #${t.issue.padEnd(5)} ${t.kind.padEnd(11)} ${t.title}${note}`);
    }
  }
  return 0;
}
