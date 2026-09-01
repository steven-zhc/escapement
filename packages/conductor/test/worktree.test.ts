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
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PRODUCTION_PATTERNS,
  ProductionValueError,
  filterEnv,
  provisionWorktree,
  removeWorktree,
  renderEnvFile,
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
  root = await mkdtemp(join(tmpdir(), "esc-worktree-"));
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
  env: { DATABASE_URL: "postgresql://u:p@dev.example.com:5432/app" },
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
    expect(planted).toContain('DATABASE_URL="postgresql://u:p@dev.example.com:5432/app"');

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

describe("filterEnv", () => {
  const source = {
    DATABASE_URL: "postgresql://u:p@dev.supabase.co:5432/app",
    CLERK_SECRET_KEY: "sk_test_abc",
    AWS_SECRET_ACCESS_KEY: "should never be planted",
    SHELL: "/bin/zsh",
  };

  it("plants only the names the recipe allows", () => {
    const { values } = filterEnv(["DATABASE_URL", "CLERK_SECRET_KEY"], source);

    expect(Object.keys(values).sort()).toEqual(["CLERK_SECRET_KEY", "DATABASE_URL"]);
    // The filtered environment is one of the three real boundaries. Anything the
    // recipe did not name simply is not there.
    expect(values).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(values).not.toHaveProperty("SHELL");
  });

  it("reports an allowed name that is not set rather than planting an empty one", () => {
    const { values, missing } = filterEnv(["DATABASE_URL", "STRIPE_KEY"], source);
    expect(missing).toEqual(["STRIPE_KEY"]);
    expect(values).not.toHaveProperty("STRIPE_KEY");
  });

  it("aborts on a value whose host looks like production", () => {
    const err = (() => {
      try {
        filterEnv(["DATABASE_URL"], {
          DATABASE_URL: "postgresql://u:p@db.prod.example.com:5432/app",
        });
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(ProductionValueError);
    expect((err as ProductionValueError).variable).toBe("DATABASE_URL");
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
      filterEnv(["DATABASE_URL"], {
        DATABASE_URL: "postgresql://u:p@reproducible.dev.example.com:5432/app",
      }),
    ).not.toThrow();
    // And a real one still trips, with or without a dash.
    expect(() =>
      filterEnv(["DATABASE_URL"], { DATABASE_URL: "postgresql://u:p@prod-db.example.com/app" }),
    ).toThrow(ProductionValueError);
  });

  it("does not trip on a password that happens to contain the word", () => {
    expect(() =>
      filterEnv(["DATABASE_URL"], {
        DATABASE_URL: "postgresql://u:reproduction@dev.example.com:5432/app",
      }),
    ).not.toThrow();
    expect(() => filterEnv(["NOTE"], { NOTE: "this is for production use later" })).not.toThrow();
  });

  it("takes its patterns from the caller", () => {
    expect(() =>
      filterEnv(["DATABASE_URL"], { DATABASE_URL: "postgresql://u:p@live.example.com/app" }, [
        "live",
      ]),
    ).toThrow(ProductionValueError);
    expect(DEFAULT_PRODUCTION_PATTERNS).toContain("prod");
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
    // A recipe that allows PATH meant PATH. This is not a hole: the value comes
    // from the operator's own environment either way, and the allowlist is
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

    // Anything a project genuinely needs belongs in `env.allow`, where a person
    // wrote it down and a reviewer saw it.
    expect("NODE_OPTIONS" in env).toBe(false);
  });
});
