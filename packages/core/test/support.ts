/**
 * Envelope fixtures. No database — `@lingtai/core` is zero-I/O on purpose,
 * which is the whole point of the split: the old loop's least testable code, the
 * six branches of `integrate()`, is a pure function here.
 *
 * Payloads are validated through the real schemas as they are built, so a
 * fixture cannot drift into a shape the store would refuse to write.
 */
import { type EventType, type Envelope, type PayloadOf, SCHEMA_VER, parsePayload } from "../src/index.ts";

let nextSeq = 1n;

/** Builds one envelope, assigning `seq` and `version` in call order per stream. */
export function makeStream(streamId: string) {
  let version = 0;
  return function event<T extends EventType>(
    type: T,
    data: PayloadOf<T>,
    extra: { actor?: string; at?: Date; schemaVer?: number } = {},
  ): Envelope {
    version += 1;
    return {
      seq: nextSeq++,
      streamId,
      version,
      type,
      schemaVer: extra.schemaVer ?? SCHEMA_VER[type],
      data: parsePayload(type, data),
      actor: extra.actor ?? "conductor",
      causation: null,
      at: extra.at ?? new Date("2026-08-31T12:00:00.000Z"),
    };
  };
}

/**
 * An envelope for a type the catalogue does not contain — what a reducer built
 * against an older catalogue would meet when a newer conductor writes something
 * it has never heard of. Deliberately bypasses validation; there is no schema.
 */
export function unknownEvent(streamId: string, version: number, seq?: bigint): Envelope {
  return {
    seq: seq ?? nextSeq++,
    streamId,
    version,
    type: "SomethingThisBuildHasNeverHeardOf",
    schemaVer: 1,
    data: { whatever: true },
    actor: "conductor",
    causation: null,
    at: new Date("2026-08-31T12:00:00.000Z"),
  };
}
