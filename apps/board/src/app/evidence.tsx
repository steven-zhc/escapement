"use client";

/**
 * Everything you need to decide, on the card.
 *
 * The rule this is built against: **if you have to open GitHub to decide,
 * nothing changed.** The old review queue did not stall because the decisions
 * were hard; it stalled because making one meant leaving the tool, and the cost
 * of leaving is what 45-items-growing-at-14-a-day measures.
 *
 * So a build failure shows its log tail, a review failure shows its findings
 * *with the failure scenarios* — the scenario is the finding, the claim alone
 * is an opinion — and a policy hold shows the files it matched. All collapsed
 * by default, because a card that is three screens tall is its own kind of
 * unreadable.
 *
 * The diff is deliberately not syntax-highlighted by language. It is
 * highlighted structurally — added, removed, hunk header, file header — which
 * is what a reviewer reads a diff *for*. Language highlighting means shipping a
 * grammar bundle into a local operator console, and the value of that against
 * its weight has not been argued for. Said plainly rather than quietly skipped.
 */
import { useState, useTransition } from "react";
import { loadDiff } from "./actions.ts";
import type { DiffFile } from "@/lib/diff";

export interface GateEvidence {
  gate: string;
  state: string;
  current: boolean;
  evidence: string | null;
  findings: {
    file: string;
    line: number | null;
    claim: string;
    failureScenario: string;
    severity: string;
  }[];
}

function Findings({ findings }: { findings: GateEvidence["findings"] }) {
  return (
    <ul className="findings">
      {findings.map((f, i) => (
        <li key={`${f.file}:${f.line}:${i}`}>
          <span className={`pill ${f.severity === "minor" ? "" : "fail"}`}>{f.severity}</span>{" "}
          <span className="fpath">
            {f.file}
            {f.line === null ? "" : `:${f.line}`}
          </span>
          <p className="claim">{f.claim}</p>
          {/* The half that makes it a finding. Without it this is an opinion,
              and the gate drops those before they ever reach here. */}
          <p className="scenario">{f.failureScenario}</p>
        </li>
      ))}
    </ul>
  );
}

function DiffView({ files, truncated }: { files: DiffFile[]; truncated: boolean }) {
  return (
    <div className="diffview">
      {truncated ? (
        <p className="note">Showing the first {files.length} files. The rest are not rendered.</p>
      ) : null}
      {files.map((file) => (
        <details key={file.path} className="dfile">
          <summary>
            <span className="fpath">{file.path}</span>
            <span className="dcount">
              <span className="add">+{file.added}</span> <span className="del">−{file.removed}</span>
            </span>
          </summary>
          {/* Scrolls inside itself. A long line in a diff must never make the
              board scroll sideways — the columns are the navigation. */}
          <pre className="dbody">
            {file.lines.map((line, i) => (
              <span key={i} className={`dl ${lineClass(line)}`}>
                {line || " "}
                {"\n"}
              </span>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

export function Evidence({
  project,
  baseSha,
  headSha,
  gates,
}: {
  project: string;
  baseSha: string | null;
  headSha: string;
  gates: GateEvidence[];
}) {
  const [diff, setDiff] = useState<{ files: DiffFile[]; truncated: boolean } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const interesting = gates.filter((g) => g.evidence || g.findings.length > 0);

  return (
    <div className="evidence">
      {interesting.map((g) => (
        <details key={g.gate} className="gdetail">
          <summary>
            <span className={`pill ${g.state === "passed" ? "pass" : g.state === "failed" ? "fail" : "hold"}`}>
              {g.gate}
            </span>
            <span className="gsum">
              {g.findings.length > 0
                ? `${g.findings.length} finding${g.findings.length === 1 ? "" : "s"}`
                : g.state}
              {g.current ? "" : " · about an earlier commit"}
            </span>
          </summary>
          {g.findings.length > 0 ? <Findings findings={g.findings} /> : null}
          {/* The log tail for a build, the matched files for a policy hold, the
              question for a human gate. Whatever the gate had to say. */}
          {g.evidence ? <pre className="gevidence">{g.evidence}</pre> : null}
        </details>
      ))}

      {baseSha ? (
        diff ? (
          <DiffView files={diff.files} truncated={diff.truncated} />
        ) : (
          <div>
            <button
              className="btn"
              onClick={() =>
                startTransition(async () => {
                  const result = await loadDiff({ project, baseSha, headSha });
                  if (result.ok) setDiff({ files: result.files, truncated: result.truncated });
                  else setDiffError(result.detail);
                })
              }
            >
              Show the diff
            </button>
            {diffError ? <p className="refusal">{diffError}</p> : null}
          </div>
        )
      ) : null}
    </div>
  );
}
