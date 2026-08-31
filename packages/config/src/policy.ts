/**
 * Where the recipe stops and enforcement begins.
 *
 * The rule is one sentence, borrowed from how branch protection relates to a
 * workflow file: **a recipe may add strictness; it can never remove it.** The
 * recipe lives in the repository the agent edits, so it is the exam paper. The
 * policy lives in Escapement's own log, where the agent cannot reach it, and it
 * is what the exam is marked against.
 *
 * Two ways a recipe can try to weaken its own run, and both are refused by name:
 *
 *   - dropping a gate the policy marks mandatory
 *   - asking for a containment tier below the policy's floor
 *
 * Nothing here is a security boundary on its own. A recipe that passes still
 * describes a run whose real boundaries are the filtered environment, the
 * isolated worktree and, where one exists, a sandbox
 * (doc/decisions/0007-dual-runtime.md). This is the part that stops the
 * *configuration* from being the way around them.
 *
 * See doc/decisions/0005-config-in-target-repo.md.
 */
import type { Tier } from "@escapement/core";
import type { Recipe } from "./recipe.ts";

/** The policy as `ProjectPolicySet` last recorded it. */
export interface Policy {
  project: string;
  /** The floor. A recipe may ask for more containment, never less. */
  tier: Tier;
  /** Gate names the recipe must declare. Removing one is a conflict. */
  requiredGates: readonly string[];
  approvers: readonly string[];
  concurrent: number;
}

/** More containment is a higher number. Comparison is the whole of the rule. */
const CONTAINMENT: Record<Tier, number> = { open: 0, guarded: 1, sandboxed: 2 };

export interface PolicyConflict {
  /** Where in the recipe, so a fix does not need a search. */
  clause: string;
  recipeSays: string;
  policyRequires: string;
  why: string;
}

export class PolicyConflictError extends Error {
  override readonly name = "PolicyConflictError";
  readonly conflicts: readonly PolicyConflict[];

  constructor(project: string, conflicts: readonly PolicyConflict[]) {
    super(
      `the recipe conflicts with ${project}'s policy:\n` +
        conflicts
          .map((c) => `  ${c.clause}: recipe says ${c.recipeSays}, policy requires ${c.policyRequires} — ${c.why}`)
          .join("\n"),
    );
    this.conflicts = conflicts;
  }
}

/**
 * Every way this recipe would weaken this policy. Empty means it is allowed.
 *
 * Returned rather than thrown so `esc doctor` can report all of them at once —
 * fixing one conflict only to be told about the next is the experience this
 * exists to avoid.
 */
export function policyConflicts(recipe: Recipe, policy: Policy): PolicyConflict[] {
  const conflicts: PolicyConflict[] = [];

  const asked = recipe.runtime.tier;
  if (asked && CONTAINMENT[asked] < CONTAINMENT[policy.tier]) {
    conflicts.push({
      clause: "runtime.tier",
      recipeSays: asked,
      policyRequires: `${policy.tier} or stricter`,
      why: "a recipe may raise containment, never lower it",
    });
  }

  const declared = new Set(recipe.gates.map((g) => g.name));
  for (const required of policy.requiredGates) {
    if (!declared.has(required)) {
      conflicts.push({
        clause: "gates",
        recipeSays: declared.size === 0 ? "no gates" : [...declared].join(", "),
        policyRequires: `a gate named "${required}"`,
        why: "the policy marks it mandatory, and a recipe cannot remove one",
      });
    }
  }

  return conflicts;
}

/** Throws unless the recipe is allowed to govern a run under this policy. */
export function assertAllowedByPolicy(recipe: Recipe, policy: Policy): void {
  const conflicts = policyConflicts(recipe, policy);
  if (conflicts.length > 0) throw new PolicyConflictError(policy.project, conflicts);
}

/**
 * The tier a run will actually execute at: whichever of the two is stricter.
 *
 * Never the recipe's alone. If the combination cannot provide it, the scheduler
 * records `DispatchRefused` and does not run — it never silently downgrades.
 */
export function effectiveTier(recipe: Recipe, policy: Policy): Tier {
  const asked = recipe.runtime.tier;
  if (!asked) return policy.tier;
  return CONTAINMENT[asked] > CONTAINMENT[policy.tier] ? asked : policy.tier;
}
