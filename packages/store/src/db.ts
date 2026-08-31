import "dotenv/config";
import postgres from "@prisma/orm-postgres/runtime";
import type { Contract } from "./prisma/contract.d.ts";
import contractJson from "./prisma/contract.json" with { type: "json" };

/**
 * Escapement's own database. Never one belonging to a managed project — it has
 * to keep running while a managed project is the thing being changed.
 */
export const db = postgres<Contract>({
  contractJson,
  url: process.env["DATABASE_URL"]!,
});
