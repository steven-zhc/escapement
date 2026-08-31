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
   * not its owner, so `esc status` could not resolve a recipe for a project it
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
