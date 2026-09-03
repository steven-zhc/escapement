/**
 * Running one command in a worktree, and coming back with something a person
 * can act on.
 *
 * This was inside `process-gate.ts`, and it is out here because the prepare
 * stage needs exactly the same execution and none of the same meaning. A gate's
 * result is a **verdict about a commit**, bound to `onSha` and invalidated by a
 * force-push. A prepare step runs before the agent has written anything and
 * holds no verdict about anything. Sharing the runner is right; sharing the
 * result type would have quietly given prepare an `onSha` that means nothing.
 *
 * It lives in `@lingtai/gates` rather than in a package of its own because
 * the dependency already runs that way — the conductor imports the gates — and a
 * package with one file in it is a worse answer than a slightly wide name.
 *
 * The three things this does that a bare `spawn` does not:
 *
 * **A failure carries its log tail.** The board's promise is that a card is
 * workable without leaving it, and "it failed" with no output is a link to
 * somewhere else wearing a disguise.
 *
 * **A timeout is a distinct outcome.** A command that ran out of time and one
 * that ran and refused are different problems with different fixes, and the
 * caller should not have to guess which it got.
 *
 * **The buffer is bounded, not just the evidence.** A runaway process can print
 * faster than anything reads it.
 */
import { spawn } from "node:child_process";

/** How much of the output a card gets. Enough to act on, bounded. */
export const EVIDENCE_LINES = 60;
export const EVIDENCE_BYTES = 8_000;

/** Above this, older output is dropped while the command is still running. */
const BUFFER_BYTES = 2_000_000;

export interface CommandOutcome {
  ok: boolean;
  /** What a person reads. On failure, the log tail. */
  evidence: string;
  /** Distinguished from a non-zero exit, deliberately. */
  timedOut: boolean;
  durationMs: number;
  /** Null when the process never ran, or was killed before exiting. */
  exitCode: number | null;
}

export interface RunCommandOptions {
  /** Through a shell: a recipe writes `pnpm lint && pnpm test`, and splitting
   *  that correctly is not this file's job. */
  run: string;
  timeoutMs: number;
  /** How the timeout is written in the recipe, for the message. `15m`, not `900000`. */
  timeoutLabel?: string;
  /** The worktree. Commands run where the agent worked, never anywhere else. */
  cwd: string;
  /** Filtered, exactly as the agent's was. */
  env: Record<string, string>;
  signal?: AbortSignal;
}

/** The last N lines, capped — a build log can be megabytes. */
export function tail(text: string, lines = EVIDENCE_LINES, bytes = EVIDENCE_BYTES): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return "";
  const kept = trimmed.split("\n").slice(-lines).join("\n");
  return kept.length <= bytes ? kept : `…${kept.slice(-bytes)}`;
}

export function runCommand(options: RunCommandOptions): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve) => {
    const started = Date.now();
    const child = spawn(options.run, {
      shell: true,
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let settled = false;
    const collect = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > BUFFER_BYTES) out = out.slice(-BUFFER_BYTES / 2);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (outcome: Omit<CommandOutcome, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ...outcome, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // A process that ignores SIGTERM still has to go, or the run leaks it.
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
      finish({
        ok: false,
        timedOut: true,
        exitCode: null,
        evidence: `timed out after ${options.timeoutLabel ?? `${options.timeoutMs}ms`}\n\n${tail(out)}`,
      });
    }, options.timeoutMs);

    const onAbort = () => {
      child.kill("SIGTERM");
      finish({ ok: false, timedOut: false, exitCode: null, evidence: `aborted\n\n${tail(out)}` });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) =>
      finish({
        ok: false,
        timedOut: false,
        exitCode: null,
        // The command not existing is the most common version of this, and
        // saying which command is the whole difference from "spawn ENOENT".
        evidence: `could not run "${options.run}": ${err.message}`,
      }),
    );

    child.on("close", (code) => {
      const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
      if (code === 0) {
        finish({
          ok: true,
          timedOut: false,
          exitCode: 0,
          evidence: `${options.run} exited 0 in ${took}`,
        });
        return;
      }
      finish({
        ok: false,
        timedOut: false,
        exitCode: code,
        evidence: `${options.run} exited ${code} after ${took}\n\n${tail(out)}`,
      });
    });
  });
}
