/**
 * The prepare stage on its own, without a database.
 *
 * The end-to-end path is covered in `run-once.test.ts`, where prepare writes a
 * file and the agent refuses unless it is there. What is left for here is the
 * behaviour that is awkward to provoke through a whole run: several steps, the
 * ones after a refusal, and a timeout as distinct from a refusal.
 */
import type { Envelope, ToAppend } from "@escapement/core";
import type { EventStore } from "@escapement/store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareWorktree } from "../src/prepare.ts";

/**
 * Enough of an event store to append and read one stream. Deliberately not a
 * mock: it enforces the same optimistic-concurrency rule the real one does, so a
 * stage that appends at the wrong version fails here too.
 */
function memoryStore(): EventStore & { events: Envelope[] } {
  const events: Envelope[] = [];
  return {
    events,
    async append(streamId: string, expectedVersion: number, batch: readonly ToAppend[]) {
      const current = events.filter((e) => e.streamId === streamId).length;
      if (current !== expectedVersion) {
        throw new Error(`expected version ${expectedVersion}, stream is at ${current}`);
      }
      const written = batch.map((e, i) => ({
        ...e,
        streamId,
        version: expectedVersion + i + 1,
        seq: BigInt(events.length + i + 1),
        at: new Date(),
        schemaVer: 1,
        eventId: crypto.randomUUID(),
      })) as unknown as Envelope[];
      events.push(...written);
      return written;
    },
    async read(streamId: string) {
      return events.filter((e) => e.streamId === streamId);
    },
    async readAll() {
      return events;
    },
  };
}

const step = (name: string, run: string, timeout = "1m") => ({ name, run, timeout });

describe("the prepare stage", () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), "esc-prepare-"));
  });
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const prepare = (steps: ReturnType<typeof step>[], store = memoryStore()) =>
    prepareWorktree({
      runId: "run-test",
      workItemId: "wi-test-1",
      cwd,
      env: { PATH: process.env["PATH"] ?? "" },
      steps,
      store,
      at: 0,
    }).then(
      (result) => ({ result, types: store.events.map((e) => e.type) }),
    );

  it("does nothing, successfully, when a project needs no preparation", async () => {
    const { result, types } = await prepare([]);

    expect(result.ok).toBe(true);
    // A Go repository may genuinely need none of this. Not needing preparation
    // is not the same as being unprepared, and it should leave no events.
    expect(types).toEqual([]);
    if (result.ok) expect(result.version).toBe(0);
  });

  it("runs steps in recipe order", async () => {
    const { result, types } = await prepare([step("first", "true"), step("second", "true")]);

    expect(result.ok).toBe(true);
    expect(types).toEqual([
      "PreparationStarted",
      "PreparationPassed",
      "PreparationStarted",
      "PreparationPassed",
    ]);
    // The version the caller will append `RunStarted` at. Getting this wrong is
    // a concurrency error at the next append rather than a wrong answer, which
    // is why the fake store enforces it.
    if (result.ok) expect(result.version).toBe(4);
  });

  it("stops at the first refusal rather than running the rest", async () => {
    const { result, types } = await prepare([
      step("install", "echo cannot resolve foo@1.2.3; exit 1"),
      step("build", "echo this must not run; exit 1"),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.step).toBe("install");
    expect(result.detail).toContain("cannot resolve foo@1.2.3");

    // Two events, not four. Running the rest after one has failed produces
    // secondary failures whose only effect is to bury the one that mattered —
    // the second command fails *because* the first did.
    expect(types).toEqual(["PreparationStarted", "PreparationFailed"]);
  });

  it("distinguishes running out of time from running and refusing", async () => {
    const { result } = await prepare([step("install", "sleep 5", "300ms")]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Different problems with different fixes. A timeout means the step needs
    // longer or is stuck; a non-zero exit means it ran and said no. Collapsing
    // them is how the old loop's gate could hang for two hours and report
    // nothing.
    expect(result.timedOut).toBe(true);
    expect(result.detail).toContain("timed out after 300ms");
  });

  it("reports a command that does not exist as the command, not as ENOENT", async () => {
    const { result } = await prepare([step("install", "definitely-not-a-real-binary-xyz")]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Through a shell, so this is a non-zero exit rather than a spawn error —
    // but the message still has to name what was being run.
    expect(result.detail).toContain("definitely-not-a-real-binary-xyz");
  });

  it("records the log tail on the event, not only in the return value", async () => {
    const store = memoryStore();
    await prepare([step("install", "echo the-thing-that-broke; exit 3")], store);

    const failed = store.events.find((e) => e.type === "PreparationFailed");
    const data = failed?.data as { evidence: string; timedOut: boolean; step: string };
    // The board reads the log, not the caller's return value. A card that says
    // "prepare failed" with no output is a link to somewhere else in disguise.
    expect(data.evidence).toContain("the-thing-that-broke");
    expect(data.timedOut).toBe(false);
    expect(data.step).toBe("install");
  });
});
