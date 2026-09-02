/**
 * Unit tests for the collector's validation boundary.
 *
 * This is where the privacy guarantee is actually enforced, so it is asserted
 * directly rather than inferred from an HTTP status. Runs the TypeScript
 * source through the same transpile trick the i18n checker uses, so there is
 * no build step to keep in sync.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function load(file) {
  const source = readFileSync(file, "utf8").replace(/^import[^;]+;$/gms, "");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  // The validator references these two from ./schema; supply the real values.
  const INSTRUMENTED_EVENTS = new Set(["page_view", "cta_clicked", "faq_searched"]);
  const isEventName = (v) => typeof v === "string";
  new Function("module", "exports", "INSTRUMENTED_EVENTS", "isEventName", js)(
    mod,
    mod.exports,
    INSTRUMENTED_EVENTS,
    isEventName,
  );
  return mod.exports;
}

const { sanitiseMetadata, parseEvent } = load("src/lib/analytics/validate.ts");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/* --------------------------- metadata allow-list -------------------------- */

const hostile = sanitiseMetadata({
  email: "someone@example.com",
  full_name: "Dana Levi",
  bio: "private bio text",
  search_query: "what the user typed",
  password: "hunter2",
  firebase_token: "eyJhbGciOiJSUzI1NiJ9",
  whop_token: "wh_secret",
  ip: "203.0.113.9",
  user_agent: "Mozilla/5.0 …",
  amount_minor: 999999,
  transaction_type: "platform_fee",
  cta_id: "creator_hero_start_earning",
  result_count: 12,
});

check("allow-listed keys survive", hostile.cta_id === "creator_hero_start_earning" && hostile.result_count === 12);
check(
  "every non-allow-listed key is dropped",
  Object.keys(hostile).length === 2,
  `kept: ${Object.keys(hostile).join(", ")}`,
);
for (const key of ["email", "full_name", "bio", "search_query", "password", "firebase_token", "whop_token", "ip", "user_agent", "amount_minor", "transaction_type"]) {
  check(`drops "${key}"`, !(key in hostile));
}

check("rejects a free-text cta_id", sanitiseMetadata({ cta_id: "Start Earning!" }) === undefined);
check("clamps an absurd result_count", sanitiseMetadata({ result_count: 9e9 }).result_count === 100000);
check("rejects an out-of-set enum", sanitiseMetadata({ mode: "administrator" }) === undefined);
check("returns undefined for an empty object", sanitiseMetadata({}) === undefined);
check("returns undefined for an array", sanitiseMetadata([1, 2, 3]) === undefined);

/* ------------------------------ event parsing ----------------------------- */

const base = {
  name: "page_view",
  occurred_at: new Date().toISOString(),
  session_id: crypto.randomUUID(),
  visitor_id: crypto.randomUUID(),
  locale: "en",
  path: "/en/discover",
};

check("accepts a well-formed event", parseEvent(base) !== null);
check("strips a query string from the path", parseEvent({ ...base, path: "/en?token=secret" })?.path === "/en");
check("rejects a non-instrumented event", parseEvent({ ...base, name: "payment_completed" }) === null);
check("rejects a bad locale", parseEvent({ ...base, locale: "de" }) === null);
check("rejects a malformed visitor id", parseEvent({ ...base, visitor_id: "not-a-uuid" })?.visitor_id === null);
check("rejects a path without a leading slash", parseEvent({ ...base, path: "en" }) === null);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
