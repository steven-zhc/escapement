/**
 * One work item, discovery through merge, with a person watching.
 *
 * This is the wiring, and almost none of the logic — every piece it calls has
 * its own tests and its own reasons. What is here is the *order*, and the order
 * is the part that has to be right:
 *
 *   resolve the recipe from origin/<base>   never from the agent's branch
 *   check it against policy                 a recipe may add strictness only
 *   discover, claim                         the constraint decides the race
 *   provision the worktree                  filtered env, submodules, 0600
 *   prove the hook fails closed             before anything is dispatched
 *   RunStarted                              the conductor knows more than the hook
 *   run the agent                           under the guard, on the socket
 *   diff → gates → integrate                each refusal typed and recorded
 *
 * **Every exit appends.** A run that ends leaves either `RunFinished` or
 * `RunFailed`, and a work item that does not land is either released or blocked
 * with a question. The old loop could end in silence in at least seven places;
 * that is the thing being replaced, so `finally` blocks here are not tidiness.
 */
import { type ResolvedRecipe, effectiveTier, parseDuration } from "@escapement/config";
import { type Tier, parsePayload } from "@escapement/core";
import { gatesFromRecipe, runGatePipeline } from "@escapement/gates";
import type { GitHubClient } from "@escapement/github";
import { type Runtime, missingForTier } from "@escapement/runtime";
import { type EventStore, eventStore } from "@escapement/store";
import { claimWorkItem, releaseWorkItem } from "./claim.ts";
import { discover, workItemStream } from "./discover.ts";
import type { GuardPolicy } from "./guard.ts";
import { smokeTestFailClosed, writeHookWiring } from "./hook-config.ts";
import { createHookServer } from "./hook-socket.ts";
import { integrate } from "./integrate.ts";
import { prepareWorktree } from "./prepare.ts";
import { policyOf } from "./projects.ts";
import type { ProjectState } from "@escapement/core";
import { DEFAULT_PRODUCTION_PATTERNS, type TokenSource, filterEnv, git, provisionWorktree, removeWorktree, runnableEnv, stateDir } from "./worktree.ts";
import { spawn } from "node:child_process";

export interface RunOnceOptions {
  project: ProjectState;
  client: GitHubClient;
  runtime: Runtime;
  /** The issue to work. Phase 1 nominates by number rather than taking the queue. */
  issue: number;
  /** Absolute path to the compiled `esc-hook`. */
  hookBinary: string;
  /** The ticket prompt. Versioned, and recorded on every `RunPrompted`. */
  prompt: string;
  promptVersion?: string;
  token?: TokenSource;
  home?: string;
  store?: EventStore;
  gitEnv?: NodeJS.ProcessEnv;
  /** Overrides the clone source. The tests point it at a local repository. */
  remote?: string;
  /**
   * False stops after the gates, with the branch pushed and every verdict
   * recorded, and asks a person for the merge.
   *
   * This is not a separate mechanism from the human gate (#20). It requests the
   * same `ApprovalRequested` the recipe will request once that exists, which is
   * what keeps it from becoming a second vocabulary for one idea. The hold is
   * bound to `onSha` like any other verdict, so a force-push invalidates it by
   * arithmetic rather than by anyone remembering to.
   */
  merge?: boolean;
  log?: (line: string) => void;
}

export type RunOnceResult =
  | { ok: true; workItemId: string; runId: string; mergeCommit: string }
  /**
   * Reached the merge and stopped, because a person asked it to. Deliberately
   * not `ok: false` with a stage — nothing refused, and calling it a failure
   * would be the kind of convenient fiction the log exists to prevent.
   */
  | { ok: "held"; workItemId: string; runId: string; headSha: string; gate: string }
  | { ok: false; workItemId: string | null; runId: string | null; stage: string; detail: string };

/** How a runtime is spawned for the fail-closed smoke test. */
function runBinary(
  bin: string,
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code, stderr }));
    child.on("error", (err) => resolve({ code: null, stderr: err.message }));
    child.stdin.end(stdin);
  });
}

