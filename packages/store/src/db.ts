import postgres from "@prisma/orm-postgres/runtime";
import { databaseUrl } from "./env.ts";
import type { Contract } from "./prisma/contract.d.ts";
import contractJson from "./prisma/contract.json" with { type: "json" };

/**
 * A client against Escapement's own database. Never one belonging to a managed
 * project — it has to keep running while a managed project is the thing being
 * changed.
 *
 * The factory exists so a caller can hold a *second*, independent connection.
 * That is not a test convenience: 0009 is the record of a probe that shared one
 * connection between the actor and the observer and therefore proved nothing.
 * Anything claiming two writers race, or that a listener hears a writer, has to
 * be able to build the second client.
 *
 * Each call constructs its own `pg.Pool`. Close what you open — `await
 * client.close()` — or the process will not exit.
 */
export function createDb(url: string = databaseUrl()) {
  return postgres<Contract>({ contractJson, url });
}

export type Db = ReturnType<typeof createDb>;

/** The process-wide client. Long-lived; never closed in a server. */
export const db = createDb();
