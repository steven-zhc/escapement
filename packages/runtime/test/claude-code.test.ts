/**
 * The adapter, against a stand-in `claude` rather than the real one.
 *
 * A real Claude Code run costs money and takes minutes, and none of the
 * properties under test are about the model: they are about what the adapter
 * does with a process that exits cleanly, exits badly, never exits, or is not
 * there at all. Each of those is a script here.
 *
 * The one thing a stand-in cannot check is that `claude` accepts these flags.
 * They were read off `claude --help` on 2026-08-31 — `-p`, `--output-format
 * json`, `--settings`, `--session-id`, `--model` — and the first supervised run
 * is what actually proves them.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  CodexNotImplementedError,
  createClaudeCodeRuntime,
  createCodexRuntime,
  meetsTier,
  missingForTier,
  parseResult,
  sessionIdFor,
} from "../src/index.ts";

let root: string;

/** A script standing in for `claude`, so the adapter meets a real process. */
async function fakeClaude(body: string): Promise<string> {
  const path = join(root, `claude-${crypto.randomUUID().slice(0, 8)}.sh`);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const request = (over: Partial<Parameters<ReturnType<typeof createClaudeCodeRuntime>["run"]>[0]> = {}) => ({
  runId: "run-01JX",
  cwd: root,
  prompt: "fix the thing",
  settingsPath: join(root, "settings.json"),
  env: { PATH: process.env["PATH"] ?? "" },
  limits: { turns: 300, wallMs: 30_000 },
  ...over,
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "esc-runtime-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("capabilities", () => {
  it("declares the intersection plus Claude Code's extras", () => {
    expect(CLAUDE_CODE_CAPABILITIES.hooks).toEqual(
      expect.arrayContaining(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]),
    );
    // Bonus signal: better when present, never required.
    expect(CLAUDE_CODE_CAPABILITIES.hooks).toContain("PreCompact");
    // Codex has only the five, which is why the contract is the intersection.
    expect(CODEX_CAPABILITIES.hooks).toHaveLength(5);
    expect(CODEX_CAPABILITIES.hooks).not.toContain("PreCompact");
  });

  /**
   * A project's safety level must not depend on which agent happens to be
   * running today. Claude Code cannot provide `sandboxed` on its own, and the
   * scheduler has to be able to say so *before* dispatching.
   */
  it("says which runtime can carry which tier, and what is missing", () => {
    expect(meetsTier(CLAUDE_CODE_CAPABILITIES, "guarded")).toBe(true);
    expect(meetsTier(CLAUDE_CODE_CAPABILITIES, "sandboxed")).toBe(false);
    expect(meetsTier(CODEX_CAPABILITIES, "sandboxed")).toBe(true);

    // Named, so DispatchRefused carries a reason rather than a refusal.
    expect(missingForTier(CLAUDE_CODE_CAPABILITIES, "sandboxed")).toEqual(["filesystem-sandbox"]);
    expect(missingForTier(CLAUDE_CODE_CAPABILITIES, "guarded")).toEqual([]);
  });
});

