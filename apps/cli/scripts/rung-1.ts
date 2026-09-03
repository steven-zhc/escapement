/**
 * Rung 1 of the ladder in #39: does the plumbing reach a real repository?
 *
 * Seven seams have never touched reality, and a single full run would light all
 * seven at once — if it failed, nobody would know which, and every retry would
 * cost agent money. This lights four of them, for free:
 *
 *   1. GitHub App authentication → an installation token
 *   2. git over https with that token injected
 *   3. a cross-repository submodule fetch with the same token
 *   4. the prepare stage, against a real dependency tree
 *
 * **It starts no agent and writes nothing to GitHub.** It clones, prepares, and
 * reports. The only things it touches are Lingtai's own mirror and worktree
 * under `LINGTAI_HOME`, and it removes the worktree afterwards.
 *
 * It also uses an in-memory event store rather than the real one. A run that
 * never happened should not leave a run-shaped hole in the log, and the evidence
 * this produces is its own output, which goes into doc/experiments/.
 *
 * Lives under `apps/cli` rather than at the root because that is where the
 * workspace links to `@lingtai/*` resolve — a script at the top level is not
 * a package and cannot import them.
 *
 *   node --experimental-strip-types apps/cli/scripts/rung-1.ts <owner>/<repo>
 */
import { resolveRecipe } from "@lingtai/config";
import type { Envelope, ToAppend } from "@lingtai/core";
import { prepareWorktree, provisionWorktree, removeWorktree, filterEnv, runnableEnv, DEFAULT_PRODUCTION_PATTERNS } from "@lingtai/conductor";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient } from "@lingtai/github";
import type { EventStore } from "@lingtai/store";

const memory = (): EventStore & { events: Envelope[] } => {
  const events: Envelope[] = [];
  return {
    events,
    async append(streamId, expectedVersion, batch: readonly ToAppend[]) {
      const written = batch.map((e, i) => ({
        ...e,
        streamId,
        version: expectedVersion + i + 1,
        seq: BigInt(events.length + i + 1),
        at: new Date(),
        schemaVer: 1,
        eventId: crypto.randomUUID(),
      })) as unknown as Envelope[];
      events.push(...written);
      return written;
    },
    async read(streamId) {
      return events.filter((e) => e.streamId === streamId);
    },
    async readAll() {
      return events;
    },
  };
};

const target = process.argv[2];
if (!target?.includes("/")) {
  console.error("usage: pnpm tsx scripts/rung-1.ts <owner>/<repo> [--base <branch>]");
  process.exit(2);
}
const [owner, repo] = target.split("/") as [string, string];
const baseFlag = process.argv.indexOf("--base");
const wantBase = baseFlag > 0 ? process.argv[baseFlag + 1] : undefined;

if (!hasGitHubApp()) {
  console.error("no GitHub App configured — see README, Connecting GitHub");
  process.exit(1);
}

const started = Date.now();
const step = (name: string) => {
  const at = Date.now();
  return (detail = "") => console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}  (${Date.now() - at}ms)`);
};

console.log(`rung 1 against ${owner}/${repo}\n`);

// ---- seam 1: the App reaches an installation -------------------------------
let done = step("app → installation token");
const client = await createGitHubClient({ auth: githubApp(), owner, repo });
const token = await client.token();
done(`installation ${client.installation.id}, token ${token.slice(0, 8)}…`);

// ---- the recipe, from the branch that governs ------------------------------
done = step("recipe");
const base = wantBase ?? (await client.defaultBranch());
const resolved = await resolveRecipe((p, r) => client.fileAt(p, r), base);
const recipe = resolved.recipe;
done(`${resolved.configHash.slice(0, 16)} from ${base}, ${recipe.prepare.length} prepare step(s)`);

if (recipe.repo.base !== base) {
  console.log(`  !!  the recipe says its base is ${recipe.repo.base}, read from ${base}`);
}

// ---- seams 2 and 3: clone and submodules, over https, with the token -------
done = step("worktree");
const env = filterEnv(recipe.env.allow, process.env, DEFAULT_PRODUCTION_PATTERNS);
if (env.missing.length > 0) console.log(`  --  env not set, so not planted: ${env.missing.join(", ")}`);

const runId = `run-rung1-${crypto.randomUUID().slice(0, 8)}`;
const worktree = await provisionWorktree({
  project: repo,
  owner,
  repo,
  base: recipe.repo.base,
  branch: `rung1/${runId}`,
  runId,
  submodules: recipe.repo.submodules,
  plantAt: recipe.env.plantAt,
  env: env.values,
  // The function, not a snapshot. Same as a real run.
  token: () => client.token(),
});
done(`${worktree.path} at ${worktree.baseSha.slice(0, 7)}`);

// ---- seam 4: prepare, against a real dependency tree -----------------------
const store = memory();
const result = await prepareWorktree({
  runId,
  workItemId: `wi-${repo}-0`,
  cwd: worktree.path,
  env: runnableEnv(env.values),
  steps: recipe.prepare,
  store,
  at: 0,
  log: (line) => console.log(`  ..  ${line}`),
});

console.log("");
if (result.ok) {
  console.log(`PASS — four seams reached reality in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`events: ${store.events.map((e) => e.type).join(", ") || "(none — the recipe declares no prepare)"}`);
} else {
  console.log(`FAIL at prepare step "${result.step}"${result.timedOut ? " (timed out)" : ""}`);
  console.log(result.detail);
}

// The worktree is disposable; the mirror is the expensive part and stays.
await removeWorktree({ project: repo, runId }).catch((err: Error) => {
  console.log(`  !!  could not remove the worktree: ${err.message}`);
});

process.exit(result.ok ? 0 : 1);
