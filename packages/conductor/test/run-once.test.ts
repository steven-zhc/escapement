/**
 * `esc run --once`, end to end.
 *
 * Everything real except GitHub: a bare repository in a temp directory as the
 * remote, the compiled `esc-hook` on a real unix socket, real gates running real
 * commands, the real integrator taking a real advisory lock, and the real board
 * projection at the end. The agent is a shell script that makes a commit,
 * because what is under test is the *wiring* — the order of the steps and what
 * each one records — and not the model.
 *
 * The one piece that is a stand-in is the GitHub client, because there is no
 * GitHub App yet. #17's exit criterion is a real `nextloom-ai-admin` issue
 * merged into `develop`, and that needs an App created by a person. This is as
 * close as it is possible to get without one, and it is close: discovery,
 * claim, worktree, hook, run, diff, gates, merge and board, all genuinely
 * executed.
 */
import { directDatabaseUrl } from "@escapement/env";
import type { GitHubClient, Issue } from "@escapement/github";
import { createClaudeCodeRuntime } from "@escapement/runtime";
import { createDb, createEventStore, createProjectionRunner, type Db, type EventStore } from "@escapement/store";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve, integrationStream, readTasks, reject, renderPrompt, runOnce, runQueue, syncQueued, taskViewProjection, waive, workItemStream } from "../src/index.ts";
import type { ProjectState } from "@escapement/core";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const authored = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const g = (args: string[], cwd: string) =>
  exec("git", args, { cwd, env: { ...process.env, ...authored } });

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();

let root: string;
let originPath: string;
let work: string;
let home: string;
let hookBinary: string;
let client: Db;
let store: EventStore;

const RECIPE = `
version: 1
repo: { base: develop, submodules: false }
source: { kinds: [bug], exclude: [blocked] }
env: { allow: [ESC_TEST_VALUE], plantAt: .env.local }
gates:
  - { kind: process, name: build, run: "test -f src/fix.ts", timeout: 2m }
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
`;

const project: ProjectState = {
  project: PROJECT,
  owner: "steven-zhc",
  // Recorded at onboarding. The fake client's default branch is `develop` too,
  // so this test would pass either way — which is exactly why the real repo
  // (whose default is a feature branch) is the one that found the bug.
  base: "develop",
  tier: "guarded",
  requiredGates: ["build"],
  approvers: [],
  concurrent: 1,
  policyBy: "human:test",
  policyReason: "test",
  configHash: "seeded",
  fromSha: "0".repeat(40),
  version: 1,
  lastSeq: null,
};

const issue2 = (n: number): Issue => ({ ...issue, number: n });

const issue: Issue = {
  number: 117,
  title: "a race in the importer",
  body: "fix it",
  labels: ["bug"],
  state: "open",
  url: "https://example.invalid/117",
};

/** A recipe whose only gate refuses, whatever the agent did. */
const REFUSING_RECIPE = RECIPE.replace(
  'run: "test -f src/fix.ts"',
  'run: "echo the build is broken; exit 1"',
);

/** GitHub, minus GitHub. Serves the issue and the recipe from the base branch. */
function fakeClient(over: Partial<GitHubClient> & { recipe?: string } = {}): GitHubClient {
  const { recipe = RECIPE, ...rest } = over;
  return {
    owner: "steven-zhc",
    repo: PROJECT,
    installation: { id: 1, permissions: {}, account: "steven-zhc", repositorySelection: "selected" },
    request: async () => {
      throw new Error("not used");
    },
    // Throws rather than returning a dummy: these tests clone from a local path
    // and must never authenticate. If something starts asking for a token, the
    // test should say so loudly rather than quietly succeed with a fake one.
    token: async () => {
      throw new Error("not used");
    },
    defaultBranch: async () => "develop",
    // The governance rule: the recipe comes from the base branch, and this
    // client will not serve it for any other ref.
    fileAt: async (path, ref) =>
      path === ".escapement/config.yaml" && ref === "develop" ? recipe : null,
    refSha: async () => "0".repeat(40),
    listOpenIssues: async () => [issue],
    getIssue: async () => issue,
    ...rest,
  };
}

