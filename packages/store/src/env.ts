import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
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
