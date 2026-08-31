import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import "./src/env.ts";

export default definePrismaConfig({
  orm: ormConfig({
    contract: "./src/prisma/contract.prisma",
    // Read, not asserted. `contract emit` and `migration plan` are offline and
    // must work with no database configured at all; the commands that do need a
    // connection fail on their own. The runtime path asserts it properly —
    // see databaseUrl() in src/env.ts.
    db: { connection: process.env["DATABASE_URL"] ?? "" },
  }),
});
