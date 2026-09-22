/**
 * ENVIRONMENT-ISOLATION TESTS.
 *
 * ONE RULE, ASSERTED REPO-WIDE:
 *
 *   A query against an environment-scoped table that matches on a
 *   PROVIDER-OWNED identifier must also constrain by OUR environment.
 *
 * Whop ids live in a different id space per environment. A pay_ / rf_ / dp_ /
 * tr_ value carries no proof of which environment it belongs to, so matching
 * on it alone lets a sandbox delivery read, update or reverse a PRODUCTION row.
 *
 * WHY THIS IS A STATIC ANALYSIS AND NOT A REGEX.
 *
 * A word search cannot tell an eq() that sits inside an and() carrying the
 * environment from one that does not, and a regex that tried would either miss
 * real defects or fire on prose. So the schema and every source file are parsed
 * with the TypeScript compiler, the environment-scoped tables and their
 * provider-id columns are DERIVED from the schema rather than listed here, and
 * each .where(...) predicate is checked as a unit. A new table, or a new
 * provider-id column on an existing one, is picked up with no change here.
 *
 * THE ALLOWLIST IS NOW EMPTY, AND THAT IS THE ASSERTION. Migration 0011 made
 * all seven provider-id unique indexes environment-aware, which removed the
 * last reason any lookup had to stay unscoped. The suite requires the set of
 * unscoped provider-id queries to be exactly empty, checks the seven indexes
 * still carry environment, and checks every ON CONFLICT target still matches
 * its index — a mismatch there is a RUNTIME error, not a build one.
 *
 * Local only: reads source files. No database, no network, no provider.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ==========================================================================
   The schema is the source of truth for what "environment-scoped" means.
   ========================================================================== */

const schemaSrc = readFileSync("src/lib/db/schema.ts", "utf8");
const schemaFile = ts.createSourceFile("schema.ts", schemaSrc, ts.ScriptTarget.ES2022, true);

/** varName -> { sqlName, columns, hasEnv, primaryKeys, uniqueIndexes } */
const TABLES = {};
(function visit(n) {
  if (
    ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) &&
    n.initializer.expression.getText() === "pgTable"
  ) {
    const varName = n.name.getText();
    const args = n.initializer.arguments;
    const columns = new Set();
    const primaryKeys = new Set();
    if (args[1] && ts.isObjectLiteralExpression(args[1])) {
      for (const p of args[1].properties) {
        if (!p.name) continue;
        const col = p.name.getText().replace(/['"]/g, "");
        columns.add(col);
        if (/\.primaryKey\(/.test(p.getText())) primaryKeys.add(col);
      }
    }
    const whole = n.initializer.getText();
    const uniqueIndexes = [...whole.matchAll(/uniqueIndex\(\s*"([^"]+)"\s*\)\s*\.on\(([^)]*)\)/gs)]
      .map((m) => ({
        name: m[1],
        columns: m[2].replace(/\s+/g, "").split(",").filter(Boolean).map((c) => c.replace(/^t\./, "")),
      }));
    TABLES[varName] = {
      sqlName: args[0] && ts.isStringLiteral(args[0]) ? args[0].text : null,
      columns, hasEnv: columns.has("environment"), primaryKeys, uniqueIndexes,
    };
  }
  ts.forEachChild(n, visit);
})(schemaFile);

/** A provider-owned identifier: Whop's or another provider's, never ours. */
const isProviderId = (col) => /^(whop|provider)[A-Z]/.test(col) && /Id$/.test(col);

const envTables = Object.entries(TABLES).filter(([, t]) => t.hasEnv);

check("the schema parsed and environment-scoped tables were found",
  Object.keys(TABLES).length > 20 && envTables.length >= 9,
  `${Object.keys(TABLES).length} tables, ${envTables.length} environment-scoped`);

// The financial tables this rule exists for. Named so that a table LOSING its
// environment column, or being renamed away, is caught rather than silently
// dropping out of the sweep below.
const MUST_BE_ENV_SCOPED = [
  "creatorEarnings", "paymentRefunds", "paymentDisputes",
  "paymentOrders", "creatorTransfers", "whopAccounts",
  "disputeAlerts", "resolutionCenterCases", "accountingTransactions",
];
for (const t of MUST_BE_ENV_SCOPED) {
  check(`${t} still carries an environment column`, TABLES[t]?.hasEnv === true);
}

/* ==========================================================================
   Walk every source file and check each .where(...) predicate as a unit.
   ========================================================================== */

const sourceFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p)) sourceFiles.push(p);
  }
})("src");

