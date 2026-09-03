/**
 * A repository-scoped GitHub client.
 *
 * Everything here is a read or a write GitHub is the *display surface* for —
 * never the source of state. `github_mirror` is a projection that writes labels
 * out; nothing reads a label back to decide anything. That inversion is the one
 * the whole design rests on (doc/decisions/0001-event-sourcing.md), so the
 * absence of a "read the agent:* labels" method here is deliberate.
 *
 * The one exception is discovery, which reads issues *once* to learn that a work
 * item exists. After that the log is the authority.
 */
import {
  type AppAuth,
  GITHUB_API,
  GitHubError,
  type Installation,
  createTokenSource,
  installationForRepo,
} from "./app.ts";

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  url: string;
}

export interface GitHubClient {
  readonly owner: string;
  readonly repo: string;
  readonly installation: Installation;

  /** Raw REST, for the calls that do not have a method yet. */
  request<T>(method: string, path: string, body?: unknown): Promise<T>;

  /** The repository's default branch, when the recipe does not name one. */
  defaultBranch(): Promise<string>;

  /**
   * A file's contents at a ref, or null if it is not there.
   *
   * `ref` is a *server-side* ref. That is the whole governance rule in one
   * argument: the recipe a run obeys is read from `origin/<base>`, not from
   * whatever the agent's worktree happens to contain
   * (doc/decisions/0005-config-in-target-repo.md).
   */
  fileAt(path: string, ref: string): Promise<string | null>;

  /** The commit a ref points at right now, so a resolution can be replayed. */
  refSha(ref: string): Promise<string>;

  listOpenIssues(): Promise<Issue[]>;
  getIssue(number: number): Promise<Issue>;

  /**
   * Posts a comment.
   *
   * The first write on this client, and it stays narrow on purpose: everything
   * that changes *code* still goes through git, so this is only for telling a
   * person something on the ticket they are already looking at.
   *
   * Called from the outbox worker, never inline. The old loop called `gh`
   * in-line and a failed call vanished with no record and no retry.
   */
  comment(issue: number, body: string): Promise<{ id: number }>;

  /**
   * Replaces the whole label set.
   *
   * Replace rather than add, because `--add-label` is set union and not a
   * transition — which is how #35 ended up carrying `agent:blocked` and
   * `agent:review` at the same time with nothing able to notice. A state that
   * is computed and then *set* cannot hold two contradictory values.
   */
  setLabels(issue: number, labels: readonly string[]): Promise<void>;

  /**
   * Closes an issue, as completed.
   *
   * The gap this fills: nothing closed a landed issue, and `labelsFor("landed")`
   * removes Lingtai's own label — so an issue Lingtai had merged was
   * indistinguishable on GitHub from one it had never touched. The old loop's
   * failure was state living in labels; the failure after it was state living
   * nowhere.
   */
  closeIssue(issue: number): Promise<void>;

  /**
   * The current installation token, refreshed if it is about to expire.
   *
   * Exposed because git needs it and this client is the only thing that has it.
   * Both managed repositories here are private, so without this every clone is
   * an anonymous one — which fails at the first fetch, before anything else in a
   * run has a chance to.
   *
   * A function rather than a value on purpose. An installation token lasts an
   * hour and a run's wall limit is two, so a snapshot taken at the start would
   * be expired by the time the integrator pushes. Callers hold *this*, and
   * resolve it per git invocation.
   */
  token(): Promise<string>;
}

export interface CreateClientOptions {
  auth: AppAuth;
  owner: string;
  repo: string;
  /** Skips the installation lookup when one has already been made. */
  installation?: Installation;
}

export async function createGitHubClient(options: CreateClientOptions): Promise<GitHubClient> {
  const { auth, owner, repo } = options;
  const installation = options.installation ?? (await installationForRepo(auth, owner, repo));
  const tokenFor = createTokenSource(auth, installation.id);

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await tokenFor();
    const response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "lingtai",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      let message = text.slice(0, 400);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // Not JSON; the prefix is still the most useful thing available.
      }
      throw new GitHubError(response.status, path, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async function comment(issue: number, body: string): Promise<{ id: number }> {
    return request<{ id: number }>("POST", `/repos/${owner}/${repo}/issues/${issue}/comments`, {
      body,
    });
  }

  async function closeIssue(issue: number): Promise<void> {
    await request<unknown>("PATCH", `/repos/${owner}/${repo}/issues/${issue}`, {
      state: "closed",
      state_reason: "completed",
    });
  }

  async function setLabels(issue: number, labels: readonly string[]): Promise<void> {
    await request<unknown>("PUT", `/repos/${owner}/${repo}/issues/${issue}/labels`, {
      labels: [...labels],
    });
  }

  function toIssue(raw: {
    number: number;
    title: string;
    body: string | null;
    labels: ({ name?: string } | string)[];
    state: string;
    html_url: string;
  }): Issue {
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      labels: raw.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
      state: raw.state === "closed" ? "closed" : "open",
      url: raw.html_url,
    };
  }

  return {
    owner,
    repo,
    installation,
    request,
    // The same source `request` uses, handed out so git can authenticate too.
    token: tokenFor,
    comment,
    setLabels,
    closeIssue,

    async defaultBranch() {
      const raw = await request<{ default_branch: string }>("GET", `/repos/${owner}/${repo}`);
      return raw.default_branch;
    },

    async fileAt(path, ref) {
      try {
        const raw = await request<{ content?: string; encoding?: string }>(
          "GET",
          `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        );
        if (!raw.content) return null;
        return Buffer.from(raw.content, (raw.encoding as BufferEncoding) ?? "base64").toString("utf8");
      } catch (err) {
        // A missing file is an answer, not a failure — a repository with no
        // recipe is a repository that has not been onboarded yet.
        if (err instanceof GitHubError && err.status === 404) return null;
        throw err;
      }
    },

    async refSha(ref) {
      const raw = await request<{ sha: string }>(
        "GET",
        `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      );
      return raw.sha;
    },

    async listOpenIssues() {
      const out: Issue[] = [];
      for (let page = 1; page <= 10; page++) {
        const raw = await request<Parameters<typeof toIssue>[0][]>(
          "GET",
          `/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`,
        );
        // GitHub returns pull requests from the issues endpoint. A PR is not a
        // work item.
        const issues = raw.filter((r) => !("pull_request" in r));
        out.push(...issues.map(toIssue));
        if (raw.length < 100) break;
      }
      return out;
    },

    async getIssue(number) {
      return toIssue(
        await request<Parameters<typeof toIssue>[0]>(
          "GET",
          `/repos/${owner}/${repo}/issues/${number}`,
        ),
      );
    },
  };
}

/** `owner/repo` → its parts, or a message saying what was wrong with it. */
export function parseSlug(slug: string): { owner: string; repo: string } {
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(slug.trim());
  if (!m) throw new Error(`"${slug}" is not owner/repo`);
  return { owner: m[1]!, repo: m[2]! };
}
