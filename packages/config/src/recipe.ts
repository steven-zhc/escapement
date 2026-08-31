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
 * What is *not* here is policy — the tier floor, which gates are mandatory, who
 * may approve, the production host patterns. That lives in Escapement's own
 * database as `ProjectPolicySet` events, out of the repo's reach entirely, the
 * same way branch protection lives outside a workflow file. A recipe may add
 * strictness; it can never remove it.
 *
 * See doc/decisions/0005-config-in-target-repo.md.
 */
import { z } from "zod";
import { WorkKind, RuntimeId } from "@escapement/core";

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
    prompt: z.string().optional(),
    limits: z
      .object({ turns: z.number().int().positive().default(300), wall: z.string().default("2h") })
      .default({ turns: 300, wall: "2h" }),
  }),
});
export type Recipe = z.infer<typeof Recipe>;
