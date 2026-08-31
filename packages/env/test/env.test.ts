/**
 * Where configuration values come from. No database, no network.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePath } from "../src/index.ts";

describe("resolvePath", () => {
  /**
   * The README documented `~/.escapement-app.pem` before this existed. Nothing
   * else expands `~` there — a shell does not read a `.env` file, dotenv takes
   * the value literally, and `path.resolve` would have produced a directory
   * *named* `~` inside the repository. The failure would have been a bare ENOENT
   * naming a path nobody wrote.
   */
  it("expands a leading tilde", () => {
    expect(resolvePath("~/.escapement-app.pem")).toBe(resolve(homedir(), ".escapement-app.pem"));
    expect(resolvePath("~")).toBe(homedir());
  });

  it("does not expand a tilde that is not the whole first segment", () => {
    // `~backup` is a file called that, not another user's home.
    expect(resolvePath("~backup.pem")).toContain("~backup.pem");
  });

  it("leaves an absolute path alone", () => {
    expect(resolvePath("/etc/escapement/key.pem")).toBe("/etc/escapement/key.pem");
  });

  it("resolves a relative path against the repository root, not the cwd", () => {
    // The same rule the environment file itself follows: a command's directory
    // must not change what configuration means.
    const fromRoot = resolvePath("../escapement-app.pem");
    expect(fromRoot.endsWith("escapement-app.pem")).toBe(true);
    expect(fromRoot.startsWith("/")).toBe(true);
    expect(fromRoot).not.toContain("packages/env");
  });
});
