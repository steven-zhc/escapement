/**
 * The upcasting hook.
 *
 * The invariant that matters is not "the registry is empty" — it was, until a
 * real field had to be added — but that **every type past version 1 has an
 * unbroken chain of steps from 1 up to its current version**. A bump without its
 * upcaster is the failure worth guarding: it makes every historical row of that
 * type unreadable, and it does so at the moment someone replays a year of them.
 */
import { describe, expect, it } from "vitest";
import {
  MissingUpcasterError,
  SCHEMA_VER,
  UPCASTERS,
  type UpcastRegistry,
  parseStoredPayload,
  upcast,
} from "../src/index.ts";

describe("upcast", () => {
  it("is a no-op at the current version", () => {
    const data = { turn: 12 };
    expect(upcast("RunContextExhausted", 1, data)).toBe(data);
  });

  it("has an unbroken chain of steps for every type past version 1", () => {
    const bumped = (Object.keys(SCHEMA_VER) as (keyof typeof SCHEMA_VER)[]).filter(
      (type) => SCHEMA_VER[type] > 1,
    );

    for (const type of bumped) {
      for (let from = 1; from < SCHEMA_VER[type]; from++) {
        expect(
          UPCASTERS[type]?.[from],
          `${type} is at schemaVer ${SCHEMA_VER[type]} with no upcaster from ${from}`,
        ).toBeTypeOf("function");
      }
    }
  });

  it("has no upcaster for a type that never moved", () => {
    // A step for a type still at version 1 is dead code that will be trusted.
    for (const type of Object.keys(UPCASTERS) as (keyof typeof SCHEMA_VER)[]) {
      expect(SCHEMA_VER[type]).toBeGreaterThan(1);
    }
  });

  /**
   * The first real bump. `ProjectConfigured` v1 recorded the repository name but
   * not its owner, so `lingtai status` could not resolve a recipe for a project it
   * had itself registered.
   */
  it("walks a v1 ProjectConfigured all the way up, filling both fields with null", () => {
    const v1 = { project: "nextloom-ai-admin", configHash: "abc", fromSha: "def" };
    const upcasted = parseStoredPayload("ProjectConfigured", 1, v1);

    // Null, not a guess. A v1 event genuinely recorded neither.
    expect(upcasted).toEqual({ ...v1, owner: null, base: null });
  });

  it("adds only what a v2 ProjectConfigured is missing", () => {
    const v2 = { project: "p", owner: "steven-zhc", configHash: "abc", fromSha: "def" };
    expect(parseStoredPayload("ProjectConfigured", 2, v2)).toEqual({ ...v2, base: null });
  });

  it("leaves a v3 ProjectConfigured alone", () => {
    const v3 = { project: "p", owner: "steven-zhc", base: "develop", configHash: "a", fromSha: "d" };
    expect(parseStoredPayload("ProjectConfigured", 3, v3)).toEqual(v3);
  });

  it("refuses a payload written by a newer build", () => {
    // Not recoverable, ever: there is no downcasting, and guessing at a field
    // this build has never seen is how history gets misread.
    expect(() => upcast("RunContextExhausted", 2, {})).toThrow(MissingUpcasterError);
  });

  it("refuses a payload it has no step for", () => {
    expect(() => upcast("RunContextExhausted", 0, {})).toThrow(MissingUpcasterError);
  });

  describe("with a chain of steps", () => {
    // A hypothetical history for one event: v1 held `turn`, v2 renamed it to
    // `atTurn`, v3 added `reason`. This is the shape a real bump would take.
    const registry: UpcastRegistry = {
      RunContextExhausted: {
        1: (d) => ({ atTurn: (d as { turn: number }).turn }),
        2: (d) => ({ ...(d as object), reason: "compaction" }),
      },
    };
    const supported = 3;

    function upcastTo(stored: number, data: unknown): unknown {
      // `upcast` walks to `SCHEMA_VER[type]`, which is 1 here, so the chain is
      // driven directly to keep the shipped catalogue untouched.
      let current = data;
      for (let from = stored; from < supported; from++) {
        const step = registry.RunContextExhausted?.[from];
        if (!step) throw new MissingUpcasterError("RunContextExhausted", stored, supported);
        current = step(current);
      }
      return current;
    }

    it("walks a v1 payload all the way to v3", () => {
      expect(upcastTo(1, { turn: 41 })).toEqual({ atTurn: 41, reason: "compaction" });
    });

    it("starts mid-chain when the payload is already partway up", () => {
      expect(upcastTo(2, { atTurn: 41 })).toEqual({ atTurn: 41, reason: "compaction" });
    });

    it("throws by name when a step is missing", () => {
      const gappy: UpcastRegistry = { RunContextExhausted: { 2: registry.RunContextExhausted![2]! } };
      expect(() => {
        let current: unknown = { turn: 1 };
        for (let from = 1; from < supported; from++) {
          const step = gappy.RunContextExhausted?.[from];
          if (!step) throw new MissingUpcasterError("RunContextExhausted", 1, supported);
          current = step(current);
        }
      }).toThrow(/RunContextExhausted needs an upcaster from schemaVer 1/);
    });
  });
});

