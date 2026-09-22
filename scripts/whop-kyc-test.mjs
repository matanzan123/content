/**
 * WHOP KYC / ACCOUNT LINK TESTS.
 *
 * The defect this suite exists to prevent: a hand-written provider request
 * body that no compiler checks. Before this, account links were minted by two
 * separate hand-rolled `fetch` calls, and BOTH were wrong against the
 * installed SDK — wrong path (`/accounts/links`, `/accounts/{id}/links`
 * instead of `account_links`), wrong field name (`type` instead of
 * `use_case`), a value that is not in the enum at all (`account_update`), a
 * required field missing entirely (`refresh_url`), and a retry on an
 * `account_id` field the SDK does not define. None of it was caught, because a
 * string literal in a fetch body is not type-checked.
 *
 * THREE LAYERS OF PROTECTION, in the order they are worth having:
 *
 *   1. COMPILE TIME. `whop-account-links.ts` calls
 *      `client.accountLinks.create()`, typed by `CreateAccountLinksRequest`.
 *      A wrong field name or a missing required field is now a build error.
 *      `npx tsc --noEmit` is the real guard; this suite cannot replace it.
 *
 *   2. RUNTIME, AGAINST OUR ADAPTER. Most of what follows: the SDK client is
 *      replaced with a stub that records the exact request object, so the
 *      request we would really send is asserted field by field.
 *
 *   3. SDK DRIFT. One narrow check reads the installed declaration files for
 *      the FIELD NAMES and ENUM VALUES only — identifiers, never formatting or
 *      line positions. If a future SDK renames `use_case` or drops
 *      `payouts_portal`, that check fails and points at the upgrade. It is
 *      deliberately not a full parse of the declarations: a test that breaks
 *      when a comment is rewrapped teaches people to delete the test.
 *
 * ZERO NETWORK. The SDK client, the cookie jar and the environment are all
 * injected. No Whop request is made, no database is touched.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ==========================================================================
   Loader — transpiles the module under test with every seam injected.
   ========================================================================== */

const SOURCE = "src/lib/server/whop-account-links.ts";

/**
 * A stand-in for the SDK's WhopError, reproducing the parts that matter.
 *
 * `message` is built the way the real SDK builds it — `buildMessage()` appends
 * `Body: ${toJson(body)}`, so the message is a full body dump wearing a
 * string's clothes. Reproduced exactly, because the diagnostic added for the
 * 502 must be proved never to reach for it.
 *
 * `body` carries a realistic Whop error envelope AND a planted credential, so
 * the allowlist is tested against something that would leak if it dumped.
 */
class FakeWhopError extends Error {
  constructor(statusCode, body) {
    const realBody = body ?? {
      error: {
        code: "invalid_request",
        type: "invalid_request_error",
        param: "company_id",
        message: "company must be a sub-merchant of the API key's company",
      },
      errors: [{ field: "company_id", code: "not_a_submerchant", message: "not owned by you" }],
      // Things Whop would never send, planted to prove they cannot escape.
      request: { headers: { authorization: "Bearer apik_SECRET_VALUE" } },
      access_token: "tok_SECRET_VALUE",
    };
    super(`Bad Request\nStatus code: ${statusCode}\nBody: ${JSON.stringify(realBody, null, 2)}`);
    this.statusCode = statusCode;
    this.body = realBody;
    // The SDK reads `x-request-id` off the RESPONSE headers via this getter.
    this.requestId = "req_abc123";
    // Present on the real error; must never be touched.
    this.rawResponse = { headers: new Map([["authorization", "Bearer apik_SECRET_VALUE"]]) };
    this.cause = new Error("inner: apik_SECRET_VALUE");
  }
}

/**
 * Builds the module over a stubbed SDK client.
 *
 * `respond` decides what `accountLinks.create` does: return a link, or throw.
 * Every call is recorded so the request body can be asserted exactly.
 */
