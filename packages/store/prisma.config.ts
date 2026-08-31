import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import "./src/env.ts";

export default definePrismaConfig({
  orm: ormConfig({
    contract: "./src/prisma/contract.prisma",
    // The DIRECT url, not the pooled one: migrations hold locks across
    // statements and transaction pooling breaks that. Read rather than
    // asserted — `contract emit` and `migration plan` are offline and must work
    // with no database configured. See doc/decisions/0009-two-connections.md.
    db: { connection: process.env["DIRECT_DATABASE_URL"] ?? "" },
  }),
});
