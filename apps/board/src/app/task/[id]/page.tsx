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

        {task.guardTrips.length > 0 ? (
          <section>
            <h2>Guard trips</h2>
            {/* 132 of these were invisible in the old loop. The command is
                stored already redacted and is never re-derived here. */}
            <ul className="trips">
              {task.guardTrips.map((t, i) => (
                <li key={i}>
                  <span className="pill fail">{t.tool}</span>
                  <span className="mono">{t.pattern}</span>
                  <code>{t.command}</code>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

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