function loadLinks({
  respond = () => ({ url: "https://whop.com/onboard/abc", expires_at: "2026-01-01T00:00:00Z" }),
  locale = "en",
  appUrl = "https://app.cliprewards.test",
  client = true,
} = {}) {
  const calls = [];
  const logged = [];

  const stubClient = client
    ? {
        accountLinks: {
          create: async (request) => {
            calls.push(request);
            const out = respond(request);
            if (out instanceof Error) throw out;
            return out;
          },
        },
      }
    : null;

  const source = readFileSync(SOURCE, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const req = (spec) => {
    if (spec === "server-only") return {};
    if (spec === "@whop/sdk") return { WhopError: FakeWhopError };
    if (spec === "next/headers") {
      return {
        cookies: async () => ({
          get: (name) => (locale === null ? undefined : { name, value: locale }),
        }),
      };
    }
    if (spec === "@/i18n/config") {
      return {
        DEFAULT_LOCALE: "en",
        LOCALE_COOKIE: "cliprewards_locale",
        isLocale: (v) => v === "en" || v === "he",
        localePath: (loc, path) => `/${loc}${path === "/" ? "" : path}`,
      };
    }
    if (spec.endsWith("whop-payments")) {
      return {
        getWhopPaymentsClient: () => stubClient,
        // The REAL implementation's logic, not a no-op: it splits the text on
        // the configured secret. `WHOP_API_KEY` is set to the planted value
        // below, so the scrub assertions exercise the real contract rather
        // than a stub that pretends to redact.
        redactWhopSecrets: (text) => {
          let out = text;
          for (const name of ["WHOP_API_KEY", "WHOP_WEBHOOK_SECRET"]) {
            const secret = process.env[name];
            if (secret) out = out.split(secret).join("[redacted]");
          }
          return out;
        },
      };
    }
    if (spec.endsWith("whop-accounts")) {
      return { isWhopAccountId: (v) => typeof v === "string" && /^biz_[A-Za-z0-9]{4,}$/.test(v) };
    }
    return require(spec);
  };

  const prevUrl = process.env.APP_PUBLIC_URL;
  if (appUrl === null) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = appUrl;

  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));

  const mod = { exports: {} };
  try {
    new Function("module", "exports", "require", js)(mod, mod.exports, req);
  } finally {
    console.error = originalError;
    if (prevUrl === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = prevUrl;
  }

  return { mod: mod.exports, calls, logged };
}

/**
 * Captures console.error around an awaited call.
 *
 * The diagnostic fires during the CALL, not during module construction, so it
 * has to be captured here rather than in the loader.
 */
async function capturing(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.error = original;
  }
}

/** Re-applies APP_PUBLIC_URL around an awaited call, since the module reads it lazily. */
async function withEnv(appUrl, fn) {
  const prev = process.env.APP_PUBLIC_URL;
  if (appUrl === null) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = appUrl;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.APP_PUBLIC_URL;
    else process.env.APP_PUBLIC_URL = prev;
  }
}

const ACCOUNT = "biz_creator123";

// The planted credential, set as the real env var the scrubber reads. Every
// leak assertion below hunts for this exact string.
process.env.WHOP_API_KEY = "apik_SECRET_VALUE";

/* ==========================================================================
   A. THE ACCOUNT LINK REQUEST CONTRACT
   ========================================================================== */

console.log("\n--- A. account link request contract ---");

{
  const { mod, calls } = loadLinks();
  const r = await withEnv("https://app.cliprewards.test", () =>
    mod.createAccountLink(ACCOUNT, "account_onboarding"));

  check("a link is minted and the url returned", r.ok === true && r.url.startsWith("https://"), r.ok ? r.url : r.reason);
  check("exactly one provider call is made", calls.length === 1);

  const body = calls[0] ?? {};
  check("the request carries company_id, and it is the creator's connected account",
    body.company_id === ACCOUNT, body.company_id);
  check("the request carries return_url", typeof body.return_url === "string" && body.return_url.startsWith("https://"));
  check("the request carries refresh_url — the field that used to be missing entirely",
    typeof body.refresh_url === "string" && body.refresh_url.startsWith("https://"));
  check("the request carries use_case", typeof body.use_case === "string", body.use_case);

  // The four wrong shapes that shipped before, asserted absent by name.
  check("the request does NOT send account_id", !("account_id" in body));
  check("the request does NOT send type", !("type" in body));
  check("the request sends NOTHING beyond the four contract fields",
    Object.keys(body).sort().join(",") === "company_id,refresh_url,return_url,use_case",
    Object.keys(body).sort().join(","));
  // The helper returns ONLY the url. `expires_at` is deliberately dropped —
  // nothing consumed it, nothing persists a link, and a link is spent on the
  // next click. A bounded result is the assertion that keeps it that way.
  check("the result carries ONLY ok and url — no expires_at, no provider extras",
    Object.keys(r).sort().join(",") === "ok,url", Object.keys(r).sort().join(","));
}

