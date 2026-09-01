import { databaseUrl, directDatabaseUrl } from "@escapement/store";
import pg from "pg";
for (const [label, get] of [["pooled", databaseUrl], ["direct", directDatabaseUrl]] as const) {
  let host = "?";
  try {
    host = new URL(get()).hostname;
    const c = new pg.Client({ connectionString: get(), connectionTimeoutMillis: 8000 });
    await c.connect(); await c.query("select 1"); await c.end();
    console.log(`${label}\tOK   \t${host.replace(/^[^.]+/, "***")}`);
  } catch (e) {
    console.log(`${label}\tFAIL \t${host.replace(/^[^.]+/, "***")}\t${(e as Error).message.slice(0, 60)}`);
  }
}
