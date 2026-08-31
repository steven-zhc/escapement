/**
 * The hook, end to end, against the real compiled binary.
 *
 * `PreToolUse` sits in front of every tool call an agent makes, so the two
 * claims worth proving are the ones that are cheap to assert and expensive to be
 * wrong about: **it fails closed**, and **it is fast enough to sit there**.
 * Both are measured here rather than asserted — the binary is built with bun and
 * spawned as a process, which is exactly how a runtime invokes it.
 */
import { directDatabaseUrl } from "@escapement/env";
import { createDb, createEventStore, type Db, type EventStore } from "@escapement/store";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHookServer,
  type GuardPolicy,
  type HookServer,
  renderSettings,
  smokeTestFailClosed,
  writeHookWiring,
} from "../src/index.ts";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const hookSource = resolve(here, "../../hook/src/esc-hook.ts");

const policy: GuardPolicy = { base: "develop", productionPatterns: ["prod", "production"] };

let root: string;
let binary: string;
let server: HookServer;
let client: Db;
let store: EventStore;
let runId: string;

/** Runs the hook exactly as a runtime does: env, stdin, exit code. */
function runHook(
  bin: string,
  env: Record<string, string>,
  stdin: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolvePromise({ code, stderr }));
    child.stdin.end(stdin);
  });
}

const preToolUse = (command: string) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    session_id: "s1",
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "esc-hook-"));
  binary = join(root, "esc-hook");
  // The real artefact, not the source: a compiled single file with no
  // dependencies is what doc/decisions/0002 specified and what gets measured.
  await exec("bun", ["build", "--compile", "--outfile", binary, hookSource]);

  client = createDb();
  store = createEventStore(client);
  runId = `run-esctest-${crypto.randomUUID().slice(0, 8)}`;

  server = createHookServer({ socketPath: join(root, "conductor.sock"), store });
  await server.listen();
  server.register(runId, policy, 0);
}, 180_000);

afterAll(async () => {
  await server.close();
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule escapement_events_no_delete");
    await c.query("delete from events where stream_id = $1", [runId]);
  } finally {
    await c.query("alter table events enable rule escapement_events_no_delete");
    await c.end();
  }
  await rm(root, { recursive: true, force: true });
});

const env = () => ({ ESC_HOOK_SOCKET: server.socketPath, ESC_RUN_ID: runId });

describe("esc-hook fails closed", () => {
  /**
   * The old loop refused to start when `test-guard.sh` failed, and that instinct
   * was right. A guard that fails *open* is worse than no guard, because it is
   * trusted.
   */
  it("denies when the socket is not there", async () => {
    const result = await smokeTestFailClosed(binary, runHook);
    expect(result.ok, result.detail).toBe(true);
    expect(result.detail).toContain("exit 2");
  });

  it("denies when the wiring is missing entirely", async () => {
    const { code, stderr } = await runHook(binary, { ESC_HOOK_SOCKET: "", ESC_RUN_ID: "" }, preToolUse("ls"));
    expect(code).toBe(2);
    expect(stderr).toContain("refusing to allow anything");
  });

  it("denies an unparseable payload", async () => {
    const { code, stderr } = await runHook(binary, env(), "{not json");
    expect(code).toBe(2);
    expect(stderr).toContain("could not parse");
  });

  it("denies a run the conductor has never heard of", async () => {
    const { code, stderr } = await runHook(
      binary,
      { ESC_HOOK_SOCKET: server.socketPath, ESC_RUN_ID: "run-nobody" },
      preToolUse("ls"),
    );
    expect(code).toBe(2);
    // A wiring mistake, not a permission.
    expect(stderr).toContain("not registered");
  });
});

