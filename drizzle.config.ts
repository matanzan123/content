import type { Config } from "drizzle-kit";

/*
 * drizzle-kit calls dotenv.config() with no path, so it reads `.env` and NOT
 * `.env.local`. Next.js reads `.env.local`. Without this, `npm run db:migrate`
 * would see an empty DATABASE_URL even though the dev server connects fine,
 * and the obvious workaround would be to copy the connection string into a
 * second file — two places to leak one secret from. Load `.env.local` here so
 * there is exactly one file holding it, and it stays the git-ignored one.
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Absent or unreadable. A real environment variable may already be set,
    // which is how this runs in CI or against a production database.
  }
}

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
