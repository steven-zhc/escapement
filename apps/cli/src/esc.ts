#!/usr/bin/env node
/**
 * `esc` — the entry point.
 *
 * Deliberately hand-rolled argument parsing. design.md §8 is a list of things
 * not being built until a specific failure demands them, and a dependency for
 * three subcommands is exactly the kind of thing it is warning about.
 *
 * Everything here loads `@escapement/store`, which loads the environment from
 * the repository root — see `packages/store/src/env.ts`. Never read
 * `process.env` for a connection string directly.
 */
import {
  createProjectionRunner,
  databaseUrl,
  directDatabaseUrl,
  guardTripsProjection,
  projectionLag,
  type Projection,
} from "@escapement/store";
import type { Tier } from "@escapement/core";
import { add } from "./add.ts";
import { formatReport, runDoctor } from "./doctor.ts";

/** Every projection the runner knows how to advance, by `checkpoints.name`. */
const PROJECTIONS: Record<string, Projection> = {
  [guardTripsProjection.name]: guardTripsProjection,
};

const USAGE = `esc — event-sourced scheduler for autonomous code agents

  esc add <owner>/<repo>        onboard a repository the App is installed on
    --base <branch>             default: the repository's own default branch
    --tier open|guarded|sandboxed
    --require <gate,gate>       gates the recipe may not remove
  esc doctor                    check everything that can be checked
  esc projection lag            how far each projection is behind the log
  esc projection rebuild <name> truncate, reset the checkpoint, replay
  esc help
  esc version

Projections: ${Object.keys(PROJECTIONS).join(", ") || "(none)"}
`;

async function doctor(): Promise<number> {
  // Touching the loaders here rather than reading process.env keeps the one rule
  // about environment loading true even in the command that inspects it.
  const env = { ...process.env };
  try {
    env["DATABASE_URL"] = databaseUrl();
  } catch {
    delete env["DATABASE_URL"];
  }
  try {
    env["DIRECT_DATABASE_URL"] = directDatabaseUrl();
  } catch {
    delete env["DIRECT_DATABASE_URL"];
  }

  const report = await runDoctor(env);
  console.log(formatReport(report));
  // Non-zero on any failure, so this can gate a restart. A deferred check is not
  // a failure; a missing one would be.
  return report.failed === 0 ? 0 : 1;
}

/** `--flag value` pairs plus positionals. Enough for three commands. */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      flags[a.slice(2)] = args[i + 1] ?? "";
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function addCommand(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const slug = positional[0];
  if (!slug) {
    console.error("esc add <owner>/<repo>");
    return 2;
  }
  const raw = flags["tier"];
  if (raw !== undefined && raw !== "open" && raw !== "guarded" && raw !== "sandboxed") {
    console.error(`--tier must be open, guarded or sandboxed (got "${raw}")`);
    return 2;
  }
  const tier: Tier | undefined = raw;
  return add({
    slug,
    base: flags["base"],
    tier,
    require: flags["require"] ? flags["require"].split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    approvers: flags["approver"] ? [flags["approver"]] : undefined,
  });
}

async function projectionCommand(args: string[]): Promise<number> {
  const [sub, name] = args;

  if (sub === "lag") {
    const lags = await projectionLag();
    if (lags.length === 0) {
      console.log("no projection has a checkpoint yet");
      return 0;
    }
    for (const l of lags) {
      console.log(`${l.name}\t${l.lastSeq}/${l.headSeq}\t${l.lag} behind\t${l.updatedAt?.toISOString() ?? "never"}`);
    }
    return 0;
  }

  if (sub === "rebuild") {
    if (!name) {
      console.error("esc projection rebuild <name>");
      return 2;
    }
    const projection = PROJECTIONS[name];
    if (!projection) {
      console.error(`unknown projection "${name}" — known: ${Object.keys(PROJECTIONS).join(", ")}`);
      return 2;
    }
    const runner = createProjectionRunner({ projection });
    try {
      // Truncate, reset the checkpoint, replay. This is what makes a
      // projection's shape free to change: a rebuild, not a migration.
      await runner.rebuild();
      const lag = await runner.lag();
      console.log(`${name} rebuilt — at ${lag.lastSeq}/${lag.headSeq}, ${lag.lag} behind`);
      return lag.lag === 0n ? 0 : 1;
    } finally {
      await runner.close();
    }
  }

  console.error(USAGE);
  return 2;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "add":
      return addCommand(rest);
    case "doctor":
      return doctor();
    case "projection":
      return projectionCommand(rest);
    case "version":
      console.log("esc 0.0.0");
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return command === undefined ? 2 : 0;
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
