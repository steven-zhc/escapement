/**
 * Resolving a recipe: read it from `origin/<base>`, validate it, hash it.
 *
 * The governance rule, in one place. Borrowed wholesale from GitHub Actions:
 * **the workflow that judges a change is read from the base branch, not from the
 * branch being judged.** So an agent that edits `.escapement/config.yaml`
 * changes nothing about the run in flight — the recipe was already snapshotted
 * and its hash recorded in `RunStarted` — the edit shows up in the diff where
 * the `tamper` gate catches it, and it takes effect from the next work item,
 * after a human approves and merges it.
 *
 * The reading is done by whatever `ReadAtRef` is given, and the only
 * implementation that matters reads through the GitHub API, where "at this ref"
 * is a server-side fact rather than a claim about a local checkout.
 * See doc/decisions/0005-config-in-target-repo.md.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { Recipe } from "./recipe.ts";

/** Where a project's recipe lives, by convention and without exception. */
export const RECIPE_PATH = ".escapement/config.yaml";

/** Reads a path at a ref. Returns null when the file is not there. */
export type ReadAtRef = (path: string, ref: string) => Promise<string | null>;

export class RecipeMissingError extends Error {
  override readonly name = "RecipeMissingError";
  readonly ref: string;

  constructor(ref: string) {
    super(
      `no ${RECIPE_PATH} on ${ref}. Add one and commit it to that branch — ` +
        "a recipe on the agent's branch is not read, by design.",
    );
    this.ref = ref;
  }
}

export class RecipeInvalidError extends Error {
  override readonly name = "RecipeInvalidError";
  /** Each problem as `path: message`, so a fix does not need a schema reading. */
  readonly problems: readonly string[];

  constructor(ref: string, problems: readonly string[]) {
    super(`${RECIPE_PATH} on ${ref} is not valid:\n  ${problems.join("\n  ")}`);
    this.problems = problems;
  }
}

export interface ResolvedRecipe {
  recipe: Recipe;
  /**
   * Hash of the *resolved* recipe, canonically serialised.
   *
   * Of the resolved form rather than the file's bytes: two files that differ
   * only in comments or key order describe the same run, and a replay comparing
   * "did results change after I edited the pipeline?" should say no. Recorded in
   * `ProjectConfigured` and in every `RunStarted`.
   */
  configHash: string;
  /** The ref it was read from — always a base branch, never an agent branch. */
  ref: string;
  /** The raw file, kept so a diff against a later version is possible. */
  source: string;
}

/** Stable JSON: keys sorted at every level, so the hash does not depend on order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function hashRecipe(recipe: Recipe): string {
  return createHash("sha256").update(canonical(recipe)).digest("hex");
}

/**
 * Reads and validates the recipe at a ref.
 *
 * Throws rather than returning a result type: every caller's correct response to
 * an unreadable recipe is to stop, and a project that cannot be configured must
 * not be silently run with a default.
 */
export async function resolveRecipe(read: ReadAtRef, ref: string): Promise<ResolvedRecipe> {
  const source = await read(RECIPE_PATH, ref);
  if (source === null) throw new RecipeMissingError(ref);

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new RecipeInvalidError(ref, [`could not be parsed as YAML: ${(err as Error).message}`]);
  }

  const parsed = Recipe.safeParse(raw);
  if (!parsed.success) {
    throw new RecipeInvalidError(
      ref,
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }

  return { recipe: parsed.data, configHash: hashRecipe(parsed.data), ref, source };
}
