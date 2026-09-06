/**
 * Runs the accounting backfill and reconciliation against the REAL database
 * and the REAL Whop API.
 *
 * This is a thin runner, not a second implementation. It loads the actual
 * server modules — `src/lib/server/accounting/backfill.ts`, which calls
 * `mapPaymentToOrder` and `postWhopSettlement`, and
 * `src/lib/server/accounting/reconcile.ts` — transpiled on the fly so there is
 * no build step to keep in sync. Nothing is stubbed except `server-only`,
 * which exists purely to make a client import a build error.
 *
 * NO SQL IS WRITTEN HERE. There is not an INSERT in this file. Every row it
 * causes is written by the journal, through the same path a webhook uses.
 *
 * Safe to run repeatedly: the posting converges on the economic idempotency
 * key, so a second run reports `already_posted` and changes nothing.
 *
 *   node scripts/accounting-backfill.mjs           # backfill + reconcile
 *   node scripts/accounting-backfill.mjs --check    # reconcile only
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const cache = new Map();

function loadTs(file) {
  const key = resolve(file);
  if (cache.has(key)) return cache.get(key).exports;

  const js = ts.transpileModule(readFileSync(key, "utf8"), {
    // esModuleInterop matters here: `import postgres from "postgres"` emits
    // `postgres_1.default(...)` without it, and that CJS module has no
    // `default` — the connection would silently fail to construct.
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const mod = { exports: {} };
  cache.set(key, mod);

  const req = (spec) => {
    if (spec === "server-only") return {};
    if (spec.startsWith("@/")) return loadTs(`src/${spec.slice(2)}.ts`);
    if (spec.startsWith(".")) {
      const base = resolve(dirname(key), spec);
      // `@/lib/db` resolves to a directory with an index.
      try {
        return loadTs(`${base}.ts`);
      } catch {
        return loadTs(`${base}/index.ts`);
      }
    }
    return require(spec);
  };

  new Function("module", "exports", "require", js)(mod, mod.exports, req);
  return mod.exports;
}

// `@/lib/db` is a directory; point the loader at its index explicitly.
cache.set(resolve("src/lib/db.ts"), { exports: loadTs("src/lib/db/index.ts") });

const { backfillSettledOrders } = loadTs("src/lib/server/accounting/backfill.ts");
const { reconcileInternal, reconcilePaymentAgainstProvider } = loadTs(
  "src/lib/server/accounting/reconcile.ts",
);
const { getAccountBalances, findUnbalancedTransactions } = loadTs(
  "src/lib/server/accounting/journal.ts",
);

const checkOnly = process.argv.includes("--check");

const paymentIds = new Set();

if (!checkOnly) {
  console.log("=== BACKFILL (authoritative path: mapPaymentToOrder -> postWhopSettlement) ===");
  const report = await backfillSettledOrders();
  console.log(`configured=${report.configured} examined=${report.examined}`);
  for (const o of report.outcomes) {
    paymentIds.add(o.paymentId);
    console.log(`  ${o.paymentId}  order=${o.orderId}  ${JSON.stringify(o.result)}`);
  }
}

console.log("\n=== RECONCILE (internal) ===");
const internal = await reconcileInternal();
console.log(
  `configured=${internal.configured} orders=${internal.ordersChecked} transactions=${internal.transactionsChecked} discrepancies=${internal.discrepancies.length}`,
);
for (const d of internal.discrepancies) console.log(`  ${d.code}: ${d.detail}`);

console.log("\n=== RECONCILE (against provider) ===");
for (const id of paymentIds.size ? paymentIds : new Set(process.argv.slice(2).filter((a) => a.startsWith("pay_")))) {
  const found = await reconcilePaymentAgainstProvider(id);
  console.log(`  ${id}: ${found.length} discrepancies`);
  for (const d of found) console.log(`    ${d.code}: ${d.detail}`);
}

console.log("\n=== BALANCES (grouped by currency, never summed across) ===");
for (const b of (await getAccountBalances()) ?? []) {
  console.log(`  ${b.account.padEnd(28)} ${b.balanceMinor.padStart(8)} ${b.currency}  (${b.entryCount} legs)`);
}

const unbalanced = await findUnbalancedTransactions();
console.log(`\nunbalanced transactions: ${unbalanced?.length ?? "n/a"}`);

process.exit(0);
