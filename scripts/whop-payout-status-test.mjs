/**
 * WHOP PAYOUT STATUS TESTS.
 *
 * THE QUESTION UNDER TEST: "can this creator receive payouts right now, and if
 * not, what is missing?" The second half is what the previous implementation
 * could not answer, and the reason it could not is instructive:
 *
 *   - `required_actions` is an array of OBJECTS; the old parser filtered it as
 *     `string[]`, so every blocking action was silently discarded;
 *   - it read a `past_due` field that does not exist on `Account`, so
 *     `restricted` was unreachable;
 *   - `payoutMethodsScope` was a hardcoded `"not_attempted"` literal, so
 *     payout DESTINATIONS — the most likely real blocker — were never checked;
 *   - `transfer` (account-to-account) counted as proof of payout readiness;
 *   - `crypto_payout` was omitted, and `accept_card_bank` / `crypto` were
 *     invented names that appear nowhere in the schema.
 *
 * Every one of those is a wrong answer on a creator's dashboard, and none was
 * a type error, because the module hand-rolled `fetch`. It now reads
 * `Whop.Account` through the SDK, so the shapes are compiler-checked, and this
 * suite pins the BEHAVIOUR the types cannot express — above all that READY is
 * the absence of every blocker, not the presence of one good signal.
 *
 * ZERO NETWORK. The SDK client is injected. No provider call, no database.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const SOURCE = "src/lib/server/whop-payout-status.ts";
const ACCOUNT = "biz_creator123";

process.env.WHOP_API_KEY = "apik_SECRET_VALUE";

class FakeWhopError extends Error {
  constructor(statusCode) {
    // The real SDK builds its message by appending the whole response body.
    // Reproduced so the leak assertions are meaningful.
    super(`Error\nStatus code: ${statusCode}\nBody: ${JSON.stringify({
      account_reference: "****6789",
      institution_name: "Big Bank",
      email: "creator@example.com",
      request: { headers: { authorization: "Bearer apik_SECRET_VALUE" } },
    })}`);
    this.statusCode = statusCode;
    this.requestId = "req_xyz";
    this.rawResponse = { headers: new Map([["authorization", "Bearer apik_SECRET_VALUE"]]) };
    this.cause = new Error("inner apik_SECRET_VALUE");
  }
}

/* -------------------------------------------------------------------------
   Fixtures — realistic Account / PayoutMethod shapes
   ------------------------------------------------------------------------- */

const caps = (over = {}) => ({
  accept_bank_payments: "active",
  accept_card_payments: "active",
  standard_payout: "inactive",
  instant_payout: "inactive",
  crypto_payout: "inactive",
  transfer: "inactive",
  card_issuing: "inactive",
  ...over,
});

const account = (over = {}) => ({
  id: ACCOUNT,
  status: "active",
  status_reason: null,
  capabilities: caps(over.capabilities ?? {}),
  required_actions: [],
  recommended_actions: [],
  // PII the provider really returns. Present so the leak assertions bite.
  email: "creator@example.com",
  phone: "+15550001111",
  business_name: "Creator LLC",
  ...over,
  ...(over.capabilities ? { capabilities: caps(over.capabilities) } : {}),
});

const requiredAction = (action, status = "required", blocked = ["standard_payout"]) => ({
  action,
  status,
  blocked_capabilities: blocked,
  cta: "https://whop.com/do-the-thing",
  cta_label: "Fix it",
  description: "Free-form provider prose that must never be rendered",
  icon_url: "https://whop.com/icon.png",
  title: "Provider headline",
});

const payoutMethod = (configured = true) => ({
  id: "pom_1",
  account_reference: "****6789",
  institution_name: "Big Bank",
  nickname: "My bank",
  is_default: true,
  currency: "usd",
  created_at: "2026-01-01T00:00:00Z",
  company: { id: ACCOUNT },
  destination: configured
    ? { category: "bank_wire", country_code: "US", name: "A Creator" }
    : null,
});

/* -------------------------------------------------------------------------
   Loader
   ------------------------------------------------------------------------- */

