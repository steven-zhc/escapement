/**
 * The deliverer's one job that is not a pass-through.
 *
 * Pure — a fake client, no network. Worth its own file because the bug it
 * pins down was found by an end-to-end run and not by any unit test: the
 * first outbox drain stripped `enhancement` from admin #120, #155 and #156,
 * which is the label the recipe selects on. Escapement deleted its own
 * queue's selection criteria and the three issues silently went unrunnable.
 */
import type { GitHubClient, Issue } from "@escapement/github";
import { describe, expect, it } from "vitest";
import { deliverer } from "../src/conduct.ts";

/** Only the two methods the deliverer touches; the rest would be noise. */
function fakeClient(labels: string[]) {
  const state = { labels, set: null as string[] | null };
  const client = {
    async getIssue(number: number): Promise<Issue> {
      return {
        number,
        title: "",
        body: "",
        labels: state.labels,
        state: "open",
        url: "",
      } as Issue;
    },
    async setLabels(_issue: number, next: readonly string[]) {
      state.set = [...next];
    },
  } as unknown as GitHubClient;
  return { client, state };
}

describe("setting labels without deleting somebody else's", () => {
  it("keeps a foreign label while adding Escapement's own", async () => {
    const { client, state } = fakeClient(["enhancement"]);
    await deliverer(new Map([["admin", client]])).setLabels("admin", 156, ["escapement:working"]);

    expect(state.set).toContain("enhancement");
    expect(state.set).toContain("escapement:working");
  });

  /**
   * The landed case, which is what actually did the damage: `labelsFor`
   * returns `[]` for a landed item, and a whole-set replace with `[]` empties
   * the issue.
   */
  it("an empty computed set clears Escapement's labels and nothing else", async () => {
    const { client, state } = fakeClient(["enhancement", "escapement:working", "agent:review"]);
    await deliverer(new Map([["admin", client]])).setLabels("admin", 156, []);

    expect(state.set).toEqual(["enhancement", "agent:review"]);
  });

  it("does not duplicate a label that is already there", async () => {
    const { client, state } = fakeClient(["enhancement"]);
    await deliverer(new Map([["admin", client]])).setLabels("admin", 156, ["escapement:waiting"]);

    expect(state.set).toHaveLength(2);
  });
});
