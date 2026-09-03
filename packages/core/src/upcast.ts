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
 * It was here before it was needed, on purpose: the first upcaster is written
 * under time pressure against real history, which is the worst moment to also be
 * designing the mechanism.
 */
import { type EventType, type PayloadOf, SCHEMA_VER, parsePayload } from "./events.ts";

/** Takes a payload at version *n* and returns it at version *n + 1*. */
export type Upcaster = (data: unknown) => unknown;

/** `type → fromVersion → upcaster`. Steps must be contiguous. */
export type UpcastRegistry = Partial<Record<EventType, Record<number, Upcaster>>>;

/**
 * 1 → 2 for every type whose payload carries a `GatePoint`: the point called
 * `diff` is called `proposed` (ADR 0018).
 *
 * A pure rename, and the only one of these steps that could have been skipped
 * by leaving the old value in the enum. It was not, because the enum is what a
 * reader is shown: two spellings of one point would mean the board, `status`
 * and every recipe had to know both forever, and the run that wrote `diff`
 * would look like a different kind of run from the one that wrote `proposed`.
 *
 * It is written as a conditional rather than an unconditional overwrite so that
 * a v1 event from one of the other four points is returned untouched — the
 * upcaster's job is to move the one value that moved, not to assert what the
 * rest were.
 */
const gatePointRenamed: Upcaster = (data) => {
  const d = data as { gate?: string };
  return d.gate === "diff" ? { ...d, gate: "proposed" } : data;
};

/**
 * Add a step here in the same commit that bumps that type's `SCHEMA_VER`, never
 * separately.
 */
export const UPCASTERS: UpcastRegistry = {
  ProjectConfigured: {
    /**
     * 1 → 2: `owner` was added because the repository name alone was not enough
     * to reach GitHub again. A v1 event did not record one, and null says that
     * rather than guessing — every other field is untouched.
     */
    1: (data) => ({ ...(data as object), owner: null }),
    /**
     * 2 → 3: `base` was added because falling back to the repository's default
     * branch is only correct by convention, and `nextloom-ai-admin`'s default
     * was a feature branch. A v2 event did not record one; null means "ask
     * GitHub", which is exactly what those runs did.
     */
    2: (data) => ({ ...(data as object), base: null }),
  },
  Reconciled: {
    /**
     * 1 → 2: each finding gained `action`. Nothing had appended one of these
     * when the field was added, so this step exists for the rule rather than
     * for any event — `reported` is the honest reading of a v1 finding, which
     * recorded that something diverged and not what became of it.
     */
    1: (data) => ({
      findings: ((data as { findings?: object[] }).findings ?? []).map((f) => ({
        ...f,
        action: "reported",
      })),
    }),
  },
  WorkItemClaimed: {
    /**
     * 1 → 2: `title` and `kind` were added when the queue left the log (0012).
     * A v1 claim recorded neither, and null says so — the upcaster is handed a
     * payload and not a stream id, so it could not recover them even in
     * principle. The projection falls back to the issue number.
     */
    1: (data) => ({ ...(data as object), title: null, kind: null }),
  },
  GatesResolved: { 1: (data) => ({
    ...(data as object),
    points: ((data as { points?: { gate: string }[] }).points ?? []).map((p) =>
      p.gate === "diff" ? { ...p, gate: "proposed" } : p,
    ),
  }) },
  GateRequested: { 1: gatePointRenamed },
  GateStarted: { 1: gatePointRenamed },
  GatePassed: { 1: gatePointRenamed },
  GateFailed: { 1: gatePointRenamed },
  GateWaived: { 1: gatePointRenamed },
  ApprovalRequested: { 1: gatePointRenamed },
  ApprovalGranted: { 1: gatePointRenamed },
  ApprovalRevoked: { 1: gatePointRenamed },
};

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
