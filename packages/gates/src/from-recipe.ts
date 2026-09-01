/**
 * Turning a recipe's `gates:` list into gates that can run.
 *
 * Kinds that are not built yet are **refused loudly**, naming the issue. A
 * pipeline that silently skipped the `human` gate because nothing implements it
 * would produce a green board for a change nobody approved — which is worse than
 * a run that will not start.
 */
import type { GateSpec } from "@escapement/config";
import { type AgentGateDeps, createAgentGate } from "./agent-gate.ts";
import type { Gate } from "./gate.ts";
import { createProcessGate } from "./process-gate.ts";

/**
 * What the kinds that are not pure processes need from the caller.
 *
 * Optional, because `esc doctor` and the config tests build gates purely to
 * check that a recipe *can* be built. Absent deps make an `agent` gate refuse
 * for the same reason an unimplemented kind does — loudly, rather than by
 * quietly not running.
 */
export interface GateDeps {
  agent?: AgentGateDeps;
}

export class GateKindNotImplementedError extends Error {
  override readonly name = "GateKindNotImplementedError";
  readonly kind: string;
  readonly gate: string;

  constructor(gate: string, kind: string, issue: string) {
    super(
      `the "${gate}" gate is kind "${kind}", which is not implemented yet (${issue}). ` +
        "Refusing to run rather than skipping it: a gate that is silently absent is worse than a run that will not start.",
    );
    this.gate = gate;
    this.kind = kind;
  }
}

const NOT_YET: Record<string, string> = {
  policy: "#19",
  human: "#20",
};

export function gatesFromRecipe(specs: readonly GateSpec[], deps: GateDeps = {}): Gate[] {
  return specs.map((spec) => {
    if (spec.kind === "process") {
      return createProcessGate({ name: spec.name, run: spec.run, timeout: spec.timeout });
    }
    if (spec.kind === "agent") {
      if (!deps.agent) {
        throw new GateKindNotImplementedError(
          spec.name,
          spec.kind,
          "no reviewer was supplied to gatesFromRecipe",
        );
      }
      return createAgentGate({ name: spec.name, prompt: spec.prompt }, deps.agent);
    }
    throw new GateKindNotImplementedError(spec.name, spec.kind, NOT_YET[spec.kind] ?? "Phase 2");
  });
}
