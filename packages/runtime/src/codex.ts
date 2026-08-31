/**
 * The Codex adapter — a stub with its capabilities declared, and deliberately
 * nothing else.
 *
 * Both runtimes are designed for from day one because retrofitting the interface
 * later is a refactor. Implementing the second one *now* would be guessing at
 * the wrong abstractions: the contract has not yet survived a single real run,
 * and the first thing a second implementation does is harden whatever the first
 * one got wrong. See doc/decisions/0007-dual-runtime.md.
 *
 * What is real here is the capability declaration. The scheduler matches against
 * it before dispatching, so a project requiring `sandboxed` can already be told
 * that Codex could carry it and Claude Code could not — the decision does not
 * wait on the implementation.
 */
import type { RunOutcome, RunRequest, Runtime, RuntimeCapabilities } from "./runtime.ts";

export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  id: "codex",
  // The intersection only. Codex has no SessionEnd, PreCompact or Notification,
  // which is exactly why the adapter contract is the intersection.
  hooks: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
  canBlockToolUse: true,
  // Codex can rewrite a tool call, not merely refuse it.
  canRewriteToolCall: true,
  // `sandbox_mode: workspace-write` is a real filesystem boundary, which is more
  // than Claude Code provides on its own.
  providesTier: "sandboxed",
};

export class CodexNotImplementedError extends Error {
  override readonly name = "CodexNotImplementedError";
  constructor() {
    super(
      "the Codex adapter is a stub — its capabilities are declared so the scheduler " +
        "can match against them, but nothing dispatches to it yet (#34).",
    );
  }
}

export function createCodexRuntime(): Runtime {
  return {
    capabilities: CODEX_CAPABILITIES,
    run(_request: RunRequest): Promise<RunOutcome> {
      // Loudly, and naming the issue. A stub that returned a plausible-looking
      // outcome would be worse than one that refuses.
      return Promise.reject(new CodexNotImplementedError());
    },
  };
}
