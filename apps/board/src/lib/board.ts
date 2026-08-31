/**
 * The board's data.
 *
 * Until now `loadBoard` returned empty columns on purpose — a board showing
 * fictional work is worse than one showing none. It now reads the `board`
 * projection, so the columns are empty exactly when the log is.
 *
 * The shape is defined here rather than in the projection because the board is
 * the only consumer and a projection's shape follows its reader. Changing it
 * costs a `TRUNCATE` and a replay, not a migration.
 */
import { type BoardCard as ProjectionCard, readBoard } from "@escapement/conductor";
import type { RefusalReason, Tier } from "@escapement/core";

export type ColumnId = "queued" | "running" | "gates" | "waiting" | "landed";

export interface GateBadge {
  gate: string;
  state: "pending" | "running" | "passed" | "failed" | "waived";
  /**
   * False when the verdict was made against a commit that is no longer the
   * head. A force-push does not revoke anything; it simply makes every verdict
   * about a different diff.
   */
  current: boolean;
  evidence: string | null;
}

export interface BoardCard {
  workItemId: string;
  ref: string;
  kind: "bug" | "feature" | "enhancement" | "tech-debt";
  title: string;
  gates: GateBadge[];
  /** Present while running. */
  run?: {
    turn: number | null;
    costUsd: number | null;
    /** 77% of the old loop's runs tripped the guard and nobody ever saw one. */
    guardTrips: number;
    /** Compaction means the item was scoped too large. */
    compactions: number;
    tier: Tier;
  };
  diff?: { headSha: string; files: number; insertions: number; deletions: number };
  /** Why the integrator refused, when it did. */
  refusal?: RefusalReason | string;
  refusalDetail?: string | null;
  /** Work items later filed against this one — merged is not the same as correct. */
  regressions?: string[];
  /** Set when a human, not a process, is the thing being waited on. */
  question?: string;
  mergeCommit?: string;
}

export interface BoardColumn {
  id: ColumnId;
  label: string;
  cards: BoardCard[];
}

export const COLUMNS: { id: ColumnId; label: string }[] = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  { id: "gates", label: "Gates" },
  // Its own column rather than a label, because it is where the queue actually
  // stalls: 45 items and growing against zero processed.
  { id: "waiting", label: "Waiting on you" },
  { id: "landed", label: "Landed" },
];

function toCard(card: ProjectionCard): BoardCard {
  return {
    workItemId: card.workItemId,
    ref: card.externalRef,
    kind: card.kind as BoardCard["kind"],
    title: card.title,
    gates: card.gates.map((g) => ({
      gate: g.gate,
      state: g.verdict as GateBadge["state"],
      current: g.current,
      evidence: g.evidence,
    })),
    ...(card.run
      ? {
          run: {
            turn: card.run.turns,
            costUsd: card.run.costUsd,
            guardTrips: card.run.guardTrips,
            compactions: card.run.compactions,
            tier: card.tier as Tier,
          },
        }
      : {}),
    ...(card.diff ? { diff: card.diff } : {}),
    ...(card.refusal ? { refusal: card.refusal.reason, refusalDetail: card.refusal.detail } : {}),
    ...(card.regressions.length ? { regressions: card.regressions } : {}),
    ...(card.question ? { question: card.question } : {}),
    ...(card.mergeCommit ? { mergeCommit: card.mergeCommit } : {}),
  };
}

/**
 * Reads the `board` projection into columns.
 *
 * If the projection has never been built the tables do not exist, and that is
 * reported as empty rather than as a crash — an unbuilt board is a state the
 * system can be in, and it is the state it is in before the first run.
 */
export async function loadBoard(project?: string): Promise<BoardColumn[]> {
  let cards: ProjectionCard[] = [];
  try {
    cards = await readBoard(project);
  } catch (err) {
    // `relation "board" does not exist` — nothing has run the projection yet.
    if (!/does not exist/i.test((err as Error).message)) throw err;
  }

  return COLUMNS.map((c) => ({
    ...c,
    cards: cards.filter((card) => card.column === c.id).map(toCard),
  }));
}
