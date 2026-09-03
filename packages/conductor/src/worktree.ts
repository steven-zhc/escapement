/**
 * Provisioning the directory an agent works in.
 *
 * Three things this has to get right, each of which cost the old loop something
 * measurable.
 *
 * **The integrator never uses your checkout.** A worktree cut from a clone
 * Lingtai owns is the blast radius; the operator's own working copy is not
 * touched, read or written. Uncommitted work in it is what made a merge fail
 * with no log, no comment and no label — five re-runs and about $29 on #58/#59.
 *
 * **Submodules are initialised.** `git worktree add` does not populate them.
 * Skipping it makes every test that imports one fail, and on a board that reads
 * as *the agent broke the tests* rather than *the harness set it up wrong*.
 *
 * **The environment is filtered, not inherited.** The agent gets exactly the
 * variable names the recipe allows, with values resolved from the conductor's
 * own environment — somewhere the agent cannot see. This is one of the three
 * real boundaries (doc/decisions/0007-dual-runtime.md); the hook is not one.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Where the conductor keeps the clones and worktrees it owns. */
export function stateDir(): string {
  return process.env["LINGTAI_HOME"] ?? join(homedir(), ".lingtai");
}

/**
 * A token, or something that will produce a current one.
 *
 * The function form is what real runs use. An installation token lasts an hour
 * and a run may last two, so anything holding a string taken at the start is
 * holding something that expires before the integrator pushes. The string form
 * stays for tests, which do not talk to GitHub at all.
 */
export type TokenSource = string | (() => Promise<string>);

export interface GitRunOptions {
  cwd?: string;
  /**
   * An installation token, passed through `GIT_CONFIG_*` environment variables
   * rather than on the command line or in `.git/config`.
   *
   * argv is visible in `ps`; `.git/config` outlives the run and would be
   * readable from inside the worktree by the agent itself. The environment of a
   * single child process is neither.
   */
  token?: TokenSource;
  env?: NodeJS.ProcessEnv;
}

