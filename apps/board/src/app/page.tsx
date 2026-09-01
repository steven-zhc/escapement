import { loadBoard, type BoardCard } from "@/lib/board";
import { loadProjects } from "@escapement/conductor/projects";
import { Decide } from "./decide.tsx";
import { Evidence } from "./evidence.tsx";

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

/**
 * The stripe down the left edge, from what the card is actually waiting on.
 *
 * Ordered by what a person needs to see first: a refusal beats a question
 * beats a merge. A card with nothing to say gets the neutral rule, not a
 * colour — every stripe on the board would be the same as none.
 */
function accent(card: BoardCard): string {
  if (card.refusal) return "a-fail";
  if (card.question) return "a-sig";
  if (card.mergeCommit) return "a-pass";
  if (card.run) return "a-run";
  return "";
}

/**
 * Verdict to colour. `pending` is a person, not a machine, so it takes the
 * held tone rather than the running one; `waived` takes amber because a waiver
 * is a decision someone made and the board never lets one look like a pass.
 */
const PILL: Record<string, string> = {
  passed: "pass",
  failed: "fail",
  pending: "hold",
  waived: "sig",
  running: "run",
};

function Card({ card, showProject }: { card: BoardCard; showProject: boolean }) {
  return (
    <article className={`card ${accent(card)}`}>
      {/* Reference and kind are one fact — which ticket — so they are one line.
          Split apart, the kind read as a status badge, which it is not. */}
      <span className="id">
        {/* Only when the board holds more than one project. With a single
            project the bar already says which, and repeating it on every card
            is noise. */}
        {showProject ? <span className="proj">{card.project} </span> : null}#{card.ref} · {card.kind}
      </span>
      <span className="ti">{card.title}</span>

      <ul className="meta">
        {card.run ? (
          <>
            <li className="pill" title="containment tier">
              {card.run.tier}
            </li>
            {card.run.turn !== null ? <li className="pill">{card.run.turn} turns</li> : null}
            {card.run.costUsd !== null ? (
              <li className="pill">${card.run.costUsd.toFixed(2)}</li>
            ) : null}
            {/* 77% of the old loop's runs tripped the guard and nobody ever saw one. */}
            {card.run.guardTrips > 0 ? (
              <li className="pill sig" title="guard trips">
                {card.run.guardTrips} guard
              </li>
            ) : null}
            {/* Compaction means the item was scoped too large. */}
            {card.run.compactions > 0 ? (
              <li className="pill sig" title="context compactions">
                {card.run.compactions}× compacted
              </li>
            ) : null}
          </>
        ) : null}

        {card.gates.map((g) => (
          <li
            key={g.gate}
            className={`pill ${PILL[g.state] ?? ""}${g.current ? "" : " stale"}`}
            title={
              g.current ? (g.evidence ?? g.state) : "this verdict was made against an earlier commit"
            }
          >
            {g.gate}
          </li>
        ))}
      </ul>

      {card.diff ? (
        <p className="diff">
          {card.diff.files} files <span className="add">+{card.diff.insertions}</span>{" "}
          <span className="del">−{card.diff.deletions}</span> {card.diff.headSha.slice(0, 7)}
        </p>
      ) : null}

      {card.question ? <p className="question">{card.question}</p> : null}

      {card.refusal ? (
        <p className="refusal" title={card.refusalDetail ?? undefined}>
          {card.refusal}
        </p>
      ) : null}

      {/* If you have to open GitHub to decide, nothing changed. The gate that
          refused, what it said, the findings with their scenarios, and the
          diff — all here, all collapsed until asked for. */}
      {card.diff ? (
        <Evidence
          project={card.project}
          baseSha={card.baseSha}
          headSha={card.diff.headSha}
          gates={card.gates.map((g) => ({
            gate: g.gate,
            state: g.state,
            current: g.current,
            evidence: g.evidence,
            findings: g.findings,
          }))}
        />
      ) : null}

      {/* The controls, only where a person is actually the thing being waited
          on. A card in Gates is waiting on a process, and offering to approve
          it would invite a decision nobody is being asked for. */}
      {card.column === "waiting" && card.diff ? (
        <Decide
          project={card.project}
          issue={Number(card.ref)}
          onSha={card.diff.headSha}
          gates={card.gates.filter((g) => g.state === "failed").map((g) => g.gate)}
        />
      ) : null}

      {card.mergeCommit ? <p className="merge">{card.mergeCommit.slice(0, 7)}</p> : null}

      {/* A merge that produced two bugs should read as what it is. */}
      {card.regressions?.length ? (
        <p className="regressions">caused {card.regressions.map((r) => `#${r}`).join(", ")}</p>
      ) : null}
    </article>
  );
}

export default async function Page() {
  const columns = await loadBoard();
  const projects = await loadProjects().catch(() => []);
  const total = columns.reduce((n, c) => n + c.cards.length, 0);
  // What the *cards* say, not what is registered: a card can outlive its
  // project, and it is the cards that have to be told apart.
  const onBoard = new Set(columns.flatMap((c) => c.cards.map((card) => card.project)));

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
                col.cards.map((card) => (
                  <Card key={card.workItemId} card={card} showProject={onBoard.size > 1} />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
