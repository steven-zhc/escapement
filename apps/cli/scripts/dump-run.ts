/**
 * Print one run's event stream.
 *
 *   node apps/cli/scripts/dump-run.ts <runId>
 *
 * Kept because the log is supposed to be the answer, and twice now the fastest
 * way to a real cause has been to read it directly rather than to reason about
 * what should have been written. It is also how the `RunTouchedFile` bug was
 * found: fifteen writes in the log, an empty diff on disk, and the disagreement
 * only visible with both in front of you.
 *
 * Deliberately not an `lingtai` subcommand. `lingtai status` and the board answer
 * "what is happening"; this answers "what exactly was appended", which is a
 * debugging question and should look like one.
 */
import { eventStore } from "@lingtai/store";

const id = process.argv[2] ?? "";
if (!id) {
  console.error("usage: node apps/cli/scripts/dump-run.ts <runId>");
  process.exit(2);
}

// A bare run uuid is the common case and gets the prefix; anything already
// carrying one — `run-`, `wi-`, `project-` — is passed through. A failed merge
// appends `WorkItemBlocked` to the *work item* stream, not the run's, so
// reading only runs makes a run look like it simply stopped.
const streamId = /^[0-9a-f]{8}-/.test(id) ? `run-${id}` : id;
const events = await eventStore.read(streamId);
if (events.length === 0) console.error(`no events for ${id}`);

for (const e of events) {
  console.log(`v${String(e.version).padStart(3)} ${e.type.padEnd(24)} ${JSON.stringify(e.data)}`);
}
