/**
 * One interface, two implementations — one of which is a stub, on purpose.
 *
 * The contract is the **intersection** of what Claude Code and Codex CLI both
 * have: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`.
 * Claude Code's extra three (`SessionEnd`, `PreCompact`, `Notification`) are
 * bonus signal — better when present, never required, and the adapter works
 * without them. Both runtimes are designed for from day one because retrofitting
 * this interface later is a refactor; only `claude-code` is implemented, because
 * writing the second adapter before the first interface has survived real use is
 * guessing at the wrong abstractions.
 *
 * **Containment is Escapement's responsibility, not the runtime's.** Codex ships
 * a filesystem sandbox and Claude Code does not, and a project's safety level
 * must not depend on which agent happens to be running today. A runtime may
 * *provide* containment; the scheduler matches capabilities before dispatching
 * and records `DispatchRefused` when the combination cannot meet the tier — it
 * never silently downgrades. See doc/decisions/0007-dual-runtime.md.
 */
import type { RuntimeId, Tier } from "@escapement/core";

export interface RuntimeCapabilities {
  id: RuntimeId;
  /** The lifecycle hooks this runtime actually emits. */
  hooks: readonly string[];
  /** Whether `PreToolUse` can refuse a call. Both can; a future one might not. */
  canBlockToolUse: boolean;
  /** Codex can rewrite a call as well as refuse it. Claude Code cannot. */
  canRewriteToolCall: boolean;
  /** The strongest containment this runtime provides on its own. */
  providesTier: Tier;
}

export interface RunRequest {
  runId: string;
  /** The worktree. Its directory is the blast radius. */
  cwd: string;
  prompt: string;
  model?: string;
  /** Rendered by the conductor, outside the worktree. */
  settingsPath: string;
  /** Filtered — only what the recipe allows, plus the hook's wiring. */
  env: Record<string, string>;
  limits: { turns: number; wallMs: number };
  /** Killed when this aborts, producing a `timeout` failure rather than silence. */
  signal?: AbortSignal;
}

/** What the adapter knows when the process is gone. */
export interface RunOutcome {
  exitCode: number | null;
  turns: number;
  durationMs: number;
  costUsd: number | null;
  /**
   * Set when the run did not complete normally. **Never null and silent** — the
   * old loop's failures produced no event at all, which is the thing this type
   * exists to make impossible.
   */
  failure: { kind: "timeout" | "crash" | "no-commits" | "aborted"; detail: string } | null;
  /**
   * The model's final message.
   *
   * Kept because a gate that asks an agent a question needs the answer, and the
   * runtime was throwing it away — cost and turn counts survived, the actual
   * output did not. Null when the run produced nothing parseable.
   */
  text: string | null;
  /** The runtime's own session identifier, for finding its transcript. */
  sessionId: string;
}

/**
 * Whether the runtime can authenticate **in a given environment**.
 *
 * The environment is the point. Asking "is the operator logged in" is not the
 * question and answering it is worse than not asking: the first real run failed
 * with "Not logged in · Please run /login" while the operator was perfectly
 * logged in, because the filtered environment a run gets had no `USER` and
 * macOS finds a keychain item by who is asking.
 */
export interface AuthStatus {
  loggedIn: boolean;
  /** `claude.ai`, `apiKey`, `none` — whatever the runtime calls it. */
  method: string | null;
  /** Said back verbatim when something could not be asked at all. */
  detail: string;
}

export interface Runtime {
  readonly capabilities: RuntimeCapabilities;
  run(request: RunRequest): Promise<RunOutcome>;
  /**
   * Optional: a runtime that cannot be asked cheaply should not pretend.
   * `esc doctor` reports an absent check as deferred rather than as passing.
   */
  checkAuth?(env: Record<string, string>): Promise<AuthStatus>;
}

/**
 * Whether this runtime can carry a project at that containment tier.
 *
 * `guarded` is what the first project runs at and what carried the old loop's 73
 * runs; `sandboxed` needs a hard filesystem boundary that Escapement has not
 * built yet.
 */
export function meetsTier(capabilities: RuntimeCapabilities, required: Tier): boolean {
  const rank: Record<Tier, number> = { open: 0, guarded: 1, sandboxed: 2 };
  return rank[capabilities.providesTier] >= rank[required];
}

/** What is missing, so `DispatchRefused` can name it rather than say "no". */
export function missingForTier(capabilities: RuntimeCapabilities, required: Tier): string[] {
  if (meetsTier(capabilities, required)) return [];
  if (required === "sandboxed") {
    return ["filesystem-sandbox"];
  }
  if (required === "guarded" && !capabilities.canBlockToolUse) {
    return ["pre-tool-use-interception"];
  }
  return [`tier-${required}`];
}