const enclosingFunction = (node) => {
  let p = node.parent;
  while (p) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) ||
        ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      if (p.name) return p.name.getText();
      if (p.parent && ts.isVariableDeclaration(p.parent)) return p.parent.name.getText();
    }
    p = p.parent;
  }
  return "(top-level)";
};

const providerIdQueries = [];

for (const file of sourceFiles) {
  const src = readFileSync(file, "utf8");
  if (!src.includes(".where(")) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);

  (function visit(n) {
    if (
      ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.getText() === "where" && n.arguments.length
    ) {
      const predicate = n.arguments[0].getText();
      const refs = [...predicate.matchAll(/(?:schema\.)?([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g)]
        .map((m) => ({ table: m[1], col: m[2] }))
        .filter((r) => TABLES[r.table]);

      for (const table of new Set(refs.filter((r) => TABLES[r.table].hasEnv).map((r) => r.table))) {
        const cols = refs.filter((r) => r.table === table).map((r) => r.col);
        const providerIds = cols.filter(isProviderId);
        if (!providerIds.length) continue;

        // Keyed by one of OUR OWN primary keys? Then the provider id is a guard
        // on an already-identified row, not the thing that finds it — and a
        // UUID primary key cannot collide across environments.
        const keyedByOurPk = cols.some((c) => TABLES[table].primaryKeys.has(c));

        providerIdQueries.push({
          file, fn: enclosingFunction(n),
          line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          table, providerIds: [...new Set(providerIds)],
          scoped: cols.includes("environment"),
          keyedByOurPk,
        });
      }
    }
    ts.forEachChild(n, visit);
  })(sf);
}

check("the sweep actually inspected a meaningful number of queries",
  providerIdQueries.length >= 25, `${providerIdQueries.length} provider-id predicates`);

/* --------------------------------------------------------------------------
   BLOCKED: the ones that cannot be scoped until the unique indexes are.

   Each is the read-back for an onConflictDoUpdate (or an insert race) whose
   conflict target is a unique index that does NOT include environment. The
   conflict therefore fires across environments; a scoped read would then find
   nothing and the function would report a storage error instead of correctly
   classifying the conflict. Scoping the query without migrating the index
   would trade an isolation gap for an idempotency bug.
   -------------------------------------------------------------------------- */
const BLOCKED = {
  // EMPTY, AND IT MUST STAY EMPTY.
  //
  // Migration 0011 widened all seven provider-id unique indexes with
  // `environment`, which removed the reason the five read-backs could not be
  // scoped. They are scoped now. An entry appearing here again means either a
  // new unscoped query was written, or an index was narrowed back.
};

const keyOf = (q) => `${q.file.split("/").pop()}:${q.fn}`;

const unscoped = providerIdQueries.filter((q) => !q.scoped && !q.keyedByOurPk);
const unexpected = unscoped.filter((q) => !(keyOf(q) in BLOCKED));

check("NO unscoped provider-id query exists outside the documented blocked set",
  unexpected.length === 0,
  unexpected.map((q) => `${q.file}:${q.line} ${q.fn}() ${q.table}.${q.providerIds.join("/")}`).join(" | ") || "none");

// The allowlist must be EMPTY. This is the end state the whole audit was
// driving at: not "the exceptions are documented" but "there are none".
check("the BLOCKED allowlist is empty — no provider-id lookup is exempt",
  Object.keys(BLOCKED).length === 0,
  Object.keys(BLOCKED).join(", ") || "empty");

// The other direction: an allowlisted entry that got fixed must be removed
// from BLOCKED, or the list rots into false confidence.
const stillUnscoped = new Set(unscoped.map(keyOf));
for (const entry of Object.keys(BLOCKED)) {
  check(`BLOCKED entry is still real and still unscoped: ${entry}`,
    stillUnscoped.has(entry), BLOCKED[entry]);
}

/* --------------------------------------------------------------------------
   THE DATA MODEL, NOT JUST THE QUERIES.

   Query-level scoping is only half of isolation. While a provider-id unique
   index omitted `environment`, uniqueness was global: the same provider id
   could not exist once per environment, and the read-back serving that index
   could not be scoped without disagreeing with its own ON CONFLICT target.
   Migration 0011 widened all seven. These assertions are what stop a later
   schema edit from silently re-opening the gap.
   -------------------------------------------------------------------------- */
const allUnique = Object.entries(TABLES).flatMap(([v, t]) =>
  t.uniqueIndexes.map((u) => ({ table: v, ...u })));

const PROVIDER_ID_UNIQUE_INDEXES = [
  ["uniq_orders_whop_payment", ["whopPaymentId", "environment"]],
  ["uniq_refunds_provider_refund", ["provider", "whopRefundId", "environment"]],
  ["uniq_disputes_provider_dispute", ["provider", "whopDisputeId", "environment"]],
  ["uniq_alerts_provider_alert", ["provider", "whopAlertId", "environment"]],
  ["uniq_cases_provider_case", ["provider", "whopCaseId", "environment"]],
  ["uniq_creator_earnings_payment_creator", ["whopPaymentId", "firebaseUid", "environment"]],
  ["uniq_creator_transfers_provider_id", ["providerTransferId", "environment"]],
];
for (const [name, expected] of PROVIDER_ID_UNIQUE_INDEXES) {
  const idx = allUnique.find((u) => u.name === name);
  check(`${name} is environment-aware`,
    Boolean(idx) && idx.columns.join(",") === expected.join(","),
    idx ? `(${idx.columns.join(", ")})` : "INDEX NOT FOUND");
}

// Stated generically as well, so a NEW provider-id unique index added later
// cannot omit environment and slip past the named list above.
{
  const offenders = allUnique.filter((u) => {
    const t = TABLES[u.table];
    if (!t?.hasEnv) return false;
    return u.columns.some(isProviderId) && !u.columns.includes("environment");
  });
  check("NO unique index keys a provider id without environment",
    offenders.length === 0,
    offenders.map((u) => `${u.name} (${u.columns.join(", ")})`).join(" | ") || "none");
}

// An ON CONFLICT target that no longer matches its unique index raises
// "there is no unique or exclusion constraint matching the ON CONFLICT
// specification" at RUNTIME, not at build. Schema and code must ship together.
{
  const mismatches = [];
  for (const file of sourceFiles) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("onConflictDoUpdate") && !src.includes("onConflictDoNothing")) continue;
    for (const m of src.matchAll(/target:\s*\[([^\]]*)\]/g)) {
      const cols = m[1].split(",").map((c) => c.trim()).filter(Boolean);
      const tableName = cols[0]?.split(".")[0]?.replace(/^schema\./, "");
      const t = TABLES[tableName];
      if (!t?.hasEnv) continue;
      const colNames = cols.map((c) => c.split(".").pop());
      if (colNames.some(isProviderId) && !colNames.includes("environment")) {
        mismatches.push(`${file}: [${colNames.join(", ")}]`);
      }
    }
  }
  check("every ON CONFLICT target on a provider-id index includes environment",
    mismatches.length === 0, mismatches.join(" | ") || "none");
}

