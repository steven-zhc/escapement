/**
 * The recipe: `<repo>/.escapement/config.yaml`, committed to the managed
 * repository and owned by it.
 *
 * It is safe to keep this in the repo the agent is editing because of one rule,
 * borrowed wholesale from GitHub Actions: **the recipe that governs a run is
 * read from `origin/<base>`, never from the agent's branch.** An agent that
 * edits this file changes nothing about the run in flight; the edit shows up in
 * the diff, the `tamper` gate catches it, and it takes effect only after a
 * human approves and merges it.
 *
 * There is no policy above it any more (ADR 0016 §7): the workflow is the
 * repository's to define, and Escapement does not second-guess it. What still
 * holds from [0005](../../../doc/decisions/0005-config-in-target-repo.md) is
 * where it is read from — `origin/<base>`, never the agent's branch, so a branch
 * cannot change the rules of the run it is part of. A recipe may add
 * strictness; it can never remove it.
 *
 * See doc/decisions/0005-config-in-target-repo.md.
 */
import { z } from "zod";
import { Tier, WorkKind, RuntimeId } from "@escapement/core";

export const GateSpec = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("process"),
    name: z.string(),
    run: z.string(),
    timeout: z.string().default("15m"),
  }),
  z.object({
    kind: z.literal("agent"),
    name: z.string(),
    prompt: z.string(),
  }),
  z.object({
    kind: z.literal("policy"),
    name: z.string(),
    /** Globs matched against the diff's file list. */
    watch: z.array(z.string()).min(1),
    then: z.enum(["request-approval", "fail"]).default("request-approval"),
  }),
  z.object({
    kind: z.literal("human"),
    name: z.string(),
  }),
]);
export type GateSpec = z.infer<typeof GateSpec>;

export const Recipe = z.object({
  version: z.literal(1),
  /** Pulls install/build/test defaults from a preset shipped with Escapement. */
  extends: z.string().optional(),

  repo: z.object({
    base: z.string(),
    /** `git worktree add` does not populate submodules; not doing so breaks every
     *  test that imports one, and reads as "the agent broke the tests". */
    submodules: z.boolean().default(false),
  }),

  /**
   * Getting the worktree workable before the agent starts. Ordered, and the
   * first refusal stops the run.
   *
   * Optional because it is genuinely optional: a Go repository may need nothing
   * at all. But `git worktree add` copies no `node_modules`, so for most of them
   * the absence of this is the difference between an agent that can run the
   * tests and one writing blind.
   *
   * Not a gate. A gate's verdict is about a commit — `onSha` — and a force-push
   * invalidates it by arithmetic. A prepare step runs before the agent has
   * written anything and holds no verdict about anything.
   */
  prepare: z
    .array(
      z.object({
        name: z.string(),
        run: z.string(),
        /** Shorter than a gate's by default: installing is not verifying. */
        timeout: z.string().default("10m"),
      }),
    )
    .default([]),

  source: z.object({
    /** Also the priority order: earlier wins. */
    kinds: z.array(WorkKind).min(1),
    /** Labels of yours that must keep the agent off a ticket. */
    exclude: z.array(z.string()).default([]),
  }),

  env: z.object({
    /** Variable NAMES only. Values resolve at runtime from somewhere the agent
     *  cannot see, so this file is safe to commit. */
    allow: z.array(z.string()).default([]),
    /** Where the filtered env file is planted inside the worktree. Rarely the
     *  repo root — Next/Prisma/vitest read it from the app directory. */
    plantAt: z.string(),
  }),

  gates: z.array(GateSpec).min(1),

  runtime: z.object({
    agent: RuntimeId.default("claude-code"),
    /**
     * How contained the runtime must be. `run-once` refuses to dispatch when the
     * runtime cannot meet it, which is the whole of the enforcement.
     *
     * Defaulted rather than optional since policy was deleted: there is no floor
     * underneath it to fall back to, and an absent tier that meant "unspecified"
     * would be a run whose containment nothing states. `guarded` is what every
     * run has actually used ([ADR 0007](../../../doc/decisions/0007-dual-runtime.md)).
     */
    tier: Tier.default("guarded"),
    prompt: z.string().optional(),
    limits: z
      .object({ turns: z.number().int().positive().default(300), wall: z.string().default("2h") })
      .default({ turns: 300, wall: "2h" }),
  }),
});
export type Recipe = z.infer<typeof Recipe>;

/**
 * `15m`, `2h`, `90s` → milliseconds.
 *
 * The recipe writes durations the way a person says them; everything that
 * consumes one needs a number. Throws on anything else rather than defaulting —
 * a gate that silently got a 0ms timeout would fail every run for a reason
 * nobody could see.
 */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a duration like 30s, 15m or 2h`);
  const n = Number(m[1]);
  const unit = m[2] as "ms" | "s" | "m" | "h";
  return n * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
}
