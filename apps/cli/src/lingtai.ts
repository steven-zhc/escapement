#!/usr/bin/env node
/**
 * `lingtai` — the entry point.
 *
 * Deliberately hand-rolled argument parsing. design.md §8 is a list of things
 * not being built until a specific failure demands them, and a dependency for
 * three subcommands is exactly the kind of thing it is warning about.
 *
 * Everything here loads `@lingtai/store`, which loads the environment from
 * the repository root — see `packages/store/src/env.ts`. Never read
 * `process.env` for a connection string directly.
 */
import {
  createProjectionRunner,
  databaseUrl,
  directDatabaseUrl,
  projectionLag,
} from "@lingtai/store";
import type { Tier } from "@lingtai/core";
import {
  HEARTBEAT_MS,
  beat,
  createStatusTable,
  createNotifier,
  createWorkLoop,
  deliverOutbox,
  macNotifier,
  pauseConductor,
  readControl,
  reconcile,
  requestRun,
  resumeConductor,
  startDaemon,
} from "@lingtai/daemon";
import { conductorPass, deliverer } from "./conduct.ts";
import { add } from "./add.ts";
import { approveCommand } from "./approve.ts";
import { formatReport, runDoctor } from "./doctor.ts";
import { PROJECTIONS } from "./projections.ts";
import { run as runOnceCommand } from "./run.ts";
import { status } from "./status.ts";

