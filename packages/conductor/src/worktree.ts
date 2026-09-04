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
 * variable names the recipe *requires*, merged from three named layers with
 * different owners, and a name with no value in any of them refuses the project
 * rather than being logged. This is one of the three real boundaries
 * (doc/decisions/0007-dual-runtime.md, reshaped by
 * doc/decisions/0020-the-agent-environment-in-layers.md); the hook is not one.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
 * **Not yet configurable, and it should be.** ADR 0005 puts production host
 * patterns in configuration, but no field carries them yet, so these are a
 * built-in default a caller can override. Adding that field is a change to the
 * recipe schema, not to this list.
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

/**
 * Lingtai's own credential names, which layer 2 never carries.
 *
 * A recipe is written by the *managed repository*. Without this, one line of
 * YAML in a repository an agent is editing would reach `DATABASE_URL` — which
 * is this system's own log, the thing it is keeping — or the App key that signs
 * every token it pushes with.
 *
 * **It blocks layer 2 only**, and that asymmetry is the whole point. Layer 3 is
 * a file the operator wrote on their own machine, so Lingtai managing itself can
 * put `TEST_DATABASE_URL` in `~/.lingtai/env/lingtai.env` while
 * `nextloom-ai-admin`'s recipe cannot reach for it by declaring the name.
 *
 * An entry ending in `*` is a prefix; everything else is an exact name.
 */
export const RESERVED = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "TEST_*",
  "GITHUB_APP_*",
] as const;

export function isReserved(name: string, reserved: readonly string[] = RESERVED): boolean {
  return reserved.some((r) => (r.endsWith("*") ? name.startsWith(r.slice(0, -1)) : name === r));
}

export interface FilteredEnv {
  values: Record<string, string>;
  /** Required names this layer did not supply. A later layer still may. */
  missing: string[];
  /** Required names refused here because they are Lingtai's own. See `RESERVED`. */
  reserved: string[];
}

/**
 * The variables a process needs in order to be a process at all — **layer 1**.
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
 * into every child; anything a project genuinely needs belongs in `env.required`,
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
  // The project's own values win: a recipe that requires `PATH` meant it.
  return { ...base, ...values };
}

/**
 * **Layer 2**: the conductor's own `process.env`, reduced to the names the
 * recipe declares, minus `RESERVED`, refusing a value that looks like
 * production.
 *
 * Not the whole answer on its own. `resolveAgentEnv` layers the per-project file
 * over this and is the thing that decides whether a run may proceed — a name
 * this layer reports as missing may still be supplied by layer 3.
 */
export function filterEnv(
  required: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
  patterns: readonly string[] = DEFAULT_PRODUCTION_PATTERNS,
): FilteredEnv {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const reserved: string[] = [];

  for (const name of required) {
    if (isReserved(name)) {
      // Refused here however the recipe declares it, and *before* the value is
      // read — so a recipe cannot learn whether one is set either.
      reserved.push(name);
      missing.push(name);
      continue;
    }
    const value = source[name];
    if (value === undefined || value === "") {
      missing.push(name);
      continue;
    }
    guardProduction(name, value, patterns);
    values[name] = value;
  }

  return { values, missing, reserved };
}

