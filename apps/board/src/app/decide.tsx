"use client";

/**
 * The controls on a card that is waiting on you.
 *
 * The optimistic state is the point and also the trap. Showing the result
 * immediately is what makes a queue of 45 feel workable; showing a result that
 * did not happen is worse than showing nothing, because the operator moves on
 * believing the item is handled. So every action **reverts on refusal and says
 * why** — the server's own sentence, not a generic "something went wrong".
 *
 * The commonest refusal is the interesting one: the branch moved between the
 * card rendering and the click, so the diff being approved is not the diff that
 * was read. That has to be visible, not swallowed.
 */
import { useState, useTransition } from "react";
import { approveCard, rejectCard, waiveGate } from "./actions.ts";
import type { ActionResult } from "@/lib/diff";

type Pending = "approve" | "reject" | "waive" | null;

export function Decide({
  project,
  issue,
  onSha,
  gates,
}: {
  project: string;
  issue: number;
  /** What the card is showing. The server refuses if the branch has moved. */
  onSha: string;
  /** Gate names that could be waived, so the reason can name one. */
  gates: string[];
}) {
  const [pending, setPending] = useState<Pending>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [asking, setAsking] = useState<"reject" | "waive" | null>(null);
  const [reason, setReason] = useState("");
  const [, startTransition] = useTransition();

  const run = (kind: Exclude<Pending, null>, action: () => Promise<ActionResult>) => {
    // Optimistic: the button reports the intent straight away.
    setPending(kind);
    setRefusal(null);
    startTransition(async () => {
      const result = await action();
      setPending(null);
      if (result.ok) {
        setDone(result.detail);
        setAsking(null);
        setReason("");
        return;
      }
      // Reverted. The card goes back to undecided and the operator is told the
      // server's actual reason, because "it didn't work" sends them nowhere.
      setRefusal(result.detail);
    });
  };

  if (done) return <p className="decided">{done}</p>;

  if (asking) {
    const label = asking === "reject" ? "Reject" : "Waive";
    return (
      <div className="decide">
        <label className="reason">
          {/* A waiver with no reason is a silent waiver by another name, so the
              field is not optional and the button stays disabled without it. */}
          <span>Why?</span>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={asking === "waive" ? "unrelated flake in the importer suite" : "wrong approach"}
          />
        </label>
        <div className="btnrow">
          <button
            className="btn pri"
            disabled={!reason.trim() || pending !== null}
            onClick={() =>
              run(asking, () =>
                asking === "reject"
                  ? rejectCard({ project, issue, onSha, reason })
                  : waiveGate({ project, issue, gate: gates[0] ?? "build", onSha, reason }),
              )
            }
          >
            {pending ? "…" : label}
          </button>
          <button className="btn" onClick={() => setAsking(null)} disabled={pending !== null}>
            Cancel
          </button>
        </div>
        {refusal ? <p className="refusal">{refusal}</p> : null}
      </div>
    );
  }

  return (
    <div className="decide">
      <div className="btnrow">
        <button
          className="btn pri"
          disabled={pending !== null}
          onClick={() => run("approve", () => approveCard({ project, issue, onSha }))}
        >
          {pending === "approve" ? "merging…" : "Approve"}
        </button>
        <button className="btn" disabled={pending !== null} onClick={() => setAsking("reject")}>
          Reject
        </button>
        {gates.length > 0 ? (
          <button className="btn" disabled={pending !== null} onClick={() => setAsking("waive")}>
            Waive
          </button>
        ) : null}
      </div>
      {refusal ? <p className="refusal">{refusal}</p> : null}
    </div>
  );
}
