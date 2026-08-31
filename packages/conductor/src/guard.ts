/**
 * The guard: what an agent's tool call is allowed to be.
 *
 * **This is not a security boundary, and saying so is load-bearing.** Both
 * runtimes' `PreToolUse` does command pattern matching, and a model can write a
 * script and execute it to step around a pattern — Codex's own documentation
 * says so. The old loop's README claimed its guard hook was "the only layer that
 * holds regardless of what an issue body says", and that was overstated. The
 * real boundaries are three: a **filtered environment** (the agent never holds a
 * production credential), an **isolated worktree** (that directory is the blast
 * radius), and a **runtime sandbox** where one exists. See
 * doc/decisions/0007-dual-runtime.md.
 *
 * What this *is* is policy enforcement and total observability. 132 blocks fired
 * across 56 of 73 runs of the old loop — 77% of runs — and every one went to
 * stderr inside a log nobody parsed. Not one pattern was ever tuned, because
 * there was no way to know which were firing or whether they were right to.
 * Every decision here is a `GuardTripped` on the run's stream, and
 * `guard_trips` is the projection that makes the tuning possible.
 *
 * Rules are data. Each carries why it exists, so a trip on the board explains
 * itself and a false positive can be argued with.
 */

export interface ToolCall {
  /** `Bash`, `Read`, `Write`, `Edit`, … as the runtime names it. */
  tool: string;
  /** The runtime's tool input, normalised to an object. */
  input: Record<string, unknown>;
}

export type GuardVerdict =
  | { allow: true }
  | { allow: false; rule: string; why: string; redacted: string };

export interface GuardPolicy {
  /** The base branch. Pushing straight to it is the integrator's job, not the agent's. */
  base: string;
  /** Host substrings that mean production. Same list the env tripwire uses. */
  productionPatterns: readonly string[];
  /** Extra denials from the project, added to — never replacing — these. */
  deny?: readonly { name: string; pattern: string; why: string }[];
}

/**
 * Whether a host is a production one, by **segment** rather than by substring.
 *
 * Substring matching looked right and was not: `reproducible.dev.example.com`
 * contains "prod", and a tripwire that refuses a development host trains people
 * to turn it off. The host is split on `.` and `-` and a segment has to match
 * outright — `db.prod.example.com` and `prod-db.example.com` both do,
 * `reproducible.dev.example.com` does not.
 *
 * Shared with the environment tripwire so the two cannot drift apart.
 */
export function hostLooksProduction(host: string, patterns: readonly string[]): string | null {
  const segments = host.toLowerCase().split(/[.\-]/);
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (segments.includes(p)) return pattern;
  }
  return null;
}

/** The command text of a call, whatever the runtime called the field. */
function commandOf(call: ToolCall): string {
  const c = call.input["command"] ?? call.input["cmd"] ?? "";
  return typeof c === "string" ? c : "";
}

/** The path a file tool is aimed at. */
function pathOf(call: ToolCall): string {
  const p = call.input["file_path"] ?? call.input["path"] ?? call.input["notebook_path"] ?? "";
  return typeof p === "string" ? p : "";
}

/**
 * A command with anything secret-shaped removed.
 *
 * What trips the guard is frequently the thing worth not storing — a connection
 * string, a token pasted into a psql invocation. The event records the shape of
 * what happened, never the value.
 */
export function redact(command: string): string {
  return command
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s"']*@/gi, "$1***@")
    .replace(/\b(sk|pk|ghp|ghs|gho|github_pat)_[A-Za-z0-9_]{8,}/g, "$1_***")
    .replace(/(-{1,2}(?:password|token|secret|key)[= ])\S+/gi, "$1***")
    .replace(/\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Za-z0-9_]*=\S+/g, (m) =>
      `${m.split("=")[0]}=***`,
    )
    .slice(0, 500);
}

interface Rule {
  name: string;
  why: string;
  /** Returns true when this call must be refused. */
  matches(call: ToolCall, policy: GuardPolicy): boolean;
}

