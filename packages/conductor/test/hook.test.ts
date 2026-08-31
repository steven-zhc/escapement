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
  socketPathFor,
  SUN_PATH_MAX,
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
const lifecycle: string[] = [];

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

  server = createHookServer({
    socketPath: join(root, "conductor.sock"),
    store,
    onLifecycle: (_runId, hook) => void lifecycle.push(hook),
  });
  await server.listen();
  server.register(runId, policy, 0, "ticket@3");
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
  const quantile = (s: number[], q: number) =>
    [...s].sort((a, b) => a - b)[Math.floor(s.length * q)]!;

  /**
   * Samples both variants **interleaved**, not one series after the other.
   *
   * The first version measured `full` for 120 iterations and then `bare` for
   * 120, and subtracted the two p50s. That is only valid if the machine is
   * equally busy during both halves, and during a full `pnpm test` it is not:
   * the difference came out over 5ms in a whole-suite run and under 1ms when
   * the file ran alone. The hook had not changed — the second half of the
   * sample simply ran on a quieter machine.
   *
   * Alternating them puts any load spike into both series at once, which is
   * what makes the *difference* mean what the assertion says it means.
   */
  async function paired(a: () => Promise<unknown>, b: () => Promise<unknown>, n = 120) {
    for (let i = 0; i < 10; i++) {
      await a();
      await b();
    }
    const sa: number[] = [];
    const sb: number[] = [];
    for (let i = 0; i < n; i++) {
      // Order swaps every iteration so neither variant systematically pays for
      // whatever the other one warmed.
      for (const [fn, into] of i % 2 === 0 ? ([[a, sa], [b, sb]] as const) : ([[b, sb], [a, sa]] as const)) {
        const t = performance.now();
        await fn();
        into.push(performance.now() - t);
      }
    }
    return {
      a: { p50: quantile(sa, 0.5), p95: quantile(sa, 0.95) },
      b: { p50: quantile(sb, 0.5), p95: quantile(sb, 0.95) },
    };
  }

  /**
   * **This does not assert 20ms, and that is deliberate.**
   *
   * #11 asked for under 20ms at p95. Measured, it is ~16ms p50 and 19–24ms p95
   * depending on what else the machine is doing — and a decomposition showed
   * every millisecond of it is Bun's runtime startup: the binary that fails
   * immediately because there is no socket costs the same as the one that does
   * the whole round trip. Asserting 20ms would be a test failing for a reason no
   * change to this repository can fix. See doc/decisions/0011 and
   * doc/experiments/004.
   *
   * So this asserts the part Escapement owns and can regress — the marginal cost
   * of talking to the conductor — and prints the real distribution.
   */
  it("adds almost nothing to the cost of starting the binary", async () => {
    const nowhere = join(root, "not-a-socket.sock");

    const { a: full, b: bare } = await paired(
      () => runHook(binary, env(), preToolUse("echo x")),
      () => runHook(binary, { ESC_HOOK_SOCKET: nowhere, ESC_RUN_ID: runId }, preToolUse("echo x")),
    );

    console.log(
      `esc-hook: round trip p50 ${full.p50.toFixed(1)}ms p95 ${full.p95.toFixed(1)}ms · ` +
        `startup only p50 ${bare.p50.toFixed(1)}ms p95 ${bare.p95.toFixed(1)}ms`,
    );

    // The only stable, meaningful assertion. The conductor answers from memory,
    // so talking to it should cost about nothing over merely starting the
    // binary; if this grows, something has started doing work on the hot path.
    expect(full.p50 - bare.p50).toBeLessThan(5);

    // Nothing is asserted about the absolute p50 or p95. It is not ours — it is Bun's
    // startup — and it is genuinely noisy: 19.0, 23.8 and 46.7ms were all
    // observed on this machine within an hour. An assertion on it would be a
    // test that fails for reasons no change here can fix, which is how a suite
    // stops being trusted. The numbers are printed instead. See 0011.
  }, 120_000);
});

describe("the lifecycle hooks", () => {
  const hookPayload = (name: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ hook_event_name: name, ...extra });

  it("records a prompt with the version that produced it", async () => {
    const before = (await store.read(runId)).filter((e) => e.type === "RunPrompted").length;
    const { code } = await runHook(binary, env(), hookPayload("UserPromptSubmit", { prompt: "do the thing" }));

    expect(code).toBe(0);
    const prompted = (await store.read(runId)).filter((e) => e.type === "RunPrompted");
    expect(prompted.length).toBe(before + 1);
    // "Which prompt produced better work" is only answerable if the version is
    // on the event.
    expect((prompted[prompted.length - 1]!.data as { promptVersion: string }).promptVersion).toBe("ticket@3");
  });

  it("records compaction, because it means the item was scoped too large", async () => {
    const { code } = await runHook(binary, env(), hookPayload("PreCompact"));
    expect(code).toBe(0);

    const compactions = (await store.read(runId)).filter((e) => e.type === "RunContextExhausted");
    expect(compactions.length).toBeGreaterThan(0);
  });

  it("records a notification, so the board lights up rather than the clock running out", async () => {
    await runHook(binary, env(), hookPayload("Notification", { message: "needs your input" }));

    const waiting = (await store.read(runId)).filter((e) => e.type === "RunAwaitingInput");
    expect((waiting[waiting.length - 1]!.data as { prompt: string }).prompt).toContain("needs your input");
  });

  it("hands Stop to the conductor rather than acting on it here", async () => {
    // Stop is where the gate pipeline fires, and firing it needs a diff — git,
    // not the hot path.
    const { code } = await runHook(binary, env(), hookPayload("Stop"));
    expect(code).toBe(0);
    expect(lifecycle).toContain("Stop");
  });

  it("never blocks on a lifecycle hook", async () => {
    for (const name of ["SessionStart", "SessionEnd", "Stop", "PreCompact", "Notification"]) {
      const { code } = await runHook(binary, env(), hookPayload(name));
      expect(code, `${name} blocked`).toBe(0);
    }
  });
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

describe("socket paths", () => {
  /**
   * macOS caps a unix socket path at 104 bytes and fails with a bare
   * `EINVAL: invalid argument` when it is exceeded. A UUID run id under a temp
   * directory is already over.
   */
  it("stays inside the sun_path limit however deep the state directory is", () => {
    // The state directory can be arbitrarily deep — a temp directory in a test
    // already is. The socket does not live there, which is the point.
    const longHome = join(
      "/private/var/folders/y7/b4lkp2c90p165_gygx2txt100000gn/T",
      "esc-runonce-80F6pP",
      "home",
    );
    const path = socketPathFor(`run-${crypto.randomUUID()}`, longHome);

    expect(Buffer.byteLength(path)).toBeLessThan(SUN_PATH_MAX);
    expect(path.startsWith(longHome)).toBe(false);
  });

  it("is stable for a run, distinct between runs, and distinct between homes", () => {
    expect(socketPathFor("run-a", "/tmp/a")).toBe(socketPathFor("run-a", "/tmp/a"));
    expect(socketPathFor("run-a", "/tmp/a")).not.toBe(socketPathFor("run-b", "/tmp/a"));
    // Two conductors with different state directories must not collide.
    expect(socketPathFor("run-a", "/tmp/a")).not.toBe(socketPathFor("run-a", "/tmp/b"));
  });
});
