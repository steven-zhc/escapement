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

/**
 * The tools that change a file, and what to call what they did.
 *
 * A list rather than a default, because the failure modes are not symmetric. A
 * tool missing from here means a real edit goes unrecorded, which shows up as a
 * diff nobody predicted — visible, and annoying. A default that treats anything
 * with a `file_path` as a write means reads are recorded as writes, which shows
 * up as a board that confidently reports work that never happened. Only the
 * second kind is hard to notice, so the list is the one that is easy to audit.
 */
/**
 * Strip anything credential-shaped out of a string bound for the wire.
 *
 * Moved here when the guard was deleted (ADR 0016 §6) rather than deleted with
 * it: the error path in `handle` puts a thrown message into a reply, and a
 * thrown message is exactly where a connection string turns up.
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

/** Just enough of a tool call to tell whether it changed a file. */
interface ToolCall {
  /** `Bash`, `Read`, `Write`, … as the runtime names it. */
  tool: string;
  input: Record<string, unknown>;
}

const MUTATIONS: Record<string, "write" | "edit" | undefined> = {
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
};

export interface RegisteredRun {
  runId: string;
  /** Recorded on every prompt, so "which prompt produced better work" is answerable. */
  promptVersion: string;
  /** Tool calls seen. Used where the runtime gives no turn number of its own. */
  calls: number;
  /** Counted in memory, flushed as events rather than one append per call. */
  allowed: number;
  touched: { path: string; op: "edit" | "write" | "delete" }[];
  /** The stream version the next append expects. */
  version: number;
}

export interface HookServerOptions {
  socketPath: string;
  store?: EventStore;
  /** Overridable so a test can watch what the server decided. */
  onDecision?: (runId: string, hook: HookName, verdict: "allow" | "deny") => void;
  /**
   * Called for a lifecycle hook the conductor has to act on rather than merely
   * record — `Stop` is the moment the gate pipeline fires, and firing it needs a
   * diff, which needs git, which does not belong on the hot path.
   */
  onLifecycle?: (runId: string, hook: HookName, payload: unknown) => void;
}

export interface HookServer {
  readonly socketPath: string;
  /** Teaches the server about a run. Until this, its calls are denied. */
  register(runId: string, version: number, promptVersion?: string): RegisteredRun;
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

    // The lifecycle hooks. Each maps to the event design.md §5 says it should,
    // except `SessionStart` — its event is `RunStarted`, and the conductor
    // writes that at dispatch because it knows the work item, the model, the
    // base sha and the config hash, none of which the hook is told.
    if (hook === "UserPromptSubmit") {
      const bytes = Buffer.byteLength(request.payload?.prompt ?? "", "utf8");
      options.onLifecycle?.(run.runId, hook, request.payload);
      await append(run, "RunPrompted", { promptVersion: run.promptVersion, bytes }).catch(() => {
        // Losing the record must not refuse the prompt.
      });
      return { allow: true };
    }

    if (hook === "PreCompact") {
      // Compaction means the work item was scoped too large — a metric, not
      // noise. The payload carries no turn number, so this records the
      // conductor's own count of tool calls at the moment it happened; what the
      // metric is *for* does not depend on which monotonic counter it is.
      await append(run, "RunContextExhausted", { turn: run.calls }).catch(() => {});
      options.onLifecycle?.(run.runId, hook, request.payload);
      return { allow: true };
    }

    if (hook === "Notification") {
      // The board lights up instead of the run burning to the wall clock.
      const prompt = request.payload?.message ?? request.payload?.prompt ?? "waiting";
      await append(run, "RunAwaitingInput", { prompt: prompt.slice(0, 2_000) }).catch(() => {});
      options.onLifecycle?.(run.runId, hook, request.payload);
      return { allow: true };
    }

    if (hook === "Stop" || hook === "SessionStart" || hook === "SessionEnd") {
      // `Stop` is the moment the gate pipeline fires, and firing it needs a diff
      // — git, not the hot path. `SessionEnd`'s event is `RunFinished`, which
      // the adapter writes from the process outcome because that is where cost,
      // turns and duration actually are.
      options.onLifecycle?.(run.runId, hook, request.payload);
      return { allow: true };
    }

    if (hook === "PostToolUse") {
      // Observation only. Counted, never blocking — the tool already ran.
      //
      // Only the tools that actually change a file. This used to record any
      // call carrying a `file_path` and default the op to "write", which meant
      // every `Read` was written down as a write. One run logged fifteen
      // `RunTouchedFile` events with `op: "write"` for a worktree it had not
      // modified at all — the board showed fifteen changed files, the diff
      // showed none, and the log was the thing that was wrong. In a system
      // whose whole claim is that the log is the answer, a plausible fiction is
      // worse than a gap.
      const op = MUTATIONS[call.tool];
      const path = (call.input["file_path"] ?? call.input["path"]) as string | undefined;
      if (op && path) run.touched.push({ path, op });
      options.onDecision?.(run.runId, hook, "allow");
      return { allow: true };
    }

    // Everything else, `PreToolUse` included. Escapement refuses no tool call
    // (ADR 0016 §6): tool restrictions are the runtime's own configuration, and
    // `permissions.deny` is enforced even under `bypassPermissions` — by
    // removing the tool from the model's list, so nothing is ever attempted.
    //
    // `PreToolUse` is not wired at all any more, so this is defensive rather
    // than a path anything takes. It counts, because a run's tool-call count is
    // what `RunContextExhausted` reports a turn number from.
    run.calls += 1;
    run.allowed += 1;
    options.onDecision?.(run.runId, hook, "allow");
    return { allow: true };
  }

  return {
    socketPath: options.socketPath,

    register(runId, version, promptVersion = "unknown") {
      const run: RegisteredRun = {
        runId,
        promptVersion,
        calls: 0,
        allowed: 0,
        touched: [],
        version,
      };
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
