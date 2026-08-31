import "dotenv/config";
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";

export default definePrismaConfig({
  orm: ormConfig({
    contract: "./src/prisma/contract.prisma",
    db: {
      // Escapement's own database — never one belonging to a managed project.
      // It has to keep running while a managed project is being changed.
      connection: process.env["DATABASE_URL"]!,
    },
  }),
});
