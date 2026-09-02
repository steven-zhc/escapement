import Link from "next/link";
import { notFound } from "next/navigation";
import { loadTask } from "@/lib/task";
import { Evidence } from "../../evidence.tsx";

/**
 * One task, in full.
 *
 * Everything here is folded from the event stream when the page is opened —
 * nothing on this page is maintained in a table ([0012]). That is the trade the
 * card makes: the list stays cheap and scannable, and the detail is as rich as
 * it needs to be because it costs a read that happens rarely.
 *
 * The history at the bottom is the point of an event-sourced system being
 * legible. Every summary above it is an interpretation; that list is what
 * actually happened, in order, with who did it.
 */
export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await loadTask(decodeURIComponent(id));
  if (!task) notFound();

  return (
    <main className="detail">
      <div className="bar">
        <Link className="brand" href="/">
          ← Escapement
        </Link>
        <span className="sep" />
        <span className="mono">{task.taskId}</span>
        {task.headSha ? (
          <>
            <span className="sep" />
            <span className="mono">{task.headSha.slice(0, 7)}</span>
          </>
        ) : null}
      </div>

      <div className="detail-body">
        {/* The gate that refused, what it said, the findings with their
            failure scenarios, and the diff. If you have to open GitHub to
            decide, nothing changed. */}
        <section>
          <h2>Gates</h2>
          {/* All five, always — including the ones nothing was configured at.
              A point that is merely omitted looks exactly like a point that was
              configured and silently did not run, and only one of those is our
              bug (ADR 0016 §4). */}
          <ol className="points">
            {task.points.map((p) => (
              <li key={p.point} className={p.skipped ? "point skipped" : "point"}>
                <span className="mono name">{p.point}</span>
                {p.skipped ? (
                  <span className="pill">skipped</span>
                ) : (
                  <span className="actions">
                    {p.planned.length > 0 ? p.planned.join(", ") : "\u2014"}
                    {p.planned.length > p.verdicts.length ? (
                      // Planned but no verdict. Either it is still running, or
                      // it did not run — and the second is the one worth seeing.
                      <span className="pill sig" title="planned, no verdict yet">
                        {p.planned.length - p.verdicts.length} pending
                      </span>
                    ) : null}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2>Verdicts</h2>
          {task.gates.length === 0 ? (
            <p className="empty">No gate has reported yet.</p>
          ) : (
            <Evidence
              project={task.taskId.slice(3, task.taskId.lastIndexOf("-"))}
              baseSha={task.baseSha}
              headSha={task.headSha ?? ""}
              gates={task.gates}
            />
          )}
        </section>

        <section>
          <h2>History</h2>
          <ol className="history">
            {task.history.map((h, i) => (
              <li key={i}>
                <span className="when">{h.at.slice(11, 19)}</span>
                <span className="what">{h.type}</span>
                <span className="who">{h.actor}</span>
                <span className="sum">{h.summary}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
