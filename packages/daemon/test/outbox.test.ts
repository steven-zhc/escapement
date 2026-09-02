/**
 * The outbox, against the real store.
 *
 * Two of the four criteria are the interesting ones and neither can be faked:
 *
 * **A retry cannot double-post.** That is not a property of the worker, it is a
 * property of the row's key — one triggering event produces one row, however
 * many times the log is replayed.
 *
 * **A crash between the event and the delivery loses nothing.** Tested by
 * rebuilding the projection, which is what a crash plus a restart amounts to,
 * and checking the row is still pending and still singular.
 */
import { databaseUrl, directDatabaseUrl } from "@escapement/env";
import { createDb, createEventStore, createProjectionRunner, type Db, type EventStore } from "@escapement/store";
import { outboxProjection, pendingOutbox, deadOutbox, labelsFor } from "@escapement/conductor/outbox";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliverOutbox, type Deliverer } from "../src/index.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();
let client: Db;
let store: EventStore;

const task = (n: number) => {
  const id = `wi-${PROJECT}-${n}`;
  created.add(id);
  return id;
};

async function build(): Promise<void> {
  const runner = createProjectionRunner({ projection: outboxProjection, store });
  try {
    await runner.rebuild();
  } finally {
    await runner.close();
  }
}

const mine = async () => (await pendingOutbox({ limit: 500 })).filter((i) => i.project === PROJECT);

/** Records what it was asked to send, and can be told to refuse. */
function recorder(fail?: { status?: number; message?: string }): Deliverer & { sent: string[] } {
  const sent: string[] = [];
  const boom = () => {
    const e = new Error(fail?.message ?? "nope") as Error & { status?: number };
    if (fail?.status !== undefined) e.status = fail.status;
    throw e;
  };
  return {
    sent,
    async comment(project, issue, body) {
      if (fail) boom();
      sent.push(`comment ${project}#${issue} ${body.slice(0, 20)}`);
      return "comment-1";
    },
    async closeIssue(project: string, issue: number) {
      sent.push(`close ${project}#${issue}`);
    },
    async setLabels(project, issue, labels) {
      if (fail) boom();
      sent.push(`labels ${project}#${issue} ${labels.join(",")}`);
    },
  };
}

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);

  // The outbox is global by design — one daemon serves every project — so this
  // shared database carries rows from suites that died before cleaning up.
  // Delivering fifty of somebody else's is slow and proves nothing.
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("delete from outbox where payload->>'project' like 'esctest%'").catch(() => {});
  } finally {
    await c.end();
  }

  // Blocked on a person: the one message worth sending unprompted, and the
  // question is the payload. `agent:blocked` carried no question at all.
  await store.append(task(1), 0, [
    {
      type: "WorkItemBlocked",
      actor: "conductor",
      data: { question: "the importer test is flaky — rerun or fix?", needsFrom: "human", runId: null },
    },
  ]);
  await build();
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule escapement_events_no_delete");
    for (const id of [...created, `ctl-outbox-${PROJECT}`]) {
      await c.query("delete from events where stream_id = $1", [id]);
    }
    await c.query("delete from outbox where payload->>'project' = $1", [PROJECT]);
  } finally {
    await c.query("alter table events enable rule escapement_events_no_delete");
    await c.end();
  }
});