export const RULES: Rule[] = [
  {
    name: "production-host",
    why: "an agent must never reach a production host; the filtered env is the real boundary, this is the tripwire",
    matches(call, policy) {
      const text = `${commandOf(call)} ${pathOf(call)}`;
      // Hosts only, for the same reason the env tripwire matches hosts: a
      // password containing "prod" is not a production database.
      for (const m of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi)) {
        try {
          if (hostLooksProduction(new URL(m[0]).hostname, policy.productionPatterns)) return true;
        } catch {
          // Not a URL after all.
        }
      }
      return false;
    },
  },
  {
    name: "executed-ddl",
    why: "schema changes belong in a reviewed migration file, not in a command; #117 was a migration applied by hand",
    matches(call) {
      const c = commandOf(call);
      // Only *executed* SQL. Writing DDL into a migration file is the correct
      // way to change a schema and must stay allowed — see the Write rules.
      if (!/\b(psql|prisma\s+db\s+execute|mysql|sqlite3)\b/i.test(c)) return false;
      return /\b(drop|alter|truncate)\s+(table|schema|database|type|column)\b/i.test(c);
    },
  },
  {
    name: "db-push",
    why: "`prisma db push` changes a schema with no migration and no review",
    matches(call) {
      return /\bprisma\b[\s\S]*\bdb\s+push\b/i.test(commandOf(call));
    },
  },
  {
    name: "pr-merge",
    why: "merging is the integrator's job, under the merge lane's advisory lock",
    matches(call) {
      return /\bgh\b[\s\S]*\bpr\s+merge\b/i.test(commandOf(call));
    },
  },
  {
    name: "push-to-base",
    why: "the agent pushes agent/*; the base branch is only ever written by the integrator",
    matches(call, policy) {
      const c = commandOf(call);
      if (!/\bgit\b[\s\S]*\bpush\b/i.test(c)) return false;
      const base = policy.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[\\s:])(HEAD:)?(refs/heads/)?${base}([\\s:]|$)`, "i").test(c);
    },
  },
  {
    name: "force-push",
    why: "a force-push rewrites history other verdicts were made against",
    matches(call) {
      const c = commandOf(call);
      if (!/\bgit\b[\s\S]*\bpush\b/i.test(c)) return false;
      return /(--force(-with-lease)?|\s-f\b|\s\+[\w/]+:)/i.test(c);
    },
  },
  {
    name: "recursive-delete",
    why: "`rm -rf` on a path the worktree does not own is unrecoverable",
    matches(call) {
      return /\brm\b[^\n]*\s-[a-z]*r[a-z]*f|\brm\b[^\n]*\s-[a-z]*f[a-z]*r/i.test(commandOf(call));
    },
  },
  {
    name: "read-dotenv",
    why: "`.env` holds values the agent is deliberately not given; `.env.local` is the one it is",
    matches(call) {
      const path = pathOf(call);
      const command = commandOf(call);
      const target = path || command;
      if (!target) return false;
      // `.env.local` is what the conductor plants, and reading it is the point.
      // Anything else in the family is not.
      return /(^|[\s"'/])\.env(\.(production|prod|staging))?([\s"']|$)/i.test(target);
    },
  },
];

/**
 * Allow-list overrides, checked before the rules.
 *
 * These exist because a pattern that is right 95% of the time still has to let
 * the ordinary case through, and the ordinary case here is *writing a
 * migration*, which contains exactly the DDL the `executed-ddl` rule looks for.
 */
function explicitlyAllowed(call: ToolCall): boolean {
  const path = pathOf(call);
  if (path && /(^|\/)(prisma\/)?migrations?\//i.test(path)) return true;
  if (path && /(^|\/)\.env\.local$/i.test(path)) return true;
  return false;
}

export function evaluate(call: ToolCall, policy: GuardPolicy): GuardVerdict {
  if (explicitlyAllowed(call)) return { allow: true };

  for (const rule of RULES) {
    if (rule.matches(call, policy)) {
      return {
        allow: false,
        rule: rule.name,
        why: rule.why,
        redacted: redact(commandOf(call) || pathOf(call)),
      };
    }
  }

  for (const extra of policy.deny ?? []) {
    const text = `${commandOf(call)} ${pathOf(call)}`;
    if (new RegExp(extra.pattern, "i").test(text)) {
      return { allow: false, rule: extra.name, why: extra.why, redacted: redact(text) };
    }
  }

  return { allow: true };
}
