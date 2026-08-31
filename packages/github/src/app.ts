/**
 * GitHub App authentication.
 *
 * An App, not a personal access token. A fine-grained PAT can do everything
 * Escapement needs and can also be wrong in a way nothing reports: on
 * 2026-08-30 one covered the admin repository's *submodule* but not the
 * repository itself, and every CI run failed with a 403 that said nothing about
 * scope. Which repositories an App can reach is explicit in its installation,
 * so the same mistake is visible at install time rather than a day later.
 * See doc/decisions/0006-github-app.md.
 *
 * Two credentials, two lifetimes:
 *
 *   app JWT             signed locally with the private key, ~9 minutes,
 *                       identifies the *App* and can only read installations
 *   installation token  fetched with that JWT, ~1 hour, identifies the App
 *                       *on one repository* and is what every real call uses
 *
 * Callers never see either. `tokenFor()` hands back a valid installation token
 * and refreshes it before it expires, so "token refresh is transparent" is a
 * property of the type rather than something every call site remembers.
 *
 * No dependency for the JWT: `node:crypto` signs RS256, which is the whole of
 * what GitHub asks for.
 */
import { createSign } from "node:crypto";

export const GITHUB_API = "https://api.github.com";

export interface AppAuth {
  appId: string;
  /** PEM. Never logged, never included in an error. */
  privateKey: string;
}

export interface Installation {
  id: number;
  /** `read` or `write` per permission name, as GitHub reports them. */
  permissions: Readonly<Record<string, string>>;
  account: string;
  /** `all`, or `selected` when the App was installed on specific repositories. */
  repositorySelection: string;
}

export class GitHubError extends Error {
  override readonly name = "GitHubError";
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message: string) {
    super(`${status} on ${path}: ${message}`);
    this.status = status;
    this.path = path;
  }
}

/** The App is not installed on that repository — the failure 0006 exists to surface. */
export class NotInstalledError extends Error {
  override readonly name = "NotInstalledError";
  readonly owner: string;
  readonly repo: string;

  constructor(owner: string, repo: string) {
    super(
      `the GitHub App is not installed on ${owner}/${repo}. ` +
        "Install it on that repository (Settings → GitHub Apps → Configure), " +
        "then run esc add again.",
    );
    this.owner = owner;
    this.repo = repo;
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A short-lived JWT identifying the App itself.
 *
 * `iat` is backdated by 60s because GitHub rejects a token whose `iat` is in its
 * future, and a laptop's clock drifts. `exp` is 9 minutes; GitHub's ceiling is
 * 10 and rejects anything over it.
 */
export function appJwt(auth: AppAuth, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: auth.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(auth.privateKey, "base64url")}`;
}

async function githubJson<T>(
  path: string,
  init: RequestInit & { token: string; tokenKind: "bearer" },
): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      // GitHub rejects a request with no User-Agent, with a message that does
      // not say so.
      "user-agent": "escapement",
      authorization: `Bearer ${init.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    let message = body.slice(0, 400);
    try {
      message = (JSON.parse(body) as { message?: string }).message ?? message;
    } catch {
      // Not JSON. The raw prefix is more useful than nothing.
    }
    throw new GitHubError(response.status, path, message);
  }
  return (await response.json()) as T;
}

/** Which installation covers a repository, and what it may do there. */
export async function installationForRepo(
  auth: AppAuth,
  owner: string,
  repo: string,
): Promise<Installation> {
  try {
    const raw = await githubJson<{
      id: number;
      permissions: Record<string, string>;
      account: { login?: string } | null;
      repository_selection: string;
    }>(`/repos/${owner}/${repo}/installation`, {
      token: appJwt(auth),
      tokenKind: "bearer",
    });
    return {
      id: raw.id,
      permissions: raw.permissions,
      account: raw.account?.login ?? owner,
      repositorySelection: raw.repository_selection,
    };
  } catch (err) {
    // 404 here means "no installation covers this repository", which is not the
    // same as "no such repository" and reads very differently to whoever is
    // trying to onboard it.
    if (err instanceof GitHubError && err.status === 404) throw new NotInstalledError(owner, repo);
    throw err;
  }
}

/**
 * The permissions ADR 0006 settled on, and why each is needed.
 *
 * Checked at add time rather than discovered as a 403 in the middle of a run —
 * which is exactly how the PAT failure went unexplained for a day.
 */
export const REQUIRED_PERMISSIONS: { name: string; level: "read" | "write"; why: string }[] = [
  { name: "issues", level: "write", why: "reading work items, writing agent:* labels and comments" },
  { name: "contents", level: "write", why: "cloning, pushing agent/*, merging into base" },
  { name: "pull_requests", level: "write", why: "opening and reading pull requests" },
  { name: "metadata", level: "read", why: "required by GitHub for any App" },
];

export interface PermissionGap {
  name: string;
  need: string;
  have: string;
  why: string;
}

/** Every required permission the installation does not actually grant. */
export function permissionGaps(installation: Installation): PermissionGap[] {
  const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
  return REQUIRED_PERMISSIONS.filter((r) => {
    const have = installation.permissions[r.name];
    return (rank[have ?? ""] ?? 0) < (rank[r.level] ?? 0);
  }).map((r) => ({
    name: r.name,
    need: r.level,
    have: installation.permissions[r.name] ?? "none",
    why: r.why,
  }));
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * A source of valid installation tokens for one repository.
 *
 * Refreshes a minute before expiry rather than on a 401, so a token never
 * expires mid-merge — the one moment where retrying is least welcome.
 */
export function createTokenSource(
  auth: AppAuth,
  installationId: number,
): () => Promise<string> {
  let cached: CachedToken | null = null;
  let inFlight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const raw = await githubJson<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { method: "POST", token: appJwt(auth), tokenKind: "bearer" },
    );
    cached = { token: raw.token, expiresAtMs: Date.parse(raw.expires_at) };
    return raw.token;
  }

  return async function tokenFor(): Promise<string> {
    if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached.token;
    // One refresh at a time: a burst of calls after expiry should not become a
    // burst of token requests.
    inFlight ??= fetchToken().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