function guardProduction(name: string, value: string, patterns: readonly string[]): void {
  const host = hostOf(value);
  if (!host) return;
  const hit = hostLooksProduction(host, patterns);
  if (hit) throw new ProductionValueError(name, hit);
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

// ------------------------------------------------------ the project's file ---

/** **Layer 3**: `~/.lingtai/env/<project>.env`, and the only file layer there is. */
export function projectEnvPath(project: string, home: string = stateDir()): string {
  return join(home, "env", `${project}.env`);
}

export interface EnvFile {
  values: Record<string, string>;
  /**
   * Names whose value asks for a **secret source** — layer 4, which is not
   * built. Kept apart rather than taken literally: planting `!op read op://…`
   * as a connection string is the silent half-move this file exists to refuse.
   */
  commands: Record<string, string>;
}

/**
 * `.env`-file text → names and values, with room reserved for a secret source.
 *
 * The format is the ordinary one, with one rule added now so that layer 4 can
 * be added later without changing any file anybody has written: **an unquoted
 * value beginning with `!` is a command, not a value.** Quoting is therefore the
 * escape hatch — `TOKEN="!literal"` is those eight characters, `TOKEN=!op read …`
 * is a request Lingtai cannot yet satisfy and says so.
 *
 * A double-quoted value is JSON, which makes this the exact inverse of
 * `renderEnvFile` and means an embedded newline survives a round trip.
 */
export function parseEnvFile(text: string): EnvFile {
  const values: Record<string, string> = {};
  const commands: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    const raw = trimmed.slice(eq + 1).trim();
    if (name === "") continue;

    if (raw.startsWith("!")) {
      commands[name] = raw.slice(1).trim();
      continue;
    }
    if (raw.startsWith('"')) {
      try {
        values[name] = JSON.parse(raw) as string;
        continue;
      } catch {
        // Not JSON after all. Fall through and take it literally rather than
        // dropping the line — a value nobody can see is worse than a quoted one.
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      values[name] = raw.slice(1, -1);
      continue;
    }
    values[name] = raw;
  }

  return { values, commands };
}

// --------------------------------------------------- the merged environment ---

/** Where a declared name's value came from. Names only — never values. */
export type EnvLayer = "process env" | "project file" | "not set";

export interface AgentEnvName {
  name: string;
  layer: EnvLayer;
}

export interface AgentEnv {
  /** Layers 2 and 3, merged. Layer 1 is added by `runnableEnv` at each call site. */
  values: Record<string, string>;
  /** Every declared name and which layer answered for it, in the recipe's order. */
  names: AgentEnvName[];
  /** Declared names no layer supplied. */
  missing: string[];
  /** Declared names layer 2 refused as Lingtai's own. See `RESERVED`. */
  reserved: string[];
  /** Declared names whose file value asks for the unbuilt layer 4. */
  deferred: string[];
  /** The per-project file, whether or not it exists. */
  file: string;
  /**
   * Why this project cannot run, or null.
   *
   * One string rather than three lists to inspect: every caller's correct
   * response is the same — refuse the project before anything is claimed — and
   * a caller that had to assemble the sentence itself would assemble a different
   * one at each of the three places this is asked.
   */
  refusal: string | null;
}

/**
 * The environment an agent may see, merged from the layers, and the refusal
 * when it cannot be completed.
 *
 * Layer 3 wins over layer 2, so one project can differ from the machine. What
 * this does *not* do is run anything or claim anything: it is a function of the
 * recipe, the process environment and one file, which is what lets
 * `lingtai doctor` ask the same question for free.
 */
export async function resolveAgentEnv(options: {
  project: string;
  /** `env.required` — what the run cannot proceed without. */
  required: readonly string[];
  source?: NodeJS.ProcessEnv;
  home?: string;
  patterns?: readonly string[];
}): Promise<AgentEnv> {
  const patterns = options.patterns ?? DEFAULT_PRODUCTION_PATTERNS;
  const file = projectEnvPath(options.project, options.home ?? stateDir());
  const fromProcess = filterEnv(options.required, options.source ?? process.env, patterns);

  let parsed: EnvFile = { values: {}, commands: {} };
  try {
    parsed = parseEnvFile(await readFile(file, "utf8"));
  } catch {
    // No file is the ordinary case for a project whose values are all on the
    // machine. An unreadable one is reported by the names it fails to supply.
  }

  const values = { ...fromProcess.values };
  const fromFile = new Set<string>();
  const deferred: string[] = [];
  for (const name of options.required) {
    if (parsed.commands[name] !== undefined) {
      deferred.push(name);
      continue;
    }
    const value = parsed.values[name];
    if (value === undefined || value === "") continue;
    guardProduction(name, value, patterns);
    values[name] = value;
    fromFile.add(name);
  }

  const names: AgentEnvName[] = options.required.map((name) => ({
    name,
    layer: fromFile.has(name) ? "project file" : name in values ? "process env" : "not set",
  }));
  const missing = options.required.filter((name) => !(name in values));

  return {
    values,
    names,
    missing,
    reserved: fromProcess.reserved,
    deferred,
    file,
    refusal: refusalFor(missing, fromProcess.reserved, deferred, file),
  };
}

function refusalFor(
  missing: readonly string[],
  reserved: readonly string[],
  deferred: readonly string[],
  file: string,
): string | null {
  if (missing.length === 0) return null;
  const isReservedName = new Set(reserved);
  const isDeferredName = new Set(deferred);

  const lines = [
    `env: ${missing.join(", ")} declared in env.required and not set in any layer. ` +
      `Nothing was claimed and no agent was started.`,
  ];

  const ordinary = missing.filter((n) => !isReservedName.has(n) && !isDeferredName.has(n));
  if (ordinary.length > 0) {
    lines.push(
      `  ${ordinary.join(", ")}: set in this process's environment, or write ` +
        `${file} — one NAME=value per line.`,
    );
  }
  const blocked = missing.filter((n) => isReservedName.has(n));
  if (blocked.length > 0) {
    lines.push(
      `  ${blocked.join(", ")}: reserved (${RESERVED.join(", ")}) — Lingtai's own credentials never ` +
        `come from the process environment however a recipe declares them. Only ${file} can supply them.`,
    );
  }
  const asked = missing.filter((n) => isDeferredName.has(n));
  if (asked.length > 0) {
    lines.push(
      `  ${asked.join(", ")}: ${file} asks for a secret source (a "!" value), which is not built yet. ` +
        `Write the value, or quote it to mean it literally.`,
    );
  }
  return lines.join("\n");
}

/** `.env`-file text. Values are quoted so a `#` or a space cannot truncate one. */
export function renderEnvFile(values: Record<string, string>): string {
  const lines = [
    "# Written by Lingtai for one run. Not committed, not inherited —",
    "# only the names the recipe's env.required lists.",
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
