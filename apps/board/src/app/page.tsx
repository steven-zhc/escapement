import { loadBoard } from "@/lib/board";

/**
 * The board is not a status page. It is where the backlog gets worked, which
 * means the diff, every gate verdict and the approve / reject / waive controls
 * belong on the card. None of that exists yet — this renders the columns and
 * says plainly that they are empty, rather than showing invented work.
 */
export const dynamic = "force-dynamic";

export default async function Page() {
  const columns = await loadBoard();

  return (
    <main>
      <div className="bar">
        <span className="brand">Escapement</span>
        <span className="sep" />
        <span>no project configured</span>
        <span className="sep" />
        <span className="chip idle">store not connected</span>
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
                  {col.id === "waiting"
                    ? "Nothing is waiting on you."
                    : "Nothing here yet."}
                </p>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
