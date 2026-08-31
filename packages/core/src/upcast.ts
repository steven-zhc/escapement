/**
 * Read-time schema evolution.
 *
 * Every event carries `schemaVer` from the first row on purpose — the cost of
 * adding it later comes due exactly when there is a year of history worth
 * replaying (doc/decisions/0001-event-sourcing.md). This is the other half:
 * the thing that reads it.
 *
 * The rule the catalogue states is *bump `SCHEMA_VER` for a type and add an
 * upcaster rather than changing a payload in place*. An upcaster takes one
 * version to the next, and a chain of them takes any stored payload up to what
 * this build understands. A missing step throws — the alternative is handing a
 * v2 payload to a v1 schema, which either fails a validation that names the
 * wrong problem or, worse, passes.
 *
 * The registry is empty today: every type is at version 1, so every chain has
 * length zero. It is here now rather than later because the first upcaster is
 * written under time pressure against real history, which is the worst moment to
 * also be designing the mechanism.
 */
import { type EventType, type PayloadOf, SCHEMA_VER, parsePayload } from "./events.ts";

/** Takes a payload at version *n* and returns it at version *n + 1*. */
export type Upcaster = (data: unknown) => unknown;

/** `type → fromVersion → upcaster`. Steps must be contiguous. */
export type UpcastRegistry = Partial<Record<EventType, Record<number, Upcaster>>>;

/**
 * Empty, and correct. Add a step here in the same commit that bumps that type's
 * `SCHEMA_VER`, never separately.
 */
export const UPCASTERS: UpcastRegistry = {};

export class MissingUpcasterError extends Error {
  override readonly name = "MissingUpcasterError";
  readonly type: EventType;
  readonly stored: number;
  readonly supported: number;

  constructor(type: EventType, stored: number, supported: number) {
    super(
      stored > supported
        ? `${type} is stored at schemaVer ${stored} but this build reads ${supported} — ` +
            "the writer is newer than the reader"
        : `${type} needs an upcaster from schemaVer ${stored} to reach ${supported}`,
    );
    this.type = type;
    this.stored = stored;
    this.supported = supported;
  }
}

/**
 * Walks a stored payload up to the version this build understands.
 *
 * A payload *ahead* of this build is not upcastable and never will be — there is
 * no downcasting, and guessing is how history gets misread. It throws.
 */
export function upcast(
  type: EventType,
  schemaVer: number,
  data: unknown,
  registry: UpcastRegistry = UPCASTERS,
): unknown {
  const supported = SCHEMA_VER[type];
  if (schemaVer === supported) return data;
  if (schemaVer > supported) throw new MissingUpcasterError(type, schemaVer, supported);

  let current = data;
  for (let from = schemaVer; from < supported; from++) {
    const step = registry[type]?.[from];
    if (!step) throw new MissingUpcasterError(type, schemaVer, supported);
    current = step(current);
  }
  return current;
}

/** Upcast, then validate. What a reader should call instead of `parsePayload`. */
export function parseStoredPayload<T extends EventType>(
  type: T,
  schemaVer: number,
  data: unknown,
  registry: UpcastRegistry = UPCASTERS,
): PayloadOf<T> {
  return parsePayload(type, upcast(type, schemaVer, data, registry));
}
