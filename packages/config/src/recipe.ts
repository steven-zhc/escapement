/**
 * The recipe: `<repo>/.lingtai/config.yaml`, committed to the managed
 * repository and owned by it.
 *
 * It is safe to keep this in the repo the agent is editing because of one rule,
 * borrowed wholesale from GitHub Actions: **the recipe that governs a run is
 * read from `origin/<base>`, never from the agent's branch.** An agent that
 * edits this file changes nothing about the run in flight; the edit shows up in
 * the diff, the `tamper` gate catches it, and it takes effect only after a
 * human approves and merges it.
 *
 * Nothing sits above this file. The workflow is the repository's to define,
 * and Lingtai does not second-guess it — what Lingtai owns is *where the file
 * is read from*, and that is the one thing a branch cannot change about the run
 * it is part of.
 *
 * See doc/decisions/0005-config-in-target-repo.md.
 */
import { z } from "zod";
import { Tier, WorkKind, RuntimeId } from "@lingtai/core";

/**
 * One thing that runs at a gate.
 *
 * The shape is GitHub Actions' — an optional `name`, exactly one key saying
 * *what kind of thing this is*, and that kind's parameters beside it. Copied
 * rather than invented because [ADR 0005](../../../doc/decisions/0005-config-in-target-repo.md)
 * already frames a recipe as a workflow file, and a second dialect for the same
 * idea is a second thing to learn for no gain.
 *
 * A union rather than a discriminated union: the discriminator is *which key is
 * present*, which zod cannot switch on. The cost is a worse error message on a
 * malformed action; the alternative was a `uses:` field on every entry,
 * including the ones where it says nothing.
 */
export const GateAction = z.union([
  /** A command. Its exit code is the verdict. */
  z.object({
    name: z.string(),
    run: z.string(),
    timeout: z.string().default("15m"),
  }),
  /** A cold reviewer, given the diff and this prompt. */
  z.object({
    name: z.string(),
    agent: z.string(),
  }),
  /** Globs against the diff's file list; a match holds or fails. */
  z.object({
    name: z.string(),
    watch: z.array(z.string()).min(1),
    then: z.enum(["request-approval", "fail"]).default("request-approval"),
  }),
  /** Waits for a person. The string is the question they are asked. */
  z.object({
    name: z.string(),
    human: z.string(),
  }),
  /**
   * Closes the issue. Only meaningful at `end`, which is the one point that
   * cannot refuse — these run for effect.
   *
   * `when` filters on the outcome, because `end` fires on *every* terminal
   * state. "Close it when it lands, label it when it is blocked" is then one
   * configuration rather than two mechanisms.
   */
  z.object({
    name: z.string(),
    close: z.literal(true),
    when: z.enum(["landed", "blocked", "failed", "any"]).default("landed"),
  }),
  /** Sets labels. Lingtai's own are replaced; everybody else's are kept. */
  z.object({
    name: z.string(),
    labels: z.array(z.string()),
    when: z.enum(["landed", "blocked", "failed", "any"]).default("any"),
  }),
]);
export type GateAction = z.infer<typeof GateAction>;

/**
 * What runs at each of the five points.
 *
 * Every point is present and defaults to empty, which is the whole design in
 * one line: **an unconfigured gate is skipped, and the skip is visible.** A
 * missing key here is not "undefined", it is "nothing runs, and the board says
 * so" (ADR 0016 §4).
 *
 * Order within a point is the array's. The first refusal wins and the actions
 * after it do not run — continuing would spend money producing verdicts about a
 * diff that is not going anywhere.
 *
 * **Strict, and that is what makes the closed set enforceable.** A key that is
 * not one of the five is a typo or a stale name, and zod's default is to drop
 * it silently — which would mean a recipe whose `merg:` block never runs and a
 * board that says `skipped` because it was told nothing was configured. That is
 * exactly the "configured and did not run" failure the model calls Lingtai's
 * bug (ADR 0016 §4). It is also what a recipe still saying `diff:` would hit
 * after [0018](../../../doc/decisions/0018-the-proposed-point.md): it fails to
 * resolve, loudly, naming the key.
 */
