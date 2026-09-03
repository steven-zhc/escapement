/**
 * The projections this application knows how to advance, and how to advance
 * them without a daemon.
 *
 * The follower lives in the daemon, which is right: it is long-lived work, and
 * [0013](../../../doc/decisions/0013-daemon-hosts-the-work.md) puts long-lived
 * work in one process behind one lock. But `lingtai run` appends too, and a
 * command that appends and returns used to leave `task_view` — the only thing
 * the board reads — exactly where it was. Nine runs went through the queue by
 * hand and the board showed nothing moving; `lingtai projection lag` said *no
 * projection has a checkpoint yet*. The fix at the time was to remember to
 * start a second process. Nothing told you that.
 *
 * So a command that appends catches the projections up on its way out. It is
 * not a second follower: it starts each runner, waits for it to reach the head,
 * and closes it. The board is therefore correct the moment the command returns,
 * and stale only *during* — which is what the daemon is for.
 *
 * Running this while a daemon holds the log is harmless and needs no lock. A
 * projection's `apply` is idempotent and its checkpoint advances inside the
 * same transaction as its writes, so two followers on the same log converge on
 * the same rows; the second one simply finds nothing left to do.
 */
import { outboxProjection, taskViewProjection } from "@lingtai/conductor";
import { createProjectionRunner, type Projection, type ProjectionLag } from "@lingtai/store";

/** Every projection the runner knows how to advance, by `checkpoints.name`. */
export const PROJECTIONS: Record<string, Projection> = {
  [taskViewProjection.name]: taskViewProjection,
  [outboxProjection.name]: outboxProjection,
};

/**
 * Brings every projection to the head of the log and stops.
 *
 * Throws what a projection's handler threw. A caller that has just finished
 * real work should report that and carry on rather than lose its own result to
 * it — the log is intact either way, and a stale board is a worse ending than
 * a stale board somebody was told about.
 */
export async function catchUpProjections(): Promise<ProjectionLag[]> {
  const lags: ProjectionLag[] = [];
  for (const projection of Object.values(PROJECTIONS)) {
    const runner = createProjectionRunner({ projection });
    try {
      // Creates the tables, catches up, then follows. Resolves once caught up,
      // and rejects if the subscription stopped before it got there.
      await runner.start();
      lags.push(await runner.lag());
    } finally {
      await runner.close();
    }
  }
  return lags;
}
