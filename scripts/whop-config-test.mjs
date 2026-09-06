/**
 * Unit tests for the Whop payments configuration boundary.
 *
 * This is where a mis-set environment variable either stops the process or
 * moves real money, so the rules are asserted directly rather than inferred
 * from a successful call. Runs the TypeScript source through the same
 * transpile trick the collector tests use, so there is no build step to keep
 * in sync — the SDK import is stripped, which is fine because every function
 * exercised here is pure configuration logic that never constructs a client.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function load(file) {
  const source = readFileSync(file, "utf8").replace(/^import[^;]+;$/gms, "");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  // The module references the SDK only inside getWhopPaymentsClient, which is
  // not called here; a stub keeps the stripped import from being a reference
  // error.
  class WhopClient {}
  new Function("module", "exports", "WhopClient", js)(mod, mod.exports, WhopClient);
  return mod.exports;
}

const {
  resolveWhopPayments,
  isWhopPaymentsConfigured,
  getWhopEnvironment,
  getWhopCompanyId,
  redactWhopSecrets,
  describeWhopError,
  WHOP_API_BASE_URLS,
} = load("src/lib/server/whop-payments.ts");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const KEY = "apik_test_not_a_real_key";
const COMPANY = "biz_testcompany";
const sandbox = { WHOP_API_KEY: KEY, WHOP_COMPANY_ID: COMPANY, WHOP_ENV: "sandbox" };
const production = { ...sandbox, WHOP_ENV: "production" };

const SANDBOX_URL = "https://sandbox-api.whop.com/api/v1";
const PRODUCTION_URL = "https://api.whop.com/api/v1";

/* ------------------------- A. sandbox selects sandbox --------------------- */

const s = resolveWhopPayments(sandbox);
check("sandbox config resolves", s.ok === true);
check("sandbox uses the sandbox API", s.ok && s.config.baseUrl === SANDBOX_URL, s.ok ? s.config.baseUrl : "");
check("sandbox base url is not production", s.ok && s.config.baseUrl !== PRODUCTION_URL);
check("getWhopEnvironment reports sandbox", getWhopEnvironment(sandbox) === "sandbox");
check("getWhopCompanyId returns the configured id", getWhopCompanyId(sandbox) === COMPANY);
check("isWhopPaymentsConfigured is true", isWhopPaymentsConfigured(sandbox) === true);

/* ---------------------- B. production is not sandbox ---------------------- */

const p = resolveWhopPayments(production);
check("production config resolves", p.ok === true);
check("production does NOT use the sandbox API", p.ok && p.config.baseUrl !== SANDBOX_URL);
check("production uses the production API", p.ok && p.config.baseUrl === PRODUCTION_URL, p.ok ? p.config.baseUrl : "");
check("the two environments never share a base url", WHOP_API_BASE_URLS.sandbox !== WHOP_API_BASE_URLS.production);

/* --------------------- C. invalid WHOP_ENV fails closed ------------------- */

for (const bad of ["staging", "test", "prod", "live", "SANDBOX", "Sandbox", "Production", "1", "true"]) {
  const r = resolveWhopPayments({ ...sandbox, WHOP_ENV: bad });
  check(
    `WHOP_ENV=${JSON.stringify(bad)} fails closed`,
    r.ok === false && r.reason === "invalid_environment",
    r.ok ? "ACCEPTED" : r.reason,
  );
}

// Surrounding whitespace is an env-file accident, not an ambiguity: it is
// trimmed, and trimming can only ever produce one of the two exact names.
const padded = resolveWhopPayments({ ...sandbox, WHOP_ENV: "  sandbox  " });
check("whitespace around a valid environment is tolerated", padded.ok === true);
check("a padded sandbox value still selects sandbox", padded.ok && padded.config.baseUrl === SANDBOX_URL);

/* --------------------------- D/E. missing values -------------------------- */

check("missing API key => unconfigured", resolveWhopPayments({ ...sandbox, WHOP_API_KEY: undefined }).reason === "missing_api_key");
check("blank API key => unconfigured", resolveWhopPayments({ ...sandbox, WHOP_API_KEY: "   " }).reason === "missing_api_key");
check("missing company id => unconfigured", resolveWhopPayments({ ...sandbox, WHOP_COMPANY_ID: undefined }).reason === "missing_company_id");
check("empty company id => unconfigured", resolveWhopPayments({ ...sandbox, WHOP_COMPANY_ID: "" }).reason === "missing_company_id");
check("isWhopPaymentsConfigured is false with no key", isWhopPaymentsConfigured({ ...sandbox, WHOP_API_KEY: undefined }) === false);
check("an empty environment yields no config at all", resolveWhopPayments({}).ok === false);

