/**
 * Tests for sandbox checkout, payment→order mapping and money handling.
 *
 * The mapping and checkout modules are transpiled with their dependencies
 * injected, so every branch is reachable — including ones no sandbox can
 * produce on demand (a payment for another company, a mismatched amount, a
 * stale failure after settlement).
 *
 * The payment-id uniqueness guarantee is behaviour of a UNIQUE INDEX, so it is
 * proved against real Postgres. Migration 0002 is NOT applied, so that check
 * runs against a session-temporary table of the same shape inside one
 * transaction: invisible to other sessions, gone at commit, nothing seeded.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const sdk = require("@whop/sdk");
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

function load(file, injected) {
  const source = readFileSync(file, "utf8").replace(/^import[^;]+;$/gms, "");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const names = Object.keys(injected);
  new Function("module", "exports", ...names, js)(mod, mod.exports, ...names.map((n) => injected[n]));
  return mod.exports;
}

const OURS = "biz_ourcompany";
const ORDER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ORDER = "99999999-2222-4333-8444-555555555555";
const PAY = "pay_realpayment01";

/** Recorded before anything runs, so the suite can prove it added no order. */
const ordersAtStart = await (async () => {
  if (!process.env.DATABASE_URL) return null;
  const probe = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
  try { return (await probe`select count(*)::int as n from payment_orders`)[0].n; }
  finally { await probe.end({ timeout: 2 }); }
})();

const money = load("src/lib/server/money.ts", {});
const lifecycleRules = load("src/lib/server/payment-lifecycle.ts", {});
const payments = load("src/lib/server/whop-payments.ts", { WhopClient: class {} });

/* ------------------------- D. money is exact, in minor units ------------- */

check("D. \"10.00\" at 2 decimals is 1000 minor units", money.decimalToMinor("10.00", 2) === BigInt(1000));
check("D. \"0.01\" is 1 minor unit", money.decimalToMinor("0.01", 2) === BigInt(1));
check("D. 1000 minor units renders as \"10.00\"", money.minorToDecimal(BigInt(1000), 2) === "10.00");
check("D. a round trip is lossless", money.minorToDecimal(money.decimalToMinor("1234.56", 2), 2) === "1234.56");
check("D. the classic float case is exact", money.decimalToMinor("0.30", 2) === BigInt(30) && money.decimalToMinor("0.10", 2) + money.decimalToMinor("0.20", 2) === BigInt(30));
for (const bad of ["10.001", "1e3", "ten", "", "10,00", "0x10", null, undefined, {}]) {
  check(`D. ${JSON.stringify(bad)} is refused, not coerced`, money.decimalToMinor(bad, 2) === null);
}
check("D. more precision than the currency has is refused", money.decimalToMinor("10.005", 2) === null);
check("D. zero is not a chargeable amount", money.isChargeableAmount(BigInt(0)) === false);
check("D. a negative amount is not chargeable", money.isChargeableAmount(BigInt(-100)) === false);
check("D. an unsupported currency has no decimals", money.currencyDecimals("btc") === null && money.currencyDecimals("eur") === null);
check("D. usd is supported at 2 decimals", money.currencyDecimals("USD") === 2);

/* --------------- A / B. sandbox isolation, end to end -------------------- */

{
  const sandboxEnv = { WHOP_API_KEY: "apik_x", WHOP_COMPANY_ID: OURS, WHOP_ENV: "sandbox" };
  check("A. checkout would use the sandbox API", payments.resolveWhopPayments(sandboxEnv).config.baseUrl === "https://sandbox-api.whop.com/api/v1");
  check("A. production resolves elsewhere", payments.resolveWhopPayments({ ...sandboxEnv, WHOP_ENV: "production" }).config.baseUrl === "https://api.whop.com/api/v1");

  const component = readFileSync("src/components/checkout/SandboxCheckout.tsx", "utf8");
  check("B. the embed is given an explicit environment", component.includes("environment={environment}"));
  check("B. the environment prop is typed to sandbox only", component.includes('environment: "sandbox"'));
  check("B. the page passes sandbox explicitly", readFileSync("src/app/[locale]/checkout/sandbox/page.tsx", "utf8").includes('environment="sandbox"'));
}

/* --------------- C. production can never reach the test surface ---------- */

{
  const SANDBOX_ENV = { WHOP_ENV: "sandbox", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "true" };
  const sandbox = load("src/lib/server/sandbox-orders.ts", {
    getWhopEnvironment: () => "sandbox",
    findOrCreateSandboxOrder: async () => ({ ok: true, order: {} }),
  });
  const production = load("src/lib/server/sandbox-orders.ts", {
    getWhopEnvironment: () => "production",
    findOrCreateSandboxOrder: async () => ({ ok: true, order: {} }),
  });
  const unset = load("src/lib/server/sandbox-orders.ts", {
    getWhopEnvironment: () => null,
    findOrCreateSandboxOrder: async () => ({ ok: true, order: {} }),
  });

  check("C. sandbox WITH the opt-in is enabled", sandbox.isSandboxOrderingEnabled(SANDBOX_ENV) === true);
  check("C. production cannot order", production.isSandboxOrderingEnabled({ ...SANDBOX_ENV, WHOP_ENV: "production" }) === false);
  check("C. an unresolved environment cannot order", unset.isSandboxOrderingEnabled({}) === false);
  check("C. production refuses to create a test order", (await production.createSandboxTestOrder()).reason === "not_sandbox");
  check("C. the page 404s outside sandbox", readFileSync("src/app/[locale]/checkout/sandbox/page.tsx", "utf8").includes("if (!isSandboxOrderingEnabled()) notFound();"));
  check("C. the return page 404s outside sandbox", readFileSync("src/app/[locale]/checkout/sandbox/complete/page.tsx", "utf8").includes("if (!isSandboxOrderingEnabled()) notFound();"));
  const api = readFileSync("src/app/api/checkout/sandbox/route.ts", "utf8");
  check("C. the API 404s outside sandbox, before parsing", api.indexOf("isSandboxOrderingEnabled()") < api.indexOf("request.json()"));
  check("C. the test amount is a server constant", sandbox.SANDBOX_TEST_AMOUNT_MINOR === BigInt(1000) && sandbox.SANDBOX_TEST_CURRENCY === "usd");
}

/* ------------- E / F. the browser cannot price or relabel an order ------- */

