/**
 * `lingtai end replay` — run the `end` point for what landed without it.
 *
 * The repair half of the doctor check next to it. `end` fires on every terminal
 * outcome, but for a while it only fired on the path where `runOnce` merged the
 * branch itself, so everything that landed through an approval merged, said
 * `WorkItemLanded`, and stopped: the issue was never closed and nothing on
 * GitHub showed that Lingtai had touched it.
 *
 * The code no longer does that. This is for the items it already did it to.
 *
 * **A replay, not a rewrite.** Nothing in the log is edited — an
 * `EndActionsResolved` is appended now, saying what the point resolved to, and
 * the outbox folds it exactly as it would have folded one written at the time.
 * That is the whole reason the plan is an event rather than something a
 * projection derives: it can be supplied late and everything downstream is
 * unchanged.
 *
 * The recipe comes from `origin/<base>` as it is *today*, which is the one
 * honest option: the recipe that was in force at the merge is not recoverable
 * from the log, and reading the current one is the same rule every other read
 * of a recipe follows (0005).
 */
import {
  appendEndActions,
  currentRecipe,
  landedWithoutEndActions,
  loadProject,
} from "@lingtai/conductor";
import { deliverOutbox } from "@lingtai/daemon";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient, type GitHubClient } from "@lingtai/github";
import { eventStore } from "@lingtai/store";
import { deliverer } from "./conduct.ts";
import { catchUpProjections } from "./projections.ts";

export interface EndReplayOptions {
  /** Narrows to one project; every affected one otherwise. */
  project?: string;
  /** Narrows to one issue. Only meaningful with a project. */
  issue?: number;
}

export async function endReplay(
  options: EndReplayOptions = {},
  log = console.log,
): Promise<number> {
  const found = (await landedWithoutEndActions()).filter(
    (f) =>
      (options.project === undefined || f.project === options.project) &&
      (options.issue === undefined || f.issue === options.issue),
  );

  if (found.length === 0) {
    log("nothing to replay — every landed item with end actions has resolved them");
    return 0;
  }
  if (!hasGitHubApp()) {
    log("no GitHub App configured — see doc/decisions/0006-github-app.md and .env.example");
    return 1;
  }

  // One client per project. An installation token is scoped to one repository,
  // and minting one per item would be a lookup per item.
  const clients = new Map<string, GitHubClient>();
  let replayed = 0;

  for (const item of found) {
    const project = await loadProject(item.project);
    if (!project?.owner) {
      log(`${item.workItemId}: no project named "${item.project}" is onboarded — skipped`);
      continue;
    }
    try {
      let client = clients.get(item.project);
      if (!client) {
        client = await createGitHubClient({
          auth: githubApp(),
          owner: project.owner,
          repo: item.project,
        });
        clients.set(item.project, client);
      }
      const resolved = await currentRecipe(project, client);
      await appendEndActions(eventStore, item.workItemId, resolved.recipe.gates.end, "landed");
      replayed += 1;
      log(`${item.project}#${item.issue}: end resolved from the recipe at ${resolved.ref}`);
    } catch (err) {
      // Named and carried on. One unreadable recipe must not strand the other
      // items, and the log is intact either way.
      log(`${item.project}#${item.issue}: not replayed — ${(err as Error).message}`);
    }
  }

  // The outbox is a projection, so the rows do not exist until something folds
  // the events just appended.
  await catchUpProjections();
  const sent = await deliverOutbox({ deliverer: deliverer(clients), log });
  log(`${replayed} replayed, ${sent.delivered} delivered`);
  if (sent.delivered < replayed) {
    // Not a failure: a fresh outbox row is not due for a second, and the
    // delivery is durable — it goes out on the next pass, of a daemon or of
    // this command.
    log("the rest are queued in the outbox and go out on the next pass");
  }
  return 0;
}
