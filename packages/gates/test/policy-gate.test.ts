/**
 * The policy gate, the human gate, and the third verdict they both produce.
 *
 * The thing worth testing hardest is that `needs-approval` is not a synonym for
 * `failed`. A migration in the diff is not a broken build, and a card that says
 * so sends a person looking for a problem that does not exist.
 */
import { BadWatchPatternError, MIGRATION_WATCH, TAMPER_WATCH } from "@escapement/config";
import { describe, expect, it } from "vitest";
import type { GateEvent } from "../src/gate.ts";
import { runGatePipeline } from "../src/gate.ts";
import { createHumanGate } from "../src/human-gate.ts";
import { createPolicyGate } from "../src/policy-gate.ts";
import { createProcessGate } from "../src/process-gate.ts";

const context = { runId: "run-1", onSha: "b".repeat(40), cwd: process.cwd(), env: {} };

const policy = (watch: readonly string[], files: string[], then: "request-approval" | "fail" = "request-approval") =>
  createPolicyGate({ name: "tamper", watch, then }, { changedFiles: async () => files });

describe("the policy gate", () => {
  it("passes when the diff touches nothing it watches", async () => {
    const result = await policy(TAMPER_WATCH, ["src/app/page.tsx", "README.md"]).run(context);

    expect(result.verdict).toBe("passed");
  });

  it("asks for a person when the diff edits what decides the verification", async () => {
    const result = await policy(TAMPER_WATCH, ["src/x.ts", "package.json"]).run(context);

    // Not `failed`. Editing package.json is not a defect; it is a thing a
    // person should see, and the two must not render the same.
    expect(result.verdict).toBe("needs-approval");
    expect(result.evidence).toContain("package.json");
  });

  it("names the files and says what to do about them", async () => {
    const result = await policy(TAMPER_WATCH, ["apps/web/vitest.config.ts"]).run(context);

    expect(result.evidence).toContain("apps/web/vitest.config.ts");
    // A card reading "held: policy" sends the reader somewhere else to find out
    // why, which is the failure the board exists to remove.
    expect(result.evidence).toMatch(/read the diff before approving/i);
  });

  it("watches dotfiles, which is most of what is worth watching", async () => {
    // `.github/workflows/**` and `.escapement/**` are both dotted, and a
    // matcher that skips them by default watches nothing while looking correct.
    const workflows = await policy(TAMPER_WATCH, [".github/workflows/ci.yml"]).run(context);
    const recipe = await policy(TAMPER_WATCH, [".escapement/config.yaml"]).run(context);

    expect(workflows.verdict).toBe("needs-approval");
    expect(recipe.verdict).toBe("needs-approval");
  });

  it("catches a migration and says to apply it by hand first", async () => {
    const result = await createPolicyGate(
      { name: "migrations", watch: MIGRATION_WATCH, then: "request-approval" },
      { changedFiles: async () => ["prisma/migrations/0002_add_column/migration.sql"] },
    ).run(context);

    expect(result.verdict).toBe("needs-approval");
    expect(result.evidence).toMatch(/apply the migration by hand first/i);
  });

  it("refuses outright when told to, for a watch nothing legitimate touches", async () => {
    const result = await policy([".env*"], [".env.production"], "fail").run(context);

    expect(result.verdict).toBe("failed");
  });

  it("refuses a broken pattern when the gate is built, not when it runs", () => {
    // Built at `esc doctor` time. A watch that matches nothing looks exactly
    // like a watch with nothing to report, and `tamper` is supposed to fire
    // rarely — so the two must never be confusable.
    expect(() => policy(["  "], [])).toThrow(BadWatchPatternError);
  });
});

describe("the human gate", () => {
  it("always asks, and says which commit it is asking about", async () => {
    const result = await createHumanGate({ name: "approval" }).run(context);

    expect(result.verdict).toBe("needs-approval");
    expect(result.evidence).toContain(context.onSha.slice(0, 7));
  });
});

describe("the pipeline, when a gate wants a person", () => {
  const collect = async (gates: Parameters<typeof runGatePipeline>[0]["gates"]) => {
    const events: GateEvent[] = [];
    const result = await runGatePipeline({ point: "diff", gates, context, emit: (e) => void events.push(e) });
    return { result, types: events.map((e) => e.type) };
  };

  it("stops, and asks in the vocabulary --no-merge already used", async () => {
    const { result, types } = await collect([
      createProcessGate({ name: "build", run: "true", timeout: "1m" }),
      createHumanGate({ name: "approval" }),
      createProcessGate({ name: "after", run: "true", timeout: "1m" }),
    ]);

    expect(result.ok).toBe(false);
    expect(result.heldAt).toBe("approval");
    // Not a failure. Nothing refused.
    expect(result.failedAt).toBeNull();
    // The same event the flag emits, so the two never become two vocabularies
    // for one idea.
    expect(types).toContain("ApprovalRequested");
    expect(types).not.toContain("GateFailed");
    // And it stops, for the same reason a failure stops: the gates after it are
    // about a diff that is not going anywhere yet.
    expect(result.skipped).toEqual(["after"]);
  }, 30_000);

  it("keeps failure and hold distinguishable all the way out", async () => {
    const { result, types } = await collect([
      createProcessGate({ name: "build", run: "exit 1", timeout: "1m" }),
      createHumanGate({ name: "approval" }),
    ]);

    expect(result.failedAt).toBe("build");
    expect(result.heldAt).toBeNull();
    expect(types).toContain("GateFailed");
    expect(types).not.toContain("ApprovalRequested");
  }, 30_000);
});
