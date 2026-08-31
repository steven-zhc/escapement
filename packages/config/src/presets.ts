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
  gates?: Recipe["gates"];
  runtime?: Partial<Recipe["runtime"]>;
};

export const PRESETS: Record<string, Preset> = {
  /**
   * A pnpm workspace with submodules and a single `verify` script — the shape
   * `nextloom-ai-admin` actually has, which is the only reason it is here.
   *
   * `submodules: true` is not a stylistic default. `git worktree add` does not
   * populate submodules, and a worktree without them fails every test that
   * imports one — which reads on the board as "the agent broke the tests".
   */
  "pnpm-workspace": {
    repo: { submodules: true },
    gates: [{ kind: "process", name: "build", run: "pnpm verify", timeout: "15m" }],
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
      gates: recipe["gates"] ?? preset.gates,
    },
    preset: name,
  };
}
