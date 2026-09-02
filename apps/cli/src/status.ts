/**
 * `esc status` — what is runnable, and what is not.
 *
 * The old loop's equivalent was `pick_ticket`, a GitHub issue search re-run every
 * hour whose result nobody could see. The important half of this command is
 * therefore not the queue but the **absences**: an issue that is not being
 * worked has a reason, and until now the reason was never written down anywhere.
 */
import { hasGitHubApp, githubApp } from "@escapement/env";
import { currentRecipe, loadProjects, readRunnable, readTasks } from "@escapement/conductor";
import { createGitHubClient } from "@escapement/github";
import type { WorkKind } from "@escapement/core";

export interface StatusOptions {
  /** Restrict to one project. */
  project?: string;
  /** Show items that have left the queue, and what holds them. */
  all?: boolean;
}

export async function status(options: StatusOptions = {}, log = console.log): Promise<number> {
  const projects = (await loadProjects()).filter(
    (p) => !options.project || p.project === options.project,
  );

  if (projects.length === 0) {
    log(
      options.project
        ? `no project named "${options.project}" — run esc add <owner>/<repo> first`
        : "no projects registered — run esc add <owner>/<repo>",
    );
    return 0;
  }

  for (const project of projects) {
    const name = project.project!;
    // No policy line any more (ADR 0016 §7). Tier, gates and everything else a
    // run obeys are the recipe's, and the recipe lives in the managed
    // repository — which is where to look, rather than here.
    log(`${name}  base=${project.base ?? "(unrecorded)"}`);

    // Priority order is the recipe's `kinds`, and the recipe lives in the
    // managed repository — so without GitHub the queue can still be listed, just
    // not prioritised. Saying so beats printing an order that is not the real one.
    let kinds: readonly WorkKind[] = [];
    if (!hasGitHubApp()) {
      log("  (priority order unavailable: no GitHub App configured, so the recipe cannot be read)");
    } else if (!project.owner) {
      // Registered before ProjectConfigured carried an owner. Saying so beats
      // guessing at one.
      log("  (priority order unavailable: no owner recorded — re-run esc add to record it)");
    } else {
      try {
        const client = await createGitHubClient({
          auth: githubApp(),
          owner: project.owner,
          repo: name,
        });
        kinds = (await currentRecipe(project, client)).recipe.source.kinds;
      } catch (err) {
        log(`  (priority order unavailable: ${(err as Error).message})`);
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