const USAGE = `lingtai — event-sourced scheduler for autonomous code agents

  lingtai add <owner>/<repo>        onboard a repository the App is installed on
    --base <branch>             default: the repository's own default branch
  lingtai run <project>             take the queue, in the recipe's priority order
    --issue <n>                 one nominated issue instead of the queue
    --max <n>                   stop after n items (--max 2 is Phase 2's bar)
    --once                      the same as --max 1
    --no-merge                  stop after the gates and ask before merging
    lingtai approve <project> --issue <n>
                                merge what a held run produced, if its head has
                                not moved since the approval was asked for
    --note <text>               recorded with the approval
    --reject <why>              withdraw instead: back to the gate, not merged
  lingtai status [project]          what is runnable, and what is holding the rest
    --all                       include items that have left the queue
    --refresh                   ask GitHub first, and say what it passed over
                                and why. Takes nothing and claims nothing.
  lingtai doctor                    check everything that can be checked
  lingtai daemon                    hold the projections current and take work
    --no-conduct                projections only, take nothing
    --no-merge                  as for lingtai run
  lingtai pause <why>               stop taking new work; a run in flight finishes
  lingtai resume                    take work again
  lingtai now <project> --issue <n> ask for one ahead of the queue
  lingtai projection run            the same thing, kept as an alias
  lingtai projection lag            how far each projection is behind the log
  lingtai projection rebuild <name> drop the table, reset the checkpoint, replay
  lingtai help
  lingtai version

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
 * and consumes nothing. Without that rule `--no-merge --no-conduct` parsed as
 * `no-merge: "--no-conduct"` and swallowed the second flag whole, so the second
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
    console.error("lingtai add <owner>/<repo>");
    return 2;
  }
  // Tier and gates are the recipe's, in the managed repository, which is why
  // this takes a slug and a branch and nothing else.
  return add({ slug, base: flags["base"] });
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
      console.error("lingtai projection rebuild <name>");
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

  // Kept as an alias: following projections is what the daemon does, and two
  // ways to say it is one more than the number of things it is.
  if (sub === "run") return daemonCommand();

  console.error(USAGE);
  return 2;
}

/**
 * `lingtai daemon` — the process that holds the long-lived work.
 *
 * The follower used to live in this file, which meant nothing held it unless
 * somebody kept a terminal open. It is in `@lingtai/daemon` now, behind one
 * advisory lock, so this is the command and not the mechanism.
 *
 * Losing the lock exits 0. Running this while launchd's copy is up is a
 * reasonable thing to do, and answering it with an error would teach people to
 * ignore errors.
 */
async function daemonCommand(flags: Record<string, string> = {}): Promise<number> {
  const started = await startDaemon({
    projections: Object.values(PROJECTIONS),
    log: (line) => console.log(line),
  });

  if (!started.ok) {
    console.log(`another daemon holds the lock${started.holder ? ` (${started.holder})` : ""} — nothing to do`);
    return 0;
  }

  // The beacon. One timer in the whole system, and it decides nothing — it
  // says "still here", which is the difference between a board that is behind
  // and a board that is broken. Two work items merged for real while their
  // cards sat still and nothing reported it; this is what makes that a glance.
  await createStatusTable();
  await beat("starting");

  // Before anything is taken. A worktree left by a killed daemon is holding a
  // branch checked out, which stops git updating that ref on the next attempt —
  // so the tidy-up has to happen before the next attempt, not after it fails.
  const found = await reconcile({ log: (line) => console.log(line) }).catch((err: unknown) => {
    // Reported, never fatal. Refusing to start because a directory could not be
    // removed would turn a mess into an outage.
    console.error(`reconcile failed: ${(err as Error).message}`);
    return [];
  });
  if (found.length > 0) console.log(`reconciled ${found.length} divergence(s)`);
  const heartbeat = setInterval(() => {
    void beat("up").catch(() => {});
  }, HEARTBEAT_MS);

  // Taking work is the default now that there is a way to stop it (#45).
  // `--no-conduct` is for a daemon you want keeping the board current while
  // you work on something else.
  let loop: ReturnType<typeof createWorkLoop> | null = null;
  if (!("no-conduct" in flags)) {
    // Tell the operator when the operator is the bottleneck. Fire and forget:
    // a notification retried later, about a decision already made, trains you
    // to ignore the next one.
    const channel = await macNotifier();
    const notifier = createNotifier({ channel, log: (line) => console.log(line) });
    console.log(
      `notifications via ${channel.name}` +
        (channel.clickable ? "" : " — install terminal-notifier to make them clickable"),
    );

    loop = createWorkLoop({
      log: (line) => console.log(line),
      notify: (event) => notifier.consider(event),
      // Asked from the log every pass. A pause issued while a run is in flight
      // has to land at the next opportunity without anybody restarting this.
      paused: async () => (await readControl()).paused,
      // A pause stops taking work, never delivering what already happened.
      // Same deliverer, no conductor pass: `conductorPass({ max: 0 })` builds
      // the per-project clients and takes nothing.
      drain: async () => {
        const idle = await conductorPass({ max: 0, log: () => {} });
        const sent = await deliverOutbox({
          deliverer: deliverer(idle.clients),
          log: (line) => console.log(line),
        });
        if (sent.delivered > 0) console.log(`paused — ${sent.delivered} delivered anyway`);
      },

      pass: async (reason) => {
        const outcome = await conductorPass({
          merge: !("no-merge" in flags),
          log: (line) => console.log(line),
        });
        // After the run, in the same pass. A comment saying "waiting on you"
        // is only useful if it goes out near the moment it became true, and
        // the pass is the only thing that knows a client for each project.
        const sent = await deliverOutbox({
          deliverer: deliverer(outcome.clients),
          log: (line) => console.log(line),
        }).catch((err: unknown) => {
          // Never fatal. A delivery that cannot go out must not stop work from
          // being taken — the row stays pending and the next pass tries again.
          console.error(`outbox: ${(err as Error).message}`);
          return { delivered: 0, failed: 0 };
        });

        console.log(
          `pass (${reason}): ${outcome.projects} project(s), ${outcome.ran} run(s)` +
            (outcome.refused.length > 0 ? `, ${outcome.refused.length} refused` : "") +
            (sent.delivered + sent.failed > 0 ? `, ${sent.delivered} sent` : ""),
        );
      },
    });
    const control = await readControl();
    if (control.paused) console.log(`paused by ${control.by} — ${control.reason}`);
    await loop.start();
  } else {
    console.log("projections only — no work will be taken");
  }

  const stop = () => {
    clearInterval(heartbeat);
    void beat("stopping").catch(() => {});
    void loop?.stop();
    started.daemon.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const reason = await started.daemon.stopped;
  if (reason === "projection-failed") {
    const failed = started.daemon.failure;
    console.error(`stopped: ${failed?.projection} failed — ${String(failed?.error)}`);
    return 1;
  }
  console.log("stopped");
  return 0;
}

/**
 * `lingtai pause` / `lingtai resume` / `lingtai now` — the operator's controls.
 *
 * They append and return. The daemon is listening, so a pause takes effect at
 * its next opportunity; if it is down, the command is waiting when it comes
 * back rather than being a race somebody has to handle.
 */
async function controlCommand(verb: "pause" | "resume" | "now", args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const by = `human:${process.env["USER"] ?? "operator"}`;

  if (verb === "pause") {
    const reason = flags["reason"] ?? positional.join(" ");
    if (!reason.trim()) {
      // A pause with no reason is one nobody can undo confidently, because
      // nobody can tell whether the thing it was waiting for has happened.
      console.error("lingtai pause <why>  — a pause needs a reason");
      return 2;
    }
    await pauseConductor(by, reason);
    console.log(`paused by ${by} — ${reason}`);
    return 0;
  }

  if (verb === "resume") {
    await resumeConductor(by);
    console.log(`resumed by ${by}`);
    return 0;
  }

  const project = positional[0];
  const issue = flags["issue"] ?? positional[1];
  if (!project || !issue) {
    console.error("lingtai now <project> --issue <n>");
    return 2;
  }
  await requestRun(project, issue, by);
  console.log(`requested ${project} #${issue}`);
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
        console.error("lingtai run <project> [--issue <n>] [--max <n>] [--no-merge]");
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
              merge: !("no-merge" in flags),
      });
    }
    case "approve": {
      const { positional, flags } = parseFlags(rest);
      const issue = Number(flags["issue"]);
      if (!positional[0] || !Number.isInteger(issue)) {
        console.error("lingtai approve <project> --issue <n> [--note <text>]");
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
      return status({ project: positional[0], all: "all" in flags, refresh: "refresh" in flags });
    }
    case "doctor":
      return doctor();
    case "daemon":
      return daemonCommand(parseFlags(rest).flags);
    case "pause":
      return controlCommand("pause", rest);
    case "resume":
      return controlCommand("resume", rest);
    case "now":
      return controlCommand("now", rest);
    case "projection":
      return projectionCommand(rest);
    case "version":
      console.log("lingtai 0.0.0");
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
 * a version banner over the one line that mattered. `lingtai add` against a
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
  if (process.env["LINGTAI_DEBUG"]) console.error(error.stack);
  else console.error("\n(LINGTAI_DEBUG=1 for the stack)");
  process.exitCode = 1;
}
