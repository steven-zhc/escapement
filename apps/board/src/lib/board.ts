import type { RefusalReason, Tier } from "@escapement/core";

/**
 * The shape of the `board` projection.
 *
 * It is declared here, not in the store, because the board is the only consumer
 * and a projection's shape follows its reader. When the store exists this type
 * stays and `loadBoard` stops being a placeholder.
 */
export type ColumnId = "queued" | "running" | "gates" | "waiting" | "landed";

export interface GateBadge {
  gate: string;
  state: "pending" | "running" | "passed" | "failed" | "waived";
}

export interface BoardCard {
  workItemId: string;
  ref: string;
  kind: "bug" | "feature" | "enhancement" | "tech-debt";
  title: string;
  gates: GateBadge[];
  /** Present while running. */
  run?: {
    turn: number;
    costUsd: number | null;
    /** 77% of the old loop's runs tripped the guard and nobody ever saw one. */
    guardTrips: number;
    tier: Tier;
  };
  /** Why the integrator refused, when it did. */
  refusal?: RefusalReason;
  /** Work items later filed against this one — merged is not the same as correct. */
  regressions?: string[];
  /** Set when a human, not a process, is the thing being waited on. */
  question?: string;
  note?: string;
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

/**
 * Reads the `board` projection.
 *
 * Placeholder: the projection does not exist yet, and neither does the store's
 * read side. It returns empty columns rather than invented rows — a board that
 * shows fictional work is worse than one that shows none.
 */
export async function loadBoard(): Promise<BoardColumn[]> {
  return COLUMNS.map((c) => ({ ...c, cards: [] }));
}