describe("esc-hook carries the verdict", () => {
  it("allows an ordinary command", async () => {
    const { code } = await runHook(binary, env(), preToolUse("pnpm verify"));
    expect(code).toBe(0);
  });

  it("refuses a guarded command, names the rule, and records the trip", async () => {
    const before = server.get(runId)!.trips;
    const { code, stderr } = await runHook(binary, env(), preToolUse("git push --force origin agent/1"));

    expect(code).toBe(2);
    expect(stderr).toContain("force-push");
    // The agent is told why, not merely refused.
    expect(stderr).toContain("rewrites history");
    expect(server.get(runId)!.trips).toBe(before + 1);

    // And it is on the record — 132 of these were invisible in the old loop.
    const trips = (await store.read(runId)).filter((e) => e.type === "GuardTripped");
    expect(trips.length).toBeGreaterThan(0);
    const last = trips[trips.length - 1]!.data as { pattern: string; redactedCommand: string };
    expect(last.pattern).toBe("force-push");
    expect(last.redactedCommand).toContain("git push --force");
  });

  it("redacts the credential out of a refused command", async () => {
    await runHook(binary, env(), preToolUse("psql postgresql://u:hunter2@db.prod.example.com/app"));

    const trips = (await store.read(runId)).filter((e) => e.type === "GuardTripped");
    const last = trips[trips.length - 1]!.data as { redactedCommand: string };
    expect(last.redactedCommand).not.toContain("hunter2");
    expect(last.redactedCommand).toContain("***@db.prod.example.com");
  });

  it("counts allowed calls in memory rather than appending one event each", async () => {
    const before = server.get(runId)!.allowed;
    const eventsBefore = (await store.read(runId)).length;

    for (let i = 0; i < 5; i++) await runHook(binary, env(), preToolUse(`echo ${i}`));

    expect(server.get(runId)!.allowed).toBe(before + 5);
    // The event store's availability must never gate a tool call, and five
    // allowed calls must not cost five appends.
    expect((await store.read(runId)).length).toBe(eventsBefore);
  });
});

describe("esc-hook latency", () => {
  /**
   * Measured, not assumed. #11 asks for under 20ms at the 95th percentile, and
   * this is the whole cost a runtime pays per tool call: process spawn, socket
   * connect, one round trip, exit.
   */
  it("answers under 20ms at the 95th percentile", async () => {
    const samples: number[] = [];
    // A warm-up: the first spawn pays for page cache the rest do not.
    for (let i = 0; i < 10; i++) await runHook(binary, env(), preToolUse("echo warm"));

    for (let i = 0; i < 200; i++) {
      const started = performance.now();
      await runHook(binary, env(), preToolUse(`echo ${i}`));
      samples.push(performance.now() - started);
    }

    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    const p99 = samples[Math.floor(samples.length * 0.99)]!;
    console.log(
      `esc-hook: p50 ${p50.toFixed(1)}ms  p95 ${p95.toFixed(1)}ms  p99 ${p99.toFixed(1)}ms  (n=${samples.length})`,
    );

    expect(p95).toBeLessThan(20);
  }, 120_000);
});

describe("hook wiring", () => {
  it("is written outside the worktree", async () => {
    const home = join(root, "home");
    const wiring = await writeHookWiring({ runId: "run-w", hookBinary: binary, home });

    // An agent that can edit its own hook configuration has no hook
    // configuration, so the file is never inside the repository.
    expect(wiring.settingsPath.startsWith(home)).toBe(true);
    expect(wiring.settingsPath).not.toContain("worktrees");
    expect(wiring.env).toEqual({ ESC_HOOK_SOCKET: wiring.socketPath, ESC_RUN_ID: "run-w" });
  });

  it("wires the five shared hooks, and Claude Code's extras only when asked", () => {
    const shared = renderSettings({ runId: "r", hookBinary: "/bin/esc-hook", includeClaudeOnly: false });
    const all = renderSettings({ runId: "r", hookBinary: "/bin/esc-hook" });

    expect(Object.keys((shared as { hooks: object }).hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    // The extras are bonus signal; the adapter contract is the intersection.
    expect(Object.keys((all as { hooks: object }).hooks)).toContain("PreCompact");
  });
});