export async function git(args: string[], options: GitRunOptions = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  // Resolved here, per invocation, rather than once by the caller — that is the
  // whole point of accepting a function.
  const token = typeof options.token === "function" ? await options.token() : options.token;
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    env["GIT_CONFIG_COUNT"] = "1";
    env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader";
    env["GIT_CONFIG_VALUE_0"] = `AUTHORIZATION: basic ${basic}`;
  }
  // Never prompt: a hung credential prompt inside a daemon is indistinguishable
  // from a slow clone.
  env["GIT_TERMINAL_PROMPT"] = "0";

  const { stdout } = await exec("git", args, { cwd: options.cwd, env, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

// ------------------------------------------------------------ environment ----

export class ProductionValueError extends Error {
  override readonly name = "ProductionValueError";
  readonly variable: string;
  readonly matched: string;

  constructor(variable: string, matched: string) {
    super(
      `${variable} looks like production (its host matches "${matched}"). ` +
        "Refusing to plant it: an agent must never hold a production credential.",
    );
    this.variable = variable;
    this.matched = matched;
  }
}

/**
 * Host substrings that mean "do not give this to an agent".
 *
 * **Not yet policy-configurable, and it should be.** ADR 0005 puts production
 * host patterns configurable, but nothing carries them yet, so
 * these are a built-in default a caller can override. Adding the field is a
 * schema bump that belongs with the policy gate (#19) rather than here.
 *
 * Matched against the *host* of a URL-shaped value, by segment. Matching the
 * whole string trips on a password containing "prod"; matching the host by
 * substring trips on `reproducible.dev.example.com`. Either way a tripwire that
 * cries wolf trains people to pass an override flag, which is the worst outcome
 * for one. See `hostLooksProduction`.
 */
export const DEFAULT_PRODUCTION_PATTERNS = ["prod", "production"];

/**
 * Whether a host is a production one, by **segment** rather than by substring.
 *
 * Substring matching looked right and was not: `reproducible.dev.example.com`
 * contains "prod", and a tripwire that refuses a development host trains people
 * to turn it off. The host is split on `.` and `-` and a segment has to match
 * outright — `db.prod.example.com` and `prod-db.example.com` both do,
 * `reproducible.dev.example.com` does not.
 *
 * Lived in `guard.ts` and moved here when the guard was deleted (ADR 0016 §6).
 * It was never the guard's: the filtered environment is one of the three real
 * boundaries, and this is what makes it refuse rather than warn.
 */
export function hostLooksProduction(host: string, patterns: readonly string[]): string | null {
  const segments = host.toLowerCase().split(/[.\-]/);
  for (const pattern of patterns) {
    if (segments.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}

export interface FilteredEnv {
  values: Record<string, string>;
  /** Allowed names that were not set. Absent is legitimate; silent is not. */
  missing: string[];
}

/**
 * Reduces an environment to the names a recipe allows, and refuses one that
 * looks like production.
 */
/**
 * The variables a process needs in order to be a process at all.
 *
 * `filterEnv` is an allowlist of the *project's* variables — the secrets and
 * connection strings a recipe names. It is not, and should not become, a list of
 * the things a shell needs to find a binary. Those are two different questions
 * and conflating them is how the first real run against a repository died on
 * `/bin/sh: pnpm: command not found`.
 *
 * That failure had three instances and one cause: the agent was given `PATH` and
 * `HOME`, the gates were given `PATH` and not `HOME` — which `pnpm` needs for
 * its store and its config — and the prepare stage was given neither. Three call
 * sites, three different answers, one of them right. So it is computed here,
 * once.
 *
 * Deliberately short. `NODE_OPTIONS` is excluded because it injects behaviour
 * into every child; anything a project genuinely needs belongs in `env.allow`,
 * where a person wrote it down.
 *
 * `HOME` is the operator's, which is what makes a warm package store possible
 * and every install after the first one fast. It also means a command can read
 * the operator's home directory — contained by the tier, not by this, and worth
 * revisiting if a scratch home ever becomes affordable.
 *
 * **`USER` is here because Claude Code cannot log in without it.** The first
 * real run against `nextloom-ai-admin` reached the agent and died on
 * "Not logged in · Please run /login", with `HOME` set and the credentials
 * exactly where they always are. Measured directly: with `USER`, the run calls
 * the API and costs money; with `SHELL` instead and no `USER`, it reports zero
 * tokens and zero cost and never calls anything. macOS finds a keychain item by
 * who is asking, and with nobody asking there is nothing to find.
 *
 * `LOGNAME` is its POSIX twin and some tools read that one instead. `SHELL` is
 * deliberately *not* here: it was not needed, and leaving it out keeps the
 * shell a command runs under predictable rather than inherited.
 */
export const RUNNABLE = ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME"] as const;

export function runnableEnv(
  values: Record<string, string>,
  from: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of RUNNABLE) {
    const value = from[name];
    if (value) base[name] = value;
  }
  // The project's own values win: a recipe that allows `PATH` meant it.
  return { ...base, ...values };
}

export function filterEnv(
  allow: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
  patterns: readonly string[] = DEFAULT_PRODUCTION_PATTERNS,
): FilteredEnv {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of allow) {
    const value = source[name];
    if (value === undefined || value === "") {
      missing.push(name);
      continue;
    }
    const host = hostOf(value);
    if (host) {
      const hit = hostLooksProduction(host, patterns);
      if (hit) throw new ProductionValueError(name, hit);
    }
    values[name] = value;
  }

  return { values, missing };
}

/** The host of a URL-shaped value, or null when it is not one. */
function hostOf(value: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/** `.env`-file text. Values are quoted so a `#` or a space cannot truncate one. */
export function renderEnvFile(values: Record<string, string>): string {
  const lines = [
    "# Written by Lingtai for one run. Not committed, not inherited —",
    "# only the names the recipe's env.allow lists.",
  ];
  for (const [name, value] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`${name}=${JSON.stringify(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

// -------------------------------------------------------------- worktrees ----

export interface ProvisionOptions {
  project: string;
  owner: string;
  repo: string;
  base: string;
  /** The agent's branch. Created from `origin/<base>`, never from local state. */
  branch: string;
  runId: string;
  submodules: boolean;
  /** Where inside the worktree the filtered env file goes. */
  plantAt: string;
  env: Record<string, string>;
  token?: TokenSource;
  /** Overrides the clone source. Tests point it at a local repository. */
  remote?: string;
  home?: string;
  /**
   * The environment every `git` child gets.
   *
   * The conductor controls it rather than inheriting it, for the same reason the
   * agent's environment is filtered. The tests also use it to set
   * `GIT_ALLOW_PROTOCOL=file`, which a local-path submodule needs and which git
   * refuses by default since CVE-2022-39253 — the real one clones over https,
   * where the restriction does not apply and must not be lifted.
   */
  gitEnv?: NodeJS.ProcessEnv;
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
  /** The env file that was written, so a caller can say what the agent can see. */
  plantedAt: string;
}

function mirrorPath(home: string, project: string): string {
  return join(home, "repos", `${project}.git`);
}

export function worktreePath(home: string, project: string, runId: string): string {
  return join(home, "worktrees", project, runId);
}

/**
 * A bare mirror of the repository, cloned once and fetched thereafter.
 *
 * Bare and owned by Lingtai: there is no working copy here to be dirty, which
 * removes the failure mode entirely rather than checking for it.
 */
export async function ensureMirror(options: {
  project: string;
  owner: string;
  repo: string;
  token?: TokenSource;
  remote?: string;
  home?: string;
  gitEnv?: NodeJS.ProcessEnv;
}): Promise<string> {
  const home = options.home ?? stateDir();
  const path = mirrorPath(home, options.project);
  const remote = options.remote ?? `https://github.com/${options.owner}/${options.repo}.git`;
  const run = { token: options.token, env: options.gitEnv };

  try {
    await git(["rev-parse", "--git-dir"], { ...run, cwd: path });
    await git(["fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*"], { ...run, cwd: path });
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await rm(path, { recursive: true, force: true });
    await git(["clone", "--bare", remote, path], run);
    // A bare clone's origin is not wired for later fetches by default.
    await git(["remote", "set-url", "origin", remote], { ...run, cwd: path });
  }
  return path;
}

export async function provisionWorktree(options: ProvisionOptions): Promise<Worktree> {
  const home = options.home ?? stateDir();
  const run = { token: options.token, env: options.gitEnv };
  const mirror = await ensureMirror({
    project: options.project,
    owner: options.owner,
    repo: options.repo,
    token: options.token,
    remote: options.remote,
    home,
    gitEnv: options.gitEnv,
  });

  const path = worktreePath(home, options.project, options.runId);
  await rm(path, { recursive: true, force: true });
  await mkdir(dirname(path), { recursive: true });

  // From the base branch as the mirror has it, which is `origin/<base>` — never
  // from anything local, and never from the agent's previous branch.
  const baseSha = await git(["rev-parse", options.base], { ...run, cwd: mirror });
  await git(["worktree", "add", "--force", "-B", options.branch, path, baseSha], {
    ...run,
    cwd: mirror,
  });

  if (options.submodules) {
    // Not optional when the recipe says so. `worktree add` leaves submodule
    // directories empty, and the tests that import them fail in a way that reads
    // as the agent's fault.
    await git(["submodule", "update", "--init", "--recursive"], { ...run, cwd: path });
  }

  const plantedAt = resolve(path, options.plantAt);
  await mkdir(dirname(plantedAt), { recursive: true });
  await writeFile(plantedAt, renderEnvFile(options.env), { mode: 0o600 });

  return { path, branch: options.branch, baseSha, plantedAt };
}

/** Removes a run's worktree. The mirror stays; it is the expensive part. */
export async function removeWorktree(options: {
  project: string;
  runId: string;
  home?: string;
}): Promise<void> {
  const home = options.home ?? stateDir();
  const path = worktreePath(home, options.project, options.runId);
  const mirror = mirrorPath(home, options.project);
  await rm(path, { recursive: true, force: true });
  // Tell git the directory is gone, so a later `worktree add` at the same path
  // is not refused by a stale registration.
  await git(["worktree", "prune"], { cwd: mirror }).catch(() => {
    // No mirror, nothing registered. Not worth failing a cleanup over.
  });
}