// The migration exists, is NEW (never an edit to an applied one), and is
// registered in the journal.
{
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  const tags = journal.entries.map((e) => e.tag);
  check("migration 0011 is registered in the drizzle journal",
    tags.includes("0011_environment_aware_unique_indexes"), tags.slice(-2).join(", "));
  const sqlText = readFileSync("drizzle/0011_environment_aware_unique_indexes.sql", "utf8");
  for (const [name] of PROVIDER_ID_UNIQUE_INDEXES) {
    check(`the migration replaces ${name}`,
      sqlText.includes(`DROP INDEX "${name}"`) &&
      sqlText.includes(`RENAME TO "${name}"`));
  }
  check("the migration preserves both partial predicates",
    (sqlText.match(/WHERE whop_payment_id is not null/g) ?? []).length === 1 &&
    (sqlText.match(/WHERE provider_transfer_id is not null/g) ?? []).length === 1);
  check("the migration creates before it drops, so uniqueness is never unenforced",
    sqlText.indexOf("CREATE UNIQUE INDEX") < sqlText.indexOf("DROP INDEX"));
  // Migrations 0000-0010 are already applied and must not be edited.
  const applied = ["0002_misty_obadiah_stane", "0005_slippery_hitman", "0006_wise_unus",
    "0010_creator_money_notifications_rate_limits"];
  check("no already-applied migration was edited to add environment",
    applied.every((tag) => {
      const t = readFileSync(`drizzle/${tag}.sql`, "utf8");
      return !/USING btree \("whop_payment_id","environment"\)/.test(t) &&
        !/"whop_refund_id","environment"/.test(t) &&
        !/"whop_payment_id","firebase_uid","environment"/.test(t);
    }));
}

