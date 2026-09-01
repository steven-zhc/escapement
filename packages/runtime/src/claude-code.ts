/**
 * The Claude Code adapter.
 *
 * `claude -p` in the worktree, with the hook wiring the conductor rendered
 * outside it, and `--output-format json` so the receipt is parsed rather than
 * scraped. That last choice is the direct answer to a measured failure: the old
 * loop wrote cost records into a `.jsonl` that also contained raw `pnpm build`
 * output, so 9,555 of its 42,147 lines were not JSON and the file would not
 * parse. A receipt you cannot read is not a receipt.
 *
 * **The session id is supplied, not observed.** `claude --session-id <uuid>`
 * takes one, so the conductor derives it deterministically from the run id.
 * design.md assumed the binding would be learned from the `SessionStart` hook
 * and stored; deriving it means there is nothing to store and nothing to lose —
 * given a run id, its transcript is computable forever.
 *
 * **Every ending produces an event.** Timeout, crash, non-zero exit and clean
 * completion each map to a kind. The old loop's failures produced no log line,
 * no comment and no label, and that silence is what `RunFailed` exists to end.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { RunOutcome, RunRequest, Runtime, RuntimeCapabilities } from "./runtime.ts";

export const CLAUDE_CODE_CAPABILITIES: RuntimeCapabilities = {
  id: "claude-code",
  hooks: [
    // The intersection both runtimes have.
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    // Claude Code's extras. Bonus signal: `PreCompact` reveals a work item that
    // was scoped too large, `Notification` lights the board up instead of the
    // run burning to the wall clock.
    "SessionEnd",
    "PreCompact",
    "Notification",
  ],
  canBlockToolUse: true,
  // Codex can rewrite a call; Claude Code refuses or allows.
  canRewriteToolCall: false,
  // No filesystem sandbox of its own. `guarded` is what the worktree plus the
  // filtered environment plus PreToolUse interception add up to, and it is what
  // carried the old loop's 73 runs.
  providesTier: "guarded",
};

/**
 * A stable UUID for a run.
 *
 * Deterministic so the binding between a run and its Claude Code transcript
 * needs no event field: given a run id, the session id is computable. Shaped as
 * a v4 UUID because `--session-id` requires a valid one.
 */
export function sessionIdFor(runId: string): string {
  const h = createHash("sha256").update(`escapement:session:${runId}`).digest("hex");
  const bytes = h.slice(0, 32).split("");
  // Version and variant nibbles, so it parses as a UUID rather than 32 hex.
  bytes[12] = "4";
  bytes[16] = "8";
  const s = bytes.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** What `--output-format json` prints when the run ends. */
interface ClaudeResult {
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  session_id?: string;
  subtype?: string;
  result?: string;
}

export interface ClaudeCodeOptions {
  /** The `claude` executable. Overridable so a test can use a stand-in. */
  binary?: string;
  /** Extra arguments, for a project that needs one. Never used to add tools. */
  extraArgs?: readonly string[];
}

export function createClaudeCodeRuntime(options: ClaudeCodeOptions = {}): Runtime {
  const binary = options.binary ?? "claude";

  return {
    capabilities: CLAUDE_CODE_CAPABILITIES,

    async run(request: RunRequest): Promise<RunOutcome> {
      const sessionId = sessionIdFor(request.runId);
      const started = Date.now();

      const args = [
        "-p",
        request.prompt,
        // Parsed, not scraped. See the module header.
        "--output-format",
        "json",
        // Outside the worktree: an agent that can edit its own hook
        // configuration has no hook configuration.
        "--settings",
        request.settingsPath,
        "--session-id",
        sessionId,
        ...(request.model ? ["--model", request.model] : []),
        ...(options.extraArgs ?? []),
      ];

      return new Promise<RunOutcome>((resolve) => {
        const child = spawn(binary, args, {
          cwd: request.cwd,
          // Filtered, not inherited. The agent gets what the recipe allows plus
          // the hook's wiring, and nothing else — one of the three real
          // boundaries (doc/decisions/0007).
          env: request.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        child.stdout.on("data", (c) => (stdout += c.toString()));
        child.stderr.on("data", (c) => (stderr += c.toString()));

        const finish = (outcome: RunOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(wall);
          request.signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        };

        const kill = (kind: "timeout" | "guard-hard-stop", detail: string) => {
          child.kill("SIGTERM");
          // A SIGTERM the agent ignores must not become a hang. The event is the
          // point; a process that will not die is a detail for the next line.
          const hard = setTimeout(() => child.kill("SIGKILL"), 5_000);
          hard.unref?.();
          finish({
            exitCode: null,
            turns: 0,
            durationMs: Date.now() - started,
            costUsd: null,
            text: null,
            failure: { kind, detail },
            sessionId,
          });
        };

        const wall = setTimeout(
          () => kill("timeout", `no result within ${request.limits.wallMs}ms`),
          request.limits.wallMs,
        );
        const onAbort = () => kill("guard-hard-stop", "the conductor aborted the run");
        request.signal?.addEventListener("abort", onAbort, { once: true });

        child.on("error", (err) =>
          finish({
            exitCode: null,
            turns: 0,
            durationMs: Date.now() - started,
            costUsd: null,
            text: null,
            // Includes "claude is not installed", which must be an event and not
            // a stack trace nobody sees.
            failure: { kind: "crash", detail: err.message },
            sessionId,
          }),
        );

        child.on("close", (code) => {
          const parsed = parseResult(stdout);
          const durationMs = parsed?.duration_ms ?? Date.now() - started;
          const turns = parsed?.num_turns ?? 0;
          const costUsd = parsed?.total_cost_usd ?? null;

          if (parsed && code === 0 && parsed.is_error !== true) {
            finish({
              exitCode: code,
              turns,
              durationMs,
              costUsd,
              text: parsed.result ?? null,
              failure: null,
              sessionId,
            });
            return;
          }

          finish({
            exitCode: code,
            turns,
            durationMs,
            costUsd,
            text: parsed?.result ?? null,
            failure: {
              kind: "crash",
              // Whatever went wrong, something says so. A run that ends with no
              // detail is the failure mode being replaced.
              detail:
                parsed?.result?.slice(0, 500) ??
                (stderr.trim() || stdout.trim()).slice(0, 500) ??
                `exited ${code}`,
            },
            sessionId,
          });
        });
      });
    },
  };
}

/**
 * The last JSON object in the output.
 *
 * `--output-format json` prints one, but a wrapper or a warning can put a line
 * in front of it, and the old loop's unparseable `.jsonl` is the reminder that
 * assuming clean output is how a receipt gets lost.
 */
export function parseResult(stdout: string): ClaudeResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeResult;
  } catch {
    // Fall through to the last line that is an object.
  }
  const lines = trimmed.split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      return JSON.parse(t) as ClaudeResult;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/** A run id. ULIDs are not in the dependency budget; a UUID sorts well enough. */
export function newRunId(): string {
  return `run-${randomUUID()}`;
}
