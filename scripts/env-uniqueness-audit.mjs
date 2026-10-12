/**
 * READ-ONLY PRE-MIGRATION AUDIT for the environment-aware unique indexes.
 *
 * Answers ONE question per table: would the proposed environment-aware unique
 * index build against the data that is actually there?
 *
 * A `CREATE UNIQUE INDEX` only fails if the NEW key has duplicates. Every
 * proposed key is the old key PLUS `environment`, so it is strictly WIDER —
 * widening a unique key can never create a new collision. The build therefore
 * cannot fail on uniqueness grounds. What this script looks for is the
 * opposite and more interesting thing: provider ids that ALREADY appear in
 * more than one environment. Those are rows the old global index should have
 * refused, so finding any means the constraint was bypassed (a restore, a
 * manual insert, or a window when the index did not exist) AND that the
 * currently-unscoped read-backs have been resolving across environments in
 * production.
 *
 * SELECT ONLY. Every statement here is a read. There is no INSERT, UPDATE,
 * DELETE, ALTER, CREATE or DROP, and no migration is executed. It opens one
 * connection, reads, and closes.
 *
 * Usage:  node scripts/env-uniqueness-audit.mjs
 * Requires DATABASE_URL (read from .env.local like the other suites).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const postgres = require("postgres");

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

if (!process.env.DATABASE_URL) {
  console.log("no DATABASE_URL — cannot run the read-only audit");
  process.exit(2);
}

/**
 * Each entry: the table, the columns the OLD unique index used, and the
 * columns the NEW one will use. `partial` mirrors the existing WHERE clause so
 * the count matches what the index actually covers.
 */
const TARGETS = [
  {
    table: "payment_orders",
    oldIndex: "uniq_orders_whop_payment",
    key: ["whop_payment_id"],
    partial: "whop_payment_id is not null",
  },
  {
    table: "payment_refunds",
    oldIndex: "uniq_refunds_provider_refund",
    key: ["provider", "whop_refund_id"],
    partial: null,
  },
  {
    table: "payment_disputes",
    oldIndex: "uniq_disputes_provider_dispute",
    key: ["provider", "whop_dispute_id"],
    partial: null,
  },
  {
    table: "dispute_alerts",
    oldIndex: "uniq_alerts_provider_alert",
    key: ["provider", "whop_alert_id"],
    partial: null,
  },
  {
    table: "resolution_center_cases",
    oldIndex: "uniq_cases_provider_case",
    key: ["provider", "whop_case_id"],
    partial: null,
  },
  {
    table: "creator_earnings",
    oldIndex: "uniq_creator_earnings_payment_creator",
    key: ["whop_payment_id", "firebase_uid"],
    partial: null,
  },
  {
    table: "creator_transfers",
    oldIndex: "uniq_creator_transfers_provider_id",
    key: ["provider_transfer_id"],
    partial: "provider_transfer_id is not null",
  },
];

const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 15 });
let problems = 0;

try {
  console.log("READ-ONLY. No statement below writes, alters or migrates.\n");

  for (const t of TARGETS) {
    const keyList = t.key.map((c) => `"${c}"`).join(", ");
    const where = t.partial ? `where ${t.partial}` : "";

    // Does the table exist yet in this database?
    const [{ present }] = await sql`
      select count(*)::int as present from information_schema.tables
      where table_schema = 'public' and table_name = ${t.table}`;
    if (!present) {
      console.log(`${t.table}: TABLE NOT PRESENT (migration not applied here)\n`);
      continue;
    }

    const [{ n: total }] = await sql.unsafe(`select count(*)::int as n from "${t.table}"`);

    // Rows the index covers (the partial predicate, where there is one).
    const [{ n: covered }] = await sql.unsafe(
      `select count(*)::int as n from "${t.table}" ${where}`,
    );

    // THE QUESTION: does any old-key value appear under more than one
    // environment? Those rows the global unique index should have refused.
    const straddling = await sql.unsafe(`
      select ${keyList},
             count(distinct environment)::int as environments,
             count(*)::int as rows
        from "${t.table}"
        ${where}
       group by ${keyList}
      having count(distinct environment) > 1
       limit 20`);

    // Environment must be one of the two enum values and never null. The
    // column is NOT NULL with an enum type, so this should be structurally
    // impossible — checked anyway, because "impossible" is what a migration
    // discovers the hard way.
    const [{ n: badEnv }] = await sql.unsafe(`
      select count(*)::int as n from "${t.table}"
       where environment is null
          or environment::text not in ('sandbox','production')`);

    // Per-environment spread, so the report says whether both are even in use.
    const spread = await sql.unsafe(`
      select environment::text as environment, count(*)::int as n
        from "${t.table}" group by environment order by environment`);

    const ok = straddling.length === 0 && badEnv === 0;
    if (!ok) problems++;

    console.log(`${t.table}`);
    console.log(`   old index      : ${t.oldIndex} (${t.key.join(", ")})${t.partial ? ` WHERE ${t.partial}` : ""}`);
    console.log(`   proposed key   : ${t.key.join(", ")}, environment`);
    console.log(`   rows           : ${total} total, ${covered} covered by the index`);
    console.log(`   spread         : ${spread.map((r) => `${r.environment}=${r.n}`).join(", ") || "(empty)"}`);
    console.log(`   straddling ids : ${straddling.length === 0 ? "none" : `${straddling.length} !!`}`);
    for (const row of straddling) {
      const vals = t.key.map((c) => `${c}=${row[c]}`).join(" ");
      console.log(`        ${vals} -> ${row.environments} environments, ${row.rows} rows`);
    }
    console.log(`   bad environment: ${badEnv === 0 ? "none" : `${badEnv} !!`}`);
    console.log(`   verdict        : ${ok ? "SAFE to widen" : "NEEDS RESOLUTION FIRST"}\n`);
  }

  console.log(problems === 0
    ? "ALL CLEAR — every proposed index can be created without a uniqueness conflict."
    : `${problems} table(s) need attention before the migration is applied.`);
} finally {
  await sql.end({ timeout: 5 });
}

process.exit(problems === 0 ? 0 : 1);
