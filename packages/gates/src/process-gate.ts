/**
 * The process gate: run a command, the exit code is the verdict.
 *
 * This is `verify.sh` unchanged, which is the point — the old loop's build check
 * was the one part of it that worked, and collapsing it into the same primitive
 * as review and approval is what makes the other three cost a configuration line
 * (design.md §2).
 *
 * The execution itself now lives in `command.ts`, because the prepare stage
 * needs the same spawning, the same bounded buffer and the same distinction
 * between a timeout and a refusal — while needing none of this file's meaning.
 * What is left here is exactly the translation from "a command ended" to "a
 * verdict about a commit", which is the part that is genuinely about gates.
 */
import { parseDuration } from "@escapement/config";
import { runCommand } from "./command.ts";
import type { Gate, GateContext, GateResult } from "./gate.ts";

// Re-exported because they were part of this module's surface before the
// extraction, and moving a file should not move someone's import.
export { EVIDENCE_BYTES, EVIDENCE_LINES, tail } from "./command.ts";

export interface ProcessGateSpec {
  name: string;
  run: string;
  /** `15m` by default, per the recipe schema. */
  timeout?: string;
}

export function createProcessGate(spec: ProcessGateSpec): Gate {
  const timeoutLabel = spec.timeout ?? "15m";
  const timeoutMs = parseDuration(timeoutLabel);

  return {
    name: spec.name,
    kind: "run",

    async run(context: GateContext): Promise<GateResult> {
      const outcome = await runCommand({
        run: spec.run,
        timeoutMs,
        timeoutLabel,
        cwd: context.cwd,
        env: context.env,
        signal: context.signal,
      });

      // A process gate finds nothing structured — that is what the agent gate is
      // for (#18). Its evidence is the log, which is what someone acting on the
      // card actually needs.
      return { verdict: outcome.ok ? "passed" : "failed", evidence: outcome.evidence, findings: [] };
    },
  };
}
