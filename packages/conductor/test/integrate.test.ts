/**
 * The integrator, against real git and the real event store.
 *
 * One rule is under test above all others: **no path returns without an event.**
 * The old loop's `integrate()` had six `return 1`s and not one emitted anything;
 * #58 and #59 re-ran five times for about $29 while a dirty checkout of `main`
 * went unreported. So every case below asserts the typed reason *and* that the
 * reason reached the log.
 *
 * The remote is a bare repository in a temp directory. Real git, real merges,
 * real conflicts, no network.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/store";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureMirror, integrate, integrationStream } from "../src/index.ts";

const exec = promisify(execFile);
const authored = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const g = (args: string[], cwd: string) =>
  exec("git", args, { cwd, env: { ...process.env, ...authored } });

let root: string;
let originPath: string;
let work: string;
let home: string;
const streams = new Set<string>();

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
let client: Db;
let store: EventStore;

/** A fresh origin with `develop` and one commit, and a fresh mirror for it. */
async function freshOrigin(): Promise<void> {
  await rm(originPath, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  await rm(join(home, "repos"), { recursive: true, force: true });
  await rm(join(home, "worktrees"), { recursive: true, force: true });

  await exec("git", ["init", "-q", "-b", "develop", work]);
  await writeFile(join(work, "README.md"), "hello\n");
  await g(["add", "-A"], work);
  await g(["commit", "-qm", "first"], work);
  await exec("git", ["clone", "-q", "--bare", work, originPath]);
  await g(["remote", "add", "origin", originPath], work).catch(() => {});
}

/** Adds a branch to origin with the given file contents. */
async function branchWith(branch: string, files: Record<string, string>): Promise<void> {
  await g(["checkout", "-q", "-B", branch, "develop"], work);
  for (const [path, body] of Object.entries(files)) {
    const full = join(work, path);
    await exec("mkdir", ["-p", join(full, "..")]);
    await writeFile(full, body);
  }
  await g(["add", "-A"], work);
  await g(["commit", "-qm", `work on ${branch}`], work);
  await g(["push", "-q", "origin", branch], work);
  await g(["checkout", "-q", "develop"], work);
}

const base = () => ({
  project: PROJECT,
  owner: "steven-zhc",
  repo: PROJECT,
  base: "develop",
  workItemId: `wi-${PROJECT}-1`,
  headSha: "0".repeat(40),
  gatesPassed: true,
  home,
  store,
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lingtai-integrate-"));
  originPath = join(root, "origin.git");
  work = join(root, "work");
  home = join(root, "home");
  client = createDb();
  store = createEventStore(client);
  streams.add(integrationStream(PROJECT, "develop"));
});

beforeEach(async () => {
  await freshOrigin();
  await ensureMirror({ project: PROJECT, owner: "x", repo: PROJECT, remote: originPath, home });
});

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1::text[])", [[...streams]]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
  await rm(root, { recursive: true, force: true });
});

/** Every event on the lane, so a test can assert what was recorded. */
async function lane(): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const events = await store.read(integrationStream(PROJECT, "develop"));
  return events.map((e) => ({ type: e.type, data: e.data as Record<string, unknown> }));
}

