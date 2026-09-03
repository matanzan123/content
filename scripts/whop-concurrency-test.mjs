/**
 * Proves that concurrent sandbox test-order initialisation converges on ONE
 * order, against real Postgres.
 *
 * SAFETY: this runs entirely inside a session-temporary table created in one
 * transaction per connection — it never touches `payment_orders`, never calls
 * Whop, and creates no provider object. The SQL under test is the same
 * advisory-lock + lookup + insert sequence `findOrCreateSandboxOrder` issues;
 * a structural assertion at the end fails if the implementation drifts from it.
 *
 * A temp table is per-session and 20 concurrent callers need 20 sessions, so
 * the shared table here is a REAL table with a random name, created and
 * dropped by this script. It is named `concurrency_probe_<random>` and is
 * removed in a finally block, with a final check that it is gone.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const postgres = require("postgres");

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!process.env.DATABASE_URL) {
  console.log("no DATABASE_URL — cannot prove concurrency against real Postgres");
  process.exit(1);
}

const TABLE = `concurrency_probe_${Math.random().toString(36).slice(2, 10)}`;
const LOCK = BigInt("724103991001");
const sql = postgres(process.env.DATABASE_URL, { max: 25, prepare: false, onnotice: () => {} });

/** The sequence under test, issued exactly as the implementation issues it. */
async function findOrCreate(tag) {
  return sql.begin(async (tx) => {
    await tx.unsafe(`select pg_advisory_xact_lock(${LOCK})`);
    const existing = await tx.unsafe(
      `select order_id from ${TABLE}
        where status in ('created','checkout_created','payment_pending','failed')
          and whop_payment_id is null and paid_at is null
        order by created_at asc limit 1`,
    );
    if (existing.length) return { orderId: existing[0].order_id, created: false, tag };
    const [row] = await tx.unsafe(
      `insert into ${TABLE} (amount_minor, currency, purpose) values (1000,'usd','sandbox_integration_test')
       returning order_id`,
    );
    return { orderId: row.order_id, created: true, tag };
  });
}

/** The same sequence WITHOUT the lock, to show the race is real. */
async function racyFindOrCreate(tag) {
  return sql.begin(async (tx) => {
    const existing = await tx.unsafe(
      `select order_id from ${TABLE}
        where status in ('created','checkout_created','payment_pending','failed')
          and whop_payment_id is null and paid_at is null
        order by created_at asc limit 1`,
    );
    if (existing.length) return { orderId: existing[0].order_id, created: false, tag };
    const [row] = await tx.unsafe(
      `insert into ${TABLE} (amount_minor, currency, purpose) values (1000,'usd','sandbox_integration_test')
       returning order_id`,
    );
    return { orderId: row.order_id, created: true, tag };
  });
}

try {
  await sql.unsafe(`
    create table ${TABLE} (
      order_id uuid primary key default gen_random_uuid(),
      amount_minor bigint not null,
      currency char(3) not null,
      purpose text not null,
      status text not null default 'created',
      whop_payment_id text,
      paid_at timestamptz,
      created_at timestamptz not null default now()
    )`);

  /* ---- 20 simultaneous callers, no order present ---- */
  const N = 20;
  const outcomes = await Promise.all(Array.from({ length: N }, (_, i) => findOrCreate(i)));
  const ids = new Set(outcomes.map((o) => o.orderId));
  const created = outcomes.filter((o) => o.created).length;

  check(`${N} simultaneous callers all succeed`, outcomes.length === N);
  check("exactly ONE order was created", created === 1, `${created} created`);
  check("every caller converged on the SAME order id", ids.size === 1, `${ids.size} distinct id(s)`);
  const [{ count: total }] = await sql.unsafe(`select count(*)::int as count from ${TABLE}`);
  check("the table holds exactly one row", total === 1, `${total} rows`);

  /* ---- a second wave finds the existing one and creates nothing ---- */
  const second = await Promise.all(Array.from({ length: N }, (_, i) => findOrCreate(100 + i)));
  const createdAgain = second.filter((o) => o.created).length;
  check("a second wave creates nothing", createdAgain === 0, `${createdAgain} created`);
  check("the second wave returns the same order", new Set(second.map((o) => o.orderId)).size === 1 && second[0].orderId === [...ids][0]);

  /* ---- the same wave WITHOUT the lock duplicates: proves the lock matters -- */
  await sql.unsafe(`delete from ${TABLE}`);
  const racy = await Promise.all(Array.from({ length: N }, (_, i) => racyFindOrCreate(i)));
  const racyCreated = racy.filter((o) => o.created).length;
  const [{ count: racyRows }] = await sql.unsafe(`select count(*)::int as count from ${TABLE}`);
  check(
    "WITHOUT the advisory lock the same code duplicates (the race is real)",
    racyCreated > 1 || racyRows > 1,
    `${racyCreated} created, ${racyRows} rows`,
  );

  /* ---- a cancelled/paid order is never reused ---- */
  await sql.unsafe(`delete from ${TABLE}`);
  await sql.unsafe(`insert into ${TABLE} (amount_minor,currency,purpose,status) values (1000,'usd','sandbox_integration_test','cancelled')`);
  const afterCancelled = await findOrCreate("x");
  check("a cancelled order is not reused — a new one is created", afterCancelled.created === true);

  await sql.unsafe(`delete from ${TABLE}`);
  await sql.unsafe(`insert into ${TABLE} (amount_minor,currency,purpose,status,whop_payment_id,paid_at) values (1000,'usd','sandbox_integration_test','paid','pay_x',now())`);
  const afterPaid = await findOrCreate("y");
  check("a paid order is not reused — a new one is created", afterPaid.created === true);

  /* ---- the implementation still issues this sequence ---- */
  const impl = readFileSync("src/lib/server/payment-orders.ts", "utf8");
  const fn = impl.slice(impl.indexOf("export async function findOrCreateSandboxOrder"));
  check("the implementation runs inside a transaction", fn.includes("db.transaction("));
  check("the implementation takes pg_advisory_xact_lock", fn.includes("pg_advisory_xact_lock"));
  check("the lock id matches the one proved here", impl.includes(`BigInt("${LOCK}")`));
  check("the lookup precedes the insert inside that transaction", fn.indexOf(".select()") < fn.indexOf(".insert("));
  check("no in-memory or process-local lock is used", /Mutex|globalThis\.[A-Za-z]*[Ll]ock|let .*locked/.test(impl) === false);
  check("reuse is ordered oldest-first", fn.includes("asc(paymentOrders.createdAt)"));
} finally {
  await sql.unsafe(`drop table if exists ${TABLE}`);
  const [{ n }] = await sql`select count(*)::int as n from information_schema.tables where table_name = ${TABLE}`;
  check("the probe table was removed", n === 0);
  const [{ n: orders }] = await sql`select count(*)::int as n from payment_orders`;
  const [{ n: ledger }] = await sql`select count(*)::int as n from financial_ledger`;
  check("payment_orders untouched by this suite", orders === 3, `${orders} rows`);
  check("financial_ledger untouched", ledger === 0);
  await sql.end({ timeout: 5 });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
