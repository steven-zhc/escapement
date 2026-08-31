/**
 * The upcasting hook, exercised against a registry the test builds itself.
 *
 * There is no real upcaster to test: every type is at `schemaVer` 1, so every
 * chain in `UPCASTERS` has length zero. Inventing a fake bump in the shipped
 * catalogue to make a test look better would put a lie in the one file that
 * costs a migration to get wrong. So the mechanism is exercised with a local
 * registry, and the shipped one is asserted to be empty — which is the honest
 * statement of where this stands.
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

  it("ships with an empty registry, because every type is at version 1", () => {
    expect(Object.keys(UPCASTERS)).toEqual([]);
    expect(new Set(Object.values(SCHEMA_VER))).toEqual(new Set([1]));
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
