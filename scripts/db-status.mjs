/**
 * Truthful database status from the command line. Reports what is actually
 * there — never a guess, and never a default that looks like a real reading.
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import path from "node:path";

try {
  for (const line of readFileSync(path.resolve(".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const url = process.env.DATABASE_URL?.trim();
if (!url || url.includes("REPLACE_ME")) {
  console.log("DATABASE_URL: not configured");
  console.log("Analytics: disabled (fail-safe — nothing is being stored)");
  process.exit(0);
}

const sql = postgres(url, { max: 1, connect_timeout: 10 });
try {
  const tables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`;
  console.log("DATABASE_URL: configured");
  console.log("Connection: ok");
  console.log("Tables:", tables.map((t) => t.table_name).join(", ") || "(none — run npm run db:migrate)");

  if (tables.some((t) => t.table_name === "analytics_events")) {
    const [{ count }] = await sql`select count(*)::int as count from analytics_events`;
    const [{ last }] = await sql`select max(received_at) as last from analytics_events`;
    console.log("Events stored:", count);
    console.log("Last event:", last ? new Date(last).toISOString() : "none");
  }
  if (tables.some((t) => t.table_name === "financial_ledger")) {
    const [{ count }] = await sql`select count(*)::int as count from financial_ledger`;
    console.log("Ledger rows:", count, count === 0 ? "(no payment source connected)" : "");
  }
} catch (e) {
  // Never print the connection string or a driver stack trace.
  console.log("Connection: failed —", e instanceof Error ? e.message.slice(0, 120) : "unknown");
  process.exit(1);
} finally {
  await sql.end({ timeout: 2 });
}
