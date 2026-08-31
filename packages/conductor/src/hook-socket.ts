/**
 * The conductor's end of the hook channel.
 *
 * A hook is usually thought of as a guard. It is better understood as **the only
 * channel through which the outside world reports facts to the event log** — and
 * the same round trip carries the verdict back. One socket, both directions.
 *
 * Three rules hold the hot path, and each is a way to make an agent slow or an
 * outage worse:
 *
 * **The verdict is synchronous; persistence is not.** An allowed call is counted
 * in memory and answered immediately. *The event store's availability must never
 * gate an agent's tool call* — a database blip would otherwise stall every tool
 * use in every run. Only a denial persists before answering, and by then the
 * decision is already made, so a slow store delays only a call that was going to
 * be refused.
 *
 * **It answers from memory.** Policy is resolved once when the run is
 * registered. No read, no parse, no allocation beyond the reply.
 *
 * **A run it does not know is denied.** The socket is per-conductor, not
 * per-run, and a request carrying an unknown run id is a misconfiguration rather
 * than a permission.
 */
import { type PayloadOf, parsePayload } from "@escapement/core";
import { type EventStore, eventStore } from "@escapement/store";
import { mkdir, rm } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { dirname } from "node:path";
import { type GuardPolicy, type ToolCall, evaluate, redact } from "./guard.ts";

/** What the runtimes call the five hooks both of them have. */
export type HookName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  // Claude Code only. Bonus signal: better when present, never required.
  | "SessionEnd"
  | "PreCompact"
  | "Notification";

export interface RegisteredRun {
  runId: string;
  policy: GuardPolicy;
  /** Counted in memory, flushed as events rather than one append per call. */
  allowed: number;
  trips: number;
  touched: { path: string; op: "edit" | "write" | "delete" }[];
  /** The stream version the next append expects. */
  version: number;
}

export interface HookServerOptions {
  socketPath: string;
  store?: EventStore;
  /** Overridable so a test can watch what the server decided. */
  onDecision?: (runId: string, hook: HookName, verdict: "allow" | "deny") => void;
}

export interface HookServer {
  readonly socketPath: string;
  /** Teaches the server about a run. Until this, its calls are denied. */
  register(runId: string, policy: GuardPolicy, version: number): RegisteredRun;
  unregister(runId: string): RegisteredRun | undefined;
  get(runId: string): RegisteredRun | undefined;
  /** Writes the counted-in-memory facts to the log. Called at the end of a run. */
  flush(runId: string): Promise<void>;
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface Request {
  runId?: string;
  payload?: {
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    prompt?: string;
    message?: string;
    session_id?: string;
  };
}

export function createHookServer(options: HookServerOptions): HookServer {
  const store = options.store ?? eventStore;
  const runs = new Map<string, RegisteredRun>();
  let server: Server | null = null;

  /** Appends to a run's stream, keeping the expected version in step. */
  async function append<T extends Parameters<typeof parsePayload>[0]>(
    run: RegisteredRun,
    type: T,
    data: PayloadOf<T>,
  ): Promise<void> {
    const [written] = await store.append(run.runId, run.version, [
      { type, actor: `agent:${run.runId}`, data: parsePayload(type, data) },
    ]);
    run.version = written!.version;
  }

  async function decide(request: Request): Promise<{ allow: boolean; reason?: string }> {
    const run = request.runId ? runs.get(request.runId) : undefined;
    if (!run) {
      // Fail closed on an unknown run: the conductor renders the wiring, so this
      // means the wiring is wrong, not that this call is exempt.
      return { allow: false, reason: `esc-hook: run ${request.runId ?? "(none)"} is not registered` };
    }

    const hook = (request.payload?.hook_event_name ?? "PreToolUse") as HookName;
    const call: ToolCall = {
      tool: request.payload?.tool_name ?? "",
      input: request.payload?.tool_input ?? {},
    };

    if (hook === "PostToolUse") {
      // Observation only. Counted, never blocking — the tool already ran.
      const path = (call.input["file_path"] ?? call.input["path"]) as string | undefined;
      if (path) {
        const op = call.tool === "Write" ? "write" : call.tool === "Edit" ? "edit" : "write";
        run.touched.push({ path, op });
      }
      options.onDecision?.(run.runId, hook, "allow");
      return { allow: true };
    }

    if (hook !== "PreToolUse") {
      options.onDecision?.(run.runId, hook, "allow");
      return { allow: true };
    }

    const verdict = evaluate(call, run.policy);
    if (verdict.allow) {
      run.allowed += 1;
      options.onDecision?.(run.runId, hook, "allow");
      return { allow: true };
    }

    run.trips += 1;
    options.onDecision?.(run.runId, hook, "deny");
    // Synchronous, deliberately. The decision is already made, so this delays
    // only a call that was going to be refused — and 132 of these were invisible
    // in the old loop precisely because nobody paid for writing them down.
    try {
      await append(run, "GuardTripped", {
        tool: call.tool,
        pattern: verdict.rule,
        redactedCommand: verdict.redacted,
      });
    } catch {
      // A store that is down must not turn a denial into an allow. The refusal
      // stands; the record is what is lost, and that is the right way round.
    }
    return { allow: false, reason: `esc-hook: ${verdict.rule} — ${verdict.why}` };
  }

  return {
    socketPath: options.socketPath,

    register(runId, policy, version) {
      const run: RegisteredRun = { runId, policy, allowed: 0, trips: 0, touched: [], version };
      runs.set(runId, run);
      return run;
    },

    unregister(runId) {
      const run = runs.get(runId);
      runs.delete(runId);
      return run;
    },

    get: (runId) => runs.get(runId),

    async flush(runId) {
      const run = runs.get(runId);
      if (!run) return;
      // One append per touched file rather than one per tool call: the board
      // wants to show what the agent changed, not every read it made.
      const touched = run.touched.splice(0);
      for (const t of touched) {
        await append(run, "RunTouchedFile", t);
      }
    },

    async listen() {
      await mkdir(dirname(options.socketPath), { recursive: true });
      // A stale socket file from a killed conductor would make bind fail; there
      // is nothing behind it to protect.
      await rm(options.socketPath, { force: true });

      server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            void (async () => {
              let reply: { allow: boolean; reason?: string };
              try {
                reply = await decide(JSON.parse(line) as Request);
              } catch (err) {
                reply = { allow: false, reason: `esc-hook: ${redact(String(err))}` };
              }
              socket.write(`${JSON.stringify(reply)}\n`);
            })();
          }
        });
        socket.on("error", () => {
          // A hook that hung up mid-question gets no answer, and its exit code
          // is 2 either way.
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(options.socketPath, () => resolve());
      });
    },

    async close() {
      const s = server;
      server = null;
      if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
      await rm(options.socketPath, { force: true });
    },
  };
}
