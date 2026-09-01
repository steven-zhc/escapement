/**
 * The governance rule, as tests: **a recipe may add strictness; it can never
 * remove it.** Both directions matter — a conflict that is refused, and a
 * tightening that is allowed.
 */
import { describe, expect, it } from "vitest";
import {
  PolicyConflictError,
  RECIPE_PATH,
  RecipeInvalidError,
  type Policy,
  assertAllowedByPolicy,
  effectiveTier,
  policyConflicts,
  resolveRecipe,
} from "../src/index.ts";

const policy: Policy = {
  project: "nextloom-ai-admin",
  tier: "guarded",
  requiredGates: ["build", "review"],
  approvers: ["human:steven"],
  concurrent: 1,
};

const recipe = (over: string) => `
version: 1
repo: { base: develop }
source: { kinds: [bug] }
env: { plantAt: apps/web/.env.local }
${over}
`;

const reader = (yaml: string) => async (path: string, ref: string) =>
  ref === "develop" && path === RECIPE_PATH ? yaml : null;

/** Both gates the policy requires. `tier` is spliced in where a test needs one. */
const gatesOk = (runtime = "{ agent: claude-code }") => `
gates:
  - { kind: process, name: build, run: pnpm verify }
  - { kind: agent, name: review, prompt: cold-review }
runtime: ${runtime}
`;
const GATES_OK = gatesOk();

describe("policyConflicts", () => {
  it("is empty when the recipe declares everything the policy requires", async () => {
    const { recipe: r } = await resolveRecipe(reader(recipe(GATES_OK)), "develop");
    expect(policyConflicts(r, policy)).toEqual([]);
  });

  /**
   * The exam paper is in the candidate's hands, so the one thing it must not be
   * able to do is delete a question.
   */
  it("names the mandatory gate a recipe dropped", async () => {
    const dropped = `
gates:
  - { kind: process, name: build, run: pnpm verify }
runtime: { agent: claude-code }
`;
    const { recipe: r } = await resolveRecipe(reader(recipe(dropped)), "develop");
    const conflicts = policyConflicts(r, policy);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.clause).toBe("gates");
    expect(conflicts[0]!.policyRequires).toContain("review");
    expect(conflicts[0]!.recipeSays).toBe("build");
  });

  it("names the tier a recipe tried to lower", async () => {
    const lowered = gatesOk("{ agent: claude-code, tier: open }");
    const { recipe: r } = await resolveRecipe(reader(recipe(lowered)), "develop");
    const conflicts = policyConflicts(r, policy);

    expect(conflicts.map((c) => c.clause)).toEqual(["runtime.tier"]);
    expect(conflicts[0]!.recipeSays).toBe("open");
    expect(conflicts[0]!.policyRequires).toContain("guarded");
    expect(conflicts[0]!.why).toContain("never lower it");
  });

  it("allows a recipe to ask for more containment than the policy demands", async () => {
    const raised = gatesOk("{ agent: claude-code, tier: sandboxed }");
    const { recipe: r } = await resolveRecipe(reader(recipe(raised)), "develop");

    expect(policyConflicts(r, policy)).toEqual([]);
    // And the run executes at the stricter of the two, never the recipe's alone.
    expect(effectiveTier(r, policy)).toBe("sandboxed");
  });

  it("reports every conflict at once, not one at a time", async () => {
    const both = `
gates:
  - { kind: process, name: build, run: pnpm verify }
runtime: { agent: claude-code, tier: open }
`;
    const { recipe: r } = await resolveRecipe(reader(recipe(both)), "develop");
    // Fixing one only to be told about the next is the experience this avoids.
    expect(policyConflicts(r, policy).map((c) => c.clause).sort()).toEqual(["gates", "runtime.tier"]);
  });

  it("falls back to the policy's tier when the recipe asks for nothing", async () => {
    const { recipe: r } = await resolveRecipe(reader(recipe(GATES_OK)), "develop");
    expect(effectiveTier(r, policy)).toBe("guarded");
  });
});

