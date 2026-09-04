/**
 * Worktree provisioning, against real git.
 *
 * No network and no GitHub: the "remote" is a bare repository this test builds
 * in a temp directory, which exercises the same clone/fetch/worktree/submodule
 * path the real one takes. The submodule case is here because skipping it makes
 * every test that imports one fail, and on a board that reads as *the agent
 * broke the tests*.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCTION_PATTERNS,
  ProductionValueError,
  RESERVED,
  filterEnv,
  isReserved,
  parseEnvFile,
  projectEnvPath,
  provisionWorktree,
  removeWorktree,
  renderEnvFile,
  resolveAgentEnv,
  runnableEnv,
} from "../src/index.ts";

const exec = promisify(execFile);
const git = (args: string[], cwd: string) =>
  exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });

let root: string;
let originPath: string;
let submodulePath: string;
let home: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lingtai-worktree-"));
  home = join(root, "home");

  // A tiny repository to be used as a submodule.
  submodulePath = join(root, "shared.git");
  const subWork = join(root, "shared");
  await exec("git", ["init", "-q", "-b", "main", subWork]);
  await writeFile(join(subWork, "shared.txt"), "shared\n");
  await git(["add", "-A"], subWork);
  await git(["commit", "-qm", "shared"], subWork);
  await exec("git", ["clone", "-q", "--bare", subWork, submodulePath]);

  // The "remote": a repository with a develop branch and that submodule.
  const work = join(root, "work");
  originPath = join(root, "origin.git");
  await exec("git", ["init", "-q", "-b", "develop", work]);
  await writeFile(join(work, "README.md"), "hello\n");
  await git(["add", "-A"], work);
  await git(["commit", "-qm", "first"], work);
  await git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", submodulePath, "packages/shared"], work);
  await git(["commit", "-qm", "add submodule"], work);
  await exec("git", ["clone", "-q", "--bare", work, originPath]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A local-path submodule needs `file` explicitly allowed; git has refused it by
 * default since CVE-2022-39253. The real provisioning clones over https, where
 * the restriction does not apply — so this belongs in the test's environment and
 * not in the code under test.
 */
const gitEnv = { ...process.env, GIT_ALLOW_PROTOCOL: "file" };

const base = {
  project: "esctest",
  gitEnv,
  owner: "steven-zhc",
  repo: "esctest",
  base: "develop",
  plantAt: "apps/web/.env.local",
  env: { LOCAL_DATABASE_URL: "postgresql://u:p@dev.example.com:5432/app" },
};

describe("provisionWorktree", () => {
  it("cuts a branch from origin/<base> and plants the env file", async () => {
    const wt = await provisionWorktree({
      ...base,
      branch: "agent/1",
      runId: "run-1",
      submodules: false,
      remote: originPath,
      home,
    });

    expect((await stat(join(wt.path, "README.md"))).isFile()).toBe(true);
    expect(wt.baseSha).toMatch(/^[0-9a-f]{40}$/);

    // The env file is where the recipe said, not at the repo root — Next, Prisma
    // and vitest read it from the app directory.
    expect(wt.plantedAt).toBe(join(wt.path, "apps/web/.env.local"));
    const planted = await readFile(wt.plantedAt, "utf8");
    expect(planted).toContain('LOCAL_DATABASE_URL="postgresql://u:p@dev.example.com:5432/app"');

    // Readable only by the owner: it holds real values.
    expect((await stat(wt.plantedAt)).mode & 0o077).toBe(0);

    const branch = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt.path });
    expect(branch.stdout.trim()).toBe("agent/1");

    await removeWorktree({ project: base.project, runId: "run-1", home });
  });

  /**
   * `git worktree add` does not populate submodules. A worktree without them
   * fails every test that imports one, which reads as the agent's fault.
   */
  it("initialises submodules when the recipe asks for them", async () => {
    const wt = await provisionWorktree({
      ...base,
      branch: "agent/2",
      runId: "run-2",
      submodules: true,
      remote: originPath,
      home,
    });

    const shared = join(wt.path, "packages/shared/shared.txt");
    expect((await stat(shared)).isFile()).toBe(true);
    expect(await readFile(shared, "utf8")).toBe("shared\n");

    await removeWorktree({ project: base.project, runId: "run-2", home });
  });

  it("leaves the submodule empty when the recipe does not ask", async () => {
    const wt = await provisionWorktree({
      ...base,
      branch: "agent/3",
      runId: "run-3",
      submodules: false,
      remote: originPath,
      home,
    });

    await expect(stat(join(wt.path, "packages/shared/shared.txt"))).rejects.toThrow();
    await removeWorktree({ project: base.project, runId: "run-3", home });
  });

  it("re-provisioning the same run replaces the worktree rather than failing", async () => {
    const first = await provisionWorktree({
      ...base,
      branch: "agent/4",
      runId: "run-4",
      submodules: false,
      remote: originPath,
      home,
    });
    await writeFile(join(first.path, "scratch.txt"), "left over\n");

    const second = await provisionWorktree({
      ...base,
      branch: "agent/4",
      runId: "run-4",
      submodules: false,
      remote: originPath,
      home,
    });

    expect(second.path).toBe(first.path);
    // A crash mid-run leaves a directory, not a state to reconcile by hand.
    await expect(stat(join(second.path, "scratch.txt"))).rejects.toThrow();
    await removeWorktree({ project: base.project, runId: "run-4", home });
  });
});