/* --------------------------------------------------------------------------
   The paths that WERE fixed must stay fixed. Named explicitly, because a
   count of scoped queries would pass if one regressed and another appeared.
   -------------------------------------------------------------------------- */
const MUST_STAY_SCOPED = [
  ["creator-earnings.ts", "recordCreatorEarning"],
  ["payment-refunds.ts", "getRefundByProviderId"],
  ["payment-disputes.ts", "getDisputeByProviderId"],
  ["payment-disputes.ts", "getAlertByProviderId"],
  ["payment-disputes.ts", "getCaseByProviderId"],
  ["creator-earnings.ts", "freezeForDispute"],
  ["creator-earnings.ts", "unfreezeFromDispute"],
  ["creator-earnings.ts", "reverseForDispute"],
  ["creator-earnings.ts", "reverseForRefund"],
  ["payment-refunds.ts", "listRefundsForPaymentLocal"],
  ["payment-refunds.ts", "localCompletedRefundTotal"],
  ["payment-disputes.ts", "listDisputesForPaymentLocal"],
  // Re-baselined: the two guessed-status mutators were replaced by a
  // provider-authoritative refresh and its reconcile/retry paths. The
  // environment-scoping property is unchanged and still asserted.
  // Only the refresh matches on a PROVIDER id. retryTransfer and
  // reconcileTransfer key on our own uuid primary key (they scope by
  // environment too, asserted in connected-account-test), so they make no
  // provider-id query for this sweep to judge.
  ["creator-transfers.ts", "refreshTransferFromProvider"],
  ["notification-triggers.ts", "notifyAccountUpdated"],
  ["notification-triggers.ts", "notifyPaymentSettled"],
  ["notification-triggers.ts", "notifyPayoutCompleted"],
  ["notification-triggers.ts", "notifyPayoutReversed"],
  ["notification-triggers.ts", "notifyDisputeOpened"],
  ["whop-child-router.ts", "resolveChildAccount"],
  ["connected-accounts.ts", "updateConnectedAccountStatus"],
  ["reconcile.ts", "reconcilePaymentAgainstProvider"],
  ["reconcile.ts", "reconcileDisputesInternal"],
];
for (const [file, fn] of MUST_STAY_SCOPED) {
  const qs = providerIdQueries.filter((q) => q.file.endsWith(file) && q.fn === fn);
  check(`${file}:${fn}() scopes every provider-id query it makes`,
    qs.length > 0 && qs.every((q) => q.scoped),
    `${qs.length} query(ies)`);
}

