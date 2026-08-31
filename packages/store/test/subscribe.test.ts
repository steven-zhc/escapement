/**
 * The subscriber, against the real database.
 *
 * The assertion that carries the weight is the third one: kill the listener's
 * backend mid-stream, append while it is down, and require that what it
 * eventually delivers has no gap and no duplicate. Everything else here is a
 * precondition for that being meaningful.
 *
 * Every test appends from the **pooled** connection and listens on the
 * **direct** one — two connections, which is the only shape that proves
 * anything (doc/decisions/0009-two-connections.md).
 */
import type { Envelope } from "@escapement/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, createEventStore, type Db, type EventStore, subscribe } from "../src/index.ts";
import type { Subscription } from "../src/index.ts";
import {
  cleanupStreams,
  currentMaxSeq,
  discovered,
  killBackend,
  sleep,
  streamId,
  waitFor,
} from "./support.ts";

let client: Db;
let store: EventStore;
const open: Subscription[] = [];

beforeAll(() => {
  client = createDb();
  store = createEventStore(client);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

afterAll(async () => {
  await client.close();
  await cleanupStreams();
});

/** Registers the subscription for teardown, so a failing test cannot leak one. */
function track(s: Subscription): Subscription {
  open.push(s);
  return s;
}

describe("subscribe", () => {
  it("delivers an append made on a different connection", async () => {
    const seen: Envelope[] = [];
    const from = await currentMaxSeq();
    const sub = track(
      subscribe({ fromSeq: from, store, onEvent: (e) => void seen.push(e), name: "esc-test-live" }),
    );
    await sub.caughtUp();

    // Long enough for a transaction pooler to hand the listener's backend to
    // someone else. Through one, nothing below arrives — and nothing errors.
    await sleep(1_500);

    const s = streamId();
    const [written] = await store.append(s, 0, [discovered("live")]);

    await waitFor(
      () => seen.some((e) => e.seq === written!.seq),
      () => `seen ${seen.length} events, none with seq ${written!.seq}`,
    );
    expect(sub.lastSeq).toBe(written!.seq);
  });

  it("catches up on what was appended before it started", async () => {
    const from = await currentMaxSeq();
    const s = streamId();
    const written = await store.append(s, 0, [discovered("before-1"), discovered("before-2")]);

    const seen: Envelope[] = [];
    const sub = track(
      subscribe({ fromSeq: from, store, onEvent: (e) => void seen.push(e), name: "esc-test-catchup" }),
    );
    await sub.caughtUp();

    // caughtUp() means the backlog is drained, so this needs no polling.
    const mine = seen.filter((e) => e.streamId === s);
    expect(mine.map((e) => e.seq)).toEqual(written.map((e) => e.seq));
  });

  it("survives its backend being killed: no gap, no duplicate", async () => {
    const name = `esc-test-kill-${crypto.randomUUID().slice(0, 8)}`;
    const seen: Envelope[] = [];
    const errors: string[] = [];

    const from = await currentMaxSeq();
    const sub = track(
      subscribe({
        fromSeq: from,
        store,
        name,
        onEvent: (e) => void seen.push(e),
        onError: (_e, phase) => void errors.push(phase),
        backoff: { baseMs: 50, capMs: 500 },
      }),
    );
    await sub.caughtUp();

    const s = streamId();
    const [one] = await store.append(s, 0, [discovered("before-kill")]);
    await waitFor(
      () => seen.some((e) => e.seq === one!.seq),
      () => "the first event never arrived, so the kill would prove nothing",
    );

    // Pull the connection out from under it. The pid is the listener's own,
    // reported after it connected — see `killBackend` for why not by name.
    const pid = sub.backendPid;
    expect(pid).toBeTypeOf("number");
    expect(await killBackend(pid!)).toBe(true);

    // Append immediately, while it is down. These notifications are addressed to
    // a backend that no longer exists — they are lost, and the catch-up read on
    // reconnect is the only thing that can recover them.
    const rest = await store.append(s, 1, [discovered("during-outage"), discovered("after")]);

    await waitFor(
      () => seen.filter((e) => e.streamId === s).length === 3,
      () => `only ${seen.filter((e) => e.streamId === s).length} of 3 events arrived`,
    );

    const mine = seen.filter((e) => e.streamId === s).map((e) => e.seq);
    // No gap: all three, in order.
    expect(mine).toEqual([one!.seq, rest[0]!.seq, rest[1]!.seq]);
    // No duplicate: the reconnect's catch-up must not re-deliver what was
    // already handled before the connection died.
    expect(new Set(mine).size).toBe(3);
    expect(sub.stopped).toBe(false);
    expect(errors).toContain("connection");
  });

  it("stops on a handler error and leaves lastSeq on the last event it handled", async () => {
    const from = await currentMaxSeq();
    const s = streamId();
    const written = await store.append(s, 0, [discovered("ok"), discovered("boom")]);

    const phases: string[] = [];
    const sub = track(
      subscribe({
        fromSeq: from,
        store,
        name: "esc-test-handler",
        onEvent: (e) => {
          if ((e.data as { title?: string }).title === "boom") throw new Error("handler said no");
        },
        onError: (_e, phase) => void phases.push(phase),
      }),
    );

    await waitFor(
      () => sub.stopped,
      () => "the subscription kept running after its handler threw",
    );
    // The failed event is not skipped: lastSeq still points at the one before it,
    // so a restart retries it rather than losing it.
    expect(sub.lastSeq).toBe(written[0]!.seq);
    expect(phases).toContain("handler");
    await expect(sub.caughtUp()).rejects.toThrow();
  });
});
