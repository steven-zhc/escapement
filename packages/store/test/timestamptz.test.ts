/**
 * No database needed. These are the exact strings Postgres prints for a
 * `timestamptz`, and the reason this function exists rather than a bare
 * `new Date(...)` — see the module header.
 */
import { describe, expect, it } from "vitest";
import { parseTimestamptz } from "../src/timestamptz.ts";

describe("parseTimestamptz", () => {
  it("parses what the live database actually returned", () => {
    // Copied from a real row, 2026-08-31.
    expect(parseTimestamptz("2026-08-31 18:02:10.201465+00").toISOString()).toBe(
      "2026-08-31T18:02:10.201Z",
    );
  });

  it("handles the offset forms Postgres prints", () => {
    expect(parseTimestamptz("2026-08-31 18:02:10+00").toISOString()).toBe(
      "2026-08-31T18:02:10.000Z",
    );
    expect(parseTimestamptz("2026-08-31 23:32:10.5+05:30").toISOString()).toBe(
      "2026-08-31T18:02:10.500Z",
    );
    expect(parseTimestamptz("2026-08-31 11:02:10-07").toISOString()).toBe(
      "2026-08-31T18:02:10.000Z",
    );
  });

  it("throws on anything else rather than returning Invalid Date", () => {
    expect(() => parseTimestamptz("2026-08-31T18:02:10.201465+00")).toThrow();
    expect(() => parseTimestamptz("yesterday")).toThrow();
    expect(() => parseTimestamptz("")).toThrow();
  });
});
