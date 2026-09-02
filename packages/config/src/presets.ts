/**
 * Presets: the defaults a recipe can `extends` instead of restating.
 *
 * A preset carries the shape a *toolchain* implies — how you install, how you
 * verify — not what a *project* decides. Which gates are mandatory, where the
 * env file is planted and which kinds of work item are eligible all differ
 * between two repositories using the same package manager, so none of them has
 * a defensible default and none is here.
 *
 * Deliberately small. There is one preset because there is one project; a second
 * that is guessed at rather than derived from a repository that exists would be
 * exactly the configuration sprawl design.md §8 refuses.
 */
import type { Recipe } from "./recipe.ts";

/** What a preset may fill in. Everything is optional; the recipe always wins. */
export type Preset = {
  repo?: Partial<Recipe["repo"]>;
  prepare?: Recipe["prepare"];
  gates?: Recipe["gates"];
  runtime?: Partial<Recipe["runtime"]>;
};

export const PRESETS: Record<string, Preset> = {
  /**
   * A pnpm workspace with submodules.
   *
   * This used to claim it was "the shape `nextloom-ai-admin` actually has" and
   * gate on `pnpm verify`. That repository has no `verify` script — it has
   * `typecheck`, `lint` and `test` — so the preset described a repository I had
   * imagined rather than one that exists, and anyone who wrote
   * `extends: pnpm-workspace` would have had the gate die on a missing script.
   * The lesson is in the comment as much as in the fix: a default derived from
   * a repository has to be read off that repository.
   *
   * The install is a `prepare` step, not part of the gate. It was in the gate
   * briefly, which fixed the gate and left the agent holding the same empty
   * worktree — unable to run the tests it was being asked to keep green.
   *
   * `submodules: true` is not a stylistic default either. `git worktree add`
   * does not populate submodules, and a worktree without them fails every test
   * that imports one — which reads the same wrong way.
   */
  "pnpm-workspace": {
    repo: { submodules: true },
    prepare: [{ name: "install", run: "pnpm install --frozen-lockfile", timeout: "10m" }],
    // Only `diff` is filled. The other four points are empty and stay empty
    // until a project says otherwise — which the board renders as `skipped`
    // rather than omitting (ADR 0016 §4).
    gates: {
      admit: [],
      prepared: [],
      diff: [{ name: "build", run: "pnpm typecheck && pnpm lint && pnpm test", timeout: "15m" }],
      merge: [],
      end: [],
    },
    runtime: { agent: "claude-code" },
  },
};

export class UnknownPresetError extends Error {
  override readonly name = "UnknownPresetError";
  constructor(name: string) {
    super(`no preset named "${name}" — known: ${Object.keys(PRESETS).join(", ")}`);
  }
}

export interface PresetApplied {
  /** The recipe with the preset merged underneath, and `extends` removed. */
  recipe: unknown;
  /** Which preset was used, kept as provenance rather than as behaviour. */
  preset: string | null;
}

/**
 * Applies a preset underneath a parsed recipe.
 *
 * Shallow per section, and arrays replace rather than concatenate. A recipe that
 * lists gates means *those* gates; silently appending the preset's would be a
 * way to acquire a gate nobody wrote down, and the merge rule you cannot predict
 * is worse than the one you have to restate.
 *
 * Runs against the raw object before validation, so a preset can satisfy a
 * required field the recipe omits.
 *
 * **`extends` does not survive.** The hash is of what the run will *do*, and a
 * preset's name is not part of that: a recipe that names a preset and one that
 * spells the same thing out describe the same run and must hash the same. The
 * preset's *contents* are inside the hash, so changing one is still a
 * configuration change. The name comes back separately, as provenance.
 */
export function applyPreset(raw: unknown): PresetApplied {
  if (raw === null || typeof raw !== "object") return { recipe: raw, preset: null };
  const recipe = raw as Record<string, unknown>;
  const name = recipe["extends"];
  if (typeof name !== "string") return { recipe: raw, preset: null };

  const preset = PRESETS[name];
  if (!preset) throw new UnknownPresetError(name);

  const section = (key: "repo" | "runtime") => {
    const base = preset[key];
    const own = recipe[key];
    if (!base) return own;
    if (own === undefined) return { ...base };
    if (own === null || typeof own !== "object") return own;
    return { ...base, ...(own as object) };
  };

  const { extends: _dropped, ...rest } = recipe;
  return {
    recipe: {
      ...rest,
      repo: section("repo"),
      runtime: section("runtime"),
      // Arrays replace rather than concatenate, for both of these. A recipe
      // that lists its own steps means *those* steps; silently appending the
      // preset's would be a way to acquire work nobody wrote down.
      prepare: recipe["prepare"] ?? preset.prepare,
      gates: recipe["gates"] ?? preset.gates,
    },
    preset: name,
  };
}