/** An "agent" that edits a file and commits, exactly as a real one would. */
async function agentThat(body: string): Promise<string> {
  const path = join(root, `agent-${crypto.randomUUID().slice(0, 8)}.sh`);
  await writeFile(
    path,
    `#!/bin/sh
set -e
${body}
echo '{"is_error":false,"num_turns":7,"duration_ms":1234,"total_cost_usd":0.42}'
`,
  );
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "esc-runonce-"));
  originPath = join(root, "origin.git");
  work = join(root, "work");
  home = join(root, "home");

  await exec("git", ["init", "-q", "-b", "develop", work]);
  await writeFile(join(work, "README.md"), "hello\n");
  await g(["add", "-A"], work);
  await g(["commit", "-qm", "first"], work);
  await exec("git", ["clone", "-q", "--bare", work, originPath]);

  hookBinary = join(root, "esc-hook");
  await exec("bun", ["build", "--compile", "--outfile", hookBinary, resolve(here, "../../hook/src/esc-hook.ts")]);

  client = createDb();
  store = createEventStore(client);

  created.add(workItemStream(PROJECT, 117));
  created.add(integrationStream(PROJECT, "develop"));
}, 240_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule escapement_events_no_delete");
    await c.query("delete from events where stream_id = any($1::text[])", [[...created]]);
    await c.query("delete from events where stream_id like $1", [`run-%`]);
  } finally {
    await c.query("alter table events enable rule escapement_events_no_delete");
    await c.query("delete from board where project = $1", [PROJECT]);
    await c.query("delete from board_project where project = $1", [PROJECT]);
    await c.query("delete from checkpoints where name = 'board'");
    await c.end();
  }
  await rm(root, { recursive: true, force: true });
});

const options = (agent: string) => ({
  project,
  client: fakeClient(),
  runtime: createClaudeCodeRuntime({ binary: agent }),
  issue: 117,
  hookBinary,
  prompt: "fix the race",
  home,
  store,
  remote: originPath,
  gitEnv: { ...process.env, ...authored },
});

