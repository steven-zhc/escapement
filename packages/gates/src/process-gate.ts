/**
 * The process gate: run a command, the exit code is the verdict.
 *
 * This is `verify.sh` unchanged, which is the point — the old loop's build check
 * was the one part of it that worked, and collapsing it into the same primitive
 * as review and approval is what makes the other three cost a configuration line
 * (design.md §2).
 *
 * Two things it does that the old one did not.
 *
 * **A failure carries its log tail.** The board's promise is that a card is
 * workable without leaving it, and "the build failed" with no output is a link
 * to somewhere else wearing a disguise.
 *
 * **A timeout is a distinct outcome.** The old loop's gate could hang until the
 * two-hour wall clock and then report nothing. A gate that ran out of time and a
 * gate that ran and refused are different problems with different fixes, and the
 * evidence says which.
 */
import { parseDuration } from "@escapement/config";
import { spawn } from "node:child_process";
import type { Gate, GateContext, GateResult } from "./gate.ts";

/** How much of the output the board gets. Enough to act on, bounded. */
export const EVIDENCE_LINES = 60;
export const EVIDENCE_BYTES = 8_000;

export interface ProcessGateSpec {
  name: string;
  run: string;
  /** `15m` by default, per the recipe schema. */
  timeout?: string;
}

/** The last N lines, capped — a build log can be megabytes. */
export function tail(text: string, lines = EVIDENCE_LINES, bytes = EVIDENCE_BYTES): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return "";
  const kept = trimmed.split("\n").slice(-lines).join("\n");
  return kept.length <= bytes ? kept : `…${kept.slice(-bytes)}`;
}

export function createProcessGate(spec: ProcessGateSpec): Gate {
  const timeoutMs = parseDuration(spec.timeout ?? "15m");

  return {
    name: spec.name,
    kind: "process",

    run(context: GateContext): Promise<GateResult> {
      return new Promise<GateResult>((resolve) => {
        const started = Date.now();
        // Through a shell, because a recipe writes `pnpm verify && pnpm lint`
        // and splitting that correctly is not this file's job.
        const child = spawn(spec.run, {
          shell: true,
          cwd: context.cwd,
          env: context.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let out = "";
        let settled = false;
        const collect = (chunk: Buffer) => {
          out += chunk.toString();
          // Bound the buffer, not just the evidence: a runaway process can
          // print faster than anything reads.
          if (out.length > 2_000_000) out = out.slice(-1_000_000);
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);

        const finish = (result: GateResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
          finish({
            verdict: "failed",
            // Distinguishable from a non-zero exit, deliberately. They are
            // different problems with different fixes.
            evidence: `timed out after ${spec.timeout ?? "15m"}\n\n${tail(out)}`,
            findings: [],
          });
        }, timeoutMs);

        const onAbort = () => {
          child.kill("SIGTERM");
          finish({ verdict: "failed", evidence: `aborted\n\n${tail(out)}`, findings: [] });
        };
        context.signal?.addEventListener("abort", onAbort, { once: true });

        child.on("error", (err) =>
          finish({
            verdict: "failed",
            evidence: `could not run "${spec.run}": ${err.message}`,
            findings: [],
          }),
        );

        child.on("close", (code) => {
          const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
          if (code === 0) {
            finish({ verdict: "passed", evidence: `${spec.run} exited 0 in ${took}`, findings: [] });
            return;
          }
          finish({
            verdict: "failed",
            evidence: `${spec.run} exited ${code} after ${took}\n\n${tail(out)}`,
            findings: [],
          });
        });
      });
    },
  };
}
