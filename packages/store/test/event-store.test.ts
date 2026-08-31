/**
 * These tests hit the real database. That is the point.
 *
 * `UNIQUE (stream_id, version)` is the entire concurrency control of this
 * system: if it does not hold, two workers claim the same work item. A mock
 * cannot tell you whether it holds. Neither can one connection — 0009 is the
 * record of a probe that shared a connection between the actor and the observer
 * and therefore confirmed something that was false. So the race test below
 * builds two independent clients and lets them collide.
 *
 * Every stream this file creates is removed afterwards. Cleanup has to disable
 * the append-only rule to do it, which is a global `ALTER TABLE` — do not run
 * this against a database a conductor is writing to.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConcurrencyError,
  createDb,
  createEventStore,
  type Db,
  type EventStore,
  UnknownEventTypeError,
} from "../src/index.ts";
import { cleanupStreams, discovered, streamId } from "./support.ts";

/** Every SQLSTATE in an error's `cause` chain. */
function sqlStates(err: unknown): string[] {
  const found: string[] = [];
  for (let cur: unknown = err, depth = 0; cur != null && depth < 8; depth++) {
    const e = cur as { sqlState?: unknown; code?: unknown; cause?: unknown };
    const state = typeof e.sqlState === "string" ? e.sqlState : e.code;
    if (typeof state === "string") found.push(state);
    cur = e.cause;
  }
  return found;
}

let a: Db;
let b: Db;
let store: EventStore;
let rival: EventStore;

beforeAll(() => {
  // Two clients, each with its own pool. Not a convenience — see the file header.
  a = createDb();
  b = createDb();
  store = createEventStore(a);
  rival = createEventStore(b);
});

afterAll(async () => {
  await a.close();
  await b.close();
  await cleanupStreams();
});

describe("append and read", () => {
  it("round-trips a batch and reads it back in version order", async () => {
    const s = streamId();

    const written = await store.append(s, 0, [discovered("first"), discovered("second")]);

    expect(written.map((e) => e.version)).toEqual([1, 2]);
    expect(written[0]!.seq).toBeLessThan(written[1]!.seq);
    expect(written[0]!.at).toBeInstanceOf(Date);
    expect(written[0]!.schemaVer).toBe(1);
    expect(written[0]!.causation).toBeNull();

    const read = await store.read(s);
    expect(read.map((e) => e.version)).toEqual([1, 2]);
    expect((read[0]!.data as { title: string }).title).toBe("first");
    expect(read[0]!.seq).toBe(written[0]!.seq);
    expect(read[0]!.at.getTime()).toBe(written[0]!.at.getTime());
  });

  it("reads from a version", async () => {
    const s = streamId();
    await store.append(s, 0, [discovered("one"), discovered("two"), discovered("three")]);

    expect((await store.read(s, 2)).map((e) => e.version)).toEqual([2, 3]);
    expect(await store.read(s, 9)).toEqual([]);
  });

  it("carries causation and a supplied actor through", async () => {
    const s = streamId();
    const [first] = await store.append(s, 0, [discovered("cause")]);
    const [second] = await store.append(s, 1, [
      { ...discovered("effect"), actor: "human:steven", causation: first!.seq },
    ]);

    expect(second!.causation).toBe(first!.seq);
    expect(second!.actor).toBe("human:steven");
  });

  it("appending nothing is not an error and writes nothing", async () => {
    const s = streamId();
    expect(await store.append(s, 0, [])).toEqual([]);
    expect(await store.read(s)).toEqual([]);
  });
});

describe("validation", () => {
  it("rejects a payload that does not match its event's schema", async () => {
    const s = streamId();
    await expect(
      store.append(s, 0, [{ type: "WorkItemDiscovered", actor: "conductor", data: { title: 12 } }]),
    ).rejects.toThrow();
    expect(await store.read(s)).toEqual([]);
  });

  it("rejects a type that is not in the catalogue", async () => {
    const s = streamId();
    await expect(
      store.append(s, 0, [{ type: "WorkItemInvented", actor: "conductor", data: {} }]),
    ).rejects.toBeInstanceOf(UnknownEventTypeError);
  });

  it("rejects a malformed actor and a malformed stream id", async () => {
    const s = streamId();
    await expect(
      store.append(s, 0, [{ ...discovered("x"), actor: "whoever" }]),
    ).rejects.toThrow();
    await expect(store.append("nonsense-1", 0, [discovered("x")])).rejects.toThrow();
  });
});

describe("optimistic concurrency", () => {
  it("a batch is all or nothing", async () => {
    const s = streamId();
    // Leave a hole: versions 1 and 3 exist, 2 does not.
    await store.append(s, 0, [discovered("v1")]);
    await store.append(s, 2, [discovered("v3")]);

    // This batch would write 2 (free) then 3 (taken). If the transaction were
    // not doing its job, version 2 would survive the failure.
    await expect(
      store.append(s, 1, [discovered("v2"), discovered("v3 again")]),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    expect((await store.read(s)).map((e) => e.version)).toEqual([1, 3]);
  });

  it("reports a lost race as ConcurrencyError, not as a driver error", async () => {
    const s = streamId();
    await store.append(s, 0, [discovered("taken")]);

    const err = await store.append(s, 0, [discovered("late")]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurrencyError);
    const conflict = err as ConcurrencyError;
    expect(conflict.streamId).toBe(s);
    expect(conflict.expectedVersion).toBe(0);
    expect(conflict.attemptedVersions).toEqual([1]);
  });

  it("two real connections racing at the same version: exactly one wins", async () => {
    // Five rounds rather than one. A single round can pass by luck of timing;
    // the claim being made is that the constraint decides, every time.
    for (let round = 0; round < 5; round++) {
      const s = streamId();

      const results = await Promise.allSettled([
        store.append(s, 0, [discovered(`a-${round}`)]),
        rival.append(s, 0, [discovered(`b-${round}`)]),
      ]);

      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");

      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const reason = (lost[0] as PromiseRejectedResult).reason as ConcurrencyError;
      expect(reason).toBeInstanceOf(ConcurrencyError);
      // And it lost *at the database*, not somewhere in the client: the cause
      // chain carries the driver's SQLSTATE 23505 on the version constraint.
      expect(sqlStates(reason)).toContain("23505");

      // And the log agrees with the verdict: one event, the winner's.
      const stored = await store.read(s);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.version).toBe(1);
    }
  });
});

describe("readAll", () => {
  it("returns the global log after a seq, in seq order", async () => {
    const s = streamId();
    const [first, second, third] = await store.append(s, 0, [
      discovered("one"),
      discovered("two"),
      discovered("three"),
    ]);

    const after = await store.readAll(first!.seq, 1000);
    const mine = after.filter((e) => e.streamId === s);

    expect(mine.map((e) => e.seq)).toEqual([second!.seq, third!.seq]);
    const sorted = [...after].sort((x, y) => (x.seq < y.seq ? -1 : 1));
    expect(after.map((e) => e.seq)).toEqual(sorted.map((e) => e.seq));
  });

  it("honours the limit", async () => {
    const s = streamId();
    const [first] = await store.append(s, 0, [discovered("a"), discovered("b"), discovered("c")]);
    expect(await store.readAll(first!.seq, 1)).toHaveLength(1);
  });
});
