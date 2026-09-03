/**
 * The human gate: a person, with the same event shape as a process.
 *
 * The whole design turns on this being a *gate* and not a special case. A
 * verification, a cold review and a person's approval are one primitive — a
 * named check that produces a verdict about a specific diff — and that is what
 * makes "require a human on anything touching payments" a configuration line
 * instead of a branch through the scheduler.
 *
 * So there is almost nothing here. It asks, every time, and the answer arrives
 * later as `ApprovalGranted` on the same stream. The interesting parts live
 * where they belong to everything: `onSha` binds the answer to a commit, so a
 * force-push invalidates it by arithmetic rather than by anybody remembering
 * to revoke it — which is the bug the old label-based approval had, where a
 * label survived any amount of rewriting and a rewritten branch inherited its
 * own approval.
 *
 * There is no `approvers` field, here or in the recipe, and that is deliberate:
 * a recipe that could name its own approvers could approve itself. Who answered
 * is recorded rather than restricted — `by` on the approval, in the log.
 */
import type { Gate, GateContext, GateResult } from "./gate.ts";

export interface HumanGateSpec {
  name: string;
  /** What the person is being asked. The card shows this and nothing else. */
  question?: string;
}

export function createHumanGate(spec: HumanGateSpec): Gate {
  return {
    name: spec.name,
    kind: "human",

    async run(context: GateContext): Promise<GateResult> {
      return {
        verdict: "needs-approval",
        // The sha is in the question because the answer is about *this* commit
        // and a person reading the card should be able to see which.
        evidence:
          spec.question ??
          `${spec.name}: this needs a person before it merges (${context.onSha.slice(0, 7)}).`,
        findings: [],
      };
    },
  };
}