describe("parseStoredPayload", () => {
  it("validates after upcasting, so a bad step is caught by the schema", () => {
    expect(parseStoredPayload("RunContextExhausted", 1, { turn: 41 })).toEqual({ turn: 41 });
    expect(() => parseStoredPayload("RunContextExhausted", 1, { turn: "forty-one" })).toThrow();
  });
});

/**
 * The rename that made this file earn its keep: the `diff` point became
 * `proposed` (ADR 0018).
 *
 * Nine types carry a `GatePoint`, and the enum no longer contains the old
 * value — so a stored row is not merely stale, it is unparseable without the
 * step. That is the good version of this failure and the reason the rename was
 * affordable: it cannot pass wrongly.
 */
describe("the gate point rename", () => {
  const GATE_CARRYING = [
    "GateRequested",
    "GateStarted",
    "GatePassed",
    "GateFailed",
    "GateWaived",
    "ApprovalRequested",
    "ApprovalGranted",
    "ApprovalRevoked",
  ] as const;

  const base = { action: "build", runId: "run-01JX", onSha: "sha-a" };
  const extra: Record<(typeof GATE_CARRYING)[number], object> = {
    GateRequested: {},
    GateStarted: {},
    GatePassed: { evidence: "exit 0" },
    GateFailed: { evidence: "exit 1", findings: [] },
    GateWaived: { by: "human:steven", reason: "known flake" },
    ApprovalRequested: { question: "Merge?", artifacts: ["diff"] },
    ApprovalGranted: { by: "human:steven", note: "" },
    ApprovalRevoked: { by: "human:steven", reason: "force-push" },
  };

  it.each(GATE_CARRYING)("moves a v1 %s from diff to proposed", (type) => {
    const v1 = { ...base, ...extra[type], gate: "diff" };
    expect(parseStoredPayload(type, 1, v1)).toEqual({ ...v1, gate: "proposed" });
  });

  it.each(GATE_CARRYING)("leaves a v1 %s at another point alone", (type) => {
    const v1 = { ...base, ...extra[type], gate: "merge", action: "human" };
    expect(parseStoredPayload(type, 1, v1)).toEqual(v1);
  });

  /**
   * The nested one. `GatesResolved` is the event the board reads to show an
   * unconfigured point as `skipped`, so a half-upcast here would not throw —
   * it would render a run as having a point nobody has ever heard of.
   */
  it("moves the point inside a v1 GatesResolved and keeps all five, in order", () => {
    const v1 = {
      runId: "run-01JX",
      configHash: "abc",
      points: [
        { gate: "admit", actions: [] },
        { gate: "prepared", actions: ["install"] },
        { gate: "diff", actions: ["build", "review"] },
        { gate: "merge", actions: [] },
        { gate: "end", actions: ["close the ticket"] },
      ],
    };

    const up = parseStoredPayload("GatesResolved", 1, v1);
    expect(up.points.map((p) => p.gate)).toEqual(["admit", "prepared", "proposed", "merge", "end"]);
    expect(up.points[2]!.actions).toEqual(["build", "review"]);
  });

  it("is the only reason those nine moved, so none of them is at v1", () => {
    for (const type of [...GATE_CARRYING, "GatesResolved"] as const) {
      expect(SCHEMA_VER[type], `${type} carries a GatePoint and must be past v1`).toBe(2);
    }
  });
});