/* ---------------------- F. malformed company id rejected ------------------ */

for (const bad of ["company_123", "biz", "biz_", "user_abc", "BIZ_abc", "abiz_123"]) {
  const r = resolveWhopPayments({ ...sandbox, WHOP_COMPANY_ID: bad });
  check(
    `company id ${JSON.stringify(bad)} rejected`,
    r.ok === false && r.reason === "invalid_company_id",
    r.ok ? "ACCEPTED" : r.reason,
  );
}
check("a well-formed biz_ id is accepted", resolveWhopPayments({ ...sandbox, WHOP_COMPANY_ID: "biz_abc123" }).ok === true);

/* ------------------- G. the API key never reaches output ------------------ */

check("resolved config carries no api key", JSON.stringify(resolveWhopPayments(sandbox)).includes(KEY) === false);
check("redactWhopSecrets removes the key", redactWhopSecrets(`Authorization: Bearer ${KEY}`, sandbox).includes(KEY) === false);
check("redaction leaves a marker", redactWhopSecrets(`Bearer ${KEY}`, sandbox).includes("[redacted]"));
check(
  "describeWhopError scrubs a key quoted in an error",
  describeWhopError(new Error(`401 from https://x/y with token ${KEY}`), sandbox).includes(KEY) === false,
);
check("describeWhopError keeps a usable message", describeWhopError(new Error("403 forbidden"), sandbox) === "403 forbidden");
check("a non-Error is described without throwing", describeWhopError({ weird: true }, sandbox) === "unknown error");

/* ------- H. a broken sandbox setup can never fall through to production ---- */

for (const broken of [
  { ...sandbox, WHOP_ENV: undefined },
  { ...sandbox, WHOP_ENV: "" },
  { ...sandbox, WHOP_ENV: "sandbx" },
  { ...sandbox, WHOP_ENV: "SANDBOX" },
]) {
  const r = resolveWhopPayments(broken);
  const leaked = r.ok && r.config.baseUrl === PRODUCTION_URL;
  check(
    `broken sandbox setup (WHOP_ENV=${JSON.stringify(broken.WHOP_ENV)}) never becomes production`,
    r.ok === false && !leaked,
    r.ok ? "RESOLVED " + r.config.baseUrl : r.reason,
  );
}
check(
  "absent WHOP_ENV does not default to production",
  resolveWhopPayments({ WHOP_API_KEY: KEY, WHOP_COMPANY_ID: COMPANY }).reason === "missing_environment",
);
check(
  "only the two known environments exist",
  Object.keys(WHOP_API_BASE_URLS).sort().join(",") === "production,sandbox",
);

/* ---------------- I. existing OAuth configuration is independent ---------- */

const oauthOnly = {
  WHOP_CLIENT_ID: "client-id",
  WHOP_CLIENT_SECRET: "client-secret",
  WHOP_REDIRECT_URI: "http://localhost:3000/api/whop/callback",
};
check("OAuth-only env leaves payments unconfigured", isWhopPaymentsConfigured(oauthOnly) === false);
check("payments do not read WHOP_CLIENT_ID", resolveWhopPayments(oauthOnly).reason === "missing_api_key");
check(
  "payments config ignores OAuth values entirely",
  JSON.stringify(resolveWhopPayments({ ...sandbox, ...oauthOnly })).includes("client-secret") === false,
);

// The legacy OAuth module is gone; account linking now lives in
// src/lib/server/whop-oauth.ts and shares nothing with payments.
check("the legacy OAuth module no longer exists", existsSync("src/lib/whop.ts") === false);
const linking = readFileSync("src/lib/server/whop-oauth.ts", "utf8");
check("the linking module exposes no payments helper", linking.includes("getWhopPaymentsClient") === false);
check("the linking module reads no payments credential", /WHOP_API_KEY|WHOP_WEBHOOK_SECRET|WHOP_COMPANY_ID/.test(linking) === false);
// Comments in the payments module name the OAuth variables to explain the
// separation; what matters is that no code reads them.
const paymentsCode = readFileSync("src/lib/server/whop-payments.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
check("the payments module reads no OAuth credential", /WHOP_CLIENT_ID|WHOP_CLIENT_SECRET|WHOP_REDIRECT_URI/.test(paymentsCode) === false);
check(
  "the linking flow uses its own cookie, unrelated to payments",
  readFileSync("src/app/api/whop/connect/route.ts", "utf8").includes("cr_whop_link"),
);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