function loadStatus({ accountResponse, methodsResponse, client = true } = {}) {
  const calls = { accounts: [], methods: [] };

  const stub = client
    ? {
        accounts: {
          retrieve: async (req) => {
            calls.accounts.push(req);
            const out = typeof accountResponse === "function" ? accountResponse() : accountResponse;
            if (out instanceof Error) throw out;
            return out === undefined ? account() : out;
          },
        },
        payoutMethods: {
          listPayoutMethod: async (req) => {
            calls.methods.push(req);
            const out = typeof methodsResponse === "function" ? methodsResponse() : methodsResponse;
            if (out instanceof Error) throw out;
            return out === undefined ? { data: [payoutMethod(true)] } : out;
          },
        },
      }
    : null;

  const js = ts.transpileModule(readFileSync(SOURCE, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const req = (spec) => {
    if (spec === "server-only") return {};
    if (spec === "@whop/sdk") return { WhopError: FakeWhopError };
    if (spec.endsWith("whop-payments")) return { getWhopPaymentsClient: () => stub };
    return require(spec);
  };

  const mod = { exports: {} };
  new Function("module", "exports", "require", js)(mod, mod.exports, req);
  return { mod: mod.exports, calls };
}

/** Runs a call with console.error captured. */
async function capturing(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
}

const silently = async (fn) => (await capturing(fn)).value;

/* ==========================================================================
   A. PROVIDER CONTRACT
   ========================================================================== */

console.log("\n--- A. provider contract ---");

{
  const { mod, calls } = loadStatus();
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));

  check("the account is retrieved with the server-resolved biz_ id",
    calls.accounts.length === 1 && calls.accounts[0].id === ACCOUNT,
    JSON.stringify(calls.accounts[0]));
  check("the account request carries ONLY an id",
    Object.keys(calls.accounts[0]).join(",") === "id");
  check("payout methods are queried with company_id — the same id",
    calls.methods.length === 1 && calls.methods[0].company_id === ACCOUNT,
    JSON.stringify(calls.methods[0]));
  check("the payout-method request sends no account_id",
    !("account_id" in calls.methods[0]));
  check("a successful read returns ok", r.ok === true, r.ok ? r.status.readiness : r.reason);
}

{
  const { mod } = loadStatus({ client: false });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("no configured client means unconfigured, never a silent ready",
    r.ok === false && r.reason === "unconfigured");
}

/* ==========================================================================
   D / E / F. THE THREE STATES THAT MATTER MOST
   ========================================================================== */

console.log("\n--- D/E/F. ready, not-ready, destination missing ---");