describe("sessionIdFor", () => {
  /**
   * design.md assumed the session id would be learned from `SessionStart` and
   * stored. `claude --session-id` takes one, so it is derived instead — there is
   * nothing to store and nothing to lose.
   */
  it("is stable for a run id and different between runs", () => {
    expect(sessionIdFor("run-a")).toBe(sessionIdFor("run-a"));
    expect(sessionIdFor("run-a")).not.toBe(sessionIdFor("run-b"));
  });

  it("is a valid UUID, because --session-id requires one", () => {
    expect(sessionIdFor("run-a")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("run", () => {
  it("reads the receipt out of --output-format json", async () => {
    const binary = await fakeClaude(
      `echo '{"is_error":false,"num_turns":63,"duration_ms":4210000,"total_cost_usd":5.42}'`,
    );
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());

    expect(outcome.failure).toBeNull();
    expect(outcome.turns).toBe(63);
    expect(outcome.costUsd).toBe(5.42);
    expect(outcome.durationMs).toBe(4_210_000);
    expect(outcome.sessionId).toBe(sessionIdFor("run-01JX"));
  });

  it("passes the flags that make the run attributable and governed", async () => {
    // The arguments are what wire the hook, the session and the model. A test
    // that only checks the exit code would not notice one going missing.
    const binary = await fakeClaude(`printf '%s\\n' "$@" > "${join(root, "args.txt")}"; echo '{}'`);
    await createClaudeCodeRuntime({ binary }).run(request({ model: "claude-opus-5" }));

    const args = (await import("node:fs/promises")).readFile;
    const written = await args(join(root, "args.txt"), "utf8");
    expect(written).toContain("-p");
    expect(written).toContain("--output-format");
    expect(written).toContain("--settings");
    expect(written).toContain(sessionIdFor("run-01JX"));
    expect(written).toContain("claude-opus-5");
  });

  /** The old loop's failures produced no event at all. Every ending has a kind. */
  it("turns a non-zero exit into a crash, with the detail", async () => {
    const binary = await fakeClaude(`echo "context window exceeded" >&2; exit 1`);
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());

    expect(outcome.failure?.kind).toBe("crash");
    expect(outcome.failure?.detail).toContain("context window exceeded");
    expect(outcome.exitCode).toBe(1);
  });

  it("turns is_error into a crash even when the exit code is zero", async () => {
    const binary = await fakeClaude(
      `echo '{"is_error":true,"result":"the model refused","num_turns":2}'; exit 0`,
    );
    const outcome = await createClaudeCodeRuntime({ binary }).run(request());

    // A clean exit code with an error result is still a failure, and saying so
    // is the difference between a receipt and a rumour.
    expect(outcome.failure?.kind).toBe("crash");
    expect(outcome.failure?.detail).toContain("the model refused");
    expect(outcome.turns).toBe(2);
  });

  it("turns a run that never ends into a timeout, not a hang", async () => {
    const binary = await fakeClaude("sleep 30");
    const outcome = await createClaudeCodeRuntime({ binary }).run(
      request({ limits: { turns: 300, wallMs: 400 } }),
    );

    expect(outcome.failure?.kind).toBe("timeout");
    expect(outcome.failure?.detail).toContain("400ms");
  });

  it("turns an abort into aborted", async () => {
    const binary = await fakeClaude("sleep 30");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const outcome = await createClaudeCodeRuntime({ binary }).run(
      request({ signal: controller.signal }),
    );
    expect(outcome.failure?.kind).toBe("aborted");
  });

  it("turns a missing binary into a crash rather than a stack trace", async () => {
    const outcome = await createClaudeCodeRuntime({ binary: join(root, "not-here") }).run(request());
    expect(outcome.failure?.kind).toBe("crash");
    expect(outcome.failure?.detail.length).toBeGreaterThan(0);
  });
});

describe("parseResult", () => {
  it("reads clean JSON", () => {
    expect(parseResult('{"num_turns":3}')).toEqual({ num_turns: 3 });
  });

  /**
   * The old loop's cost record was a `.jsonl` that also contained raw `pnpm
   * build` output — 9,555 of 42,147 lines were not JSON and the file would not
   * parse. Assuming clean output is how a receipt gets lost.
   */
  it("finds the result even behind a line of noise", () => {
    expect(parseResult('npm warn something\n{"num_turns":3}')).toEqual({ num_turns: 3 });
  });

  it("returns null rather than guessing", () => {
    expect(parseResult("")).toBeNull();
    expect(parseResult("not json at all")).toBeNull();
  });
});

describe("the Codex stub", () => {
  it("declares capabilities but refuses to run, naming the issue", async () => {
    const codex = createCodexRuntime();
    expect(codex.capabilities.providesTier).toBe("sandboxed");
    await expect(codex.run({} as never)).rejects.toBeInstanceOf(CodexNotImplementedError);
    await expect(codex.run({} as never)).rejects.toThrow(/#34/);
  });
});