describe("the outbox", () => {
  it("queues a comment carrying the question, not just the fact", async () => {
    const rows = await mine();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("issue-comment");
    expect(JSON.stringify(rows[0]!.payload)).toContain("the importer test is flaky");
  });

  /**
   * A crash between the event and the delivery is a restart with the row still
   * pending — which only works because the row is derived from the log rather
   * than written beside it.
   */
  it("still has the row after a rebuild, and still only one", async () => {
    await build();
    const rows = await mine();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveredAt).toBeNull();
  });

  it("delivers once, and a second pass finds nothing left to do", async () => {
    // Scoped to this project throughout. The outbox is global on purpose — one
    // daemon serves every project — and the test database carries rows from
    // other suites, so counting everything would be counting somebody else's
    // work.
    const first = recorder();
    await deliverOutbox({ deliverer: first, store, limit: 500 });
    expect(first.sent.filter((s) => s.includes(PROJECT))).toHaveLength(1);

    // The worker appended `OutboxDelivered`; nothing has folded it yet. In the
    // daemon the projection follower does that continuously, which is why the
    // worker can be this simple — it never writes to the table it reads.
    await build();

    const second = recorder();
    await deliverOutbox({ deliverer: second, store, limit: 500 });
    expect(
      second.sent.filter((s) => s.includes(PROJECT)),
      "a delivered item must not be sent again",
    ).toHaveLength(0);
  });

  /**
   * The idempotence criterion, at the layer where it is actually decided. The
   * worker does not deduplicate — the row's key does, because it is the
   * triggering event's seq.
   */
  it("replaying the log cannot resurrect a delivered item", async () => {
    await build();
    const after = recorder();
    await deliverOutbox({ deliverer: after, store, limit: 500 });
    expect(after.sent.filter((s) => s.includes(PROJECT))).toHaveLength(0);
  });

  it("computes the label set rather than adding to it", () => {
    // `--add-label` is set union, not a transition. #35 carried agent:blocked
    // and agent:review at once and nothing could notice.
    expect(labelsFor("running")).toEqual(["escapement:working"]);
    expect(labelsFor("waiting")).toEqual(["escapement:waiting"]);
    expect(labelsFor("landed")).toEqual([]);
  });
});

describe("a delivery that fails", () => {
  const other = `esctest${crypto.randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    const id = `wi-${other}-9`;
    created.add(id);
    await store.append(id, 0, [
      {
        type: "WorkItemBlocked",
        actor: "conductor",
        data: { question: "?", needsFrom: "human", runId: null },
      },
    ]);
    await build();
  });

  afterAll(async () => {
    const c = new pg.Client({ connectionString: directDatabaseUrl() });
    await c.connect();
    try {
      await c.query("alter table events disable rule escapement_events_no_delete");
      await c.query("delete from events where stream_id = $1", [`ctl-outbox-${other}`]);
      await c.query("delete from outbox where payload->>'project' = $1", [other]);
    } finally {
      await c.query("alter table events enable rule escapement_events_no_delete");
      await c.end();
    }
  });

  it("stops permanently on a status that will not improve", async () => {
    // 404: the issue is gone. Retrying it forever is how a queue's depth stops
    // meaning anything and the one real failure in it becomes invisible.
    const gone = recorder({ status: 404, message: "Not Found" });
    await deliverOutbox({ deliverer: gone, store, limit: 500 });
    await build();

    const dead = (await deadOutbox()).filter((i) => i.project === other);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.lastError).toContain("Not Found");

    // And it is not tried again.
    const again = recorder();
    await deliverOutbox({ deliverer: again, store, limit: 500 });
    expect(again.sent.filter((s) => s.includes(other))).toHaveLength(0);
  });
});

describe("the end point", () => {
  /**
   * The division ADR 0016 §7 turns on: the conductor reads the recipe and
   * writes down what it resolved; the projection only folds. That is why a
   * rebuild years later produces the same rows even if the recipe has changed
   * since — the plan is in the log, not re-derived from configuration.
   */
  it("turns a resolved close into a delivery, and does not re-enqueue on rebuild", async () => {
    const id = task(9);
    created.add(id);
    await store.append(id, 0, [
      {
        type: "EndActionsResolved",
        actor: "conductor",
        data: { outcome: "landed", actions: [{ name: "close the ticket", close: true }] },
      },
    ]);
    await build();

    const first = await pendingOutbox({ url: databaseUrl() });
    const closes = first.filter((i) => i.kind === "issue-close" && i.target === "9");
    expect(closes, "the close was never enqueued").toHaveLength(1);

    // Replaying is idempotent: the row is keyed on the event's seq, so a second
    // fold finds it already there rather than queueing a second close.
    await build();
    const again = await pendingOutbox({ url: databaseUrl() });
    expect(again.filter((i) => i.kind === "issue-close" && i.target === "9")).toHaveLength(1);
  }, 120_000);
});
