/**
 * The board's data: one query, against one table.
 *
 * `task_view` holds what a card shows and nothing else
 * ([0012](../../../../doc/decisions/0012-one-task-view.md)). Gate evidence,
 * review findings and the diff are **not** here — they are read
 * from the event stream when somebody opens a task, because a list view and a
 * detail view have opposite economics and the list is what has to be cheap.
 *
 * That is also why the card got readable. It was heavy because the old
 * projection made everything available and what is available gets rendered;
 * moving detail behind a task id makes a card's contents a decision.
 */
// The subpath, not the barrel: importing the barrel pulls in the gate
// pipeline and its child-process types, which a page rendering cards has no
// business compiling.
import { readTasks, type TaskCard } from "@escapement/conductor/task-view";

/**
 * Four, not five. `gates` folded into `running` (ADR 0016 §8).
 *
 * From an operator's seat "the agent is working" and "the build is running" are
 * the same fact — the machine is busy and you are not needed — so two lanes for
 * them made the board wider without making it say more. `waiting` is the lane
 * the board exists for, and keeping it distinct is the whole point.
 */
export type ColumnId = "queued" | "running" | "waiting" | "landed";

export interface BoardCard {
  taskId: string;
  /**
   * Which repository this is from.
   *
   * Carried because an issue number is only unique *within* a project. Two
   * projects both having a #122 renders as two cards that look identical and
   * are not — which a board full of `esctest*` fixtures made obvious: eight
   * cards reading `#122`, one per project, none of them duplicates.
   */
  project: string;
  column: ColumnId;
  ref: string;
  kind: string;
  title: string;
  tier: string;
  /** For the approve/reject controls, which are bound to a specific commit. */
  headSha: string | null;
  /** Counts, not verdicts. The verdicts are on the task's own page. */
  gatesPassed: number;
  gatesFailed: number;
  turns: number | null;
  costUsd: number | null;
  /** One line: what it is waiting on, or why it stopped, or what it merged as. */
  note: string | null;
  updatedAt: string;
  /** Attempts so far, so a card that keeps failing reads as one. */
  attempts: number;
}

export interface BoardColumn {
  id: ColumnId;
  label: string;
  cards: BoardCard[];
}

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  // Its own column rather than a label, because it is where the queue actually
  // stalls: 45 items and growing against zero processed.
  { id: "waiting", label: "Waiting on you" },
  { id: "landed", label: "Landed" },
];

function toCard(t: TaskCard): BoardCard {
  return {
    taskId: t.taskId,
    project: t.project,
    // `gates` is a task state and no longer a lane; it belongs with `running`.
    column: t.state === "gates" ? "running" : t.state,
    ref: t.issue,
    kind: t.kind,
    title: t.title,
    tier: t.tier,
    headSha: t.headSha,
    gatesPassed: t.gatesPassed,
    gatesFailed: t.gatesFailed,
    turns: t.turns,
    costUsd: t.costUsd,
    note: t.note,
    updatedAt: t.updatedAt.toISOString(),
    attempts: t.attempts,
  };
}

/**
 * Reads `task_view` into columns.
 *
 * An unbuilt projection is reported as empty rather than as a crash: it is a
 * state the system can be in, and it is the state it is in before the first
 * run. Showing fictional work would be worse than showing none.
 */
export async function loadBoard(project?: string): Promise<BoardColumn[]> {
  let tasks: TaskCard[] = [];
  try {
    tasks = await readTasks(project === undefined ? {} : { project });
  } catch (err) {
    // `relation "task_view" does not exist` — nothing has run the projection.
    if (!/does not exist/i.test((err as Error).message)) throw err;
  }

  return COLUMNS.map((c) => ({
    ...c,
    cards: tasks.filter((t) => t.state === c.id).map(toCard),
  }));
}
