import Link from "next/link";
import { loadBoard, type BoardCard } from "@/lib/board";
import { loadProjects } from "@lingtai/conductor/projects";
import { Decide } from "./decide.tsx";
import { Live } from "./live.tsx";

/**
 * The board is not a status page. It is where the backlog gets worked, and the
 * old loop's review queue reached 45 items growing at 14 a day against zero
 * processed because working one meant leaving the tool.
 *
 * **The card carries what you scan; everything else is one click away.** It
 * used to carry the gate evidence, the findings and the diff too, and it grew
 * heavy for a structural reason: the projection made all of it available, and
 * what is available gets rendered. Since 0012 the list reads one table and the
 * detail is folded from the event stream on demand, which makes a card's
 * contents a decision instead of a consequence.
 *
 * The controls stay on the card. Deciding is the thing this exists for, and
 * making somebody open a page to approve would put back the cost that the 45
 * items measured.
 */
export const dynamic = "force-dynamic";

/**
 * The stripe down the left edge, from what the card is waiting on.
 *
 * Ordered by what a person needs to see first: a failed gate beats a question
 * beats a merge. A card with nothing to say gets the neutral rule, not a
 * colour — every stripe on the board would be the same as none.
 */
function accent(card: BoardCard): string {
  if (card.gatesFailed > 0) return "a-fail";
  if (card.column === "waiting") return "a-sig";
  if (card.column === "landed") return "a-pass";
  if (card.column === "running") return "a-run";
  return "";
}

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

      {/* The whole card title is the link. Anything smaller is a target you
          have to aim at, on the one control every card has. */}
      <Link className="ti" href={`/task/${encodeURIComponent(card.taskId)}`}>
        {card.title}
      </Link>

      <ul className="meta">
        {card.turns !== null ? <li className="pill">{card.turns} turns</li> : null}
        {card.costUsd !== null ? <li className="pill">${card.costUsd.toFixed(2)}</li> : null}
        {card.gatesPassed > 0 ? <li className="pill pass">{card.gatesPassed} passed</li> : null}
        {card.gatesFailed > 0 ? <li className="pill fail">{card.gatesFailed} failed</li> : null}
        {/* A card that keeps failing should read as one rather than looking new
            every time it comes back round. */}
        {card.attempts > 1 ? (
          <li className="pill sig" title="attempts so far">
            attempt {card.attempts}
          </li>
        ) : null}
      </ul>

      {card.note ? <p className="question">{card.note}</p> : null}

      {/* Only where a person is actually the thing being waited on. A card in
          Gates is waiting on a process, and offering to approve it would invite
          a decision nobody is being asked for. */}
      {card.column === "waiting" && card.headSha ? (
        <Decide
          project={card.project}
          issue={Number(card.ref)}
          onSha={card.headSha}
          gates={card.gatesFailed > 0 ? ["build"] : []}
        />
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
        <span className="brand">Lingtai</span>
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
        <span className="sep" />
        {/* Says whether what you are looking at is current. A board that has
            silently stopped updating is worse than one that admits it. */}
        <Live />
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
                  <Card key={card.taskId} card={card} showProject={onBoard.size > 1} />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
