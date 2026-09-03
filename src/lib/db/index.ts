import "server-only";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/* ==========================================================================
   DATABASE CONNECTION — server only.

   `server-only` makes an import from a client component a build error, so a
   connection string can never reach a browser bundle.

   FAIL SAFE, not fail silent: with no DATABASE_URL the accessor returns null.
   Callers must handle that by reporting "not configured" — never by pretending
   a write succeeded. The public site keeps working either way; analytics is
   not on the critical path for rendering a page.
   ========================================================================== */

export type Database = PostgresJsDatabase<typeof schema>;

let cached: Database | null = null;
let attempted = false;

function connectionString(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  // Guard against a placeholder being left in an env file.
  if (url.includes("REPLACE_ME") || !/^postgres(ql)?:\/\//.test(url)) return null;
  return url;
}

export function isDatabaseConfigured(): boolean {
  return connectionString() !== null;
}

export function getDb(): Database | null {
  if (cached) return cached;
  if (attempted) return null;
  attempted = true;

  const url = connectionString();
  if (!url) return null;

  try {
    // Modest pool: serverless instances are many and short-lived, so each one
    // holding a large pool is how a Postgres connection limit gets exhausted.
    // Point DATABASE_URL at a pooled endpoint (Neon pooler, PgBouncer).
    const client = postgres(url, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      // Required for a pooled endpoint. Neon's pooler is PgBouncer in
      // transaction mode, where a named prepared statement created on one
      // pooled backend is not there on the next — postgres.js prepares by
      // default, so leaving this on produces intermittent "prepared statement
      // does not exist" failures that only appear under concurrency. The cost
      // on a direct connection is small, and serverless instances are too
      // short-lived to amortise a prepared statement anyway.
      prepare: false,
      // Analytics writes must never take the page down; surface nothing.
      onnotice: () => {},
    });
    cached = drizzle(client, { schema });
    return cached;
  } catch {
    return null;
  }
}

export { schema };
