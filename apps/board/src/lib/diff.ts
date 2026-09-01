/**
 * Shapes shared between the server actions and the card.
 *
 * Separate from `actions.ts` because a `"use server"` module may only export
 * async functions — a constant or an interface in there is a build error, and
 * the message ("Only async functions are allowed to be exported") does not say
 * which export it means.
 */

/** One file's worth of a diff, split on the server so the client need not. */
export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  lines: string[];
}

/**
 * Past this a diff is truncated rather than sent whole.
 *
 * A change touching more than this many files is a work item that was scoped
 * too large, which the compaction counter on the same card already says.
 */
export const DIFF_FILE_LIMIT = 300;

export type DiffResult =
  | { ok: true; files: DiffFile[]; truncated: boolean }
  | { ok: false; detail: string };

export interface ActionResult {
  ok: boolean;
  /** Always said back. A refusal the operator cannot read is a lie by omission. */
  detail: string;
}
