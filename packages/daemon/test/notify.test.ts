/**
 * What gets through, and what it says.
 *
 * Pure — no database, no `osascript`. The two things worth asserting are that
 * the filter is right (a notification you cannot act on is noise, and noise is
 * how the useful ones stop being read) and that the message carries the
 * question rather than the fact.
 */
import type { Envelope } from "@escapement/core";
import { describe as describeTest, expect, it } from "vitest";
import {
  DEFAULT_SUBSCRIPTIONS,
  createNotifier,
  describe as render,
  recordingChannel,
  subscribed,
} from "../src/index.ts";

const event = (type: string, data: unknown, streamId = "wi-admin-155"): Envelope => ({
  seq: 1n,
  streamId,
  version: 1,
  type,
  schemaVer: 1,
  data,
  actor: "conductor",
  causation: null,
  at: new Date(),
});

const everything = [{ project: "*", types: [...DEFAULT_SUBSCRIPTIONS] }];

describeTest("what is worth interrupting somebody for", () => {
  it("passes the four that mean nothing moves until a person acts", () => {
    for (const type of DEFAULT_SUBSCRIPTIONS) {
      expect(subscribed(event(type, {}), everything), type).toBe(true);
    }
  });

  it("drops everything the conductor will handle by itself", () => {
    // A landed task is good news that needed nobody. Interrupting for it is how
    // the ones that do need somebody stop being read.
    for (const type of ["WorkItemLanded", "GatePassed", "RunFinished", "RunTouchedFile"]) {
      expect(subscribed(event(type, {}), everything), type).toBe(false);
    }
  });

  it("can be narrowed to one project", () => {
    const only = [{ project: "admin", types: ["WorkItemBlocked"] }];
    expect(subscribed(event("WorkItemBlocked", {}, "wi-admin-1"), only)).toBe(true);
    expect(subscribed(event("WorkItemBlocked", {}, "wi-press-1"), only)).toBe(false);
  });
});

describeTest("what the notification says", () => {
  it("carries the question, not just the fact", () => {
    const n = render(
      event("WorkItemBlocked", { question: "rerun the flaky importer test, or fix it?" }),
      "http://localhost:3200",
    );
    // `agent:blocked` carried no question, which is the whole reason the old
    // review queue could not be worked without opening the issue.
    expect(n.body).toContain("rerun the flaky importer test");
    expect(n.title).toContain("#155");
  });

  it("links to the task's own page, so a click lands somewhere useful", () => {
    const n = render(event("ApprovalRequested", { question: "Merge?" }), "http://localhost:3200");
    expect(n.url).toBe("http://localhost:3200/task/wi-admin-155");
  });
});

describeTest("the notifier", () => {
  it("sends only what is subscribed", async () => {
    const channel = recordingChannel();
    const notifier = createNotifier({ channel });

    await notifier.consider(event("WorkItemBlocked", { question: "?" }));
    await notifier.consider(event("WorkItemLanded", { mergeCommit: "abc" }));

    expect(channel.sent).toHaveLength(1);
  });

  /**
   * This runs on the daemon's own subscription. A notifier that could throw
   * would be a notifier that stops the log being followed — which would take
   * the board down to tell somebody about a merge.
   */
  it("swallows a channel that throws", async () => {
    const lines: string[] = [];
    const notifier = createNotifier({
      channel: {
        name: "broken",
        clickable: false,
        async send() {
          throw new Error("no notification centre here");
        },
      },
      log: (l) => void lines.push(l),
    });

    await expect(notifier.consider(event("WorkItemBlocked", { question: "?" }))).resolves.toBeUndefined();
    expect(lines[0]).toContain("notification failed");
  });
});