/* --------------------------------------------------------------------------
   THE ENVIRONMENT MUST COME FROM THE TRUSTED HELPER, NOWHERE ELSE.
   -------------------------------------------------------------------------- */
{
  const codeOnly = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const offenders = [];
  for (const file of sourceFiles) {
    const code = codeOnly(readFileSync(file, "utf8"));
    // An `environment` bound out of a payload, body, query or route param.
    if (/(?:const|let)\s+environment\s*=[^;]*?(?:\bdata\.|\broot\.|\bbody\.|payload|searchParams|\breq\.|\brequest\.|params\.)/s.test(code)) {
      offenders.push(file);
    }
  }
  check("no module derives `environment` from a payload, body, query or route param",
    offenders.length === 0, offenders.join(", ") || "none");

  // Every module that scopes a query must obtain the value from the one
  // helper, OR receive it as the typed `WhopEnvironmentName` parameter. The
  // TYPE is what makes the second form trustworthy: a raw payload string
  // cannot reach it without a cast, and the cast check below forbids that.
  // (This is precisely the hole the old notifyAccountUpdated had — it took a
  // plain `string` and cast it with `as never` at the query.)
  const scopingFiles = [...new Set(providerIdQueries.filter((q) => q.scoped).map((q) => q.file))];
  const missing = scopingFiles.filter((f) => {
    const src = readFileSync(f, "utf8");
    const viaHelper = /getWhopEnvironment|resolveTransferEnvironment|resolvePlatformConfig/.test(src);
    const viaTypedParam = /environment:\s*WhopEnvironmentName/.test(src) ||
      /environment:\s*"sandbox"\s*\|\s*"production"/.test(src);
    return !viaHelper && !viaTypedParam;
  });
  check("every module that scopes a query sources the environment from the trusted helper or a typed parameter",
    missing.length === 0, missing.join(", ") || "none");

  // No module may launder an untrusted value into the environment type.
  const casters = sourceFiles.filter((f) => {
    const code = codeOnly(readFileSync(f, "utf8"));
    return /\.environment\s+as\s+never|environment\s+as\s+WhopEnvironmentName|environment\s+as\s+"sandbox"/.test(code);
  });
  check("no module casts an untrusted value into the environment type",
    casters.length === 0, casters.join(", ") || "none");

  // A SERVER module taking the environment as a parameter must type it, never
  // accept a bare string — that is the shape an unvalidated payload arrives in.
  // Scoped to the server tree on purpose: a client component's response DTO
  // types what the server sent and never reaches a query, so it is not this
  // rule's business.
  const serverFiles = sourceFiles.filter((f) => f.startsWith("src/lib/server/") || f.startsWith("src/app/api/"));
  const looseParams = serverFiles.filter((f) => {
    const code = codeOnly(readFileSync(f, "utf8"));
    return /^\s*environment:\s*string\s*[,;]?\s*$/m.test(code);
  });
  check("no function accepts the environment as an untyped string",
    looseParams.length === 0, looseParams.join(", ") || "none");
  check("and the helper itself reads only process.env",
    (() => {
      const p = readFileSync("src/lib/server/whop-payments.ts", "utf8");
      const fn = p.slice(p.indexOf("export function getWhopEnvironment"), p.indexOf("export function getWhopCompanyId"));
      return fn.includes("resolveWhopPayments(env)") && !/body|payload|request|searchParams/i.test(fn);
    })());
}

