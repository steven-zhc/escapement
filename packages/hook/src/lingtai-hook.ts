#!/usr/bin/env node
/**
 * `lingtai-hook` — the only hot path in the system.
 *
 * `PreToolUse` sits in front of every tool call an agent makes: tens of
 * thousands across a run. So this is a **thin client** and nothing else. It
 * reads JSON on stdin, sends one line to a unix socket, reads one line back, and
 * exits. No dependencies, no configuration parsing, no policy. Policy evaluation
 * and event persistence live in the long-running conductor, where they cost
 * nothing per call (doc/decisions/0002-typescript.md).
 *
 * **It fails closed.** Socket unreachable, timeout, unparseable payload,
 * malformed reply — every one of them exits 2, which both runtimes read as
 * "refuse this tool call". A guard that fails open is worse than no guard,
 * because it is trusted. The conductor proves this path with a smoke test at
 * startup and refuses to start if the binary does not deny when the socket is
 * gone.
 *
 * Exit codes are the contract:
 *   0  allow
 *   2  deny — the reason goes to stderr, which the runtime shows the agent
 */
import { connect } from "node:net";

/** A hook that has not answered in this long is a hook that failed. */
const TIMEOUT_MS = Number(process.env["ESC_HOOK_TIMEOUT_MS"] ?? 2_000);

const DENY = 2;
const ALLOW = 0;

function deny(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(DENY);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    // A runtime that opens the hook and never writes is a hang, not an allow.
    setTimeout(() => resolve(data), TIMEOUT_MS).unref?.();
  });
}

interface Reply {
  allow?: boolean;
  reason?: string;
}

async function ask(socketPath: string, line: string): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer from the conductor in ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    socket.on("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Reply);
      } catch {
        reject(new Error("the conductor's reply was not JSON"));
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      reject(new Error("the conductor closed the connection without answering"));
    });
  });
}

const socketPath = process.env["ESC_HOOK_SOCKET"];
const runId = process.env["ESC_RUN_ID"];
if (!socketPath || !runId) {
  // The conductor renders this configuration itself, outside the worktree, so
  // its absence means the wiring is wrong rather than that this run is exempt.
  deny("lingtai-hook: ESC_HOOK_SOCKET and ESC_RUN_ID are not set — refusing to allow anything");
}

const raw = await readStdin();
let payload: unknown;
try {
  payload = JSON.parse(raw || "{}");
} catch {
  deny("lingtai-hook: could not parse the hook payload");
}

let reply: Reply;
try {
  reply = await ask(socketPath, JSON.stringify({ runId, payload }));
} catch (err) {
  deny(`lingtai-hook: ${(err as Error).message}`);
}

if (reply.allow === true) process.exit(ALLOW);
deny(reply.reason ?? "lingtai-hook: refused by policy");
