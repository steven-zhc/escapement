/**
 * The `watch` action: look at what the diff touches, and stop when it touches
 * something a person should see.
 *
 * The cheapest gate there is — it reads a list of paths and matches globs, with
 * no process and no model — and two of the three things it guards were real
 * gaps in the old loop.
 *
 * **`tamper`.** `package.json` scripts and the test configuration decide what
 * the build gate actually verifies, and the agent can edit them. A change that
 * edited the verification and then passed the verification was indistinguishable
 * from one that passed. The old loop had no defence here at all.
 *
 * **The migration hold.** A schema change is applied by a person who has looked
 * at it, not by a merge. The integrator refuses these too; this one runs
 * earlier, puts the reason on the card, and names the files.
 *
 * `then` decides which of the two things a match means. `request-approval` is
 * "someone look at this" — the diff is fine, it just is not the machine's to
 * wave through. `fail` is "this should not have happened", for a watch on
 * something nothing legitimate touches.
 *
 * The evidence names the files **and what to do about them**, because a card
 * that says "held: tamper" sends the reader somewhere else to find out why, and
 * that is the failure the board exists to remove.
 */
import { compileWatch, type Watcher } from "@lingtai/config";
import type { Gate, GateContext, GateResult } from "./gate.ts";

export interface WatchGateSpec {
  name: string;
  watch: readonly string[];
  then: "request-approval" | "fail";
}

export interface WatchGateDeps {
  /** Paths in the diff, relative to the repository root. Supplied by the caller
   *  for the same reason the reviewer's diff is: this package has no git. */
  changedFiles: () => Promise<string[]>;
  /** Said back to the operator on a match. Defaults are per-gate below. */
  advice?: string;
}

/** What to do about it, when the gate's name is one that ships with Lingtai. */
const ADVICE: Record<string, string> = {
  tamper:
    "These decide what the other gates actually check, so a change to them is a " +
    "change to the verification itself. Read the diff before approving.",
  migrations:
    "Apply the migration by hand first, then approve. A merge does not run it, " +
    "and a branch that lands ahead of its schema is the expensive kind of broken.",
};

export function createWatchGate(spec: WatchGateSpec, deps: WatchGateDeps): Gate {
  // Compiled once, when the gate is built — which is also `lingtai doctor` time, so
  // a bad pattern is a configuration error rather than a gate that silently
  // matches nothing.
  const watcher: Watcher = compileWatch(spec.name, spec.watch);

  return {
    name: spec.name,
    kind: "watch",

    async run(_context: GateContext): Promise<GateResult> {
      const changed = await deps.changedFiles();
      const hits = watcher.matches(changed);

      if (hits.length === 0) {
        return {
          verdict: "passed",
          evidence: `nothing in the diff matches ${spec.watch.join(", ")}`,
          findings: [],
        };
      }

      const advice = deps.advice ?? ADVICE[spec.name] ?? "Read these before approving.";
      const listed = hits.slice(0, 20).join("\n");
      const more = hits.length > 20 ? `\n…and ${hits.length - 20} more` : "";
      const evidence = `${spec.name} matched ${hits.length} file(s):\n${listed}${more}\n\n${advice}`;

      return {
        verdict: spec.then === "fail" ? "failed" : "needs-approval",
        evidence,
        findings: [],
      };
    },
  };
}