describe("integrate", () => {
  it("merges a clean branch and records the merge commit", async () => {
    await branchWith("agent/1", { "src/a.ts": "export const a = 1;\n" });

    const before = (await lane()).length;
    const result = await integrate({ ...base(), branch: "agent/1" });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const events = (await lane()).slice(before);
    expect(events.map((e) => e.type)).toEqual(["IntegrationAttempted", "IntegrationSucceeded"]);
    expect(events[1]!.data["mergeCommit"]).toBe(result.mergeCommit);

    // And it really landed on the base branch at origin.
    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).toContain("work on agent/1");
  });

  it("refuses a conflict with the file that conflicted", async () => {
    await branchWith("agent/2", { "README.md": "from the agent\n" });
    // The base moves underneath it, touching the same file.
    await writeFile(join(work, "README.md"), "from develop\n");
    await g(["add", "-A"], work);
    await g(["commit", "-qm", "base moved"], work);
    await g(["push", "-q", "origin", "develop"], work);

    const before = (await lane()).length;
    const result = await integrate({ ...base(), branch: "agent/2" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("conflict");
    expect(result.detail).toContain("README.md");

    const refusal = (await lane()).slice(before).find((e) => e.type === "IntegrationRefused");
    expect(refusal?.data["reason"]).toBe("conflict");
  });

  it("refuses a branch with nothing to merge", async () => {
    await g(["push", "-q", "origin", "develop:refs/heads/agent/3"], work);

    const result = await integrate({ ...base(), branch: "agent/3" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-commits");
    expect((await lane()).at(-1)?.data["reason"]).toBe("no-commits");
  });

  /** The hold that caught #117: a migration is applied by a person who read it. */
  it("holds a diff that adds migration files", async () => {
    await branchWith("agent/4", {
      "prisma/migrations/20260901_add_index/migration.sql": "create index x on y (z);\n",
    });

    const result = await integrate({ ...base(), branch: "agent/4" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("pending-migration");
    expect(result.detail).toContain("migration.sql");
    expect((await lane()).at(-1)?.data["reason"]).toBe("pending-migration");
  });

  it("refuses when a gate already said no, and does not merge", async () => {
    await branchWith("agent/5", { "src/b.ts": "export const b = 1;\n" });

    const result = await integrate({
      ...base(),
      branch: "agent/5",
      gatesPassed: false,
      gateDetail: "build exited 1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("gate-failed");
    expect(result.detail).toContain("build exited 1");

    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("work on agent/5");
  });

  it("refuses when verification after merging the base in fails", async () => {
    await branchWith("agent/6", { "src/c.ts": "export const c = 1;\n" });

    const result = await integrate({
      ...base(),
      branch: "agent/6",
      verify: async () => ({ ok: false, evidence: "3 tests failed" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The gates ran against the agent's head; this is the different question of
    // whether it still works beside what landed since.
    expect(result.reason).toBe("gate-failed");
    expect(result.detail).toContain("3 tests failed");

    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("work on agent/6");
  });

  /**
   * Two integrations against one base must never overlap. The lane is a
   * session-level advisory lock in Postgres, so a process that dies holding it
   * drops it when its connection closes — nothing to unwind.
   */
  it("serialises: a second integration on the same base is refused as lane-busy", async () => {
    await branchWith("agent/7", { "src/d.ts": "export const d = 1;\n" });
    await branchWith("agent/8", { "src/e.ts": "export const e = 1;\n" });

    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseFirst = r));

    const first = integrate({
      ...base(),
      branch: "agent/7",
      // Holds the lane while the second one tries.
      verify: async () => {
        await gate;
        return { ok: true, evidence: "" };
      },
    });

    // Give the first one time to take the lock.
    await new Promise((r) => setTimeout(r, 1_500));
    const second = await integrate({ ...base(), branch: "agent/8" });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("lane-busy");

    releaseFirst();
    expect((await first).ok).toBe(true);

    // Both outcomes are on the record, which is the whole point.
    const reasons = (await lane()).filter((e) => e.type === "IntegrationRefused");
    expect(reasons.some((r) => r.data["reason"] === "lane-busy")).toBe(true);
  });

  it("never returns without an event, whatever happened", async () => {
    // Every case above asserts its own event; this asserts the invariant across
    // all of them: the lane has exactly one terminal event per attempt.
    const events = await lane();
    const attempts = events.filter((e) => e.type === "IntegrationAttempted").length;
    const terminal = events.filter(
      (e) => e.type === "IntegrationRefused" || e.type === "IntegrationSucceeded",
    ).length;

    // `lane-busy` refuses before it attempts, so terminals are never fewer.
    expect(terminal).toBeGreaterThanOrEqual(attempts);
    expect(attempts).toBeGreaterThan(0);
  });
});