describe("resolveRecipe with a policy", () => {
  it("refuses to resolve a recipe that would weaken the run, naming the clause", async () => {
    const dropped = `
gates:
  - { kind: process, name: build, run: pnpm verify }
runtime: { agent: claude-code }
`;
    const err = await resolveRecipe(reader(recipe(dropped)), "develop", policy).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PolicyConflictError);
    expect((err as Error).message).toContain('a gate named "review"');
    expect((err as PolicyConflictError).conflicts[0]!.clause).toBe("gates");
  });

  it("reports the tier the run will actually execute at", async () => {
    const resolved = await resolveRecipe(reader(recipe(GATES_OK)), "develop", policy);
    expect(resolved.tier).toBe("guarded");
  });

  it("leaves the tier unknown when no policy was supplied", async () => {
    const resolved = await resolveRecipe(reader(recipe(GATES_OK)), "develop");
    expect(resolved.tier).toBeNull();
  });

  it("assertAllowedByPolicy throws with every clause in the message", () => {
    expect(() =>
      assertAllowedByPolicy(
        {
          version: 1,
          repo: { base: "develop", submodules: false },
          source: { kinds: ["bug"], exclude: [] },
          env: { allow: [], plantAt: ".env" },
          gates: [{ kind: "process", name: "build", run: "x", timeout: "15m" }],
          runtime: { agent: "claude-code", tier: "open", limits: { turns: 300, wall: "2h" } },
        },
        policy,
      ),
    ).toThrow(/runtime\.tier[\s\S]*gates|gates[\s\S]*runtime\.tier/);
  });
});

describe("presets", () => {
  it("fills in what the recipe leaves out", async () => {
    const extending = `
version: 1
extends: pnpm-workspace
repo: { base: develop }
source: { kinds: [bug] }
env: { plantAt: apps/web/.env.local }
`;
    const { recipe: r } = await resolveRecipe(reader(extending), "develop");

    // submodules is not a stylistic default: a worktree without them fails every
    // test that imports one, and reads as the agent breaking them.
    expect(r.repo.submodules).toBe(true);
    expect(r.gates.map((g) => g.name)).toEqual(["build"]);
    expect(r.runtime.agent).toBe("claude-code");
  });

  it("lets the recipe override the preset, and does not append to its arrays", async () => {
    const overriding = `
version: 1
extends: pnpm-workspace
repo: { base: main, submodules: false }
source: { kinds: [bug] }
env: { plantAt: .env.local }
gates:
  - { kind: process, name: test, run: pnpm test }
`;
    const { recipe: r } = await resolveRecipe(reader(overriding), "develop");

    expect(r.repo.submodules).toBe(false);
    expect(r.repo.base).toBe("main");
    // A recipe that lists gates means *those* gates. Silently appending the
    // preset's would be a way to acquire a gate nobody wrote down.
    expect(r.gates.map((g) => g.name)).toEqual(["test"]);
  });

  it("names the unknown preset and what does exist", async () => {
    const bad = `
version: 1
extends: nope
repo: { base: develop }
source: { kinds: [bug] }
env: { plantAt: .env }
gates: [{ kind: process, name: build, run: x }]
`;
    const err = await resolveRecipe(reader(bad), "develop").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeInvalidError);
    expect((err as Error).message).toContain("pnpm-workspace");
  });

  it("puts the preset inside the hash, so changing one is a configuration change", async () => {
    const withPreset = `
version: 1
extends: pnpm-workspace
repo: { base: develop }
source: { kinds: [bug] }
env: { plantAt: apps/web/.env.local }
`;
    // Deliberately spelled out by hand rather than read from PRESETS: the test
    // is that two independent descriptions of the same run agree, and deriving
    // one from the other would make it agree with itself. The cost is that
    // changing the preset means changing this string, which is the correct
    // amount of friction for changing what every extending recipe will do.
    const spelledOut = `
version: 1
repo: { base: develop, submodules: true }
source: { kinds: [bug] }
env: { plantAt: apps/web/.env.local }
gates:
  - kind: process
    name: build
    run: pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test
    timeout: 15m
runtime: { agent: claude-code }
`;
    const a = await resolveRecipe(reader(withPreset), "develop");
    const b = await resolveRecipe(reader(spelledOut), "develop");

    // Same run, therefore same hash — the preset is resolved before hashing.
    expect(a.configHash).toBe(b.configHash);
  });
});