/* --------------------------------------------------------------------------
   FAIL CLOSED: a module that scopes must refuse when it cannot resolve,
   never fall back to a literal environment.
   -------------------------------------------------------------------------- */
{
  const fallbackOffenders = [];
  for (const file of [...new Set(providerIdQueries.map((q) => q.file))]) {
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/getWhopEnvironment\(\)\s*(?:\?\?|\|\|)\s*["']/.test(code)) fallbackOffenders.push(file);
  }
  check("no module defaults a missing environment to a literal sandbox/production",
    fallbackOffenders.length === 0, fallbackOffenders.join(", ") || "none");
}

/* --------------------------------------------------------------------------
   THE OUR-ID SIBLING CLASS.

   The rule above is about PROVIDER ids. But a creator's earnings are keyed on
   OUR firebase uid, and one uid has rows in both environments — so an unscoped
   balance summed sandbox test money together with real earnings, and an
   unscoped withdrawal scan reserved against that mixed total. Different key,
   same isolation objective, and the money consequence is more direct.
   -------------------------------------------------------------------------- */
{
  const earningsByUid = [];
  for (const file of sourceFiles) {
    const src = readFileSync(file, "utf8");
    if (!/creatorEarnings\.firebaseUid/.test(src)) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
    (function visit(n) {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.getText() === "where" && n.arguments.length) {
        const p = n.arguments[0].getText();
        if (/creatorEarnings\.firebaseUid/.test(p)) {
          earningsByUid.push({
            file, fn: enclosingFunction(n),
            line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
            scoped: /creatorEarnings\.environment/.test(p),
          });
        }
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  check("every creator-earnings query keyed on our firebase uid is environment-scoped",
    earningsByUid.length > 0 && earningsByUid.every((q) => q.scoped),
    earningsByUid.filter((q) => !q.scoped).map((q) => `${q.file}:${q.line} ${q.fn}()`).join(" | ") ||
      `${earningsByUid.length} query(ies), all scoped`);

  for (const [file, fn] of [
    ["creator-earnings.ts", "getCreatorBalance"],
    ["creator-withdrawals.ts", "requestWithdrawal"],
  ]) {
    const qs = earningsByUid.filter((q) => q.file.endsWith(file) && q.fn === fn);
    check(`${file}:${fn}() scopes its earnings scan by environment`,
      qs.length > 0 && qs.every((q) => q.scoped), `${qs.length} query(ies)`);
  }

  // Both must fail closed rather than fall back to an unscoped scan.
  for (const f of ["src/lib/server/creator-earnings.ts", "src/lib/server/creator-withdrawals.ts"]) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check(`${f.split("/").pop()} refuses to proceed when the environment is unresolvable`,
      /const environment = getWhopEnvironment\(\);\s*\n\s*if \(!environment\) return/.test(code));
  }
}

/* --------------------------------------------------------------------------
   THE SWEEP SIBLING CLASS: a whole-table read on an environment-scoped
   financial table with no predicate at all. These carry no provider id, so
   the check above cannot see them.
   -------------------------------------------------------------------------- */
{
  const SWEEPABLE = ["paymentDisputes", "disputeAlerts", "resolutionCenterCases", "creatorTransfers", "creatorEarnings"];
  const sweeps = [];
  for (const file of sourceFiles) {
    const src = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
    (function visit(n) {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.getText() === "from" && n.arguments.length === 1) {
        const tbl = n.arguments[0].getText().replace(/^schema\./, "");
        if (SWEEPABLE.includes(tbl)) {
          // A TRUE sweep: no predicate at all. Queries that DO carry a
          // predicate are judged by the provider-id check above (if they match
          // on a provider id) or are keyed by one of our own identifiers, which
          // is a different question and deliberately out of this rule's scope.
          let chain = n; let hops = 0;
          while (chain.parent && hops++ < 10 &&
                 (ts.isPropertyAccessExpression(chain.parent) || ts.isCallExpression(chain.parent))) {
            chain = chain.parent;
          }
          if (!/\.where\(/.test(chain.getText())) {
            sweeps.push({
              file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
              table: tbl, fn: enclosingFunction(n),
            });
          }
        }
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  // Operator-facing listings are intentionally whole-table: they are views,
  // not reconciliation inputs, and they render the environment column.
  // Anything else is a defect.
  const SWEEP_ALLOWED = new Set([
    "listAllDisputes", "listAllAlerts", "listAllCases",
    "listWithdrawals", "listAllRefunds", "listPendingWithdrawals",
  ]);
  const badSweeps = sweeps.filter((s) => !SWEEP_ALLOWED.has(s.fn));
  check("no reconciliation path sweeps an environment-scoped financial table unscoped",
    badSweeps.length === 0,
    badSweeps.map((s) => `${s.file}:${s.line} ${s.fn}() ${s.table}`).join(" | ") || "none");
}

/* ============================== summary ============================== */

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
