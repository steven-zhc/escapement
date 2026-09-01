/**
 * The hook wiring, rendered by the conductor **outside the worktree**.
 *
 * That location is the point. `settings.json` inside the repository would be a
 * file the agent can edit, and an agent that can edit its own hook configuration
 * has no hook configuration. Claude Code takes `--settings <path>`, so the file
 * lives beside the socket in Escapement's own state directory, and the worktree
 * never contains it.
 *
 * What is rendered is the five hooks both runtimes have plus Claude Code's extra
 * four, all pointing at the same binary. The adapter contract is the
 * intersection (doc/decisions/0007-dual-runtime.md); the extras are bonus signal
 * and the system works without them.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { stateDir } from "./worktree.ts";

/** The five both runtimes have, then Claude Code's extras. */
export const INTERSECTION_HOOKS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;

export const CLAUDE_ONLY_HOOKS = ["SessionEnd", "PreCompact", "Notification"] as const;

export interface HookWiring {
  /** `--settings` for `claude -p`. Outside the worktree, always. */
  settingsPath: string;
  socketPath: string;
  /** Environment the runtime child needs so the hook can find the conductor. */
  env: Record<string, string>;
}

/** macOS caps `sun_path` at 104 bytes; Linux at 108. Neither reports why. */
export const SUN_PATH_MAX = 104;

/**
 * Where a run's hook socket lives.
 *
 * **Not under `home`.** The first version put it there and `listen` failed with
 * a bare `EINVAL: invalid argument` — the path was 106 bytes, and nothing in the
 * error said so. Shortening the *name* was not enough either: the limit is on
 * the whole path, and `home` can be arbitrarily deep.
 *
 * So a socket goes in the temp directory, which is what ephemeral runtime state
 * is for — `home` holds mirrors and worktrees, which are durable and want to be
 * somewhere predictable. The name is a digest of the home *and* the run id, so
 * two conductors with different state directories cannot collide.
 */
export function socketPathFor(runId: string, home = stateDir()): string {
  const short = createHash("sha256").update(`${home}\u0000${runId}`).digest("hex").slice(0, 12);
  const path = join(tmpdir(), "escapement", `${short}.sock`);

  if (Buffer.byteLength(path) >= SUN_PATH_MAX) {
    // Say which limit and how far over. `EINVAL` on its own costs an hour.
    throw new Error(
      `the hook socket path is ${Buffer.byteLength(path)} bytes and the limit is ${SUN_PATH_MAX}: ${path}. ` +
        "Set TMPDIR to something shorter.",
    );
  }
  return path;
}

export function settingsPathFor(runId: string, home = stateDir()): string {
  return join(home, "runs", runId, "settings.json");
}

export interface RenderOptions {
  runId: string;
  /** Absolute path to the compiled `esc-hook`. */
  hookBinary: string;
  home?: string;
  /** Claude Code's extras. Off for a runtime that does not have them. */
  includeClaudeOnly?: boolean;
  /**
   * False wires no hooks at all: the settings file is still written, so
   * `--settings` has somewhere to point, but nothing mediates a tool call.
   *
   * For bringing the pipeline up on a machine the operator is watching. The
   * guard is not one of the three real boundaries (ADR 0007) — the filtered
   * environment and the disposable worktree still hold with this off — but a
   * run without it records no guard trips and no touched files, so it proves
   * less about a run than it looks like it does.
   */
  guard?: boolean;
}

/**
 * Claude Code's settings shape: a matcher per hook with a list of commands.
 *
 * `matcher: "*"` on `PreToolUse` is deliberate — every tool call goes through
 * the guard, and a matcher that lists tools is a list that will fall behind the
 * runtime's.
 */
export function renderSettings(options: RenderOptions): unknown {
  // Explicitly empty rather than absent. `--settings` still points at a real
  // file, and a settings file with no hooks says "nothing mediates tool calls
  // here" in a way that reading it makes obvious.
  if (options.guard === false) return { hooks: {} };

  // Absolute, and checked rather than trusted, because a relative path here
  // fails *open*. The caller verifies the binary exists by resolving it against
  // its own cwd; Claude Code spawns it resolved against the worktree. A relative
  // path can therefore pass the existence check and then not be found — and a
  // hook command that is not found exits 127, which is not the 2 that means
  // deny, so the runtime treats it as a non-blocking error and runs the tool
  // anyway. The result is a run with no guard that looks exactly like a run
  // with one. Refusing here costs nothing and removes the whole class.
  const command = options.hookBinary;
  if (!isAbsolute(command)) {
    throw new Error(`esc-hook path must be absolute, got: ${command}`);
  }
  const entry = () => [{ matcher: "*", hooks: [{ type: "command", command }] }];

  const hooks: Record<string, unknown> = {};
  for (const name of INTERSECTION_HOOKS) hooks[name] = entry();
  if (options.includeClaudeOnly !== false) {
    for (const name of CLAUDE_ONLY_HOOKS) hooks[name] = entry();
  }
  return { hooks };
}

export async function writeHookWiring(options: RenderOptions): Promise<HookWiring> {
  const home = options.home ?? stateDir();
  const settingsPath = settingsPathFor(options.runId, home);
  const socketPath = socketPathFor(options.runId, home);

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(renderSettings(options), null, 2)}\n`, {
    mode: 0o600,
  });

  return {
    settingsPath,
    socketPath,
    env: {
      ESC_HOOK_SOCKET: socketPath,
      ESC_RUN_ID: options.runId,
    },
  };
}

/**
 * Proves the hook denies when the conductor is not there.
 *
 * The old loop refused to start when `test-guard.sh` failed, and that instinct
 * was right: a guard that fails *open* is worse than no guard, because it is
 * trusted. This runs the real binary against a socket path that does not exist
 * and requires exit 2. The conductor calls it before dispatching anything.
 */
export async function smokeTestFailClosed(
  hookBinary: string,
  run: (
    bin: string,
    env: Record<string, string>,
    stdin: string,
  ) => Promise<{ code: number | null; stderr: string }>,
): Promise<{ ok: boolean; detail: string }> {
  const nowhere = join(stateDir(), "sockets", `smoke-${Date.now()}.sock`);
  const { code, stderr } = await run(
    hookBinary,
    { ESC_HOOK_SOCKET: nowhere, ESC_RUN_ID: "run-smoke" },
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
  );

  if (code === 2) {
    return { ok: true, detail: `denied with exit 2 when the socket was absent: ${stderr.trim()}` };
  }
  return {
    ok: false,
    detail:
      `esc-hook exited ${code} with no conductor listening — it must exit 2. ` +
      "A guard that fails open is worse than no guard.",
  };
}
