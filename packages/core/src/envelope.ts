import { z } from "zod";

/**
 * What wraps every event. The store fills `seq` and `at`; everything else is
 * supplied by whoever appends.
 */
export const Actor = z
  .string()
  .regex(
    /^(conductor|github|agent:[\w-]+|human:[\w.@-]+)$/,
    "actor must be conductor, github, agent:<runId> or human:<id>",
  );

export const StreamId = z
  .string()
  .regex(
    /^(wi|run|int|prj|ctl)-[\w.-]+$/,
    // `ctl` is the operator's own aggregate: pauses, resumes and hand-picked
    // runs. One stream for the whole installation — control is not per-project,
    // and a pause that only stopped one repository would be a surprise.
    "streamId must be wi-… (work item), run-…, int-… (integration lane), prj-… (project) or ctl-… (control)",
  );

export interface Envelope<T = unknown> {
  /** Global order, assigned by the store. */
  seq: bigint;
  streamId: string;
  /** Position within the stream, from 1. */
  version: number;
  type: string;
  /** Which shape `data` is in. Upcasting on read keys off this. */
  schemaVer: number;
  data: T;
  actor: string;
  /** The seq of the event that caused this one, when there is one. */
  causation: bigint | null;
  at: Date;
}

/** What an appender supplies. `seq` and `at` belong to the store. */
export type ToAppend<T = unknown> = Pick<Envelope<T>, "type" | "data" | "actor"> & {
  schemaVer?: number;
  causation?: bigint | null;
};
