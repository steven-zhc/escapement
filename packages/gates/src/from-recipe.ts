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
import { createHumanGate } from "./human-gate.ts";
import { createPolicyGate, type PolicyGateDeps } from "./policy-gate.ts";
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
  policy?: PolicyGateDeps;
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
    if (spec.kind === "policy") {
      if (!deps.policy) {
        throw new GateKindNotImplementedError(
          spec.name,
          spec.kind,
          "no file list was supplied to gatesFromRecipe",
        );
      }
      // Compiles the globs here, so a bad pattern refuses at configuration time
      // rather than becoming a watch that quietly matches nothing.
      return createPolicyGate({ name: spec.name, watch: spec.watch, then: spec.then }, deps.policy);
    }
    if (spec.kind === "human") {
      // Needs nothing: it asks, and the answer arrives later on the same stream.
      return createHumanGate({ name: spec.name });
    }

    // Every kind in the schema is handled, so this is `never` and the compiler
    // says so. Kept rather than deleted: adding a fifth kind should be a type
    // error here, not a gate that falls through and does nothing.
    const unreachable: never = spec;
    throw new GateKindNotImplementedError(
      (unreachable as { name: string }).name,
      (unreachable as { kind: string }).kind,
      "Phase 2",
    );
  });
}
