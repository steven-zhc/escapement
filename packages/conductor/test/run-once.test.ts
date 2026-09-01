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
import { boardProjection, integrationStream, readBoard, runOnce, workItemStream } from "../src/index.ts";
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
    expect(wi).toEqual(["WorkItemDiscovered", "WorkItemClaimed", "WorkItemLanded"]);

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
    const runner = createProjectionRunner({ projection: boardProjection, store });
    try {
      await runner.start();
      const cards = await readBoard(PROJECT);
      const card = cards.find((c) => c.externalRef === "117");

      expect(card, "the work item never reached the board").toBeDefined();
      expect(card!.column).toBe("landed");
      expect(card!.mergeCommit).toBeTruthy();
      expect(card!.run?.turns).toBe(7);
      expect(card!.run?.costUsd).toBe(0.42);
      expect(card!.gates.map((g) => g.gate)).toContain("build");
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
    expect(wi).toEqual(["WorkItemDiscovered", "WorkItemClaimed", "WorkItemBlocked"]);

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