describe("runOnce", () => {
  it("takes one issue from discovery to a merge, and records the whole story", async () => {
    process.env["ESC_TEST_VALUE"] = "planted";

    const agent = await agentThat(`
mkdir -p src
echo 'export const fix = 1;' > src/fix.ts
git add -A
git -c user.name=agent -c user.email=a@example.invalid commit -qm 'fix the race'
`);

    const lines: string[] = [];
    const result = await runOnce({ ...options(agent), log: (l) => lines.push(l) });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    created.add(result.runId);

    // It really landed on the base branch at the remote.
    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).toContain("fix the race");

    // ---- the event stream reads as a coherent story with no gaps ----
    const wi = (await store.read(workItemId())).map((e) => e.type);
    expect(wi).toEqual(["WorkItemClaimed", "WorkItemLanded"]);

    const run = (await store.read(result.runId)).map((e) => e.type);
    expect(run.slice(0, 2)).toEqual(["RunStarted", "RunFinished"]);
    expect(run).toContain("RunProducedDiff");
    expect(run).toContain("RunProposedCompletion");
    expect(run).toContain("GateRequested");
    expect(run).toContain("GatePassed");

    const lane = (await store.read(integrationStream(PROJECT, "develop"))).map((e) => e.type);
    expect(lane).toEqual(["IntegrationAttempted", "IntegrationSucceeded"]);

    // The receipt survived the round trip.
    const finished = (await store.read(result.runId)).find((e) => e.type === "RunFinished")!;
    expect(finished.data).toMatchObject({ turns: 7, costUsd: 0.42 });

    // The agent could see the allowlisted value and nothing else.
    expect(lines.join("\n")).toContain("worktree");
  }, 240_000);

  it("shows the landed card on the board with its receipt", async () => {
    const runner = createProjectionRunner({ projection: taskViewProjection, store });
    try {
      await runner.start();
      const cards = await readTasks({ project: PROJECT, retentionDays: 3650 });
      const card = cards.find((c) => c.issue === "117");

      expect(card, "the work item never reached the board").toBeDefined();
      expect(card!.state).toBe("landed");
      expect(card!.note).toBeTruthy();
      expect(card!.turns).toBe(7);
      expect(card!.costUsd).toBe(0.42);
      // The count, not the verdicts: evidence is read from the stream when
      // somebody opens the task.
      expect(card!.gatesPassed).toBeGreaterThan(0);
    } finally {
      await runner.close();
    }
  }, 120_000);

  it("blocks with the typed reason when a gate refuses, and does not merge", async () => {
    // A second issue, so the first one's history stays intact.
    const other = { ...issue, number: 118 };
    created.add(workItemStream(PROJECT, 118));

    // A perfectly ordinary change, against a recipe whose gate refuses. The
    // gate has to be the thing that fails rather than the file state: by now
    // `develop` contains what the first run merged, so a gate looking for that
    // file would pass — which is exactly how this test failed the first time.
    const agent = await agentThat(`
echo 'a change like any other' > CHANGELOG.md
git add -A
git -c user.name=agent -c user.email=a@example.invalid commit -qm 'wrong change'
`);

    const result = await runOnce({
      ...options(agent),
      issue: 118,
      client: fakeClient({
        recipe: REFUSING_RECIPE,
        getIssue: async () => other,
        listOpenIssues: async () => [other],
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    created.add(result.runId!);
    expect(result.stage).toBe("integrate");
    expect(result.detail).toContain("gate-failed");
    // The evidence travels with the refusal: the board shows why, not that.
    expect(result.detail).toContain("the build is broken");

    // Blocked with a question, not silently dropped — the board's "Waiting on
    // you" column is where a refusal goes.
    const wi = (await store.read(workItemStream(PROJECT, 118))).map((e) => e.type);
    expect(wi).toEqual(["WorkItemClaimed", "WorkItemBlocked"]);

    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("wrong change");
  }, 240_000);

  /**
   * `nextloom-ai-admin`'s default branch is a feature branch, not `develop`.
   * Falling back to it would read a run's rules from one branch while merging
   * into another — the confusion 0005 exists to prevent.
   */
  it("reads the recipe from the recorded base, not the default branch", async () => {
    let askedFor: string[] = [];
    const result = await runOnce({
      ...options(await agentThat("true")),
      issue: 121,
      client: fakeClient({
        // GitHub says the default is something else entirely.
        defaultBranch: async () => "feature/062-user-suggested-skills",
        fileAt: async (path, ref) => {
          askedFor.push(ref);
          return path === ".escapement/config.yaml" && ref === "develop" ? RECIPE : null;
        },
      }),
    });

    // It asked `develop` — the recorded base — and never the default branch.
    expect(askedFor).toContain("develop");
    expect(askedFor).not.toContain("feature/062-user-suggested-skills");
    // It got past the recipe stage, which is all this case is about.
    if (!result.ok) expect(result.stage).not.toBe("recipe");
  }, 120_000);

  /**
   * The point of the stage, stated as a test: whatever prepare does, the agent
   * is looking at afterwards. Before it existed the agent got a worktree with no
   * node_modules and could not run the repository's own tests — it wrote blind,
   * and nothing said so until a gate failed at the very end.
   *
   * Here prepare writes a file and the agent refuses unless it is there.
   */
  it("runs prepare before the agent, so the agent sees a worktree that works", async () => {
    const recipe = RECIPE.replace(
      "source:",
      'prepare:\n  - { name: install, run: "echo ready > .prepared", timeout: 1m }\nsource:',
    );
    const agent = await agentThat(`
test -f .prepared || { echo "prepare did not run before me"; exit 1; }
mkdir -p src && echo "export const x = 1;" > src/fix.ts
git add -A && git commit -q -m "fix the race"
`);

    const result = await runOnce({
      ...options(agent),
      issue: 122,
      client: fakeClient({ recipe, getIssue: async () => ({ ...issue, number: 122 }) }),
    });

    expect(result.ok).toBe(true);

    const events = (await store.read(result.runId!)).map((e) => e.type);
    // Ordering is the assertion. Prepare finishes before the run begins.
    expect(events.indexOf("PreparationPassed")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("PreparationPassed")).toBeLessThan(events.indexOf("RunStarted"));
  }, 180_000);

  it("refuses at prepare without starting the agent, and says which step", async () => {
    const recipe = RECIPE.replace(
      "source:",
      'prepare:\n  - { name: install, run: "echo could not resolve dependency; exit 1", timeout: 1m }\nsource:',
    );
    // If this ever runs, the test fails loudly rather than quietly passing.
    const agent = await agentThat(`echo "the agent must not have started"; exit 1`);

    const result = await runOnce({
      ...options(agent),
      issue: 123,
      client: fakeClient({ recipe, getIssue: async () => ({ ...issue, number: 123 }) }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("prepare");
    // The log tail, not just "it failed". A card has to be workable without
    // leaving it.
    expect(result.detail).toContain("could not resolve dependency");

    const events = (await store.read(result.runId!)).map((e) => e.type);
    expect(events).toContain("PreparationFailed");
    // The whole cost argument: nothing expensive happened.
    expect(events).not.toContain("RunStarted");

    // And the work item goes back rather than sitting claimed by a run that is
    // over — the same rule every other refusal follows.
    const item = await store.read(workItemStream(PROJECT, 123));
    expect(item.map((e) => e.type)).toContain("WorkItemReleased");
  }, 180_000);

  /**
   * `--no-merge` is the only thing standing between a passing gate and a write
   * to the base branch until the human gate exists (#20). It is also how rung 2
   * of the ladder runs at all.
   */
  it("holds after the gates instead of merging, and asks for approval", async () => {
    // Unique content. `develop` is shared across these tests and an earlier one
    // merges `src/fix.ts`; writing the same bytes again produces no commit, and
    // the run then fails at `diff` for a reason that has nothing to do with
    // holding.
    const agent = await agentThat(`
mkdir -p src && echo "export const held = 124;" > src/fix.ts
git add -A && git commit -q -m "fix the race"
`);
    const before = await g(["rev-parse", "develop"], originPath);

    const result = await runOnce({
      ...options(agent),
      issue: 124,
      merge: false,
      client: fakeClient({ getIssue: async () => ({ ...issue, number: 124 }) }),
    });

    expect(result.ok).toBe("held");
    if (result.ok !== "held") return;

    // Nothing was written to the base branch. That is the entire promise.
    expect((await g(["rev-parse", "develop"], originPath)).stdout).toBe(before.stdout);

    const events = (await store.read(result.runId)).map((e) => e.type);
    // The gates ran and their verdicts stand — a hold is not a skip.
    expect(events).toContain("GatePassed");
    // And it asked, in the vocabulary the human gate will use, rather than
    // inventing a second one.
    expect(events).toContain("ApprovalRequested");
    expect(events).not.toContain("IntegrationAttempted");

    // "Waiting on you", not back in the queue where another run could claim it
    // and throw the question away.
    const item = (await store.read(result.workItemId)).map((e) => e.type);
    expect(item).toContain("WorkItemBlocked");
    expect(item).not.toContain("WorkItemReleased");

    // ---- and then approving it merges the thing that was looked at ---------
    const approved = await approve({
      project: PROJECT,
      issue: 124,
      base: "develop",
      client: fakeClient({ refSha: async () => result.headSha }),
      by: "human:test",
      store,
      home,
      gitEnv: { ...process.env, ...authored },
    });

    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect((await g(["rev-parse", "develop"], originPath)).stdout).not.toBe(before.stdout);
  }, 180_000);

  /**
   * The reason the approval carries a sha at all. In the old system approval was
   * a label, and a label survives any amount of rewriting — so a force-push
   * inherited its own approval.
   */
  it("refuses to merge an approval whose branch has moved since", async () => {
    const agent = await agentThat(`
mkdir -p src && echo "export const held = 125;" > src/fix.ts
git add -A && git commit -q -m "fix the race"
`);
    const result = await runOnce({
      ...options(agent),
      issue: 125,
      merge: false,
      client: fakeClient({ getIssue: async () => ({ ...issue, number: 125 }) }),
    });
    expect(result.ok).toBe("held");
    if (result.ok !== "held") return;

    const before = (await g(["rev-parse", "develop"], originPath)).stdout;

    const approved = await approve({
      project: PROJECT,
      issue: 125,
      base: "develop",
      // The branch head is not what was approved: someone pushed after the ask.
      client: fakeClient({ refSha: async () => "9".repeat(40) }),
      by: "human:test",
      store,
      home,
      gitEnv: { ...process.env, ...authored },
    });

    expect(approved.ok).toBe(false);
    if (approved.ok) return;
    expect(approved.reason).toBe("stale");
    // Nothing merged, and the message names both shas rather than saying "no".
    expect(approved.detail).toContain(result.headSha.slice(0, 7));
    expect((await g(["rev-parse", "develop"], originPath)).stdout).toBe(before);
  }, 180_000);

  /**
   * The three things a person can do, and the rules that keep them honest.
   * #21 calls this the ticket the whole project is a bet on.
   */
  describe("deciding", () => {
    const held = async (issue: number, marker: string) => {
      const agent = await agentThat(`
mkdir -p src && echo "export const held = ${marker};" > src/fix.ts
git add -A && git commit -q -m "fix the race"
`);
      const result = await runOnce({
        ...options(agent),
        issue,
        merge: false,
        client: fakeClient({ getIssue: async () => ({ ...issue2(issue) }) }),
      });
      expect(result.ok).toBe("held");
      return result as Extract<typeof result, { ok: "held" }>;
    };

    it("refuses a waiver with no reason, because a silent waiver is the thing being replaced", async () => {
      const r = await held(130, "130");
      const outcome = await waive({
        project: PROJECT,
        issue: 130,
        gate: "build",
        by: "human:test",
        reason: "   ",
        store,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("needs a reason");
      expect(r.runId).toBeTruthy();
    }, 180_000);

    it("records who and why on a waiver, and binds it to the commit", async () => {
      const r = await held(131, "131");
      const outcome = await waive({
        project: PROJECT,
        issue: 131,
        gate: "build",
        by: "human:test",
        reason: "unrelated flake in the importer suite",
        store,
      });

      expect(outcome.ok).toBe(true);
      const waived = (await store.read(r.runId)).find((e) => e.type === "GateWaived");
      const d = waived?.data as { by: string; reason: string; onSha: string };
      // Never silent. Both halves, on the event, on the card.
      expect(d.by).toBe("human:test");
      expect(d.reason).toContain("unrelated flake");
      // And about a diff, so a force-push stops it counting by arithmetic.
      expect(d.onSha).toBe(r.headSha);
    }, 180_000);

    it("refuses a decision made against a commit the card is no longer showing", async () => {
      const r = await held(132, "132");
      const outcome = await waive({
        project: PROJECT,
        issue: 132,
        gate: "build",
        by: "human:test",
        reason: "looks fine",
        // What a stale card would send.
        onSha: "0".repeat(40),
        store,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain(r.headSha.slice(0, 7));
    }, 180_000);

    it("sends a rejection back to the gate rather than to the queue", async () => {
      const r = await held(133, "133");
      const outcome = await reject({
        project: PROJECT,
        issue: 133,
        base: "develop",
        client: fakeClient(),
        by: "human:test",
        reason: "wrong approach",
        store,
      });

      expect(outcome.ok).toBe(true);
      const events = (await store.read(r.runId)).map((e) => e.type);
      expect(events).toContain("ApprovalRevoked");
      // Still waiting on a person, not released for another run to claim and
      // throw the question away.
      const item = (await store.read(r.workItemId)).map((e) => e.type);
      expect(item).not.toContain("WorkItemReleased");
    }, 180_000);

    it("refuses someone the project's policy did not name", async () => {
      await held(134, "134");
      const outcome = await waive({
        project: PROJECT,
        issue: 134,
        gate: "build",
        by: "human:someone-else",
        approvers: ["human:steven"],
        reason: "trust me",
        store,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("not in this project's approvers");
    }, 180_000);
  });

  /**
   * Taking the queue, which is what "consecutive" in Phase 2's exit criterion
   * means. The dangerous test is the second one.
   */
  describe("the scheduler", () => {
    // Its own project. `runQueue` drains a project's queue, and every other
    // test in this file leaves work items in PROJECT's — so sharing it would
    // make these two assert on their neighbours' rows. The same isolation the
    // live tests already needed.
    const SCHED = `${PROJECT}sched`;
    const schedProject: ProjectState = { ...project, project: SCHED };

    const queued = async (refs: number[]) => {
      // What the conductor does: ask GitHub, write the runnable set into
      // `task_view`. Nothing is appended — since 0012 the queue is not in the
      // log, so seeding it by appending would be testing a path that no longer
      // exists.
      const runner = createProjectionRunner({ projection: taskViewProjection, store });
      try {
        await runner.start();
      } finally {
        await runner.close();
      }
      await syncQueued(
        SCHED,
        refs.map((ref) => ({ ref: String(ref), title: `issue ${ref}`, kind: "bug" })),
      );
    };

    it("takes items itself, in order, without anyone naming them", async () => {
      await queued([140, 141]);
      const agent = await agentThat(`
mkdir -p src && echo "export const q = $RANDOM;" > src/fix.ts
git add -A && git commit -q -m "fix"
`);

      const outcome = await runQueue({
        project: schedProject,
        client: fakeClient({ getIssue: async (n: number) => issue2(n) }),
        runtime: createClaudeCodeRuntime({ binary: agent }),
        hookBinary,
        prompt: "fix the race",
        kinds: ["bug"],
        max: 2,
        merge: false,
        home,
        store,
        remote: originPath,
        gitEnv: { ...process.env, ...authored },
      });

      // Two, consecutively, and nobody typed a second number.
      expect(outcome.ran).toHaveLength(2);
      expect(outcome.stopped).toBe("max");
      expect(new Set(outcome.attempted).size).toBe(2);
    }, 300_000);

    /**
     * The one that matters. `runOnce` releases a failed item back into the
     * queue, so the obvious loop takes it again immediately — forever, at the
     * price of an agent call per pass. The old loop did a version of this: #58
     * and #59 re-ran five times for roughly $29.
     */
    it("does not take the same failing item twice in one pass", async () => {
      await queued([142]);
      // Fails every time, and is released every time.
      const agent = await agentThat(`echo "no commits from me"; exit 0`);

      const outcome = await runQueue({
        project: schedProject,
        client: fakeClient({ getIssue: async (n: number) => issue2(n) }),
        runtime: createClaudeCodeRuntime({ binary: agent }),
        hookBinary,
        prompt: "fix the race",
        kinds: ["bug"],
        home,
        store,
        remote: originPath,
        gitEnv: { ...process.env, ...authored },
      });

      // One attempt, not an unbounded number of them.
      expect(outcome.ran).toHaveLength(1);
      expect(outcome.ran[0]?.ok).toBe(false);
      // And it says *why* it stopped: the queue is not empty, everything left
      // has been tried. A caller reading this as "all done" would be wrong,
      // which is why it is not called `empty`.
      expect(outcome.stopped).toBe("exhausted");
    }, 300_000);
  });

  /**
   * The defect that made the first real run useless. The prompt said "read the
   * issue" and the agent was handed a number — no title, no body, and no `gh`
   * to fetch one with. Thirty turns and $1.11 later it had written to
   * `.escapement/config.yaml`, the only thing in the worktree that looked like
   * an instruction, and committed nothing.
   */
  it("gives the implementer the ticket, not just its number", () => {
    const filled = renderPrompt("#{{issue}} — {{title}}\n\n{{body}}", {
      number: 120,
      title: "The dashboard reports state but does not start work",
      body: "`/` shows twelve stat tiles and no way in.",
    });

    expect(filled).toContain("#120");
    expect(filled).toContain("The dashboard reports state");
    expect(filled).toContain("twelve stat tiles");
    // Nothing left for the agent to wonder about.
    expect(filled).not.toContain("{{");
  });

  it("refuses before claiming anything when the recipe cannot be read", async () => {
    const result = await runOnce({
      ...options(await agentThat("true")),
      issue: 119,
      client: fakeClient({ fileAt: async () => null }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // An unreadable recipe stops the run rather than falling back to a default.
    expect(result.stage).toBe("recipe");
    expect(result.workItemId).toBeNull();
    expect(await store.read(workItemStream(PROJECT, 119))).toEqual([]);
  }, 120_000);
});

function workItemId(): string {
  return workItemStream(PROJECT, 117);
}