export const GateMap = z.strictObject({
  admit: z.array(GateAction).default([]),
  prepared: z.array(GateAction).default([]),
  /** Was `diff` until [0018](../../../doc/decisions/0018-the-proposed-point.md). */
  proposed: z.array(GateAction).default([]),
  merge: z.array(GateAction).default([]),
  end: z.array(GateAction).default([]),
});
export type GateMap = z.infer<typeof GateMap>;

/** The action's kind, for an event and for dispatch. Exactly one key decides it. */
export type ActionKind = "run" | "agent" | "watch" | "human" | "close" | "labels";

export function kindOfAction(action: GateAction): ActionKind {
  if ("run" in action) return "run";
  if ("agent" in action) return "agent";
  if ("watch" in action) return "watch";
  if ("close" in action) return "close";
  if ("labels" in action) return "labels";
  return "human";
}

export const Recipe = z.object({
  version: z.literal(1),
  /** Pulls install/build/test defaults from a preset shipped with Lingtai. */
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
  source: z.object({
    /** Also the priority order: earlier wins. */
    kinds: z.array(WorkKind).min(1),
    /**
     * Labels of yours that must keep the agent off a ticket, matched
     * case-insensitively by whole name.
     *
     * **This is the only reason an issue is passed over for its labels.** There
     * was a rule in `discover.ts` too, skipping anything labelled `agent:*` as
     * belonging to another system; it is gone. A namespace is not a meaning —
     * `agent:hold` and `agent:followup` share a prefix and mean opposite
     * things — and which of a repository's labels are holds is a fact that
     * repository has and this schema does not.
     *
     * Whole names rather than patterns, deliberately: `agent:*` would have to
     * be spelled with an exception for the one label in it that means "ready",
     * and an exclude list with negation in it is a small language. List them.
     */
    exclude: z.array(z.string()).default([]),
  }),

  /**
   * What the run cannot proceed without.
   *
   * **Strict, for the reason `GateMap` is.** This was `allow` — an allowlist,
   * meaning "plant these if they happen to exist" — and that meaning cost $0.97
   * and ten turns against a database the agent could not reach, with one log
   * line as the only sign. A repository naming a variable is a repository saying
   * it needs one ([0020](../../../doc/decisions/0020-the-agent-environment-in-layers.md)).
   * A recipe still saying `allow:` must therefore fail to resolve and name the
   * key, rather than resolve to an empty list and refuse nothing — the same
   * silent half-move [0018](../../../doc/decisions/0018-the-proposed-point.md)
   * made zod's default drop.
   */
  env: z.strictObject({
    /** Variable NAMES only. Values resolve at runtime from somewhere the agent
     *  cannot see, so this file is safe to commit. A name that is not here never
     *  reaches the agent from the conductor's environment. */
    required: z.array(z.string()).default([]),
    /** Where the filtered env file is planted inside the worktree. Rarely the
     *  repo root — Next/Prisma/vitest read it from the app directory. */
    plantAt: z.string(),
  }),

  // Spelled out rather than `.default({})`: all five points exist whether or
  // not a recipe mentions them, and writing that here says so once.
  gates: GateMap.default({ admit: [], prepared: [], proposed: [], merge: [], end: [] }),

  runtime: z.object({
    agent: RuntimeId.default("claude-code"),
    /**
     * How contained the runtime must be. `run-once` refuses to dispatch when the
     * runtime cannot meet it, which is the whole of the enforcement.
     *
     * Defaulted rather than optional: nothing sits underneath it to fall back
     * to, so an absent tier meaning "unspecified" would be a run whose
     * containment nothing states. `guarded` is what every
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
