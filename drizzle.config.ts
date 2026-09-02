import type { Config } from "drizzle-kit";

/**
 * Migrations are explicit files, generated once and applied deliberately.
 * Nothing in the application creates or alters a table at request time — a
 * schema that changes on first traffic is a schema nobody can reproduce.
 */
export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
} satisfies Config;
