import { loadBoard, type BoardCard } from "@/lib/board";
import { loadProjects } from "@escapement/conductor";

/**
 * The board is not a status page. It is where the backlog gets worked, and the
 * old loop's review queue reached 45 items growing at 14 a day against zero
 * processed because working one meant leaving the tool.
 *
 * The cards are real now — read from the `board` projection, which composes the
 * work item's stream, the run's and the integration lane's. What is still
 * missing is the *acting*: the rendered diff and the approve / reject / waive
 * controls are Phase 2 (#21, #22), and nothing here pretends otherwise.
 */
export const dynamic = "force-dynamic";

function Card({ card }: { card: BoardCard }) {
  return (
    <article className="card">
      <header className="card-h">
        <span className={`kind ${card.kind}`}>{card.kind}</span>
        <span className="ref">#{card.ref}</span>
      </header>
      <p className="title">{card.title}</p>

      {card.run ? (
        <ul className="facts">
          <li title="containment tier">{card.run.tier}</li>
          {card.run.turn !== null ? <li>{card.run.turn} turns</li> : null}
          {card.run.costUsd !== null ? <li>${card.run.costUsd.toFixed(2)}</li> : null}
          {/* 77% of the old loop's runs tripped the guard and nobody ever saw one. */}
          {card.run.guardTrips > 0 ? (
            <li className="warn" title="guard trips">
              {card.run.guardTrips} guard
            </li>
          ) : null}
          {/* Compaction means the item was scoped too large. */}
          {card.run.compactions > 0 ? (
            <li className="warn" title="context compactions">
              {card.run.compactions}× compacted
            </li>
          ) : null}
        </ul>
      ) : null}

      {card.diff ? (
        <p className="diff">
          {card.diff.files} files <span className="add">+{card.diff.insertions}</span>{" "}
          <span className="del">−{card.diff.deletions}</span>{" "}
          <span className="sha">{card.diff.headSha.slice(0, 7)}</span>
        </p>
      ) : null}

      {card.gates.length > 0 ? (
        <ul className="gates">
          {card.gates.map((g) => (
            <li
              key={g.gate}
              className={`gate ${g.state}${g.current ? "" : " stale"}`}
              title={
                g.current
                  ? (g.evidence ?? g.state)
                  : "this verdict was made against an earlier commit"
              }
            >
              {g.gate}
            </li>
          ))}
        </ul>
      ) : null}

      {card.question ? <p className="question">{card.question}</p> : null}

      {card.refusal ? (
        <p className="refusal" title={card.refusalDetail ?? undefined}>
          {card.refusal}
        </p>
      ) : null}

      {card.mergeCommit ? <p className="merge">{card.mergeCommit.slice(0, 7)}</p> : null}

      {/* A merge that produced two bugs should read as what it is. */}
      {card.regressions?.length ? (
        <p className="regressions">
          caused {card.regressions.map((r) => `#${r}`).join(", ")}
        </p>
      ) : null}
    </article>
  );
}

export default async function Page() {
  const columns = await loadBoard();
  const projects = await loadProjects().catch(() => []);
  const total = columns.reduce((n, c) => n + c.cards.length, 0);

  return (
    <main>
      <div className="bar">
        <span className="brand">Escapement</span>
        <span className="sep" />
        <span>
          {projects.length === 0
            ? "no project configured"
            : projects.map((p) => p.project).join(", ")}
        </span>
        <span className="sep" />
        <span className={`chip ${total > 0 ? "" : "idle"}`}>
          {total > 0 ? `${total} items` : "nothing in the log yet"}
        </span>
      </div>

      <div className="cols">
        {columns.map((col) => (
          <section key={col.id} className={`col${col.id === "waiting" ? " hot" : ""}`}>
            <header className="col-h">
              <span>{col.label}</span>
              <span className="ct">{col.cards.length}</span>
            </header>
            <div className="cards">
              {col.cards.length === 0 ? (
                <p className="empty">
                  {col.id === "waiting" ? "Nothing is waiting on you." : "Nothing here yet."}
                </p>
              ) : (
                col.cards.map((card) => <Card key={card.workItemId} card={card} />)
              )}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
