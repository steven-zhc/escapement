/**
 * `esc status` — what is runnable, and what is not.
 *
 * The old loop's equivalent was `pick_ticket`, a GitHub issue search re-run every
 * hour whose result nobody could see. The important half of this command is
 * therefore not the queue but the **absences**: an issue that is not being
 * worked has a reason, and until now the reason was never written down anywhere.
 */
import { hasGitHubApp, githubApp } from "@escapement/env";
import { currentRecipe, loadProjects, readQueue } from "@escapement/conductor";
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
    log(`${name}  tier=${project.tier}  concurrency=${project.concurrent}`);
    log(
      `  policy: ${project.requiredGates.length ? `requires ${project.requiredGates.join(", ")}` : "no mandatory gates"}` +
        `${project.approvers.length ? `, approvers ${project.approvers.join(", ")}` : ""}` +
        `${project.policyReason ? ` (${project.policyReason})` : ""}`,
    );

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

    const queue = await readQueue(name, kinds, { includeHeld: options.all });
    if (queue.length === 0) {
      log("  queue: empty");
      continue;
    }

    log(`  queue: ${queue.filter((q) => q.heldBy === null).length} runnable`);
    for (const entry of queue) {
      const held = entry.heldBy ? `  [${entry.heldBy}]` : "";
      log(`    #${entry.externalRef.padEnd(5)} ${entry.kind.padEnd(11)} ${entry.title}${held}`);
    }
  }
  return 0;
}
