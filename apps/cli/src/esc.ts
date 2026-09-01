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
import { boardProjection, queueProjection, taskViewProjection } from "@escapement/conductor";
import { add } from "./add.ts";
import { approveCommand } from "./approve.ts";
import { formatReport, runDoctor } from "./doctor.ts";
import { run as runOnceCommand } from "./run.ts";
import { status } from "./status.ts";

/** Every projection the runner knows how to advance, by `checkpoints.name`. */
const PROJECTIONS: Record<string, Projection> = {
  [taskViewProjection.name]: taskViewProjection,
  [boardProjection.name]: boardProjection,
  [guardTripsProjection.name]: guardTripsProjection,
  [queueProjection.name]: queueProjection,
};

const USAGE = `esc — event-sourced scheduler for autonomous code agents

  esc add <owner>/<repo>        onboard a repository the App is installed on
    --base <branch>             default: the repository's own default branch
    --tier open|guarded|sandboxed
    --require <gate,gate>       gates the recipe may not remove
  esc run <project>             take the queue, in the recipe's priority order
    --issue <n>                 one nominated issue instead of the queue
    --max <n>                   stop after n items (--max 2 is Phase 2's bar)
    --once                      the same as --max 1
    --no-merge                  stop after the gates and ask before merging
    --no-guard                  wire no hooks; nothing mediates a tool call
  esc approve <project> --issue <n>
                                merge what a held run produced, if its head has
                                not moved since the approval was asked for
    --note <text>               recorded with the approval
    --reject <why>              withdraw instead: back to the gate, not merged
  esc status [project]          what is runnable, and what is holding the rest
    --all                       include items that have left the queue
  esc doctor                    check everything that can be checked
  esc projection run            follow the log and keep every projection current
  esc projection lag            how far each projection is behind the log
  esc projection rebuild <name> drop the table, reset the checkpoint, replay
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

/**
 * `--flag value` pairs plus positionals. Enough for three commands.
 *
 * A flag whose next token is another flag, or which ends the line, is a boolean
 * and consumes nothing. Without that rule `--no-merge --no-guard` parsed as
 * `no-merge: "--no-guard"` and swallowed the second flag whole, so the guard
 * stayed on while the command line said to turn it off — a flag that reads as
 * ignored is the one kind that is worse than a flag that errors.
 */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[a.slice(2)] = "";
      } else {
        flags[a.slice(2)] = next;
        i++;
      }
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
      // Drop the table, reset the checkpoint, replay. This is what makes a
      // projection's shape free to change: a rebuild, not a migration.
      await runner.rebuild();
      const lag = await runner.lag();
      console.log(`${name} rebuilt — at ${lag.lastSeq}/${lag.headSeq}, ${lag.lag} behind`);
      return lag.lag === 0n ? 0 : 1;
    } finally {
      await runner.close();
    }
  }

  if (sub === "run") return followProjections();

  console.error(USAGE);
  return 2;
}

/**
 * Hold every projection open and follow the log until told to stop.
 *
 * The runner already knew how to do this — `start()` creates the tables,
 * catches up and then follows. What was missing was a *process* to hold them,
 * so in practice nothing ever advanced a projection: `esc run` appended events,
 * the board's SSE dutifully re-read on every notify, and what it re-read was a
 * table that had not moved since the last manual `rebuild`. Two work items
 * merged into `develop` for real while their cards sat in "waiting on you",
 * which reads as "the button did nothing" and is the worst way to be wrong —
 * the system was right and only its account of itself was stale.
 *
 * No timer. Postgres notifies on append, and `subscribe` resumes from the
 * checkpoint, so a process that was asleep or dead catches up on the way back
 * rather than skipping what it missed.
 *
 * A projection whose handler throws stops with its checkpoint intact, and this
 * exits rather than carrying on with the others. Serving three-quarters of a
 * board is how you get a board nobody can trust: the failure has to be as
 * visible as the thing it broke.
 */
async function followProjections(): Promise<number> {
  const names = Object.keys(PROJECTIONS);
  if (names.length === 0) {
    console.error("no projections registered");
    return 2;
  }

  let stopping = false;
  // A holder rather than a bare `let`: the only assignment is inside a callback,
  // which the compiler cannot see, so it narrows the variable to `null` and then
  // rejects reading it after the await.
  const outcome: { failed: { name: string; error: unknown } | null } = { failed: null };
  const runners = names.map((name) =>
    createProjectionRunner({
      projection: PROJECTIONS[name]!,
      onError: (error, phase) => {
        // A connection error retries inside `subscribe`; a handler error has
        // already stopped that runner.
        if (phase !== "handler") return;
        outcome.failed ??= { name, error };
        stop();
      },
    }),
  );

  let release: () => void = () => {};
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });

  function stop(): void {
    if (stopping) return;
    stopping = true;
    release();
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    for (const runner of runners) {
      await runner.start();
      const lag = await runner.lag();
      console.log(`${runner.name}\tfollowing at ${lag.lastSeq}/${lag.headSeq}`);
    }
    console.log(`following ${runners.length} projection(s) — ctrl-c to stop`);
    await until;
  } finally {
    for (const runner of runners) {
      await runner.stop().catch(() => {});
      await runner.close().catch(() => {});
    }
  }

  if (outcome.failed) {
    console.error(`${outcome.failed.name} stopped: ${String(outcome.failed.error)}`);
    return 1;
  }
  console.log("stopped");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "add":
      return addCommand(rest);
    case "run": {
      const { flags } = parseFlags(rest);
      const positional = rest.filter(
        (a) => !a.startsWith("--") && a !== flags["issue"] && a !== flags["max"],
      );
      const project = positional.find((p) => p !== "--once") ?? flags["project"];
      if (!project) {
        console.error("esc run <project> [--issue <n>] [--max <n>] [--no-merge] [--no-guard]");
        return 2;
      }

      // `--once` with no `--issue` used to be the only mode. It now means the
      // same as `--max 1`: take the queue, but stop after one.
      const issue = "issue" in flags ? Number(flags["issue"]) : undefined;
      if (issue !== undefined && !Number.isInteger(issue)) {
        console.error("--issue takes a number");
        return 2;
      }
      const max =
        "max" in flags ? Number(flags["max"]) : "once" in flags && issue === undefined ? 1 : undefined;
      if (max !== undefined && (!Number.isInteger(max) || max < 1)) {
        console.error("--max takes a positive number");
        return 2;
      }

      return runOnceCommand({
        project,
        ...(issue === undefined ? {} : { issue }),
        ...(max === undefined ? {} : { max }),
        // `--no-merge` is absence of merging, so the flag's presence is the
        // whole signal. Same shape for `--no-guard`.
        merge: !("no-merge" in flags),
        guard: !("no-guard" in flags),
      });
    }
    case "approve": {
      const { positional, flags } = parseFlags(rest);
      const issue = Number(flags["issue"]);
      if (!positional[0] || !Number.isInteger(issue)) {
        console.error("esc approve <project> --issue <n> [--note <text>]");
        return 2;
      }
      return approveCommand({
        project: positional[0],
        issue,
        note: flags["note"],
        ...("reject" in flags ? { reject: flags["reject"] ?? "no reason given" } : {}),
      });
    }
    case "status": {
      const { positional, flags } = parseFlags(rest);
      return status({ project: positional[0], all: "all" in flags });
    }
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

/**
 * Every ending is a sentence, not a stack trace.
 *
 * The commands report their own refusals and return an exit code, but anything
 * that *throws* went straight to Node — which printed a stack, a file path and
 * a version banner over the one line that mattered. `esc add` against a
 * repository whose default branch has no recipe did exactly that, and the
 * README's claim that "every refusal names itself" was false for it.
 *
 * The stack is still there for the errors that are bugs rather than refusals;
 * it just has to be asked for.
 */
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  const error = err as Error;
  console.error(error.message || String(err));
  if (process.env["ESCAPEMENT_DEBUG"]) console.error(error.stack);
  else console.error("\n(ESCAPEMENT_DEBUG=1 for the stack)");
  process.exitCode = 1;
}
