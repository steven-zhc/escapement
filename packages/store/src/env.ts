/**
 * Environment now lives in `@escapement/env`, because the GitHub client and the
 * CLI need it too and neither should depend on the event store to get it. This
 * re-export stays so `packages/store` reads the same as it did.
 */
export { databaseUrl, dbVar, directDatabaseUrl } from "@escapement/env";