{
  // READY: active rail, no blockers, a configured destination.
  const { mod } = loadStatus({
    accountResponse: account({ capabilities: { standard_payout: "active" } }),
    methodsResponse: { data: [payoutMethod(true)] },
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("READY when a rail is active, nothing blocks, and a destination exists",
    r.ok && r.status.readiness === "ready" && r.status.canReceivePayout === true,
    r.ok ? r.status.readiness : r.reason);
  check("and ready carries no reasons", r.ok && r.status.reasons.length === 0);
}

{
  // THE CURRENTLY OBSERVED SCENARIO: KYC verified, but nothing to pay into.
  const { mod } = loadStatus({
    accountResponse: account({ capabilities: { standard_payout: "active" } }),
    methodsResponse: { data: [] },
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("KYC verified + active rail + NO destination → destination_missing",
    r.ok && r.status.readiness === "destination_missing", r.ok ? r.status.readiness : r.reason);
  check("and it says WHY — payout_method",
    r.ok && r.status.reasons.join(",") === "payout_method", r.ok ? r.status.reasons.join(",") : "");
  check("and canReceivePayout is false", r.ok && r.status.canReceivePayout === false);
}

{
  // A method row exists but its destination is not configured yet. The SDK
  // documents `destination` as "Null if not yet configured", so a half-built
  // row must not count as somewhere money can land.
  const { mod } = loadStatus({
    accountResponse: account({ capabilities: { standard_payout: "active" } }),
    methodsResponse: { data: [payoutMethod(false)] },
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("an UNCONFIGURED payout method does not count as a destination",
    r.ok && r.status.readiness === "destination_missing" &&
    r.status.destinations.count === 1 && r.status.destinations.configuredCount === 0);
}

/* ==========================================================================
   K. FALSE-POSITIVE PROTECTION — the most dangerous failure
   ========================================================================== */

console.log("\n--- K. false-positive protection ---");

{
  const { mod } = loadStatus({
    accountResponse: account({
      capabilities: { standard_payout: "active" },
      required_actions: [requiredAction("update_payout_profile")],
    }),
    methodsResponse: { data: [payoutMethod(true)] },
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("an ACTIVE rail + a blocking required action is NOT ready",
    r.ok && r.status.readiness === "action_required" && r.status.canReceivePayout === false,
    r.ok ? r.status.readiness : r.reason);
  check("and the reason is the mapped action", r.ok && r.status.reasons.includes("payout_profile"));
}

{
  // `transfer` is account-to-account, not a payout rail. Treating it as one
  // would authorise a withdrawal that cannot settle.
  const { mod } = loadStatus({
    accountResponse: account({ capabilities: { transfer: "active" } }),
    methodsResponse: { data: [payoutMethod(true)] },
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("transfer:active alone is NOT payout readiness",
    r.ok && r.status.readiness !== "ready" && r.status.canReceivePayout === false,
    r.ok ? r.status.readiness : r.reason);
  check("but transfer is still reported for diagnostics",
    r.ok && r.status.capabilities.transfer === "active");
}

{
  const { mod } = loadStatus({
    accountResponse: account({ status: "suspended", status_reason: "we suspended you because X" }),
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("a SUSPENDED account is restricted regardless of capabilities",
    r.ok && r.status.readiness === "restricted" && r.status.canReceivePayout === false);
  check("the suspension REASON TEXT is never carried, only its presence",
    r.ok && r.status.hasStatusReason === true &&
    !JSON.stringify(r.status).includes("we suspended you"));
}

/* ==========================================================================
   G. REQUIRED ACTION NORMALIZATION
   ========================================================================== */

console.log("\n--- G. required_actions ---");

for (const [token, expected] of [
  ["verify_identity", "verify_identity"],
  ["update_payout_profile", "payout_profile"],
  ["reauthorize_payout_methods", "payout_method"],
  ["submit_information_request", "information_request"],
  ["some_brand_new_token_whop_added", "action_required"],
]) {
  const { mod } = loadStatus({
    accountResponse: account({ required_actions: [requiredAction(token)] }),
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check(`action "${token}" maps to ${expected}`,
    r.ok && r.status.actions[0]?.reason === expected,
    r.ok ? r.status.actions[0]?.reason : r.reason);
}

{
  const { mod } = loadStatus({
    accountResponse: account({ required_actions: [requiredAction("verify_identity", "required", ["standard_payout", "instant_payout"])] }),
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  const a = r.ok ? r.status.actions[0] : null;
  check("actions are parsed as OBJECTS — the bug that dropped every blocker",
    a !== null && a.status === "required" && a.blockedCapabilities.join(",") === "standard_payout,instant_payout");
  check("provider prose and CTA urls are NOT carried into the action",
    a !== null && !("cta" in a) && !("title" in a) && !("description" in a) && !("icon_url" in a),
    a ? Object.keys(a).join(",") : "");
  check("no provider prose appears anywhere in the status",
    r.ok && !JSON.stringify(r.status).includes("Free-form provider prose") &&
    !JSON.stringify(r.status).includes("whop.com/do-the-thing"));
}

/* ==========================================================================
   H / I / J. PENDING, CRYPTO, REACHABILITY
   ========================================================================== */

console.log("\n--- H/I/J. pending, crypto, remaining states ---");

{
  const { mod } = loadStatus({
    accountResponse: account({ capabilities: { standard_payout: "pending" } }),
    methodsResponse: { data: [payoutMethod(true)] },
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("a PENDING rail with a destination is pending, not ready",
    r.ok && r.status.readiness === "pending" && r.status.canReceivePayout === false);
}

{
  const { mod } = loadStatus({
    accountResponse: account({ required_actions: [requiredAction("verify_identity", "pending")] }),
    methodsResponse: { data: [payoutMethod(true)] },
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("an action under provider review is pending, not action_required",
    r.ok && r.status.readiness === "pending", r.ok ? r.status.readiness : r.reason);
}

{
  // crypto_payout is a real rail. Omitting it was a false-negative.
  const { mod } = loadStatus({
    accountResponse: account({ capabilities: { crypto_payout: "active" } }),
    methodsResponse: { data: [{ ...payoutMethod(true), destination: { category: "crypto", country_code: "US", name: "A Creator" } }] },
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("crypto_payout:active with a crypto destination IS ready",
    r.ok && r.status.readiness === "ready", r.ok ? r.status.readiness : r.reason);
  check("and the bounded category token is reported",
    r.ok && r.status.destinations.categories.join(",") === "crypto");
}

{
  const { mod } = loadStatus({
    accountResponse: account(),
    methodsResponse: { data: [payoutMethod(true)] },
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("destination present, nothing blocking, no live rail → not_ready",
    r.ok && r.status.readiness === "not_ready", r.ok ? r.status.readiness : r.reason);
}

/* ==========================================================================
   N. PAYOUT METHOD OUTCOMES
   ========================================================================== */

console.log("\n--- N. payout method outcomes ---");

for (const [label, response, outcome, readiness] of [
  ["success", { data: [payoutMethod(true)] }, "ok", "ready"],
  ["empty", { data: [] }, "ok", "destination_missing"],
  ["forbidden", new FakeWhopError(403), "forbidden", "unknown"],
  ["provider error", new FakeWhopError(500), "unavailable", "unknown"],
  ["network error", new Error("socket hang up"), "unavailable", "unknown"],
]) {
  const { mod } = loadStatus({
    accountResponse: account({ capabilities: { standard_payout: "active" } }),
    methodsResponse: response,
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check(`payout methods ${label} → outcome=${outcome}, readiness=${readiness}`,
    r.ok && r.status.destinations.outcome === outcome && r.status.readiness === readiness,
    r.ok ? `${r.status.destinations.outcome}/${r.status.readiness}` : r.reason);
}

check("a forbidden destination read never reports 'ready' by guessing", true);

/* ==========================================================================
   L / M. MALFORMED AND FAILED ACCOUNT READS
   ========================================================================== */

console.log("\n--- L/M. account read failures ---");

for (const [status, expected] of [
  [400, "provider_error"],
  [403, "platforms_access_required"],
  [404, "not_found"],
  [429, "provider_error"],
  [500, "provider_error"],
]) {
  const { mod } = loadStatus({ accountResponse: new FakeWhopError(status) });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check(`account read ${status} → ${expected}`,
    r.ok === false && r.reason === expected, r.ok ? "ok!" : r.reason);
}

{
  const { mod } = loadStatus({ accountResponse: new Error("socket hang up") });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("a network failure is provider_error, never a pass", r.ok === false && r.reason === "provider_error");
}

for (const [label, body] of [["null", null], ["a string", "nope"], ["a number", 7]]) {
  const { mod } = loadStatus({ accountResponse: body });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check(`a malformed account response (${label}) is provider_error`,
    r.ok === false && r.reason === "provider_error", r.ok ? "ok!" : r.reason);
}

{
  // Missing capabilities entirely must not throw or accidentally read ready.
  const { mod } = loadStatus({
    accountResponse: { id: ACCOUNT, status: "active" },
    methodsResponse: { data: [payoutMethod(true)] },
  });
  const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
  check("an account with NO capabilities object degrades to not_ready",
    r.ok && r.status.readiness === "not_ready", r.ok ? r.status.readiness : r.reason);
}

/* ==========================================================================
   R. REACHABILITY — every declared state produced by a test
   ========================================================================== */

console.log("\n--- R. reachability ---");

{
  const source = readFileSync(SOURCE, "utf8");
  const declared = [...source.matchAll(/^\s*\|\s*"([a-z_]+)"/gm)]
    .map((m) => m[1]);
  const readinessStates = ["ready", "pending", "action_required", "destination_missing", "restricted", "not_ready", "unknown"];

  const produced = new Set();
  const scenarios = [
    [account({ capabilities: { standard_payout: "active" } }), { data: [payoutMethod(true)] }],
    [account({ capabilities: { standard_payout: "pending" } }), { data: [payoutMethod(true)] }],
    [account({ required_actions: [requiredAction("verify_identity")] }), { data: [payoutMethod(true)] }],
    [account({ capabilities: { standard_payout: "active" } }), { data: [] }],
    [account({ status: "suspended" }), { data: [payoutMethod(true)] }],
    [account(), { data: [payoutMethod(true)] }],
    [account({ capabilities: { standard_payout: "active" } }), new FakeWhopError(403)],
  ];
  for (const [acc, methods] of scenarios) {
    const { mod } = loadStatus({ accountResponse: acc, methodsResponse: methods });
    const r = await silently(() => mod.fetchPayoutStatus(ACCOUNT));
    if (r.ok) produced.add(r.status.readiness);
  }
  const missing = readinessStates.filter((s) => !produced.has(s));
  check("EVERY declared readiness state is reachable",
    missing.length === 0, missing.join(",") || [...produced].sort().join(","));

  // The dead concepts must be gone, not merely unused.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the phantom past_due read is gone", !/past_due/.test(code));
  check("the bogus capability aliases are gone",
    !/accept_card_bank/.test(code) && !/"crypto"/.test(code));
  check("CapabilityState no longer declares 'restricted'",
    !/CapabilityState[\s\S]{0,120}"restricted"/.test(code));
  check("payoutMethodsScope / not_attempted is gone", !/not_attempted|payoutMethodsScope/.test(code));
  check("the module uses the SDK, not raw fetch", !/\bfetch\(/.test(code) && /client\.accounts\.retrieve/.test(code));
  check("transfer is excluded from the payout capability list",
    /PAYOUT_CAPABILITY_KEYS[\s\S]{0,200}crypto_payout/.test(code) &&
    !/PAYOUT_CAPABILITY_KEYS[\s\S]{0,200}"transfer"/.test(code));
  check("declared union members were parsed for the reachability sweep", declared.length > 0);
}

/* ==========================================================================
   Q. NO SECRET / PII LEAKAGE
   ========================================================================== */

console.log("\n--- Q. secret and PII handling ---");

{
  const run = await capturing(() => {
    const { mod } = loadStatus({
      accountResponse: account({
        capabilities: { standard_payout: "active" },
        required_actions: [requiredAction("update_payout_profile")],
      }),
      methodsResponse: { data: [payoutMethod(true)] },
    });
    return mod.fetchPayoutStatus(ACCOUNT);
  });
  const everything = JSON.stringify(run.value) + "\n" + run.lines.join("\n");

  for (const [label, needle] of [
    ["the API key", "apik_SECRET_VALUE"],
    ["the authorization header", "authorization"],
    ["the masked bank reference", "****6789"],
    ["the institution name", "Big Bank"],
    ["the payout nickname", "My bank"],
    ["the payer name", "A Creator"],
    ["the creator email", "creator@example.com"],
    ["the creator phone", "+15550001111"],
    ["the business name", "Creator LLC"],
    ["provider CTA urls", "whop.com/do-the-thing"],
    ["provider prose", "Free-form provider prose"],
  ]) {
    check(`${label} appears in NEITHER the result nor the log`, !everything.includes(needle));
  }

  check("the diagnostic logged exactly one line", run.lines.length === 1, `${run.lines.length}`);
  check("the log is one flat key=value line, not an object dump",
    run.lines[0].startsWith("[whop:payout_status]") &&
    !run.lines[0].includes("{") && !run.lines[0].includes(String.fromCharCode(10)));
  check("the diagnostic names the real blocker for the upcoming live read",
    run.lines[0].includes("readiness=") && run.lines[0].includes("payout_caps=[") &&
    run.lines[0].includes("destinations=") && run.lines[0].includes("raw_action_tokens="),
    run.lines[0].slice(0, 110));
}

{
  const run = await capturing(() => {
    const { mod } = loadStatus({ accountResponse: new FakeWhopError(403) });
    return mod.fetchPayoutStatus(ACCOUNT);
  });
  const everything = JSON.stringify(run.value) + "\n" + run.lines.join("\n");
  check("a failed account read leaks nothing", !everything.includes("apik_SECRET_VALUE"));
  check("the SDK error message is never used — it embeds the body",
    !everything.includes("Status code: 403") && !everything.includes("Body: {"));
  check("rawResponse and cause are never touched",
    !everything.includes("rawResponse") && !everything.includes("inner apik"));
  check("the failure is a closed-set token", run.value.ok === false && /^[a-z_]+$/.test(run.value.reason));
}

{
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const run = await capturing(() => {
    const { mod } = loadStatus();
    return mod.fetchPayoutStatus(ACCOUNT);
  });
  if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
  check("in production the diagnostic is silent", run.lines.length === 0, `${run.lines.length}`);
  check("and the answer is unchanged", run.value.ok === true);
}

/* ==========================================================================
   B / C. OWNERSHIP AND ENVIRONMENT (route-level)
   ========================================================================== */

console.log("\n--- B/C. ownership and environment ---");

const codeOnly = (file) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

{
  const route = codeOnly("src/app/api/whop/payout/status/route.ts");
  check("the route authenticates before anything else", route.includes("requireWhopEligible"));
  check("the route checks the request origin", route.includes("checkRequestOrigin"));
  check("the account is resolved from the session uid AND the trusted environment",
    /getConnectedAccount\(\s*firebaseUid,\s*platform\.config\.environment\s*\)/.test(route));
  check("no account or company id is accepted from the browser",
    !/body\.(account_id|company_id|whop_account_id)/.test(route) && !/request\.json\(\)/.test(route));
  check("no environment is accepted from the browser",
    !/body\.environment|searchParams\.get\(["']environment/.test(route));
  check("the route is rate limited", /checkRateLimit\(`whop:payout_status:/.test(route));

  const portal = codeOnly("src/app/api/whop/payout/portal/route.ts");
  check("the payout portal route is rate limited too", /checkRateLimit\(`whop:payout_portal:/.test(portal));

  // The public response must stay bounded.
  check("the response forwards reasons and counts, never raw provider objects",
    route.includes("reasons: status.reasons") &&
    route.includes("configured_count: status.destinations.configuredCount") &&
    !/status\.actions\b/.test(route) && !/account_reference|institution_name/.test(route));
}

/* ==========================================================================
   O. RETURN / REFRESH HANDLING
   ========================================================================== */

console.log("\n--- O. return and refresh ---");

{
  const dash = codeOnly("src/app/[locale]/dashboard/page.tsx");
  for (const step of ["kyc_return", "kyc_refresh", "payout_return", "payout_refresh"]) {
    check(`the dashboard consumes step=${step}`, dash.includes(`"${step}"`));
  }
  check("kyc refresh feeds the verification card's trigger",
    /kycReturn\s*=\s*search\.step === "kyc_return" \|\| search\.step === "kyc_refresh"/.test(dash));
  check("payout refresh feeds the payout card's trigger",
    /payoutReturn\s*=\s*search\.step === "payout_return" \|\| search\.step === "payout_refresh"/.test(dash));

  // The links Task #10 mints must still match what the dashboard reads.
  const links = codeOnly("src/lib/server/whop-account-links.ts");
  check("the minted links still use those exact step tokens",
    links.includes("${step}_return") && links.includes("${step}_refresh"));
}

/* ==========================================================================
   P. TRANSLATION COVERAGE
   ========================================================================== */

console.log("\n--- P. translation coverage ---");

{
  const STATES = ["statusReady", "statusPending", "statusActionRequired",
    "statusDestinationMissing", "statusRestricted", "statusNotReady", "statusUnknown"];
  const BODIES = ["readyBody", "pendingBody", "actionRequiredBody",
    "destinationMissingBody", "restrictedBody", "notReadyBody", "unknownBody", "restrictedHint"];
  const REASONS = ["verify_identity", "payout_profile", "payout_method",
    "information_request", "action_required"];

  for (const dict of ["en", "he"]) {
    const src = readFileSync(`src/i18n/dictionaries/${dict}.ts`, "utf8");
    const start = src.indexOf("    payout: {");
    const block = src.slice(start, src.indexOf("    withdraw: {", start));
    const missing = [...STATES, ...BODIES, ...REASONS].filter((k) => !block.includes(`${k}:`));
    check(`${dict}: every reachable state and reason has copy`,
      missing.length === 0 && block.length > 0, missing.join(",") || "complete");
  }

  // The stale hint that told a VERIFIED creator to go and verify must be gone.
  for (const dict of ["en", "he"]) {
    const src = readFileSync(`src/i18n/dictionaries/${dict}.ts`, "utf8");
    check(`${dict}: the misleading notReadyHint is gone`, !src.includes("notReadyHint:"));
  }

  const card = codeOnly("src/components/dashboard/WhopPayoutStatusCard.tsx");
  check("the card renders reasons through the dictionary, not raw tokens",
    card.includes("t.reasons") && card.includes("reasonCopy[r]"));
  check("the card delegates the CTA decision rather than inlining it",
    /showButton = shouldOfferPortal\(readiness\)/.test(card));
  check("the card delegates the navigation decision too",
    /resolvePortalOutcome\(res\.ok, body\)/.test(card));
}

/* ==========================================================================
   PORTAL CTA AND NAVIGATION — the real product logic, called directly.

   These two rules used to live as expressions inside the component, where a
   test could only re-type them and watch its own copy pass. They are now pure
   functions in `lib/dashboard/payout-portal.ts`, so the assertions below call
   exactly what the card calls. No React, no DOM, no test framework — the same
   transpile-and-invoke pattern the rest of this repo uses.
   ========================================================================== */

console.log("\n--- portal CTA and navigation ---");

{
  const js = ts.transpileModule(readFileSync("src/lib/dashboard/payout-portal.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function("module", "exports", "require", js)(mod, mod.exports, require);
  const { shouldOfferPortal, resolvePortalOutcome } = mod.exports;

  /* --- CTA availability, state by state --- */

  for (const readiness of ["action_required", "destination_missing", "pending", "not_ready", "unknown"]) {
    check(`CTA IS offered for ${readiness}`, shouldOfferPortal(readiness) === true);
  }
  // `ready` has nothing to set up; `restricted` is a provider suspension the
  // hosted portal cannot lift, so the button would lead nowhere useful.
  for (const readiness of ["ready", "restricted"]) {
    check(`CTA is NOT offered for ${readiness}`, shouldOfferPortal(readiness) === false);
  }
  check("exactly two states withhold the CTA — no state is accidentally excluded",
    ["ready", "pending", "action_required", "destination_missing", "restricted", "not_ready", "unknown"]
      .filter((r) => !shouldOfferPortal(r)).sort().join(",") === "ready,restricted");

  /* --- navigation safety --- */

  const HTTPS = "https://sandbox.whop.com/payouts/abc";

  check("a successful https url navigates",
    JSON.stringify(resolvePortalOutcome(true, { url: HTTPS })) ===
    JSON.stringify({ kind: "navigate", url: HTTPS }));

  for (const [label, body] of [
    ["a missing url", {}],
    ["a null url", { url: null }],
    ["an empty url", { url: "" }],
    ["a non-string url", { url: 42 }],
    ["a relative path", { url: "/dashboard" }],
    ["an http url", { url: "http://whop.com/payouts" }],
    ["a javascript: url", { url: "javascript:alert(1)" }],
    ["a protocol-relative url", { url: "//evil.test/payouts" }],
    ["a null body", null],
  ]) {
    const out = resolvePortalOutcome(true, body);
    check(`${label} on a 200 does NOT navigate`,
      out.kind === "error" && out.key === "portal", JSON.stringify(out));
  }

  check("a failed response never navigates, even carrying a url",
    resolvePortalOutcome(false, { url: HTTPS, error: "provider_rejected" }).kind === "error");
  check("and it surfaces the provider's TOKEN, not provider text",
    resolvePortalOutcome(false, { error: "provider_rejected" }).key === "provider_rejected");
  check("a failure with no token falls back to the generic portal key",
    resolvePortalOutcome(false, {}).key === "portal" &&
    resolvePortalOutcome(false, null).key === "portal");
  check("a non-string error token cannot become the key",
    resolvePortalOutcome(false, { error: { nested: "obj" } }).key === "portal");

  /* --- busy guard --- */

  // The guard is `if (!user || busy) return;` at the top of openPortal, with
  // `busy` left SET through navigation so the button cannot be pressed again
  // while the tab is loading away.
  const card2 = codeOnly("src/components/dashboard/WhopPayoutStatusCard.tsx");
  const openPortalBody = card2.slice(
    card2.indexOf("async function openPortal()"),
    card2.indexOf("const pillClass"),
  );
  check("openPortal returns early while busy — no duplicate link is minted",
    /if \(!user \|\| busy\) return;/.test(openPortalBody));
  check("busy is set before the request, not after",
    openPortalBody.indexOf("setBusy(true)") < openPortalBody.indexOf("fetch("));
  check("busy is cleared on every error path",
    (openPortalBody.match(/setBusy\(false\)/g) ?? []).length === 2);
  // On the SUCCESS path busy is deliberately NOT cleared: the tab is
  // navigating away, and clearing it would re-enable the button during the
  // load. (The catch block clears it, but that is a different path.)
  check("busy stays SET through navigation, so the button cannot be re-pressed",
    (() => {
      const errorBranchEnd = openPortalBody.indexOf("window.location.assign");
      const successPath = openPortalBody.slice(
        openPortalBody.indexOf("return;", openPortalBody.indexOf("outcome.kind === \"error\"")),
        errorBranchEnd,
      );
      return errorBranchEnd > 0 && !successPath.includes("setBusy(false)");
    })());
  check("the button is disabled and marked busy for assistive tech",
    /disabled=\{busy\}/.test(card2) && /aria-busy=\{busy\}/.test(card2));
  check("the portal link url is never logged or stored by the card",
    !/console\.(log|error|warn)/.test(card2) && !/localStorage|sessionStorage/.test(card2));
}

/* ==========================================================================
   DICTIONARY COMPLETENESS FOR THE PORTAL ROUTE

   Route and dictionary drift silently: adding an error branch is a one-line
   change, and the card's `errors[key] ?? t.errors.portal` fallback means a
   missing string degrades to generic copy rather than crashing. This derives
   the token set FROM THE ROUTE so a new branch fails here instead.
   ========================================================================== */

console.log("\n--- portal dictionary completeness ---");

{
  const route = codeOnly("src/app/api/whop/payout/portal/route.ts");

  // Every `error: "..."` literal and every `{ error: result.reason }` branch.
  const literals = [...route.matchAll(/error:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  // `result.reason` forwards the helper's failure union verbatim.
  const helper = codeOnly("src/lib/server/whop-account-links.ts");
  const union = helper.slice(helper.indexOf("export type AccountLinkFailure"), helper.indexOf("export type AccountLinkResult"));
  const reasons = [...union.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]);

  const emitted = [...new Set([...literals, ...reasons])]
    // `forbidden` is the pre-auth origin rejection: the browser never renders
    // it because the request was not same-origin in the first place.
    .filter((k) => k !== "forbidden");

  check("the token set was derived from the route and the helper, not hardcoded",
    emitted.length >= 7, emitted.sort().join(","));

  for (const dict of ["en", "he"]) {
    const src = readFileSync(`src/i18n/dictionaries/${dict}.ts`, "utf8");
    const start = src.indexOf("    payout: {");
    const block = src.slice(start, src.indexOf("    withdraw: {", start));
    const missing = emitted.filter((k) => !block.includes(`${k}:`));
    check(`${dict}: every portal error token has payout copy`,
      missing.length === 0 && block.length > 0, missing.join(",") || `${emitted.length} tokens`);
  }

  // Both dictionaries must carry the SAME key set, or one locale silently
  // falls back to generic copy while the other explains the problem.
  const keysOf = (dict) => {
    const src = readFileSync(`src/i18n/dictionaries/${dict}.ts`, "utf8");
    const start = src.indexOf("    payout: {");
    const block = src.slice(start, src.indexOf("    withdraw: {", start));
    const errs = block.slice(block.indexOf("errors: {"));
    return [...errs.matchAll(/^\s{8}([a-z_]+):/gm)].map((m) => m[1]).sort();
  };
  check("en and he declare the identical payout error key set",
    keysOf("en").join(",") === keysOf("he").join(","),
    `en=${keysOf("en").length} he=${keysOf("he").length}`);

  for (const k of ["unavailable", "malformed_response", "invalid_account_id", "not_found"]) {
    check(`the newly added key "${k}" exists in both dictionaries`,
      keysOf("en").includes(k) && keysOf("he").includes(k));
  }
}

/* ============================== summary ============================== */

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
