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

/** Throws with a useful message rather than handing Postgres `undefined`. */
export function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local at the repo root and fill it in.",
    );
  }
  return url;
}
