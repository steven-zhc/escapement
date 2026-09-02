/**
 * `esc add <owner>/<repo>` — the whole of onboarding.
 *
 * Give it a repository slug and permissions; it does the rest. What it does
 * *not* do is take a configuration file: the recipe belongs to the managed
 * repository and is read from its base branch, and the policy is Escapement's
 * and lives in Escapement's own log. That split is
 * doc/decisions/0005-config-in-target-repo.md, and it is why this command needs
 * so few arguments.
 *
 * The order matters. Permissions are checked *before* anything is written, so a
 * half-onboarded project is not a state that exists. The failure this guards
 * against is specific: a fine-grained PAT that covered the admin repository's
 * submodule but not the repository itself produced a day of 403s on CI, and
 * nothing anywhere said "wrong scope".
 */
import { RECIPE_PATH, RecipeMissingError, resolveRecipe } from "@escapement/config";
import { type Tier, parsePayload } from "@escapement/core";
import {
  NotInstalledError,
  createGitHubClient,
  installationForRepo,
  parseSlug,
  permissionGaps,
} from "@escapement/github";
import { githubApp } from "@escapement/env";
import { eventStore } from "@escapement/store";

export interface AddOptions {
  slug: string;
  /** Defaults to the repository's own default branch. */
  base?: string;
  /** Containment floor. `guarded` is what the first project runs at (0007). */
}

/** A project's own stream. Policy and configuration live here, not in the repo. */
export function projectStream(project: string): string {
  return `prj-${project}`;
}

export async function add(options: AddOptions, log = console.log): Promise<number> {
  const { owner, repo } = parseSlug(options.slug);
  const auth = githubApp();

  // 1. Is the App installed here at all? This is the question a PAT cannot be
  //    asked, and the reason 0006 chose an App.
  let installation;
  try {
    installation = await installationForRepo(auth, owner, repo);
  } catch (err) {
    if (err instanceof NotInstalledError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
  log(`installation ${installation.id} on ${installation.account} (${installation.repositorySelection})`);

  // 2. Does it grant what Escapement actually needs? Named individually, with
  //    what each one is for — a gap here becomes a 403 in the middle of a merge.
  const gaps = permissionGaps(installation);
  if (gaps.length > 0) {
    log("the installation is missing permissions:");
    for (const g of gaps) log(`  ${g.name}: have ${g.have}, need ${g.need} — ${g.why}`);
    log("Fix them in the App's settings, then re-run.");
    return 1;
  }
  log("permissions: issues, contents, pull requests write; metadata read");

  const client = await createGitHubClient({ auth, owner, repo, installation });
  const fromDefault = options.base === undefined;
  const base = options.base ?? (await client.defaultBranch());
  // Said *before* the read, not after it. When this is the wrong branch the
  // failure is otherwise a sentence about a file, and the reader has to work
  // out for themselves that the branch is the surprising part.
  log(`base: ${base}${fromDefault ? " (the repository's default branch)" : ""}`);

  // 3. The recipe, read from the base branch. Never from anywhere else.
  let resolved: Awaited<ReturnType<typeof resolveRecipe>>;
  try {
    resolved = await resolveRecipe((path, ref) => client.fileAt(path, ref), base);
  } catch (err: unknown) {
    if (!(err instanceof RecipeMissingError)) throw err;
    log(err.message);
    if (fromDefault) {
      // The overwhelmingly common cause: a repository whose default branch is
      // not the branch it merges into. `nextloom-ai-admin`'s default is a
      // feature branch, and the recipe lives on `develop`.
      log("");
      log(`Nothing named a base, so this used ${base} — the repository's default branch.`);
      log("If that is not the branch work merges into, say which is:");
      log(`  esc add ${owner}/${repo} --base <branch>`);
    }
    return 1;
  }
  const fromSha = await client.refSha(base);
  log(`recipe: ${RECIPE_PATH} at ${base}@${fromSha.slice(0, 7)} — hash ${resolved.configHash.slice(0, 12)}`);
  log(`  ${resolved.recipe.gates.length} gate(s): ${resolved.recipe.gates.map((g) => g.name).join(", ")}`);
  log(`  runtime ${resolved.recipe.runtime.agent}, kinds ${resolved.recipe.source.kinds.join(" > ")}`);

  // Tier is the recipe's now (ADR 0016 §7). There is no policy to write here:
  // nothing sits above a repository's own workflow, so onboarding records what
  // the project *is* and stops.
  log(`  tier ${resolved.recipe.runtime.tier}`);

  const stream = projectStream(repo);
  const existing = await eventStore.read(stream);
  await eventStore.append(stream, existing.length === 0 ? 0 : existing[existing.length - 1]!.version, [
    {
      type: "ProjectConfigured",
      actor: "conductor",
      data: parsePayload("ProjectConfigured", {
        project: repo,
        owner,
        // Recorded, not re-derived. A run must not have to ask GitHub which
        // branch governs it — that is a decision made here, once.
        base,
        configHash: resolved.configHash,
        fromSha,
      }),
    },
  ]);

  log(
    existing.length === 0
      ? `added ${repo} — tier ${resolved.recipe.runtime.tier}, ${resolved.recipe.gates.length} gate(s)`
      : `updated ${repo} — its ${existing.length} earlier event(s) are still on the record`,
  );
  return 0;
}