/* ==========================================================================
   B / C. USE CASES — the two hosted flows must not be confused
   ========================================================================== */

console.log("\n--- B/C. use cases ---");

{
  const kyc = loadLinks();
  await withEnv("https://app.cliprewards.test", () => kyc.mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check("KYC uses use_case = account_onboarding", kyc.calls[0].use_case === "account_onboarding", kyc.calls[0].use_case);

  const portal = loadLinks();
  await withEnv("https://app.cliprewards.test", () => portal.mod.createAccountLink(ACCOUNT, "payouts_portal"));
  check("the payout portal uses use_case = payouts_portal", portal.calls[0].use_case === "payouts_portal", portal.calls[0].use_case);
  check("the payout portal NEVER sends account_update",
    portal.calls[0].use_case !== "account_update" && !("type" in portal.calls[0]));

  check("the two flows are distinguishable by their return step",
    kyc.calls[0].return_url.includes("step=kyc_return") &&
    portal.calls[0].return_url.includes("step=payout_return"));

  // BOTH portal URLs asserted by EXACT VALUE, not by substring or by reading
  // the source. The refresh url is the one Whop uses when the hosted session
  // expires before the creator finishes; it was previously only covered
  // indirectly (that the dashboard reads the token, and that the module
  // contains the template), so a wrong origin, a missing locale segment or a
  // swapped step would have gone unnoticed for the portal specifically.
  check("the portal return_url is exactly the localized dashboard + payout_return",
    portal.calls[0].return_url === "https://app.cliprewards.test/en/dashboard?step=payout_return",
    portal.calls[0].return_url);
  check("the portal refresh_url is exactly the localized dashboard + payout_refresh",
    portal.calls[0].refresh_url === "https://app.cliprewards.test/en/dashboard?step=payout_refresh",
    portal.calls[0].refresh_url);
  check("the portal urls differ ONLY in the step token",
    portal.calls[0].return_url.replace("payout_return", "X") ===
    portal.calls[0].refresh_url.replace("payout_refresh", "X"));
  check("the portal never borrows the KYC step tokens",
    !portal.calls[0].return_url.includes("kyc") && !portal.calls[0].refresh_url.includes("kyc"));

  // And in the other locale, so the portal's locale handling is proved too.
  const portalHe = loadLinks({ locale: "he" });
  await withEnv("https://app.cliprewards.test", () => portalHe.mod.createAccountLink(ACCOUNT, "payouts_portal"));
  check("the portal urls follow the validated locale",
    portalHe.calls[0].return_url === "https://app.cliprewards.test/he/dashboard?step=payout_return" &&
    portalHe.calls[0].refresh_url === "https://app.cliprewards.test/he/dashboard?step=payout_refresh",
    portalHe.calls[0].return_url);
}

/* ==========================================================================
   D. REDIRECT URL GENERATION
   ========================================================================== */

console.log("\n--- D. redirect urls ---");

{
  const en = loadLinks({ locale: "en" });
  await withEnv("https://app.cliprewards.test", () => en.mod.createAccountLink(ACCOUNT, "account_onboarding"));
  const b = en.calls[0];

  // The bug this replaces: the old return url was `/onboarding?step=kyc_return`,
  // a page that does not render the verification card, with no locale segment.
  check("return_url lands on the LOCALIZED dashboard, the page that renders the card",
    b.return_url === "https://app.cliprewards.test/en/dashboard?step=kyc_return", b.return_url);
  check("refresh_url lands there too, with its own step token",
    b.refresh_url === "https://app.cliprewards.test/en/dashboard?step=kyc_refresh", b.refresh_url);
  check("return_url is NOT the old /onboarding path", !b.return_url.includes("/onboarding"));

  const he = loadLinks({ locale: "he" });
  await withEnv("https://app.cliprewards.test", () => he.mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check("the locale comes from the validated cookie", he.calls[0].return_url.includes("/he/dashboard"), he.calls[0].return_url);

  // A locale cookie is attacker-writable, and its value lands in a URL a third
  // party redirects a browser to. Only the supported set may pass.
  const evil = loadLinks({ locale: "https://evil.test/" });
  await withEnv("https://app.cliprewards.test", () => evil.mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check("an unsupported locale cookie cannot reach the URL — falls back to default",
    evil.calls[0].return_url === "https://app.cliprewards.test/en/dashboard?step=kyc_return",
    evil.calls[0].return_url);
  check("and no open redirect is possible from the locale",
    !evil.calls[0].return_url.includes("evil.test"));

  const missing = loadLinks();
  const r1 = await withEnv(null, () => missing.mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check("a missing APP_PUBLIC_URL fails closed, with NO provider call",
    r1.ok === false && r1.reason === "unconfigured" && missing.calls.length === 0);

  const insecure = loadLinks();
  const r2 = await withEnv("http://app.cliprewards.test", () => insecure.mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check("a non-HTTPS APP_PUBLIC_URL fails closed, with NO provider call",
    r2.ok === false && r2.reason === "unconfigured" && insecure.calls.length === 0);

  const junk = loadLinks();
  const r3 = await withEnv("not a url", () => junk.mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check("a malformed APP_PUBLIC_URL fails closed, with NO provider call",
    r3.ok === false && r3.reason === "unconfigured" && junk.calls.length === 0);

  // Only the origin is used, so a path or query on the env var cannot leak in.
  const noisy = loadLinks();
  await withEnv("https://app.cliprewards.test/sub/path?x=1", () => noisy.mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check("only the ORIGIN of APP_PUBLIC_URL is used",
    noisy.calls[0].return_url === "https://app.cliprewards.test/en/dashboard?step=kyc_return",
    noisy.calls[0].return_url);
}

/* ==========================================================================
   E. RESOURCE ID VALIDATION
   ========================================================================== */

console.log("\n--- E. account id validation ---");

for (const bad of ["", "acct_123", "biz_", "BIZ_abcd", "  biz_abcd", null, undefined, 42, {}]) {
  const { mod, calls } = loadLinks();
  const r = await withEnv("https://app.cliprewards.test", () => mod.createAccountLink(bad, "account_onboarding"));
  check(`a malformed company id ${JSON.stringify(bad)} is refused BEFORE any provider call`,
    r.ok === false && r.reason === "invalid_account_id" && calls.length === 0, r.ok ? "accepted!" : r.reason);
}

{
  const { mod } = loadLinks({ client: false });
  const r = await withEnv("https://app.cliprewards.test", () => mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check("no configured client means unconfigured, never a silent success",
    r.ok === false && r.reason === "unconfigured");
}

/* ==========================================================================
   G. PROVIDER FAILURES
   ========================================================================== */

console.log("\n--- G. provider failures ---");

for (const [status, expected] of [
  [400, "provider_rejected"],
  [422, "provider_rejected"],
  [403, "platforms_access_required"],
  [404, "not_found"],
  [429, "provider_error"],
  [500, "provider_error"],
  [503, "provider_error"],
]) {
  const { mod } = loadLinks({ respond: () => new FakeWhopError(status) });
  const r = await withEnv("https://app.cliprewards.test", () => mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check(`a ${status} maps to ${expected}`, r.ok === false && r.reason === expected, r.ok ? "ok!" : r.reason);
}

{
  const { mod } = loadLinks({ respond: () => { throw new Error("socket hang up"); } });
  const r = await withEnv("https://app.cliprewards.test", () => mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check("a network failure is a provider_error, never a pass", r.ok === false && r.reason === "provider_error");
}

for (const [label, body] of [
  ["no url at all", { expires_at: "x" }],
  ["a null url", { url: null }],
  ["a non-string url", { url: 42 }],
  ["a non-HTTPS url", { url: "http://whop.com/onboard" }],
  ["a javascript: url", { url: "javascript:alert(1)" }],
]) {
  const { mod } = loadLinks({ respond: () => body });
  const r = await withEnv("https://app.cliprewards.test", () => mod.createAccountLink(ACCOUNT, "account_onboarding"));
  check(`a 2xx with ${label} is malformed_response, not a redirect`,
    r.ok === false && r.reason === "malformed_response", r.ok ? r.url : r.reason);
}

/* ==========================================================================
   J. NO SECRET LEAKAGE
   ========================================================================== */

console.log("\n--- J. secret handling ---");

{
  const { mod, logged } = loadLinks({ respond: () => new FakeWhopError(400) });
  const r = await withEnv("https://app.cliprewards.test", () => mod.createAccountLink(ACCOUNT, "account_onboarding"));
  const dump = JSON.stringify(r) + logged.join("\n");
  check("the api key never reaches the result or the log", !dump.includes("apik_SECRET_VALUE"), `${dump.length} chars`);
  check("the raw provider body never reaches the result", !JSON.stringify(r).includes("authorization"));
  check("the failure is a closed-set token, not a provider message",
    r.ok === false && /^[a-z_]+$/.test(r.reason), r.reason);
  check("the browser response carries NO provider detail",
    r.ok === false && Object.keys(r).sort().join(",") === "ok,reason", Object.keys(r).join(","));
}

/* ==========================================================================
   DEV DIAGNOSTIC — added to explain a real sandbox 502.

   The route answers `{ error: "provider_rejected" }` and always will. This
   asserts the server-side detail is genuinely useful AND genuinely safe: an
   allowlist that leaks is worse than no diagnostic, because it is trusted.
   ========================================================================== */

console.log("\n--- diagnostic: useful ---");

{
  const { mod } = loadLinks();
  const d = mod.describeProviderRejection(new FakeWhopError(400));

  check("the provider HTTP status is captured", d.status === 400, String(d.status));
  check("the provider request id is captured — the id to quote to support",
    d.requestId === "req_abc123", d.requestId);
  check("the provider error code is captured", d.code === "invalid_request", d.code);
  check("the provider error type is captured", d.type === "invalid_request_error", d.type);
  check("the offending field is captured", d.field === "company_id", d.field);
  check("the provider message is captured", typeof d.message === "string" && d.message.includes("sub-merchant"), d.message);
  check("per-field validation errors are captured",
    d.validation.length === 1 && d.validation[0] === "company_id: not_a_submerchant", d.validation.join("|"));

  // A flat envelope, which Whop has also used.
  const flat = mod.describeProviderRejection(new FakeWhopError(422, {
    code: "unprocessable", type: "validation_error", message: "nope", field: "return_url",
  }));
  check("a FLAT provider envelope is read too",
    flat.code === "unprocessable" && flat.field === "return_url", `${flat.code}/${flat.field}`);

  const empty = mod.describeProviderRejection(new FakeWhopError(500, {}));
  check("an empty body degrades to nulls rather than throwing",
    empty.status === 500 && empty.code === null && empty.validation.length === 0);
  const notWhop = mod.describeProviderRejection(new Error("plain"));
  check("a non-WhopError degrades safely", notWhop.status === null && notWhop.message === null);
}

console.log("\n--- diagnostic: safe ---");

{
  const { mod } = loadLinks({ respond: () => new FakeWhopError(400) });
  const run = await capturing(() =>
    withEnv("https://app.cliprewards.test", () => mod.createAccountLink(ACCOUNT, "account_onboarding")));

  const d = mod.describeProviderRejection(new FakeWhopError(400));
  const detail = JSON.stringify(d);
  const output = run.lines.join("\n");
  const everything = detail + "\n" + output;

  check("the diagnostic logged exactly one line", run.lines.length === 1, `${run.lines.length} line(s)`);

  // The planted credential lives in body.request.headers.authorization,
  // body.access_token, error.message, error.cause and error.rawResponse.
  // Five different paths to the same secret; the allowlist must miss all five.
  for (const [label, needle] of [
    ["the API key", "apik_SECRET_VALUE"],
    ["an access token", "tok_SECRET_VALUE"],
    ["the authorization header name", "authorization"],
    ["the Bearer prefix", "Bearer "],
  ]) {
    check(`${label} appears in NEITHER the detail nor the log`, !everything.includes(needle));
  }

  check("the SDK message is never used — it embeds the whole body by construction",
    !everything.includes("Status code: 400") && !everything.includes("Body: {"));
  check("rawResponse and cause are never touched",
    !everything.includes("rawResponse") && !everything.includes("inner:"));
  check("the detail has ONLY the allowlisted keys",
    Object.keys(d).sort().join(",") === "code,field,message,requestId,status,type,validation",
    Object.keys(d).sort().join(","));
  // One line, key=value, no object dump. Brackets are fine — the prefix and
  // the validation list use them; a brace or a newline would mean a dump.
  check("the log line is one flat key=value line, not an object dump",
    output.startsWith("[whop:account_links] rejected") &&
    !output.includes("{") && !output.includes(String.fromCharCode(10)),
    output.slice(0, 60));

  // A hostile provider message cannot smuggle a credential through the
  // allowlist: the scrubber is a second line of defence behind it.
  const planted = loadLinks({
    respond: () => new FakeWhopError(400, { error: { message: "failed using apik_SECRET_VALUE" } }),
  });
  const pd = planted.mod.describeProviderRejection(
    new FakeWhopError(400, { error: { message: "failed using apik_SECRET_VALUE" } }));
  check("a credential inside an ALLOWLISTED field is still scrubbed",
    !JSON.stringify(pd).includes("apik_SECRET_VALUE") && pd.message.includes("[redacted]"), pd.message);

  // An over-long provider message cannot flood a log.
  const long = mod.describeProviderRejection(new FakeWhopError(400, { error: { message: "x".repeat(5000) } }));
  check("an over-long provider message is truncated", long.message.length <= 300, `${long.message.length} chars`);

  // The minted link is a bearer credential for the hosted flow.
  const okMod = loadLinks().mod;
  const okRun = await capturing(() =>
    withEnv("https://app.cliprewards.test", () => okMod.createAccountLink(ACCOUNT, "account_onboarding")));
  check("a SUCCESSFUL mint logs nothing at all — the link url is never printed",
    okRun.lines.length === 0, okRun.lines.join("|"));
}

{
  // Production silence, asserted by running the real code path with NODE_ENV set.
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const { mod } = loadLinks({ respond: () => new FakeWhopError(400) });
  const run = await capturing(() =>
    withEnv("https://app.cliprewards.test", () => mod.createAccountLink(ACCOUNT, "account_onboarding")));
  if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;

  check("in production the diagnostic is silent", run.lines.length === 0, `${run.lines.length} line(s)`);
  check("and the classification is unchanged by the diagnostic",
    run.value.ok === false && run.value.reason === "provider_rejected",
    run.value.ok ? "ok!" : run.value.reason);
}

{
  // The public contract the browser sees must not have moved.
  const routeCode = readFileSync("src/app/api/whop/kyc/start/route.ts", "utf8");
  check("the route still answers the browser with only an error token",
    /json\(\{ error: link\.reason \}, 502\)/.test(routeCode));
  check("the route never forwards provider detail to the browser",
    !/describeProviderRejection|statusCode|requestId|providerMessage/.test(routeCode));
}

/* ==========================================================================
   F. KYC STATUS MAPPING  (whop-kyc.ts, unchanged by this task)
   ========================================================================== */

console.log("\n--- F. kyc status mapping ---");

function loadKyc(respond) {
  const source = readFileSync("src/lib/server/whop-kyc.ts", "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const req = (spec) => {
    if (spec === "server-only") return {};
    if (spec.endsWith("whop-accounts")) {
      return { resolvePlatformConfig: () => ({ ok: true, config: { baseUrl: "https://stub.invalid", apiKey: "apik_SECRET_VALUE", environment: "sandbox" } }) };
    }
    return require(spec);
  };
  const prev = globalThis.fetch;
  globalThis.fetch = async () => respond();
  const mod = { exports: {} };
  try {
    new Function("module", "exports", "require", js)(mod, mod.exports, req);
  } finally { /* fetch restored by caller */ }
  return { mod: mod.exports, restore: () => { globalThis.fetch = prev; } };
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

for (const [label, body, expected] of [
  ["active with nothing outstanding", { status: "active" }, "verified"],
  ["active but with a requirement", { status: "active", required_actions: ["verify_identity"] }, "action_required"],
  ["pending", { status: "pending" }, "action_required"],
  ["unverified", { status: "unverified" }, "action_required"],
  ["restricted", { status: "restricted" }, "restricted"],
  ["anything past due", { status: "active", past_due: ["verify_identity"] }, "restricted"],
  ["an unknown status word", { status: "teleported" }, "unknown"],
  ["no status at all", {}, "unknown"],
]) {
  const { mod, restore } = loadKyc(() => jsonResponse(200, body));
  const r = await mod.fetchKycStatus(ACCOUNT);
  restore();
  check(`status mapping: ${label} → ${expected}`,
    r.ok === true && r.kycStatus.state === expected, r.ok ? r.kycStatus.state : r.reason);
}

{
  // THE REQUIREMENT THE PRODUCT ACTUALLY TURNS ON.
  const { mod, restore } = loadKyc(() => jsonResponse(200, { status: "pending", required_actions: ["verify_identity"] }));
  const r = await mod.fetchKycStatus(ACCOUNT);
  restore();
  check("verify_identity produces action_required AND is carried to the UI as an action code",
    r.ok === true && r.kycStatus.state === "action_required" &&
    r.kycStatus.requiredActions.includes("verify_identity"));

  // The nested requirements shape Whop uses on some account types.
  const nested = loadKyc(() => jsonResponse(200, { status: "pending", required_actions: { currently_due: ["verify_identity"] } }));
  const rn = await nested.mod.fetchKycStatus(ACCOUNT);
  nested.restore();
  check("a NESTED currently_due requirement is read too",
    rn.ok === true && rn.kycStatus.requiredActions.includes("verify_identity"));
}

for (const [status, expected] of [[403, "platforms_access_required"], [404, "not_found"], [500, "provider_error"]]) {
  const { mod, restore } = loadKyc(() => jsonResponse(status, { error: { code: "nope" } }));
  const r = await mod.fetchKycStatus(ACCOUNT);
  restore();
  check(`status read: a ${status} maps to ${expected}`, r.ok === false && r.reason === expected, r.ok ? "ok!" : r.reason);
}

/* ==========================================================================
   H / I. ROUTE OWNERSHIP AND ENVIRONMENT INVARIANTS
   ========================================================================== */

console.log("\n--- H/I. route ownership and environment ---");

const codeOnly = (file) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

for (const route of [
  "src/app/api/whop/kyc/start/route.ts",
  "src/app/api/whop/kyc/status/route.ts",
  "src/app/api/whop/payout/portal/route.ts",
]) {
  const code = codeOnly(route);
  const name = route.split("/").slice(-3, -1).join("/");
  check(`${name}: authenticates before anything else`, code.includes("requireWhopEligible"));
  check(`${name}: checks the request origin`, code.includes("checkRequestOrigin"));
  check(`${name}: resolves the account from the session uid AND the trusted environment`,
    /getConnectedAccount\(\s*firebaseUid,\s*platform\.config\.environment\s*\)/.test(code));
  check(`${name}: never reads an account or company id from the request body`,
    !/body\.(account_id|company_id|whop_account_id|accountId|companyId)/.test(code) &&
    !/request\.json\(\)/.test(code));
  check(`${name}: never lets a caller choose the environment`,
    !/body\.environment|searchParams\.get\(["']environment/.test(code));
}

/* ==========================================================================
   K. ONE IMPLEMENTATION, AND ONLY ONE
   ========================================================================== */

console.log("\n--- K. no second provider contract ---");

{
  const { readdirSync, statSync, existsSync } = require("node:fs");
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = `${d}/${n}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) files.push(p);
    }
  })("src");

  const canonical = resolve(SOURCE);
  const offenders = files.filter((f) => {
    if (resolve(f) === canonical) return false;
    const code = codeOnly(f);
    return /account_links|accounts\/links|accountLinks\s*\.\s*create/.test(code);
  });
  check("only ONE module in src builds an account-link request",
    offenders.length === 0, offenders.join(", ") || "none");

  check("the removed legacy helper is gone", !files.some((f) => /createAccountLink/.test(codeOnly(f)) && !f.endsWith("whop-account-links.ts") && !/route\.ts$/.test(f)));
  check("the dead legacy route /api/whop/account/kyc-link no longer exists",
    !existsSync("src/app/api/whop/account/kyc-link"));

  const kycSource = codeOnly("src/lib/server/whop-kyc.ts");
  check("whop-kyc.ts no longer mints links", !/account_links|accounts\/links|return_url/.test(kycSource));
  check("no module anywhere still sends the invalid account_update use case",
    !files.some((f) => /["']account_update["']/.test(codeOnly(f))));
  // Scoped to ACCOUNT-LINK contexts on purpose. `account_id` is a legitimate,
  // SDK-declared field on other resources — `checkoutConfigurations.create`
  // takes one — so a bare repo-wide search would fire on correct code. What
  // must never come back is `account_id` in an account-link request, which is
  // the field the removed retry invented.
  check("no module sends account_id in an account-link request",
    !files.some((f) => {
      const code = codeOnly(f);
      return /account_links|accountLinks/.test(code) && /account_id\s*:/.test(code);
    }));
}

/* ==========================================================================
   UI: every backend outcome has a string in BOTH dictionaries
   ========================================================================== */

console.log("\n--- UI error coverage ---");

{
  // The card renders `errors[body.error] ?? t.errors.start`, so any outcome
  // without a key silently degrades to a generic message.
  const OUTCOMES = [
    "account_not_provisioned", "platforms_access_required", "provider_error",
    "provider_rejected", "malformed_response", "unavailable", "invalid_account_id",
  ];
  for (const dict of ["en", "he"]) {
    const src = readFileSync(`src/i18n/dictionaries/${dict}.ts`, "utf8");
    const block = src.slice(src.indexOf("verification:"), src.indexOf("payout:", src.indexOf("verification:")));
    const missing = OUTCOMES.filter((k) => !block.includes(`${k}:`));
    check(`${dict}: every backend outcome has a verification error string`,
      missing.length === 0, missing.join(", ") || `${OUTCOMES.length} keys`);
  }
}

/* ==========================================================================
   SDK CONTRACT DRIFT  (layer 3 — identifiers only, never formatting)
   ========================================================================== */

console.log("\n--- SDK contract drift ---");

{
  const base = "node_modules/@whop/sdk/dist/cjs/api";
  const reqDecl = readFileSync(`${base}/resources/accountLinks/client/requests/CreateAccountLinksRequest.d.ts`, "utf8");
  const useCaseDecl = readFileSync(`${base}/types/AccountLinkUseCases.d.ts`, "utf8");

  // Field NAMES, not their order, types or surrounding comments.
  for (const field of ["company_id", "refresh_url", "return_url", "use_case"]) {
    check(`the installed SDK still declares ${field}`,
      new RegExp(`\\b${field}\\s*:`).test(reqDecl));
  }
  check("the installed SDK does NOT declare account_id for this request",
    !/\baccount_id\s*:/.test(reqDecl));
  check("the installed SDK does NOT declare type for this request",
    !/^\s*type\s*:/m.test(reqDecl));

  for (const value of ["account_onboarding", "payouts_portal"]) {
    check(`the use-case enum still contains ${value}`, useCaseDecl.includes(`"${value}"`));
  }
  check("the use-case enum contains no value we do not handle",
    (useCaseDecl.match(/readonly \w+:\s*"([a-z_]+)"/g) ?? []).length === 2,
    (useCaseDecl.match(/"([a-z_]+)"/g) ?? []).join(","));

  // And our adapter sends exactly those field names.
  const adapter = codeOnly(SOURCE);
  check("the adapter calls the SDK rather than hand-building a request",
    /client\.accountLinks\.create\(/.test(adapter) && !/fetch\(/.test(adapter));
}

/* ============================== summary ============================== */

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