export async function runOnce(options: RunOnceOptions): Promise<RunOnceResult> {
  const store = options.store ?? eventStore;
  const home = options.home ?? stateDir();
  const log = options.log ?? (() => {});
  const project = options.project.project!;
  const promptVersion = options.promptVersion ?? "ticket@1";

  // ---- 1. the recipe, from the base branch, checked against policy ----------
  let resolved: ResolvedRecipe;
  try {
    // The base recorded at `esc add`, not the repository's default branch. Those
    // are the same only by convention, and `nextloom-ai-admin`'s default is a
    // feature branch — reading the rules from one branch while merging into
    // another is exactly the confusion 0005 exists to prevent.
    const from = options.project.base ?? (await options.client.defaultBranch());
    resolved = await (
      await import("@escapement/config")
    ).resolveRecipe((p, r) => options.client.fileAt(p, r), from, policyOf(options.project));
  } catch (err) {
    // Refusing here is the point of 0005: an unreadable or non-compliant recipe
    // must stop the run rather than fall back to a default.
    return { ok: false, workItemId: null, runId: null, stage: "recipe", detail: (err as Error).message };
  }
  const recipe = resolved.recipe;
  const base = recipe.repo.base;
  log(`recipe ${resolved.configHash.slice(0, 12)} from ${resolved.ref}, tier ${resolved.tier ?? "?"}`);

  // ---- 2. capability matching, before anything is claimed ------------------
  const tier: Tier = effectiveTier(recipe, policyOf(options.project));
  const missing = missingForTier(options.runtime.capabilities, tier);
  const workItemId = workItemStream(project, options.issue);

  if (missing.length > 0) {
    // Never silently downgrade. The refusal is an event on the work item so the
    // board can say why nothing ran.
    await discover({ project, client: options.client, recipe, store, only: [options.issue] });
    const at = (await store.read(workItemId)).length;
    if (at > 0) {
      await store.append(workItemId, at, [
        {
          type: "DispatchRefused",
          actor: "conductor",
          data: parsePayload("DispatchRefused", {
            requiredTier: tier,
            runtime: options.runtime.capabilities.id,
            missing,
          }),
        },
      ]);
    }
    return {
      ok: false,
      workItemId,
      runId: null,
      stage: "dispatch",
      detail: `${options.runtime.capabilities.id} cannot provide ${tier}: missing ${missing.join(", ")}`,
    };
  }

  // ---- 3. discover and claim ----------------------------------------------
  const found = await discover({ project, client: options.client, recipe, store, only: [options.issue] });
  if ((await store.read(workItemId)).length === 0) {
    const why = found.skipped.find((s) => s.ref === options.issue)?.reason ?? "not discovered";
    return { ok: false, workItemId, runId: null, stage: "discover", detail: why };
  }

  const runId = `run-${crypto.randomUUID()}`;
  const claim = await claimWorkItem(workItemId, { runId, store });
  if (!claim.ok) {
    return {
      ok: false,
      workItemId,
      runId: null,
      stage: "claim",
      detail: JSON.stringify(claim.refusal),
    };
  }
  log(`claimed ${workItemId} as ${runId}`);

  // ---- 4. the worktree, and the environment the agent may see --------------
  const branch = `agent/${options.issue}`;
  let released = false;
  const release = async (reason: string) => {
    if (released) return;
    released = true;
    // A work item that does not land goes back to the queue rather than sitting
    // claimed by a run that is over.
    await releaseWorkItem(workItemId, runId, reason, store).catch(() => {});
  };

  try {
    const env = filterEnv(recipe.env.allow, process.env, DEFAULT_PRODUCTION_PATTERNS);
    if (env.missing.length > 0) log(`env: ${env.missing.join(", ")} not set, so not planted`);

    const worktree = await provisionWorktree({
      project,
      owner: options.client.owner,
      repo: options.client.repo,
      base,
      branch,
      runId,
      submodules: recipe.repo.submodules,
      plantAt: recipe.env.plantAt,
      env: env.values,
      token: options.token,
      home,
      remote: options.remote,
      gitEnv: options.gitEnv,
    });
    log(`worktree ${worktree.path} at ${worktree.baseSha.slice(0, 7)}`);

    // ---- 5. the hook, proven to fail closed before anything is dispatched ---
    const wiring = await writeHookWiring({ runId, hookBinary: options.hookBinary, home });
    const smoke = await smokeTestFailClosed(options.hookBinary, runBinary);
    if (!smoke.ok) {
      // The old loop refused to start when its guard smoke test failed. That
      // instinct was right and applies to every check.
      await release("the hook did not fail closed");
      return { ok: false, workItemId, runId, stage: "hook", detail: smoke.detail };
    }

    // ---- 6. prepare: make the worktree workable, or refuse for free --------
    // After the hook smoke test, which costs milliseconds — a broken hook should
    // not take a ten-minute install to discover. Before the agent, which is the
    // whole point: everything past here assumes the agent can run this
    // repository's own commands, and until this stage existed that assumption
    // was simply false.
    const prepared = await prepareWorktree({
      runId,
      workItemId,
      cwd: worktree.path,
      env: runnableEnv(env.values),
      steps: recipe.prepare,
      store,
      at: 0,
      log,
    });
    if (!prepared.ok) {
      await release(`prepare failed at ${prepared.step}`);
      return {
        ok: false,
        workItemId,
        runId,
        stage: "prepare",
        detail: `the ${prepared.step} step ${prepared.timedOut ? "timed out" : "refused"}:\n${prepared.detail}`,
      };
    }

    const guard: GuardPolicy = { base, productionPatterns: DEFAULT_PRODUCTION_PATTERNS };
    let proposedSha: string | null = null;

    const server = createHookServer({
      socketPath: wiring.socketPath,
      store,
      onLifecycle: (_r, hook) => {
        if (hook === "Stop") proposedSha = "pending";
      },
    });
    await server.listen();

    try {
      // ---- 7. RunStarted, then the agent --------------------------------
      // Not version 0 any more: prepare wrote first. Asserting 0 here would
      // have failed the moment a recipe declared a single prepare step.
      await store.append(runId, prepared.version, [
        {
          type: "RunStarted",
          actor: "conductor",
          data: parsePayload("RunStarted", {
            workItemId,
            runtime: options.runtime.capabilities.id,
            model: "",
            promptVersion,
            baseSha: worktree.baseSha,
            configHash: resolved.configHash,
            worktree: worktree.path,
          }),
        },
      ]);
      server.register(runId, guard, prepared.version + 1, promptVersion);

      const outcome = await options.runtime.run({
        runId,
        cwd: worktree.path,
        prompt: options.prompt,
        settingsPath: wiring.settingsPath,
        env: runnableEnv({ ...env.values, ...wiring.env }),
        limits: {
          turns: recipe.runtime.limits.turns,
          wallMs: parseDuration(recipe.runtime.limits.wall),
        },
      });

      // Flush what the hook counted in memory before anything else reads it.
      await server.flush(runId).catch(() => {});
      const registered = server.get(runId);
      const version = registered?.version ?? 1;

      if (outcome.failure) {
        // Never silence. Every ending has a kind.
        await store.append(runId, version, [
          { type: "RunFailed", actor: "conductor", data: parsePayload("RunFailed", outcome.failure) },
        ]);
        await release(`run failed: ${outcome.failure.kind}`);
        return { ok: false, workItemId, runId, stage: "run", detail: outcome.failure.detail };
      }

      await store.append(runId, version, [
        {
          type: "RunFinished",
          actor: "conductor",
          data: parsePayload("RunFinished", {
            exitCode: outcome.exitCode ?? 0,
            turns: outcome.turns,
            durationMs: outcome.durationMs,
            costUsd: outcome.costUsd,
          }),
        },
      ]);
      log(`run finished: ${outcome.turns} turns, ${outcome.costUsd ?? "unknown"} usd`);

      // ---- 7. the diff the gates will be about --------------------------
      const headSha = await git(["rev-parse", "HEAD"], { ...{ token: options.token, env: options.gitEnv }, cwd: worktree.path });
      const stat = await git(["diff", "--numstat", `${worktree.baseSha}..HEAD`], {
        token: options.token,
        env: options.gitEnv,
        cwd: worktree.path,
      });
      const rows = stat.split("\n").filter(Boolean).map((l) => l.split("\t"));
      const insertions = rows.reduce((n, r) => n + (Number(r[0]) || 0), 0);
      const deletions = rows.reduce((n, r) => n + (Number(r[1]) || 0), 0);

      if (headSha === worktree.baseSha) {
        await release("the agent produced no commits");
        return { ok: false, workItemId, runId, stage: "diff", detail: "no commits" };
      }

      let at = (await store.read(runId)).length;
      await store.append(runId, at, [
        {
          type: "RunProducedDiff",
          actor: "conductor",
          data: parsePayload("RunProducedDiff", {
            branch,
            headSha,
            files: rows.length,
            insertions,
            deletions,
          }),
        },
        {
          // The moment the gate pipeline fires.
          type: "RunProposedCompletion",
          actor: "conductor",
          data: parsePayload("RunProposedCompletion", { headSha }),
        },
      ]);
      void proposedSha;

      // ---- 8. the gates ---------------------------------------------------
      const gates = gatesFromRecipe(recipe.gates);
      const pipeline = await runGatePipeline({
        gates,
        context: { runId, onSha: headSha, cwd: worktree.path, env: runnableEnv(env.values) },
        emit: async (event) => {
          const at = (await store.read(runId)).length;
          await store.append(runId, at, [
            { type: event.type, actor: "conductor", data: event.data },
          ]);
        },
      });
      log(`gates: ${pipeline.results.map((r) => `${r.gate}=${r.verdict}`).join(" ")}`);

      // The agent's branch has to exist on the remote for the integrator to
      // merge it; it works in a worktree, not on origin.
      await git(["push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`], {
        token: options.token,
        env: options.gitEnv,
        cwd: worktree.path,
      });

      // And then the worktree has done its job. It has to go *before* the
      // integrator runs: it holds `agent/<n>` checked out against the same
      // mirror, and git refuses to update a ref that some worktree has checked
      // out. Keeping it alive through the merge is what made the first
      // end-to-end run fail.
      await removeWorktree({ project, runId, home }).catch(() => {});

      // ---- 9. hold, if a person asked to see it first ----------------------
      // After the push, so the branch is there to look at, and after the gates,
      // so what is being approved is a diff someone has evidence about.
      //
      // The approval is requested even when a gate refused. "The build is red,
      // merge anyway" is a decision a person is allowed to make — that is what
      // a waiver is for — and pre-empting it here would mean the flag silently
      // means something different on a red run than on a green one.
      if (options.merge === false) {
        const gate = "merge";
        const at = (await store.read(runId)).length;
        await store.append(runId, at, [
          {
            type: "ApprovalRequested",
            actor: "conductor",
            data: parsePayload("ApprovalRequested", {
              gate,
              runId,
              onSha: headSha,
              question: pipeline.ok
                ? `Merge ${branch} into ${base}? Every gate passed.`
                : `Merge ${branch} into ${base} anyway? The ${pipeline.failedAt} gate refused.`,
              artifacts: [`${branch}@${headSha}`],
            }),
          },
        ]);
        // Blocked rather than released, the same as a refusal — a question for
        // a person belongs in "Waiting on you", not back in the queue where
        // another run could claim it and throw the question away. It also stops
        // the claim's lease from quietly expiring while someone thinks.
        const blockedAt = (await store.read(workItemId)).length;
        await store.append(workItemId, blockedAt, [
          {
            type: "WorkItemBlocked",
            actor: "conductor",
            data: parsePayload("WorkItemBlocked", {
              question: `held for approval to merge ${branch} into ${base}`,
              needsFrom: "human",
              runId,
            }),
          },
        ]);
        released = true;

        log(`held at ${headSha.slice(0, 7)} — asked for approval to merge into ${base}`);
        return { ok: "held", workItemId, runId, headSha, gate };
      }

      // ---- 10. the merge lane ---------------------------------------------
      const merged = await integrate({
        project,
        owner: options.client.owner,
        repo: options.client.repo,
        base,
        branch,
        workItemId,
        headSha,
        gatesPassed: pipeline.ok,
        gateDetail: pipeline.failedAt
          ? `${pipeline.failedAt}: ${pipeline.results.find((r) => r.gate === pipeline.failedAt)?.evidence ?? ""}`
          : undefined,
        token: options.token,
        home,
        gitEnv: options.gitEnv,
        store,
      });

      if (!merged.ok) {
        // Blocked rather than released: a refusal is a question for a person,
        // and the board's "Waiting on you" column is where it goes.
        const blockedAt = (await store.read(workItemId)).length;
        await store.append(workItemId, blockedAt, [
          {
            type: "WorkItemBlocked",
            actor: "conductor",
            data: parsePayload("WorkItemBlocked", {
              question: `${merged.reason}: ${merged.detail.slice(0, 500)}`,
              needsFrom: "human",
              runId,
            }),
          },
        ]);
        released = true;
        return { ok: false, workItemId, runId, stage: "integrate", detail: `${merged.reason}: ${merged.detail}` };
      }

      const landedAt = (await store.read(workItemId)).length;
      await store.append(workItemId, landedAt, [
        {
          type: "WorkItemLanded",
          actor: "conductor",
          data: parsePayload("WorkItemLanded", { mergeCommit: merged.mergeCommit, base }),
        },
      ]);
      released = true;
      log(`landed ${merged.mergeCommit.slice(0, 7)} on ${base}`);
      return { ok: true, workItemId, runId, mergeCommit: merged.mergeCommit };
    } finally {
      server.unregister(runId);
      await server.close().catch(() => {});
    }
  } catch (err) {
    // The catch-all that keeps "every exit appends" true for anything
    // unforeseen. Without it a thrown error would leave the item claimed by a
    // run that is over — the state the lease exists to make survivable, but not
    // a state to create on purpose.
    await release(`unexpected failure: ${(err as Error).message}`);
    return { ok: false, workItemId, runId, stage: "unexpected", detail: (err as Error).message };
  } finally {
    await removeWorktree({ project, runId, home }).catch(() => {});
  }
}
