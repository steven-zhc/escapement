import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where configuration values come from, for every package that needs one.
 *
 * Loads the environment from the workspace root rather than from whichever
 * directory a command happened to start in.
 *
 * `dotenv/config` alone would only read `packages/store/.env`, which is wrong
 * twice over: the file belongs at the root, where the board and the CLI will
 * also want it, and it should be `.env.local` so that `.env.example` can stay
 * committed as the template.
 *
 * Order is priority — dotenv does not overwrite a key that is already set, so
 * the first file to define one wins. A real environment variable beats them all,
 * which is what makes CI and launchd work without a file at all.
 */
const here = dirname(fileURLToPath(import.meta.url));
/** `packages/env/src` → the repository root. */
const root = resolve(here, "../../..");

config({
  path: [resolve(root, ".env.local"), resolve(root, ".env")],
  quiet: true,
});

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local at the repo root and fill it in.`,
    );
  }
  return v;
}

/** Pooled. Ordinary reads and writes. */
export function databaseUrl(): string {
  return required("DATABASE_URL");
}

/**
 * Session mode, against the same database.
 *
 * Migrations, `LISTEN/NOTIFY` and session-level advisory locks all need a
 * connection that is not handed to someone else between statements. Through a
 * transaction pooler each of those fails **silently** — a cross-connection
 * NOTIFY simply never arrives, which would leave the system looking merely slow
 * rather than broken. Measured against Supabase's pooler on 2026-08-31; see
 * doc/decisions/0009-two-connections.md.
 *
 * On a plain Postgres this may be the same string as `databaseUrl()`.
 */
export function directDatabaseUrl(): string {
  return required("DIRECT_DATABASE_URL");
}

/** Set, or undefined. For values whose absence is a legitimate state. */
export function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

/**
 * The GitHub App's credentials.
 *
 * An App rather than a personal access token, because a fine-grained PAT can be
 * wrong in a way nothing reports: on 2026-08-30 one covered the admin
 * repository's submodule but not the repository itself, and every CI run failed
 * with a 403 that said nothing about scope. An installation makes reachability
 * explicit. See doc/decisions/0006-github-app.md.
 *
 * The private key is a real secret. It is read from a file by default so it
 * never has to be pasted into a shell, and it never appears in any log — a
 * caller that needs to show configuration shows `keySource`, not the key.
 */
export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  /** Where the key came from, for diagnostics. Never the key itself. */
  keySource: string;
}

export function githubApp(): GitHubAppCredentials {
  const appId = required("GITHUB_APP_ID");
  const path = optional("GITHUB_APP_PRIVATE_KEY_PATH");
  const inline = optional("GITHUB_APP_PRIVATE_KEY");

  if (path) {
    return { appId, privateKey: readFileSync(resolve(root, path), "utf8"), keySource: path };
  }
  if (inline) {
    // Some hosts can only carry the key as one line; \n restores the PEM.
    return { appId, privateKey: inline.replace(/\\n/g, "\n"), keySource: "GITHUB_APP_PRIVATE_KEY" };
  }
  throw new Error(
    "Neither GITHUB_APP_PRIVATE_KEY_PATH nor GITHUB_APP_PRIVATE_KEY is set. " +
      "See doc/decisions/0006-github-app.md for creating the App.",
  );
}

/** Whether the App is configured at all, without throwing to find out. */
export function hasGitHubApp(): boolean {
  return Boolean(
    optional("GITHUB_APP_ID") &&
      (optional("GITHUB_APP_PRIVATE_KEY_PATH") || optional("GITHUB_APP_PRIVATE_KEY")),
  );
}
