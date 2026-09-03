/**
 * The globs a policy gate watches, compiled early.
 *
 * Compiled at `lingtai doctor` time rather than mid-run, because a pattern with a
 * typo in it should be a refusal at configuration time, not a gate that quietly
 * matches nothing. A watch that matches nothing looks exactly like a watch with
 * nothing to report, and the two must not be confusable — the whole point of
 * `tamper` is that it fires rarely.
 */
import picomatch from "picomatch";

export class BadWatchPatternError extends Error {
  override readonly name = "BadWatchPatternError";
  readonly gate: string;
  readonly pattern: string;

  constructor(gate: string, pattern: string, cause: string) {
    super(`the "${gate}" gate watches "${pattern}", which is not a usable glob: ${cause}`);
    this.gate = gate;
    this.pattern = pattern;
  }
}

export interface Watcher {
  /** Every watched path in the list, in the order given. */
  matches(paths: readonly string[]): string[];
}

export function compileWatch(gate: string, patterns: readonly string[]): Watcher {
  const compiled = patterns.map((pattern) => {
    if (!pattern.trim()) {
      throw new BadWatchPatternError(gate, pattern, "it is empty");
    }
    try {
      // `dot: true` because half of what is worth watching is a dotfile —
      // `.github/workflows/**` and `.lingtai/**` both are, and a matcher
      // that skips them by default would watch nothing while looking correct.
      return picomatch(pattern, { dot: true });
    } catch (err) {
      throw new BadWatchPatternError(gate, pattern, (err as Error).message);
    }
  });

  return {
    matches(paths) {
      return paths.filter((path) => compiled.some((isMatch) => isMatch(path)));
    },
  };
}

/**
 * `tamper` — the surface an agent can edit to change what its own gates check.
 *
 * `package.json` scripts and the test configuration decide what the build gate
 * actually verifies, and the agent can edit both. The old loop had no defence
 * here at all: a change that edited `verify.sh` and then passed `verify.sh` was
 * indistinguishable from one that passed.
 *
 * `.lingtai/**` is here for completeness rather than for safety. The recipe
 * that governs a run is read from `origin/<base>`, so editing it on a branch
 * changes nothing about the run in flight — but it changes the *next* one, and
 * a person should see that before it merges.
 *
 * Note what this is not: a security boundary. An agent that wants to weaken its
 * own verification can do so in a file nobody thought to watch. This catches
 * the accident and the obvious, which is most of them, and 0007 says the rest
 * plainly.
 */
export const TAMPER_WATCH: readonly string[] = [
  ".lingtai/**",
  "package.json",
  "**/package.json",
  ".github/workflows/**",
  "**/vitest.config.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/playwright.config.*",
  "**/tsconfig*.json",
];

/**
 * The migration hold: a schema change is applied by a person who has read it.
 *
 * The integrator refuses a diff containing these too, and that is deliberate
 * duplication. This one runs earlier, produces evidence on the card, and is
 * configurable; the integrator's is a backstop that no recipe can switch off.
 * A hold that only exists in configuration is one an edit can remove.
 */
export const MIGRATION_WATCH: readonly string[] = [
  "**/migrations/**",
  "**/migration/**",
  "prisma/**/*.sql",
];