describe("filterEnv — layer 2, the machine's own environment", () => {
  const source = {
    LOCAL_DATABASE_URL: "postgresql://u:p@dev.supabase.co:5432/app",
    CLERK_SECRET_KEY: "sk_test_abc",
    AWS_SECRET_ACCESS_KEY: "should never be planted",
    SHELL: "/bin/zsh",
  };

  it("plants only the names the recipe requires", () => {
    const { values } = filterEnv(["LOCAL_DATABASE_URL", "CLERK_SECRET_KEY"], source);

    expect(Object.keys(values).sort()).toEqual(["CLERK_SECRET_KEY", "LOCAL_DATABASE_URL"]);
    // The filtered environment is one of the three real boundaries. Anything the
    // recipe did not name simply is not there.
    expect(values).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(values).not.toHaveProperty("SHELL");
  });

  it("reports a required name that is not set rather than planting an empty one", () => {
    const { values, missing } = filterEnv(["LOCAL_DATABASE_URL", "STRIPE_KEY"], source);
    expect(missing).toEqual(["STRIPE_KEY"]);
    expect(values).not.toHaveProperty("STRIPE_KEY");
  });

  it("aborts on a value whose host looks like production", () => {
    const err = (() => {
      try {
        filterEnv(["LOCAL_DATABASE_URL"], {
          LOCAL_DATABASE_URL: "postgresql://u:p@db.prod.example.com:5432/app",
        });
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(ProductionValueError);
    expect((err as ProductionValueError).variable).toBe("LOCAL_DATABASE_URL");
    expect((err as Error).message).toContain("never hold a production credential");
  });

  /**
   * Matched against the host only. A password containing "prod" is not a
   * production database, and a tripwire that cries wolf trains people to pass
   * an override flag — the worst outcome for one.
   */
  it("does not trip on a host whose name merely contains the word", () => {
    // `reproducible` contains `prod`; matching host segments is what saves it.
    expect(() =>
      filterEnv(["LOCAL_DATABASE_URL"], {
        LOCAL_DATABASE_URL: "postgresql://u:p@reproducible.dev.example.com:5432/app",
      }),
    ).not.toThrow();
    // And a real one still trips, with or without a dash.
    expect(() =>
      filterEnv(["LOCAL_DATABASE_URL"], {
        LOCAL_DATABASE_URL: "postgresql://u:p@prod-db.example.com/app",
      }),
    ).toThrow(ProductionValueError);
  });

  it("does not trip on a password that happens to contain the word", () => {
    expect(() =>
      filterEnv(["LOCAL_DATABASE_URL"], {
        LOCAL_DATABASE_URL: "postgresql://u:reproduction@dev.example.com:5432/app",
      }),
    ).not.toThrow();
    expect(() => filterEnv(["NOTE"], { NOTE: "this is for production use later" })).not.toThrow();
  });

  it("takes its patterns from the caller", () => {
    expect(() =>
      filterEnv(
        ["LOCAL_DATABASE_URL"],
        { LOCAL_DATABASE_URL: "postgresql://u:p@live.example.com/app" },
        ["live"],
      ),
    ).toThrow(ProductionValueError);
    expect(DEFAULT_PRODUCTION_PATTERNS).toContain("prod");
  });
});

/**
 * The asymmetry that makes self-hosting possible.
 *
 * A recipe is written by the *managed repository*, so layer 2 would otherwise
 * let one line of YAML in a repository an agent is editing reach `DATABASE_URL`
 * — this system's own log — or the App key that signs its tokens.
 */
describe("RESERVED", () => {
  it("refuses a recipe reaching for DATABASE_URL, however it declares it", async () => {
    const source = { DATABASE_URL: "postgresql://u:p@lingtais-own.example.com:5432/log" };
    const { values, reserved, missing } = filterEnv(["DATABASE_URL"], source);

    expect(values).not.toHaveProperty("DATABASE_URL");
    expect(reserved).toEqual(["DATABASE_URL"]);
    expect(missing).toEqual(["DATABASE_URL"]);

    // And the whole project refuses, rather than the value simply being absent.
    const env = await resolveAgentEnv({
      project: "someone-elses-repo",
      required: ["DATABASE_URL"],
      source,
      home: join(root, "no-such-home"),
    });
    expect(env.values).not.toHaveProperty("DATABASE_URL");
    expect(env.refusal).toContain("reserved");
  });

  it("covers the prefixes as well as the names", () => {
    expect(isReserved("DATABASE_URL")).toBe(true);
    expect(isReserved("DIRECT_DATABASE_URL")).toBe(true);
    expect(isReserved("TEST_DATABASE_URL")).toBe(true);
    expect(isReserved("GITHUB_APP_PRIVATE_KEY_PATH")).toBe(true);
    // A project's own connection string is not Lingtai's.
    expect(isReserved("LOCAL_DATABASE_URL")).toBe(false);
    expect(isReserved("CLERK_SECRET_KEY")).toBe(false);
    expect(RESERVED).toContain("DATABASE_URL");
  });
});

describe("parseEnvFile — layer 3's format", () => {
  it("reads names and values, ignoring comments and blank lines", () => {
    const { values } = parseEnvFile(
      ["# a note", "", "A=one", "B=two three", "export C=four", "  D = five  "].join("\n"),
    );
    expect(values).toEqual({ A: "one", B: "two three", C: "four", D: "five" });
  });

  it("is the inverse of renderEnvFile, so a value survives a round trip", () => {
    const original = { A: "one two", B: "x # not a comment", C: "line\nbreak" };
    expect(parseEnvFile(renderEnvFile(original)).values).toEqual(original);
  });

  /**
   * The room reserved for layer 4. Defining the syntax now and refusing it is
   * the point: planting `!op read op://…` as a connection string would be a
   * silent half-move, and quoting is the escape hatch for a value that really
   * does begin with `!`.
   */
  it("keeps a `!command` value apart rather than planting it literally", () => {
    const { values, commands } = parseEnvFile(
      ['SECRET=!op read op://vault/db/url', 'LITERAL="!not a command"'].join("\n"),
    );
    expect(commands).toEqual({ SECRET: "op read op://vault/db/url" });
    expect(values).toEqual({ LITERAL: "!not a command" });
  });
});

describe("resolveAgentEnv — the layers, and the refusal", () => {
  let envHome: string;

  beforeAll(async () => {
    envHome = join(root, "envhome");
    await mkdir(join(envHome, "env"), { recursive: true });
    await writeFile(
      projectEnvPath("layered", envHome),
      ["# the operator's own file", "LOCAL_DATABASE_URL=postgres://localhost/dev", "TEST_DATABASE_URL=postgres://localhost/test"].join("\n"),
    );
  });

  it("says which layer answered for each declared name", async () => {
    const env = await resolveAgentEnv({
      project: "layered",
      required: ["CLERK_SECRET_KEY", "LOCAL_DATABASE_URL", "STRIPE_KEY"],
      source: { CLERK_SECRET_KEY: "sk_test_abc" },
      home: envHome,
    });

    expect(env.names).toEqual([
      { name: "CLERK_SECRET_KEY", layer: "process env" },
      { name: "LOCAL_DATABASE_URL", layer: "project file" },
      { name: "STRIPE_KEY", layer: "not set" },
    ]);
    expect(env.missing).toEqual(["STRIPE_KEY"]);
  });

  it("lets the project's file win over the machine, so two projects can differ", async () => {
    const env = await resolveAgentEnv({
      project: "layered",
      required: ["LOCAL_DATABASE_URL"],
      source: { LOCAL_DATABASE_URL: "postgres://the-machines/one" },
      home: envHome,
    });

    expect(env.values["LOCAL_DATABASE_URL"]).toBe("postgres://localhost/dev");
    expect(env.refusal).toBeNull();
  });

  /**
   * `RESERVED` blocks layer 2 only, and this is what that buys: Lingtai's own
   * recipe requires its test database, which no managed repository's recipe
   * could ever reach by declaring the same name.
   */
  it("lets the operator's own file supply a reserved name", async () => {
    const env = await resolveAgentEnv({
      project: "layered",
      required: ["TEST_DATABASE_URL"],
      source: { TEST_DATABASE_URL: "postgres://never-from-here/x" },
      home: envHome,
    });

    expect(env.values["TEST_DATABASE_URL"]).toBe("postgres://localhost/test");
    expect(env.names).toEqual([{ name: "TEST_DATABASE_URL", layer: "project file" }]);
    expect(env.refusal).toBeNull();
  });

  /**
   * The failure the whole change is about. It used to be one log line, after
   * which the run claimed the ticket and spent $0.97 producing nothing.
   */
  it("refuses, naming the file to write, when a declared name has no value", async () => {
    const env = await resolveAgentEnv({
      project: "nowhere",
      required: ["LOCAL_DATABASE_URL"],
      source: {},
      home: envHome,
    });

    expect(env.refusal).toContain("LOCAL_DATABASE_URL");
    expect(env.refusal).toContain(projectEnvPath("nowhere", envHome));
    // Never the value of anything, and there is nothing to leak here anyway —
    // but the refusal is what a person reads, so it says what to do.
    expect(env.refusal).toContain("env.required");
  });

  it("declares nothing and refuses nothing when the recipe requires nothing", async () => {
    const env = await resolveAgentEnv({ project: "nowhere", required: [], source: {}, home: envHome });
    expect(env.refusal).toBeNull();
    expect(env.values).toEqual({});
  });
});

describe("renderEnvFile", () => {
  it("quotes values so a space or a # cannot truncate one", () => {
    const text = renderEnvFile({ A: "one two", B: "x # not a comment" });
    expect(text).toContain('A="one two"');
    expect(text).toContain('B="x # not a comment"');
  });

  it("is stable in order, so a diff of two runs is about the values", () => {
    expect(renderEnvFile({ B: "2", A: "1" })).toBe(renderEnvFile({ A: "1", B: "2" }));
  });
});

/**
 * The first real run against a private repository died here, on
 * `/bin/sh: pnpm: command not found`, after three seams had already worked.
 *
 * The cause was that `filterEnv` answers "which of the project's variables may
 * this run see" and something had to answer the different question "what does a
 * process need in order to be a process". Three call sites had answered it
 * three ways: the agent got PATH and HOME, the gates got PATH without HOME —
 * which pnpm needs for its store and config — and prepare got neither.
 */
describe("the environment a command needs to run at all", () => {
  const from = {
    PATH: "/usr/bin",
    HOME: "/home/t",
    TMPDIR: "/tmp/",
    LANG: "en_US.UTF-8",
    USER: "t",
    LOGNAME: "t",
  };

  it("adds what a shell needs to find and run a binary", () => {
    expect(runnableEnv({}, from)).toEqual(from);
  });

  it("carries who is running, because a keychain is looked up by user", () => {
    // The second instance of this bug, and the more expensive one. The first
    // real run reached the agent and died on "Not logged in", with HOME set and
    // the credentials where they always are. Measured: USER alone makes the run
    // call the API; without it there are zero tokens and zero cost.
    expect(runnableEnv({}, from)["USER"]).toBe("t");
  });

  it("keeps the project's own values alongside", () => {
    const env = runnableEnv({ LOCAL_DATABASE_URL: "postgres://localhost/dev" }, from);

    expect(env["LOCAL_DATABASE_URL"]).toBe("postgres://localhost/dev");
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/t");
  });

  it("lets a recipe override one, because naming it was deliberate", () => {
    // A recipe that requires PATH meant PATH. This is not a hole: the value comes
    // from the operator's own environment either way, and the required list is
    // about which of *those* the run may see.
    expect(runnableEnv({ PATH: "/opt/toolchain/bin" }, from)["PATH"]).toBe("/opt/toolchain/bin");
  });

  it("carries nothing that was not set, rather than an empty string", () => {
    const env = runnableEnv({}, { PATH: "/usr/bin" });

    // `HOME: ""` is worse than no HOME: tools read it, believe it, and resolve
    // paths against the filesystem root.
    expect("HOME" in env).toBe(false);
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("does not carry NODE_OPTIONS, which would inject behaviour into every child", () => {
    const env = runnableEnv({}, { ...from, NODE_OPTIONS: "--require ./evil.js" });

    // Anything a project genuinely needs belongs in `env.required`, where a person
    // wrote it down and a reviewer saw it.
    expect("NODE_OPTIONS" in env).toBe(false);
  });
});