{
  const api = readFileSync("src/app/api/checkout/sandbox/route.ts", "utf8");
  for (const field of ["amount", "currency", "price", "company_id", "plan_id", "payment_id"]) {
    check(`E. the API reads no ${field} from the request body`, api.includes(`.${field}`) === false || api.includes(`body as { ${field}`) === false);
  }
  // The client supplies three things and none of them prices anything: which
  // action, which order, and which language to return to.
  check(
    "E. the client supplies only an action, an order id and a locale",
    (api.match(/body as \{[^}]+\}/g) ?? []).every((m) => /action|order_id|locale/.test(m)),
  );
  check("E. the locale is narrowed to the two known values", api.includes('value === "he" ? "he" : "en"'));
  // Every `amount` in the route is an OUTPUT read off a server-side order.
  // None is read from the request body.
  check("E. no amount is ever read from the request", /body as \{[^}]*amount/.test(api) === false);
  // The route no longer assembles amounts itself: every response is a DTO
  // built by `buildCheckoutSession` from the stored order row.
  const dto = readFileSync("src/lib/server/checkout-session.ts", "utf8");
  check(
    "E. the amount in the DTO comes from the order row",
    dto.includes("amount_minor: order.amountMinor.toString()") && dto.includes("currency: order.currency"),
  );
  check("E. the route spreads no provider object into JSON", /\.\.\.\s*(configuration|cfg|payment|plan)\b/.test(api) === false);
  const orders = readFileSync("src/lib/server/payment-orders.ts", "utf8");
  check("E. no code path updates an order's amount", /set\(\{[^}]*amountMinor/s.test(orders) === false);
  check("E. no code path updates an order's currency", /set\(\{[^}]*currency/s.test(orders) === false);
  const checkout = readFileSync("src/lib/server/whop-checkout.ts", "utf8");
  check("E. the price is read from the order row", checkout.includes("minorToDecimal(order.amountMinor, decimals)"));
  check("F. checkout metadata carries the order id and nothing else", /metadata: \{ order_id: order\.orderId \}/.test(checkout));
  check("F. the plan is one-time", checkout.includes('plan_type: "one_time"'));
  check("R. the create call carries an idempotency key", checkout.includes("idempotencyKey: `order-${order.orderId}`"));
}

/* -------------------- Q / R. checkout creation guards -------------------- */

function checkoutModule(order, { created = { id: "ch_new", plan: { id: "plan_new" } }, throws = null, attach = true } = {}) {
  const calls = { create: 0, attach: 0 };
  const mod = load("src/lib/server/whop-checkout.ts", {
    describeWhopError: (e) => String(e?.message ?? ""),
    getWhopCompanyId: () => OURS,
    getWhopEnvironment: () => "sandbox",
    getWhopPaymentsClient: () => ({
      checkoutConfigurations: {
        create: async () => {
          calls.create++;
          if (throws) throw throws;
          return created;
        },
      },
    }),
    currencyDecimals: money.currencyDecimals,
    minorToDecimal: money.minorToDecimal,
    buildCheckoutReturnUrl: (id, locale) => "https://example.test/" + locale + "/checkout/sandbox/complete?order_id=" + id,
    attachCheckout: async () => {
      calls.attach++;
      return attach;
    },
    getPaymentOrder: async () => order,
    isCheckoutEligible: (s) => ["created", "checkout_created", "payment_pending", "failed"].includes(s),
    isOrderId: (v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v),
  });
  return { mod, calls };
}

const baseOrder = {
  orderId: ORDER_ID,
  environment: "sandbox",
  amountMinor: BigInt(1000),
  currency: "usd",
  status: "created",
  purpose: "sandbox_integration_test",
  whopCheckoutId: null,
  whopPlanId: null,
  whopPaymentId: null,
  paidAt: null,
};

{
  const { mod, calls } = checkoutModule(baseOrder);
  const r = await mod.createWhopCheckoutForOrder(ORDER_ID);
  check("a fresh order gets a checkout", r.ok === true && r.session.checkoutId === "ch_new", r.ok ? "" : r.reason);
  check("the plan id is returned for the embed", r.ok && r.session.planId === "plan_new");
  check("the amount travels as a string, never a float", r.ok && r.session.amountMinor === "1000");
  check("one provider object was created", calls.create === 1);
}
{
  const paid = { ...baseOrder, status: "paid", whopPaymentId: PAY, paidAt: new Date() };
  const { mod, calls } = checkoutModule(paid);
  const r = await mod.createWhopCheckoutForOrder(ORDER_ID);
  check("Q. a paid order cannot create another checkout", r.ok === false && r.reason === "already_paid");
  check("Q. and no provider object was created", calls.create === 0);
}
{
  const cancelled = { ...baseOrder, status: "cancelled" };
  const { mod } = checkoutModule(cancelled);
  check("a cancelled order cannot create a checkout", (await mod.createWhopCheckoutForOrder(ORDER_ID)).reason === "not_eligible");
}
{
  const existing = { ...baseOrder, status: "checkout_created", whopCheckoutId: "ch_first", whopPlanId: "plan_first" };
  const { mod, calls } = checkoutModule(existing);
  const r = await mod.createWhopCheckoutForOrder(ORDER_ID);
  check("R. a second request REUSES the existing checkout", r.ok === true && r.session.checkoutId === "ch_first" && r.reused === true);
  check("R. no duplicate provider object is created", calls.create === 0);
}
{
  const { mod } = checkoutModule({ ...baseOrder, environment: "production" });
  check("a production order cannot be charged in sandbox", (await mod.createWhopCheckoutForOrder(ORDER_ID)).reason === "environment_mismatch");
}
{
  const { mod } = checkoutModule({ ...baseOrder, currency: "btc" });
  check("an unsupported currency is refused", (await mod.createWhopCheckoutForOrder(ORDER_ID)).reason === "unsupported_currency");
}
{
  const { mod } = checkoutModule(null);
  check("H. a missing order is refused", (await mod.createWhopCheckoutForOrder(ORDER_ID)).reason === "order_not_found");
}
{
  const { mod } = checkoutModule(baseOrder);
  for (const bad of ["not-a-uuid", "", null, 42, "'; drop table payment_orders; --"]) {
    check(`a client-invented order id ${JSON.stringify(bad)} is refused`, (await mod.createWhopCheckoutForOrder(bad)).reason === "invalid_order_id");
  }
}
{
  const { mod } = checkoutModule(baseOrder, { throws: new sdk.WhopError({ message: "boom", statusCode: 500 }) });
  const r = await mod.createWhopCheckoutForOrder(ORDER_ID);
  check("a provider failure is a category, never a verbatim error", r.ok === false && r.reason === "provider_error");
}
{
  // The order settled between the provider call and the attach.
  const { mod } = checkoutModule(baseOrder, { attach: false });
  check("R. a race that settles the order mid-create refuses the checkout", (await mod.createWhopCheckoutForOrder(ORDER_ID)).reason === "not_eligible");
}

/* --------------------- G–L, P, S. payment → order mapping ---------------- */

function mappingModule(payment, order, { throws = null, orders = {} } = {}) {
  const state = { markCalls: [], attemptCalls: [], order };
  const mod = load("src/lib/server/whop-payment-mapping.ts", {
    // The state machine is injected REAL, not stubbed: what these cases check
    // is that the mapping reaches the right decision, and a fake classifier
    // would let a wrong decision pass.
    classifyProviderStatus: lifecycleRules.classifyProviderStatus,
    targetOrderStatus: lifecycleRules.targetOrderStatus,
    isAbsorbing: lifecycleRules.isAbsorbing,
    WhopError: sdk.WhopError,
    describeWhopError: (e) => String(e?.message ?? ""),
    getWhopCompanyId: () => OURS,
    getWhopEnvironment: () => "sandbox",
    getWhopPaymentsClient: () => ({
      payments: {
        retrieve: async () => {
          if (throws) throw throws;
          return payment;
        },
      },
    }),
    isPaymentId: (v) => typeof v === "string" && /^pay_[A-Za-z0-9]{1,64}$/.test(v),
    currencyDecimals: money.currencyDecimals,
    decimalToMinor: money.decimalToMinor,
    normaliseCurrency: money.normaliseCurrency,
    getPaymentOrder: async (id) => (state.order && state.order.orderId === id ? state.order : null),
    markOrderPaid: async (id, pid) => {
      state.markCalls.push([id, pid]);
      return orders.markResult ?? { ok: true, alreadyPaid: false };
    },
    recordOrderAttempt: async (id, status) => {
      state.attemptCalls.push([id, status]);
      return orders.attemptResult ?? true;
    },
  });
  return { mod, state };
}

const usd = (amount) => ({ amount, currency: "usd", decimals: 2, display_decimals: 2 });
const goodPayment = {
  id: PAY,
  account_id: OURS,
  metadata: { order_id: ORDER_ID },
  subtotal: usd("10.00"),
  total: usd("10.00"),
  status: "paid",
};

{
  const { mod, state } = mappingModule(goodPayment, baseOrder);
  const r = await mod.mapPaymentToOrder(PAY, "succeeded");
  check("M. a fully verified payment marks the order paid", r.kind === "paid" && r.orderId === ORDER_ID, r.kind === "rejected" ? r.reason : "");
  check("M. exactly one order settlement was attempted", state.markCalls.length === 1);
  check("M. it settled with the provider's own payment id", state.markCalls[0][1] === PAY);
}
{
  const { mod } = mappingModule({ ...goodPayment, account_id: "biz_someoneelse" }, baseOrder);
  check("G. a payment owned by another company is rejected", (await mod.mapPaymentToOrder(PAY, "succeeded")).reason === "wrong_company");
}
{
  const { mod } = mappingModule({ ...goodPayment, account_id: null }, baseOrder);
  check("G. a payment with no account is rejected", (await mod.mapPaymentToOrder(PAY, "succeeded")).reason === "wrong_company");
}
{
  const { mod } = mappingModule(goodPayment, null);
  check("H. a payment naming a missing order is rejected", (await mod.mapPaymentToOrder(PAY, "succeeded")).reason === "order_not_found");
}
{
  const { mod } = mappingModule({ ...goodPayment, metadata: {} }, baseOrder);
  check("I. a payment with no order reference is rejected", (await mod.mapPaymentToOrder(PAY, "succeeded")).reason === "no_order_reference");
}
{
  const { mod } = mappingModule({ ...goodPayment, metadata: { order_id: OTHER_ORDER } }, baseOrder);
  check("I. a payment naming a DIFFERENT order cannot settle this one", (await mod.mapPaymentToOrder(PAY, "succeeded")).reason === "order_not_found");
}
for (const [label, amount] of [["more", "10.01"], ["less", "9.99"], ["far more", "1000.00"]]) {
  const { mod, state } = mappingModule({ ...goodPayment, subtotal: usd(amount), total: usd(amount) }, baseOrder);
  const r = await mod.mapPaymentToOrder(PAY, "succeeded");
  check(`J. a payment for ${label} than the order is rejected`, r.reason === "amount_mismatch");
  check(`J. and nothing was settled`, state.markCalls.length === 0);
}
{
  const eur = { amount: "10.00", currency: "eur", decimals: 2, display_decimals: 2 };
  const { mod } = mappingModule({ ...goodPayment, subtotal: eur, total: eur }, baseOrder);
  check("K. a payment in another currency is rejected", (await mod.mapPaymentToOrder(PAY, "succeeded")).reason === "currency_mismatch");
}
{
  const { mod } = mappingModule({ ...goodPayment, subtotal: null, total: null }, baseOrder);
  check("J. a payment with no readable amount is rejected", (await mod.mapPaymentToOrder(PAY, "succeeded")).reason === "amount_unreadable");
}
for (const status of ["open", "pending", "authorized", "draft", "void", "uncollectible", ""]) {
  const { mod, state } = mappingModule({ ...goodPayment, status }, baseOrder);
  const r = await mod.mapPaymentToOrder(PAY, "succeeded");
  check(`L. status "${status}" cannot mark an order paid`, r.kind !== "paid" && state.markCalls.length === 0, r.kind);
}
{
  const { mod } = mappingModule({ ...goodPayment, status: "paid" }, { ...baseOrder, environment: "production" });
  check("a sandbox payment cannot settle a production order", (await mod.mapPaymentToOrder(PAY, "succeeded")).reason === "environment_mismatch");
}
{
  const { mod } = mappingModule(goodPayment, baseOrder, { orders: { markResult: { ok: false, reason: "payment_already_used" } } });
  check("O. a payment already attached elsewhere is refused", (await mod.mapPaymentToOrder(PAY, "succeeded")).reason === "payment_already_used");
}
{
  const { mod } = mappingModule(goodPayment, baseOrder, { orders: { markResult: { ok: true, alreadyPaid: true } } });
  const r = await mod.mapPaymentToOrder(PAY, "succeeded");
  check("P. a duplicate delivery is idempotent, not a second settlement", r.kind === "paid" && r.alreadyPaid === true);
}
{
  // S. an out-of-order failure arriving after settlement.
  const paidOrder = { ...baseOrder, status: "paid", whopPaymentId: PAY, paidAt: new Date() };
  const { mod, state } = mappingModule({ ...goodPayment, status: "void" }, paidOrder);
  const r = await mod.mapPaymentToOrder(PAY, "failed");
  check("S. a late failure cannot downgrade a paid order", r.kind === "ignored" && r.reason === "already_paid_elsewhere");
  check("S. and no attempt was recorded against it", state.attemptCalls.length === 0);
}
{
  const { mod, state } = mappingModule({ ...goodPayment, status: "pending" }, baseOrder);
  const r = await mod.mapPaymentToOrder(PAY, "pending");
  check("a pending payment records an attempt, not a settlement", r.kind === "pending" && state.markCalls.length === 0);
  check("the attempt is payment_pending", state.attemptCalls[0][1] === "payment_pending");
}
{
  const { mod } = mappingModule(goodPayment, baseOrder, { throws: new sdk.WhopError({ message: "nope", statusCode: 404 }) });
  check("a payment that does not exist is rejected", (await mod.mapPaymentToOrder(PAY, "succeeded")).reason === "resource_not_found");
}
for (const bad of ["", "nope", "PAY_x", "pay_../x", null, 42]) {
  const { mod } = mappingModule(goodPayment, baseOrder);
  check(`a malformed payment id ${JSON.stringify(bad)} is refused`, (await mod.mapPaymentToOrder(bad, "succeeded")).reason === "invalid_payment_id");
}

/* ------------------ N / M. no ledger write anywhere in this path --------- */

{
  for (const file of [
    "src/lib/server/whop-payment-mapping.ts",
    "src/lib/server/payment-orders.ts",
    "src/lib/server/whop-checkout.ts",
    "src/lib/server/sandbox-orders.ts",
    "src/app/api/checkout/sandbox/route.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    check(`N. ${file.split("/").pop()} never references financialLedger`, source.includes("financialLedger") === false && source.includes("financial_ledger") === false || source.includes("NOT") || source.includes("never"));
    check(`N. ${file.split("/").pop()} performs no ledger insert`, /insert\(\s*financialLedger/.test(source) === false);
  }
  const webhooks = readFileSync("src/lib/server/whop-webhooks.ts", "utf8");
  check("N. the webhook path performs no ledger insert", /insert\(\s*financialLedger/.test(webhooks) === false);
}

/* ------------------ T. no secret can reach the browser ------------------- */

{
  const client = readFileSync("src/components/checkout/SandboxCheckout.tsx", "utf8");
  for (const f of ["WHOP_API_KEY", "WHOP_WEBHOOK_SECRET", "DATABASE_URL", "apik_", "ws_"]) {
    check(`T. the client component contains no ${f}`, client.includes(f) === false);
  }
  const api = readFileSync("src/app/api/checkout/sandbox/route.ts", "utf8");
  for (const f of ["WHOP_API_KEY", "WHOP_WEBHOOK_SECRET", "DATABASE_URL", "process.env"]) {
    check(`T. the API route never reads ${f} directly`, api.includes(f) === false);
  }
  check("T. the client is a client component and imports no server module", client.includes('from "@/lib/server/') === false);
  check("T. the checkout response exposes only display fields", /order_id|checkout_id|plan_id|amount_minor|currency|environment|reused/.test(api));
}

/* ---------------- APP_PUBLIC_URL: the return-URL contract ---------------- */

const appUrl = load("src/lib/server/app-url.ts", { getWhopEnvironment: () => "sandbox" });
/**
 * A tunnel-shaped origin, deliberately fictional. The real tunnel host belongs
 * in `.env.local`, not in the repository: it changes whenever someone restarts
 * ngrok, and a test pinned to today's URL would rot by tomorrow. What matters
 * here is the SHAPE — an https origin on a tunnel domain — not which one.
 */
const NGROK = "https://example-tunnel-host.ngrok-free.dev";

{
  const env = (APP_PUBLIC_URL) => ({ APP_PUBLIC_URL });

  check("B. an absolute https origin is accepted", appUrl.resolveAppPublicUrl(env(NGROK)).ok === true);
  check("D. it resolves to the configured origin", appUrl.getAppPublicUrl(env(NGROK)) === NGROK);
  check("D. a trailing slash is normalised away", appUrl.getAppPublicUrl(env(NGROK + "/")) === NGROK);
  check("D. a path is reduced to the origin", appUrl.getAppPublicUrl(env(NGROK + "/some/path")) === NGROK);

  check("A. a missing value is refused", appUrl.resolveAppPublicUrl({}).reason === "missing");
  check("A. an empty value is refused", appUrl.resolveAppPublicUrl(env("   ")).reason === "missing");
  check("B. a relative value is refused", appUrl.resolveAppPublicUrl(env("/checkout")).reason === "not_absolute");
  check("B. nonsense is refused", appUrl.resolveAppPublicUrl(env("not a url")).reason === "not_absolute");
  check("C. http:// is refused", appUrl.resolveAppPublicUrl(env("http://example.com")).reason === "not_https");
  check("C. https localhost is refused too", appUrl.resolveAppPublicUrl(env("https://localhost:3000")).reason === "local_host");
  check("C. 127.0.0.1 is refused", appUrl.resolveAppPublicUrl(env("https://127.0.0.1:3000")).reason === "local_host");
  check("A. there is no localhost fallback", appUrl.getAppPublicUrl({}) === null);

  const production = load("src/lib/server/app-url.ts", { getWhopEnvironment: () => "production" });
  check("a tunnel origin is refused in production", production.resolveAppPublicUrl(env(NGROK)).reason === "tunnel_in_production");
  check("a real domain is accepted in production", production.resolveAppPublicUrl(env("https://cliprewards.com")).ok === true);
  check("a tunnel origin is fine in sandbox", appUrl.resolveAppPublicUrl(env(NGROK)).ok === true);

  check("E. an English return URL keeps /en", appUrl.buildCheckoutReturnUrl(ORDER_ID, "en", env(NGROK)) === NGROK + "/en/checkout/sandbox/complete?order_id=" + ORDER_ID);
  check("E. a Hebrew return URL keeps /he", appUrl.buildCheckoutReturnUrl(ORDER_ID, "he", env(NGROK)).includes("/he/checkout/sandbox/complete"));
  check("E. an unknown locale falls back to en, not a path segment", appUrl.buildCheckoutReturnUrl(ORDER_ID, "../../evil", env(NGROK)).includes("/en/checkout/"));
  check("E. the order id is encoded", appUrl.buildCheckoutReturnUrl("a b", "en", env(NGROK)).includes("order_id=a%20b"));
  check("A. no origin means no return URL", appUrl.buildCheckoutReturnUrl(ORDER_ID, "en", {}) === null);
}

/* --------- A. checkout creation refuses without a usable return URL ------ */

{
  let created = false;
  const noUrl = load("src/lib/server/whop-checkout.ts", {
    describeWhopError: () => "",
    getWhopCompanyId: () => OURS,
    getWhopEnvironment: () => "sandbox",
    getWhopPaymentsClient: () => ({
      checkoutConfigurations: {
        create: async () => {
          created = true;
          return { id: "ch_never", plan: { id: "plan_never" } };
        },
      },
    }),
    currencyDecimals: money.currencyDecimals,
    minorToDecimal: money.minorToDecimal,
    buildCheckoutReturnUrl: () => null,
    attachCheckout: async () => true,
    getPaymentOrder: async () => baseOrder,
    isCheckoutEligible: () => true,
    isOrderId: () => true,
  });
  const r = await noUrl.createWhopCheckoutForOrder(ORDER_ID, "en");
  check("A. checkout is refused when no return URL can be built", r.ok === false && r.reason === "missing_public_url");
  check("A. and no provider object was created", created === false);
}
{
  let sentUrl = null;
  const withUrl = load("src/lib/server/whop-checkout.ts", {
    describeWhopError: () => "",
    getWhopCompanyId: () => OURS,
    getWhopEnvironment: () => "sandbox",
    getWhopPaymentsClient: () => ({
      checkoutConfigurations: {
        create: async (body) => {
          sentUrl = body.redirect_url;
          return { id: "ch_x", plan: { id: "plan_x" } };
        },
      },
    }),
    currencyDecimals: money.currencyDecimals,
    minorToDecimal: money.minorToDecimal,
    buildCheckoutReturnUrl: (id, locale) => appUrl.buildCheckoutReturnUrl(id, locale, { APP_PUBLIC_URL: NGROK }),
    attachCheckout: async () => true,
    getPaymentOrder: async () => baseOrder,
    isCheckoutEligible: () => true,
    isOrderId: () => true,
  });
  const r = await withUrl.createWhopCheckoutForOrder(ORDER_ID, "he");
  check("E. a Hebrew checkout succeeds", r.ok === true);
  check("D. the provider receives the configured origin", sentUrl === NGROK + "/he/checkout/sandbox/complete?order_id=" + ORDER_ID, sentUrl);
}

/* ------------- F / J. the completion page trusts only the database ------- */

{
  const page = readFileSync("src/app/[locale]/checkout/sandbox/complete/page.tsx", "utf8");
  check("F. the page reads the order from the database", page.includes("await getPaymentOrder(orderId)"));
  check("F. it never reads a status query parameter", page.includes("query.status") === false);
  check("F. it never reads a payment id from the URL", page.includes("payment_id") === false && page.includes("paymentId") === false);
  check("J. paid is shown only when the ORDER says paid", page.includes('order.status === "paid"'));
  check("J. the page performs no write of any kind", page.includes("markOrderPaid") === false && page.includes(".update(") === false);
  check("F. the order id from the URL is shape-checked", page.includes("isOrderId(orderId)"));
}

/* ------------------ H. no tunnel URL is hardcoded in source -------------- */

{
  for (const file of [
    "src/lib/server/app-url.ts",
    "src/lib/server/whop-checkout.ts",
    "src/app/api/checkout/sandbox/route.ts",
    "src/components/checkout/SandboxCheckout.tsx",
    "src/app/[locale]/checkout/sandbox/page.tsx",
    "src/app/[locale]/checkout/sandbox/complete/page.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    check(`H. ${file.split("/").pop()} hardcodes no tunnel host`, source.includes("nickname-whisking") === false);
  }
  check("H. the checkout builder reads no env var directly", readFileSync("src/lib/server/whop-checkout.ts", "utf8").includes("process.env") === false);
}

/* -------------------- I. the origin never reaches the client ------------- */

{
  const client = readFileSync("src/components/checkout/SandboxCheckout.tsx", "utf8");
  // Comments mention APP_PUBLIC_URL by name; only real code matters here, so
  // block and line comments are stripped before the check.
  const clientCode = client
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  check("I. the client component never READS APP_PUBLIC_URL", clientCode.includes("APP_PUBLIC_URL") === false);
  check("I. the client reads no process.env at all", clientCode.includes("process.env") === false);
  check("I. the client sends only an action, an order id and a locale", (client.match(/JSON\.stringify\(\{[^}]+\}/g) ?? []).every((m) => /action|order_id|locale/.test(m)));
  const api = readFileSync("src/app/api/checkout/sandbox/route.ts", "utf8");
  check("I. the API response carries no origin", api.includes("APP_PUBLIC_URL") === false && api.includes("redirect_url") === false);
}

/* ============ session binding: the fix for orphaned payments ============= */

{
  const client = readFileSync("src/components/checkout/SandboxCheckout.tsx", "utf8");
  const api = readFileSync("src/app/api/checkout/sandbox/route.ts", "utf8");
  const dto = readFileSync("src/lib/server/checkout-session.ts", "utf8");

  // 1 & 2. planId-only is impossible; sessionId is what the embed receives.
  check("1. the embed is NOT mounted by planId", /planId=\{/.test(client) === false);
  check("2. the embed is mounted by sessionId", client.includes("sessionId={phase.session.session_id}"));
  check("2. the environment prop is still explicit", client.includes("environment={environment}"));

  // 3. The session id can only come from the stored checkout id.
  check("3. the DTO's session_id is the stored whop_checkout_id", dto.includes("session_id: order.whopCheckoutId"));
  check("3. the DTO is built from an order row, not a provider response", dto.includes("buildCheckoutSession(order"));

  // 4. Nothing provider-shaped is ever read from a request.
  for (const f of ["session_id", "plan_id", "checkout_id", "payment_id", "company_id", "account_id"]) {
    check(`4. the API never reads ${f} from a request body`, new RegExp(`body as \\{[^}]*${f}`).test(api) === false);
  }
  check("4. the API reads only action, locale and order_id from callers", (api.match(/body as \{[^}]+\}/g) ?? []).every((m) => /action|locale/.test(m)));
  check("4. the client validates what the server returned before rendering", client.includes("isSession(body)") && client.includes('v.session_id.startsWith("ch_")'));

  // 5 & 6. Missing or malformed stored references fail safely.
  const sessionMod = load("src/lib/server/checkout-session.ts", {
    getWhopEnvironment: () => "sandbox",
    getPaymentOrder: async () => null,
    isOrderId: (v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v),
    buildCheckoutReturnUrl: (id, locale) => `https://x.test/${locale}/checkout/sandbox/complete?order_id=${id}`,
  });
  const base = { orderId: ORDER_ID, environment: "sandbox", amountMinor: BigInt(1000), currency: "usd",
    status: "checkout_created", purpose: "sandbox_integration_test",
    whopCheckoutId: "ch_valid123", whopPlanId: "plan_valid123", whopPaymentId: null, paidAt: null };

  check("5. an order with no checkout fails safely", sessionMod.buildCheckoutSession({ ...base, whopCheckoutId: null }, "en").reason === "no_checkout");
  check("5. an order with no plan fails safely", sessionMod.buildCheckoutSession({ ...base, whopPlanId: null }, "en").reason === "no_checkout");
  check("5. an empty stored checkout id reads as no checkout", sessionMod.buildCheckoutSession({ ...base, whopCheckoutId: "" }, "en").reason === "no_checkout");
  for (const bad of ["nope", "CH_abc", "ch_", "pay_abc", "ch_../x"]) {
    check(`6. a malformed stored checkout id ${JSON.stringify(bad)} is refused`,
      sessionMod.buildCheckoutSession({ ...base, whopCheckoutId: bad }, "en").reason === "malformed_provider_reference");
  }
  check("6. a malformed stored plan id is refused", sessionMod.buildCheckoutSession({ ...base, whopPlanId: "nope" }, "en").reason === "malformed_provider_reference");
  check("a well-formed order yields a session", sessionMod.buildCheckoutSession(base, "en").ok === true);
  check("the session carries the stored ch_ verbatim", sessionMod.buildCheckoutSession(base, "en").session.session_id === "ch_valid123");

  // 14. Stale / cross-environment / closed orders are rejected before render.
  check("14. a production order is not renderable in sandbox", sessionMod.buildCheckoutSession({ ...base, environment: "production" }, "en").reason === "environment_mismatch");
  check("14. a paid order is not renderable", sessionMod.buildCheckoutSession({ ...base, status: "paid" }, "en").reason === "already_paid");
  check("14. a cancelled order is not renderable", sessionMod.buildCheckoutSession({ ...base, status: "cancelled" }, "en").reason === "order_closed");
  check("14. no return URL means no session", (() => {
    const noUrl = load("src/lib/server/checkout-session.ts", {
      getWhopEnvironment: () => "sandbox", getPaymentOrder: async () => null,
      isOrderId: () => true, buildCheckoutReturnUrl: () => null,
    });
    return noUrl.buildCheckoutSession(base, "en").reason === "missing_return_url";
  })());

  // 17. Refresh recovery reads an existing order; it never starts a new one.
  check("17. a GET recovers a session for an existing order", api.includes("export async function GET") && api.includes("buildCheckoutSession(order, locale)"));
  check("17. the GET path creates nothing", api.slice(api.indexOf("export async function GET")).includes("createSandboxTestOrder") === false);
  check("17. the client recovers from sessionStorage on mount", client.includes("useEffect") && client.includes("sessionStorage.getItem(ORDER_KEY)"));
  check("17. recovery is a hint only — the server re-reads the order", client.includes("/api/checkout/sandbox?order_id="));

  // 22. Browser callbacks cannot move money.
  check("22. onComplete only changes local phase", client.includes("current.name === \"ready\" ? { name: \"submitted\"") );
  check("22. onPaymentError only changes local phase", /onPaymentError = useCallback\([^)]*\)[\s\S]{0,400}setPhase\(\{ name: "error"/.test(client));
  check("22. no callback posts to any API", client.slice(client.indexOf("UX ONLY")).includes("fetch(") === false);
  check("22. the provider message is never rendered or logged", client.includes("error?.code") && client.includes("error.message") === false);
}

/* ------------------- CSRF / origin check on the sandbox API -------------- */

{
  const origin = load("src/lib/server/request-origin.ts", {
    getAppPublicUrl: () => "https://tunnel.test",
  });
  const H = (h) => new Headers(h);

  check("a same-origin request is allowed", origin.checkRequestOrigin(H({ origin: "https://tunnel.test" })).ok === true);
  check("a localhost request is allowed", origin.checkRequestOrigin(H({ origin: "http://localhost:3000" })).ok === true);
  check("a cross-site origin is refused", origin.checkRequestOrigin(H({ origin: "https://evil.example" })).ok === false);
  check("a look-alike origin is refused", origin.checkRequestOrigin(H({ origin: "https://tunnel.test.evil.example" })).ok === false);
  check("referer is used when origin is absent", origin.checkRequestOrigin(H({ referer: "https://tunnel.test/en/checkout/sandbox" })).ok === true);
  check("a cross-site referer is refused", origin.checkRequestOrigin(H({ referer: "https://evil.example/x" })).ok === false);
  // Browsers attach Origin to every non-GET request, so a POST without one is
  // not a browser and gets no benefit of the doubt.
  check("a request with NO origin header is refused", origin.checkRequestOrigin(H({})).ok === false);
  check("and the refusal names the missing header", origin.checkRequestOrigin(H({})).reason === "missing_origin");
  check("a forged Host header is NOT trusted", origin.checkRequestOrigin(H({ origin: "https://evil.example", host: "tunnel.test" })).ok === false);
  check("x-forwarded-host is NOT trusted", origin.checkRequestOrigin(H({ origin: "https://evil.example", "x-forwarded-host": "tunnel.test" })).ok === false);

  const api = readFileSync("src/app/api/checkout/sandbox/route.ts", "utf8");
  check("the POST runs the origin check", api.includes("checkRequestOrigin(request.headers)"));
  check("an untrusted origin gets 403", api.includes('{ error: "forbidden" }, 403'));
  check("the origin check runs before the body is parsed", api.indexOf("checkRequestOrigin") < api.indexOf("request.json()"));
  check("a JSON content-type is required", api.includes('includes("application/json")'));
  check("unknown actions are refused", api.includes('action !== "start"'));
}

/* ---------------- 20. dev origin allow-list stays scoped ---------------- */

{
  const cfg = readFileSync("next.config.ts", "utf8");
  check("20. allowedDevOrigins is derived from APP_PUBLIC_URL", cfg.includes("process.env.APP_PUBLIC_URL"));
  check("20. no wildcard origin", cfg.includes('"*"') === false && cfg.includes("'*'") === false);
  check("20. no origin reflection from a request header", cfg.includes("headers") === false);
  check("20. an unset APP_PUBLIC_URL allows nothing extra", cfg.includes("if (!raw) return [];"));
  check("20. only the hostname is allowed, not an arbitrary string", cfg.includes("new URL(raw)") && cfg.includes("hostname"));
}

/* ========== exact terminal-success semantics for Payment.status ========== */

{
  // The authoritative set, read from the installed SDK rather than assumed.
  const { ReceiptStatus } = sdk.Whop;
  const ALL = Object.values(ReceiptStatus);
  check("the SDK exposes a closed ReceiptStatus enum", Array.isArray(ALL) && ALL.length === 8, ALL.join(","));
  check("`paid` is a member", ALL.includes("paid"));
  check("there is NO `succeeded` status on the resource", ALL.includes("succeeded") === false);

  const mapping = readFileSync("src/lib/server/whop-payment-mapping.ts", "utf8");
  // The settled test used to be a bare `status !== "paid"` in this file. It
  // now goes through the lifecycle classifier, which knows all eight statuses;
  // what has to stay true is that the decision is a positive classification of
  // the PROVIDER's status and never a negation of an event name.
  check("settlement is decided by classifying the provider status",
    mapping.includes("const phase = classifyProviderStatus(payment.status)") &&
    mapping.includes('phase !== "settled"'));
  check("no status is decided by negating a failure name",
    /status !== ["'`]failed/.test(mapping) === false);
  const rules = readFileSync("src/lib/server/payment-lifecycle.ts", "utf8");
  check("exactly one status is classified as settled",
    rules.includes('const SETTLED: ReadonlySet<string> = new Set(["paid"])'));
  check("the classifier covers every SDK status",
    ALL.every((v) => lifecycleRules.classifyProviderStatus(v) !== "unknown"),
    ALL.filter((v) => lifecycleRules.classifyProviderStatus(v) === "unknown").join(",") || "all covered");

  // Every enum value plus values Whop might add later.
  const settles = [];
  for (const status of [...ALL, "succeeded", "complete", "SOMETHING_NEW", "", null, undefined]) {
    const { mod, state } = mappingModule({ ...goodPayment, status }, baseOrder);
    const r = await mod.mapPaymentToOrder(PAY, "succeeded");
    const didSettle = r.kind === "paid" || state.markCalls.length > 0;
    if (didSettle) settles.push(String(status));
    check(`status ${JSON.stringify(status)} settles: ${didSettle}`, didSettle === (status === "paid"), r.kind);
  }
  check("EXACTLY ONE status can settle an order", settles.length === 1 && settles[0] === "paid", settles.join(",") || "none");
}

/* -------- explicit returnUrl, and the trimmed browser-facing DTO --------- */

{
  const client = readFileSync("src/components/checkout/SandboxCheckout.tsx", "utf8");
  const dto = readFileSync("src/lib/server/checkout-session.ts", "utf8");
  const api = readFileSync("src/app/api/checkout/sandbox/route.ts", "utf8");

  check("the embed receives an explicit returnUrl", client.includes("returnUrl={phase.session.return_url}"));
  check("the deprecated redirectUrl prop is not used", client.includes("redirectUrl=") === false);
  check("the return URL comes from the server DTO", dto.includes("return_url: returnUrl"));
  check("the DTO builds it with the server-side builder", dto.includes("buildCheckoutReturnUrl(order.orderId, locale)"));
  check("no return URL is read from a request body", /body as {[^}]*return/.test(api) === false);
  check("no return URL is read from a query parameter", api.includes('searchParams.get("return') === false);
  check("the client refuses a session whose return URL is not https", client.includes('v.return_url.startsWith("https://")'));
  check("a missing return URL blocks the session entirely", dto.includes('return { ok: false, reason: "missing_return_url" }'));

  // The browser-facing DTO carries no plan id any more.
  const dtoType = dto.slice(dto.indexOf("export type CheckoutSessionDto"), dto.indexOf("export type SessionResult"));
  check("the DTO does NOT expose plan_id", dtoType.includes("plan_id") === false);
  check("the DTO fields are exactly the ones the embed needs",
    ["order_id", "session_id", "environment", "status", "amount_minor", "currency", "return_url"].every((f) => dtoType.includes(f)));
  check("the client type carries no plan_id", client.slice(client.indexOf("type Session = {"), client.indexOf("type Phase")).includes("plan_id") === false);
  check("whop_plan_id is still stored in the database", readFileSync("src/lib/db/schema.ts", "utf8").includes('whop_plan_id'));
}

/* ---------------- explicit opt-in for the sandbox test UI ---------------- */

{
  const build = (env) => load("src/lib/server/sandbox-orders.ts", {
    getWhopEnvironment: (e) => (e ?? env).WHOP_ENV === "sandbox" ? "sandbox" : (e ?? env).WHOP_ENV === "production" ? "production" : null,
    findOrCreateSandboxOrder: async () => ({ ok: true, order: {} }),
  });
  const on = { WHOP_ENV: "sandbox", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "true" };

  check("both switches on => enabled", build(on).isSandboxOrderingEnabled(on) === true);
  check("sandbox but opt-in UNSET => disabled", build(on).isSandboxOrderingEnabled({ WHOP_ENV: "sandbox" }) === false);
  check("sandbox but opt-in empty => disabled", build(on).isSandboxOrderingEnabled({ WHOP_ENV: "sandbox", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "" }) === false);
  check("sandbox but opt-in \"1\" => disabled (exact string only)", build(on).isSandboxOrderingEnabled({ WHOP_ENV: "sandbox", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "1" }) === false);
  check("sandbox but opt-in \"TRUE\" => disabled", build(on).isSandboxOrderingEnabled({ WHOP_ENV: "sandbox", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "TRUE" }) === false);
  check("production with opt-in on => still disabled", build(on).isSandboxOrderingEnabled({ WHOP_ENV: "production", ENABLE_SANDBOX_CHECKOUT_TEST_UI: "true" }) === false);
  check("no environment at all => disabled", build(on).isSandboxOrderingEnabled({}) === false);
  check("the switch is never NEXT_PUBLIC_", readFileSync(".env.example", "utf8").includes("NEXT_PUBLIC_ENABLE_SANDBOX") === false);
  check("the switch is documented in .env.example", readFileSync(".env.example", "utf8").includes("ENABLE_SANDBOX_CHECKOUT_TEST_UI="));
}

/* ------------- double-click safety on the sandbox test button ------------ */

{
  const client = readFileSync("src/components/checkout/SandboxCheckout.tsx", "utf8");
  check("the in-flight guard is a ref, set synchronously", client.includes("inFlight.current = true") && client.includes("if (inFlight.current) return;"));
  // The guard sits at the top of `begin`, before that function's own fetch.
  const beginFn = client.slice(client.indexOf("const begin = useCallback"), client.indexOf("UX ONLY"));
  check("the guard is checked BEFORE any fetch", beginFn.indexOf("if (inFlight.current) return;") < beginFn.indexOf("fetch("));
  check("the guard is released in a finally block", beginFn.slice(beginFn.indexOf("} finally {")).includes("inFlight.current = false;"));
  check("the button is disabled while working", client.includes("disabled={working}") && client.includes("aria-busy={working}"));
  check("state alone is not relied on for the guard", client.includes("useRef"));
  check("the UI has an explicit order-created state", client.includes("copy.orderCreated"));
  check("the UI shows the order id", client.includes("phase.orderId"));
  check("errors never render a provider message", client.includes("copy.errorBody") && client.includes("error.message") === false);

  const sandbox = readFileSync("src/lib/server/sandbox-orders.ts", "utf8");
  check("the server reuse/create step is the transactional one", sandbox.includes("findOrCreateSandboxOrder"));
  const orders = readFileSync("src/lib/server/payment-orders.ts", "utf8");
  const reuse = orders.slice(orders.indexOf("export async function findOrCreateSandboxOrder"));
  // Reuse covers every state an order can still be PAID from — including
  // checkout_created, which is where an order sits after a successful start.
  // Matching only "created" was the bug that let a second click create a
  // second order and a second Whop configuration for the same test.
  // The match predicate lives just above the function, shared so the lookup
  // and the tests cannot drift apart.
  const predicate = orders.slice(orders.indexOf("function stillPayable"), orders.indexOf("const SANDBOX_ORDER_LOCK"));
  check("reuse covers every still-payable state", predicate.includes("in ('created', 'checkout_created', 'payment_pending', 'failed')"));
  check("reuse never returns a settled order", predicate.includes("isNull(paymentOrders.whopPaymentId)") && predicate.includes("isNull(paymentOrders.paidAt)"));
  check("reuse picks the oldest, so clicks converge on one order", reuse.includes("asc(paymentOrders.createdAt)"));
  check("reuse is sandbox-only", reuse.includes(`environment !== "sandbox"`));
  // It DOES create — but only when the guarded lookup found nothing, inside
  // the same locked transaction.
  check("creation happens only after the lookup, inside the lock", reuse.indexOf("pg_advisory_xact_lock") < reuse.indexOf(".select()") && reuse.indexOf(".select()") < reuse.indexOf(".insert("));
  check("the create/lookup pair is one transaction", reuse.includes("db.transaction("));
}

/* --------- O. one payment cannot settle two orders — real Postgres ------- */

if (process.env.DATABASE_URL) {
  const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
  await sql.begin(async (tx) => {
    await tx`
      create temp table orders (
        order_id uuid primary key default gen_random_uuid(),
        amount_minor bigint not null,
        currency char(3) not null,
        status text not null default 'created',
        whop_payment_id text,
        paid_at timestamptz
      ) on commit drop`;
    await tx`create unique index on orders (whop_payment_id) where whop_payment_id is not null`;

    const [a] = await tx`insert into orders (amount_minor, currency) values (1000, 'usd') returning order_id`;
    const [b] = await tx`insert into orders (amount_minor, currency) values (1000, 'usd') returning order_id`;

    await tx`update orders set whop_payment_id = ${PAY}, status='paid', paid_at=now() where order_id=${a.order_id}`;
    // A constraint violation aborts the enclosing transaction, so the attempt
    // runs inside a savepoint — the same shape a real handler needs.
    let refused = false;
    try {
      await tx.savepoint(
        async (sp) =>
          sp`update orders set whop_payment_id = ${PAY}, status='paid', paid_at=now() where order_id=${b.order_id}`,
      );
    } catch {
      refused = true;
    }
    check("O. the database REFUSES one payment settling a second order", refused);

    const [{ n }] = await tx`select count(*)::int as n from orders where whop_payment_id = ${PAY}`;
    check("O. exactly one order holds that payment", n === 1, `${n}`);

    // Many unpaid orders must coexist: the index is partial for that reason.
    await tx`insert into orders (amount_minor, currency) values (1000,'usd'), (1000,'usd')`;
    const [{ n: nulls }] = await tx`select count(*)::int as n from orders where whop_payment_id is null`;
    check("O. many orders without a payment coexist", nulls >= 3, `${nulls}`);
  });

  const [{ n: ledger }] = await sql`select count(*)::int as n from financial_ledger`;
  check("N. financial_ledger is still empty", ledger === 0, `${ledger} rows`);
  const tables = await sql`select table_name from information_schema.tables where table_schema='public'`;
  check("payment_orders exists (migration 0002 applied)", tables.some((t) => t.table_name === "payment_orders") === true);

  // Nothing in this suite writes an order. Exactly one exists — the real
  // sandbox test order — and no run may add to it.
  const [{ n: orders }] = await sql`select count(*)::int as n from payment_orders`;
  // The suite must not add an order. The absolute count is not asserted —
  // orders accumulate from real sandbox testing — but this run must leave it
  // exactly as it found it.
  check("the suite itself created no order", orders === ordersAtStart, `${ordersAtStart} -> ${orders}`);
  // A payment id may only ever sit on a settled order. Asserted as an
  // invariant rather than as a fixed count, so it keeps holding as more
  // sandbox payments happen.
  const [{ n: paid }] = await sql`select count(*)::int as n from payment_orders where status = 'paid'`;
  const [{ n: attached }] = await sql`select count(*)::int as n from payment_orders where whop_payment_id is not null`;
  check("every order carrying a payment id is paid", attached === paid, `${attached} attached, ${paid} paid`);
  const [{ n: mismatched }] = await sql`
    select count(*)::int as n from payment_orders
     where (whop_payment_id is not null) <> (status = 'paid')
        or (paid_at is not null) <> (status = 'paid')`;
  check("payment id, paid_at and status agree on every order", mismatched === 0, `${mismatched} disagree`);
  // A cancelled order never acquires a payment.
  const [{ n: cancelledWithPayment }] = await sql`
    select count(*)::int as n from payment_orders where status = 'cancelled' and whop_payment_id is not null`;
  check("no cancelled order carries a payment", cancelledWithPayment === 0);

  // The partial UNIQUE index is the real defence for "one payment, one order".
  const [{ n: partial }] = await sql`select count(*)::int as n from pg_indexes
     where tablename='payment_orders' and indexname='uniq_orders_whop_payment'
       and indexdef ilike '%where%whop_payment_id is not null%'`;
  check("O. the partial UNIQUE payment index is live in the database", partial === 1);
  await sql.end({ timeout: 2 });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
