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
 * Deliberately not an `esc` subcommand. `esc status` and the board answer
 * "what is happening"; this answers "what exactly was appended", which is a
 * debugging question and should look like one.
 */
import { eventStore } from "@escapement/store";

const id = process.argv[2] ?? "";
if (!id) {
  console.error("usage: node apps/cli/scripts/dump-run.ts <runId>");
  process.exit(2);
}

const events = await eventStore.read(id.startsWith("run-") ? id : `run-${id}`);
if (events.length === 0) console.error(`no events for ${id}`);

for (const e of events) {
  console.log(`v${String(e.version).padStart(3)} ${e.type.padEnd(24)} ${JSON.stringify(e.data)}`);
}
