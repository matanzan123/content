#!/usr/bin/env node
/**
 * TASK #27 — PRODUCTION WEBHOOK READINESS.
 *
 * The receiver was already in good shape: the raw body is verified before it is
 * parsed, the signing secret comes only from server config, an unverified
 * delivery is never acknowledged, the receipt row is acquired atomically with a
 * processing lease, every timestamp comes from Postgres rather than this
 * process, and no handler trusts a status out of the payload. Signature and
 * lease semantics are proved in `whop-webhook-test.mjs` and `whop-retry-test.mjs`;
 * child-account routing in `whop-child-webhook-test.mjs`. This suite covers what
 * those do not, and what a production cutover actually turns on.
 *
 * WHAT WAS WRONG — event coverage.
 *
 * The app moves money through TWO provider resources: `client.transfers.*`
 * (platform balance to a creator's Whop balance, `creator_transfers`) and
 * `client.payouts.*` (creator balance out to their bank, `creator_withdrawals`,
 * `wdrl_` ids). The installed SDK's `WebhookEvent` enum carries event families
 * for both — `transfer.created/completed/failed` and
 * `withdrawal.created/updated/reversed` — and only `payout.*` was subscribed.
 *
 *   - `transfer.*` was omitted on the strength of a comment claiming transfers
 *     "have no webhook of their own in the installed SDK". The enum says
 *     otherwise. A completed transfer therefore became visible only when an
 *     administrator ran a reconcile by hand, and there is no scheduler.
 *   - `withdrawal.*` versus `payout.*` for the `wdrl_` resource is a
 *     provider-dashboard fact this repository cannot settle. Both are now
 *     subscribed, so the answer no longer has to be guessed at.
 *
 * NO NETWORK. NO PROVIDER CALL. The reconcilers are injected, so each handler
 * outcome is exercised without a request leaving the process. The real database
 * is read for the receipt inventory and is counted before and after.
 *
 * NO SECRET IS PRINTED. Where configuration is read it is reduced to a boolean
 * before anything is shown.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const postgres = require("postgres");

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const section = (t) => console.log(`\n--- ${t} ---`);
const src = (p) => readFileSync(p, "utf8");
const codeOnly = (p) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** Imports stripped, for any assertion whose subject is ORDER of execution. */
const bodyOnly = (p) =>
  codeOnly(p).replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");

/**
 * One function's body out of comment-stripped source.
 *
 * SLICED TO THE NEXT `export`, not to the next `/**`. `codeOnly` has already
 * removed every block comment, so a doc-comment boundary does not exist in this
 * text — asking for one returns -1 and the "body" silently becomes the rest of
 * the file, which then matches whatever any later function does. That is how an
 * assertion about one handler ends up reading another's `.insert(`.
 */
function functionBody(text, name) {
  const at = text.indexOf(`export async function ${name}`);
  if (at < 0) return null;
  const next = text.indexOf("\nexport ", at + 10);
  return text.slice(at, next < 0 ? undefined : next);
}

const HOOKS = "src/lib/server/whop-webhooks.ts";
const ROUTE = "src/app/api/webhooks/whop/route.ts";
const WEBHOOK_PATH = "/api/webhooks/whop";

/* Loader in the established shape for this module: imports stripped, named
 * dependencies injected, so each seam can be driven directly. */
function load(file, injected = {}) {
  const source = src(file).replace(/^import[^;]+;$/gms, "");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const names = Object.keys(injected);
  new Function("module", "exports", "require", ...names, js)(
    mod, mod.exports, require, ...names.map((n) => injected[n]),
  );
  return mod.exports;
}

/* ---------------------------------------------------------------- A ---- */
section("A. Event coverage matches the installed SDK, not a memory of it");

/* THE ENUM IS THE CONTRACT. Read from the installed .d.ts so an SDK upgrade that
 * adds or renames an event shows up here rather than in production. */
const sdkEnumSrc = src("node_modules/@whop/sdk/dist/cjs/api/types/WebhookEvent.d.ts");
const sdkEvents = new Set(
  [...sdkEnumSrc.matchAll(/readonly \w+:\s*"([^"]+)"/g)].map((m) => m[1]));

/* THE SUBSCRIBABLE LIST IS THE ONE THAT MATTERS, and it is a DIFFERENT set.
 *
 * `WebhookEvent` is the enum of event names that exist. `CreateWebhooksRequest.
 * Events.Item` is what an endpoint can actually be subscribed to — and they do
 * not agree: `withdrawal.created/updated/reversed` are in the former and absent
 * from the latter, while `resolution.created/updated/decided` are in the latter
 * and absent from the former. An event that cannot be subscribed cannot be
 * delivered, so a handler for one is dead code; an event that CAN be subscribed
 * and has no handler is a delivery recorded `unsupported` with the lifecycle
 * behind it receiving nothing. Both mistakes were made and corrected in Task #27,
 * which is why this suite reads both files. */
const createReqSrc = src(
  "node_modules/@whop/sdk/dist/cjs/api/resources/webhooks/client/requests/CreateWebhooksRequest.d.ts");
const subscribable = new Set(
  [...createReqSrc.matchAll(/readonly \w+:\s*"([^"]+)"/g)].map((m) => m[1]));

const hooksMod = load(HOOKS, {
  getWhopEnvironment: () => "sandbox",
  getWhopCompanyId: () => "biz_platform",
  getWhopWebhookSecret: () => null,
  getDb: () => null,
  unwrapWebhook: () => { throw new Error("unused"); },
  WebhookVerificationError: Error,
  resolveChildAccount: async () => null,
  refreshTransferFromProvider: async () => ({ ok: false, reason: "not_ours" }),
  findWithdrawalByProviderPayoutId: async () => null,
  reconcileWithdrawal: async () => ({ ok: true }),
  and: () => null, eq: () => null, isNull: () => null, or: () => null,
  sql: () => null,
  whopWebhookReceipts: {},
  verifyPaymentOwnership: async () => ({ kind: 'verified' }),
  verifyRefundOwnership: async () => ({ kind: 'verified' }),
  verifyDisputeOwnership: async () => ({ kind: 'verified' }),
  verifyAlertOwnership: async () => ({ kind: 'verified' }),
  verifyCaseOwnership: async () => ({ kind: 'verified' }),
  shouldRetryLookup: () => false,
  mapPaymentToOrder: async () => ({ kind: 'ignored', reason: 'not_settled' }),
  postWhopSettlement: async () => ({ ok: true }),
  mapRefundToOrder: async () => ({ kind: 'pending' }),
  postWhopRefund: async () => ({ ok: true }),
  mapDisputeToOrder: async () => ({ kind: 'recorded' }),
  mapAlertToOrder: async () => ({ kind: 'recorded_unmatched' }),
  mapCaseToOrder: async () => ({ kind: 'recorded' }),
  postDisputeMovementsForPayment: async () => ({ ok: true }),
  updateConnectedAccountStatus: async () => ({ ok: true, updated: true }),
  describeWhopError: (e) => (e instanceof Error ? e.message : "unknown"),
});

{
  const supported = hooksMod.SUPPORTED_EVENTS;
  check("the SDK enum parsed", sdkEvents.size > 50, `${sdkEvents.size} names`);
  check("the subscribable list parsed", subscribable.size > 50, `${subscribable.size} subscribable`);
  check("the two lists genuinely differ, which is why both are read",
    [...sdkEvents].some((e) => !subscribable.has(e)) &&
      [...subscribable].some((e) => !sdkEvents.has(e)));

  /* EVERY EVENT WE HANDLE MUST BE ONE AN ENDPOINT CAN BE SUBSCRIBED TO. A
   * handler for an unsubscribable name can never run. */
  const unsubscribable = supported.filter((e) => !subscribable.has(e));
  check("every subscribed event is actually subscribable",
    unsubscribable.length === 0, unsubscribable.join(", "));
  check("withdrawal.* is NOT taken, because it cannot be subscribed",
    !supported.some((e) => e.startsWith("withdrawal.")) &&
      ![...subscribable].some((e) => e.startsWith("withdrawal.")),
    [...subscribable].filter((e) => e.startsWith("withdrawal.")).join(",") || "absent from both");
  check("there are no duplicates in the list",
    new Set(supported).size === supported.length);

  /* THE MONEY-MOVEMENT FAMILIES, both of them. */
  for (const e of [
    "payment.created", "payment.pending", "payment.authorized",
    "payment.succeeded", "payment.failed", "payment.canceled",
    "refund.created", "refund.updated",
    "dispute.created", "dispute.updated", "dispute_alert.created",
    "resolution_center_case.created", "resolution_center_case.updated",
    "resolution_center_case.decided",
    "resolution.created", "resolution.updated", "resolution.decided",
    "payout.created", "payout.updated", "payout.reversed",
    "transfer.created", "transfer.completed", "transfer.failed",
    "account.updated",
  ]) {
    check(`  ${e} is subscribed`, supported.includes(e));
  }
  check("that is the whole list — nothing unaccounted for",
    supported.length === 24, `${supported.length} events`);

  /* THE NEGATIVE CLAIMS THE SOURCE MAKES, verified against the enum rather than
   * trusted: these names must NOT exist, or the comments explaining their absence
   * would be wrong. */
  for (const absent of ["payment.completed", "dispute.won", "dispute.lost", "dispute_alert.updated"]) {
    check(`  ${absent} genuinely does not exist in the SDK`, !sdkEvents.has(absent));
  }

  /* EVENTS THE SDK OFFERS AND WE DELIBERATELY DO NOT TAKE. Listed so that the set
   * is a decision with a reason, not an oversight — and so a future SDK adding a
   * money event lands in the unreviewed bucket below. */
  const DELIBERATELY_UNSUBSCRIBED = new Set([
    /* NOT SUBSCRIBABLE AT ALL. Present in `WebhookEvent`, absent from the list an
     * endpoint can subscribe to, so no handler could ever be reached. `payout.*`
     * is the family that carries this resource. */
    "withdrawal.created", "withdrawal.updated", "withdrawal.reversed",
    // Identity/verification: the app reads KYC readiness by retrieving the
    // account (`fetchPayoutStatus`), and `account.updated` already triggers that.
    // Subscribing four more identity events would add triggers for one state.
    "identity_profile.approved", "identity_profile.rejected",
    "identity_profile.needs_action", "identity_profile.updated",
    "verification.succeeded", "payout_account.status_updated",
    "payout_method.created",
    // Products the app does not sell, features it does not have.
    "invoice.created", "invoice.marked_uncollectible", "invoice.paid",
    "invoice.past_due", "invoice.voided",
    "membership.activated", "membership.deactivated",
    "membership.trial_ending_soon", "membership.cancel_at_period_end_changed",
    "entry.created", "entry.approved", "entry.denied", "entry.deleted",
    "export.completed", "export.failed",
    "setup_intent.requires_action", "setup_intent.succeeded", "setup_intent.canceled",
    "ledger_account.funds_available", "swap.completed", "deposit.succeeded",
    "card_transaction.created", "card_transaction.updated",
    "card_transaction.completed", "card_transaction.declined",
    "card_transaction.reversed",
    "card.created", "card.updated", "card.frozen", "card.canceled",
    "card_application.created", "card_application.updated",
    "card_application.approved", "card_application.denied",
    "course_lesson_interaction.completed",
    "product.created", "product.updated", "product.deleted",
    "product.published", "product.unpublished",
    "plan.created", "plan.updated", "plan.deleted",
    "shipment.created", "shipment.updated", "member.created",
    "ad_campaign.payment_failed", "chat.message.created", "chat.reaction.created",
  ]);
  const unreviewed = [...sdkEvents].filter(
    (e) => !supported.includes(e) && !DELIBERATELY_UNSUBSCRIBED.has(e));
  check("every SDK event is either subscribed or explicitly reviewed",
    unreviewed.length === 0, unreviewed.join(", "));
}

/* ---------------------------------------------------------------- B ---- */
section("B. Every subscribed event routes somewhere, and money events to an authority");

{
  const table = codeOnly(HOOKS).slice(codeOnly(HOOKS).indexOf("const HANDLERS"));
  const supported = hooksMod.SUPPORTED_EVENTS;
  const unrouted = supported.filter((e) => !table.includes(`"${e}":`));
  check("no subscribed event is missing a handler", unrouted.length === 0, unrouted.join(", "));

  /* THE TWO NEW FAMILIES SHARE THE TWO AUTHORITY-BASED RESOLVERS. */
  for (const [event, fn] of [
    ["payout.created", "handleWhopPayoutUpdated"],
    ["payout.updated", "handleWhopPayoutUpdated"],
    ["payout.reversed", "handleWhopPayoutUpdated"],
    ["resolution.created", "handleWhopResolutionCase"],
    ["resolution.updated", "handleWhopResolutionCase"],
    ["resolution.decided", "handleWhopResolutionCase"],
    ["transfer.created", "handleWhopTransferUpdated"],
    ["transfer.completed", "handleWhopTransferUpdated"],
    ["transfer.failed", "handleWhopTransferUpdated"],
  ]) {
    /* EITHER FORM. Some entries name the handler directly, others wrap it in an
     * arrow to reorder or drop arguments; both are the same routing decision. */
    check(`  ${event} → ${fn}`,
      new RegExp(`"${event}": (?:${fn},|\\([^)]*\\) => ${fn}\\()`).test(table),
      (table.match(new RegExp(`"${event}": [^\\n]*`)) ?? ["absent"])[0].trim());
  }

  /* NEITHER RESOLVER READS AN OUTCOME OUT OF THE PAYLOAD, even though both
   * families put one in the event NAME. `transfer.completed` is a trigger. */
  const whole = codeOnly(HOOKS);
  for (const fn of ["handleWhopPayoutUpdated", "handleWhopTransferUpdated"]) {
    const body = functionBody(whole, fn);
    check(`${fn} exists`, body !== null && body.length > 100, `${body?.length ?? 0} chars`);
    check(`  ${fn} reads no status from the payload`,
      !/readString\(data, "status"\)|data\.status/.test(body));
    check(`  ${fn} writes no money state itself`,
      !/\.insert\(|\.update\(|accountingEntries|reverseTransaction/.test(body));
    check(`  ${fn} resolves the id against our own rows before the provider`,
      /findWithdrawalByProviderPayoutId|refreshTransferFromProvider/.test(body));
  }
}

/* ---------------------------------------------------------------- C ---- */
section("C. The transfer handler's three outcomes");

{
  /* DRIVEN DIRECTLY, because the distinction that matters is invisible in source:
   * whether a delivery is ACKNOWLEDGED or RETRIED. Acknowledging a provider we
   * could not read would let Whop stop redelivering an event whose real state we
   * never learned — the one outcome that loses money state silently. */
  const outcomes = [];
  const withReconciler = (result) => load(HOOKS, {
    getWhopEnvironment: () => "sandbox",
    getWhopCompanyId: () => "biz_platform",
    getWhopWebhookSecret: () => null,
    getDb: () => null,
    unwrapWebhook: () => { throw new Error("unused"); },
    WebhookVerificationError: Error,
    resolveChildAccount: async () => null,
    refreshTransferFromProvider: async (id) => { outcomes.push(id); return result; },
    findWithdrawalByProviderPayoutId: async () => null,
    reconcileWithdrawal: async () => ({ ok: true }),
    and: () => null, eq: () => null, isNull: () => null, or: () => null,
    sql: () => null, whopWebhookReceipts: {},
  verifyPaymentOwnership: async () => ({ kind: 'verified' }),
  verifyRefundOwnership: async () => ({ kind: 'verified' }),
  verifyDisputeOwnership: async () => ({ kind: 'verified' }),
  verifyAlertOwnership: async () => ({ kind: 'verified' }),
  verifyCaseOwnership: async () => ({ kind: 'verified' }),
  shouldRetryLookup: () => false,
  mapPaymentToOrder: async () => ({ kind: 'ignored', reason: 'not_settled' }),
  postWhopSettlement: async () => ({ ok: true }),
  mapRefundToOrder: async () => ({ kind: 'pending' }),
  postWhopRefund: async () => ({ ok: true }),
  mapDisputeToOrder: async () => ({ kind: 'recorded' }),
  mapAlertToOrder: async () => ({ kind: 'recorded_unmatched' }),
  mapCaseToOrder: async () => ({ kind: 'recorded' }),
  postDisputeMovementsForPayment: async () => ({ ok: true }),
  updateConnectedAccountStatus: async () => ({ ok: true, updated: true }),
    describeWhopError: (e) => (e instanceof Error ? e.message : "unknown"),
  });

  const body = { data: { id: "tr_abc123", status: "succeeded" } };

  const okMod = withReconciler({ ok: true, status: "completed" });
  const handled = await okMod.handleWhopTransferUpdated("tr_abc123", "msg_1", body);
  check("a reconciled transfer is handled", handled.kind === "handled", JSON.stringify(handled));

  outcomes.length = 0;
  const foreignMod = withReconciler({ ok: false, reason: "not_ours" });
  const foreign = await foreignMod.handleWhopTransferUpdated("tr_zzz", "msg_2", body);
  check("an id that is not ours is ACKNOWLEDGED, not retried forever",
    foreign.kind === "business_mapping_not_implemented", JSON.stringify(foreign));

  const unreadableMod = withReconciler({ ok: false, reason: "unreadable" });
  const unreadable = await unreadableMod.handleWhopTransferUpdated("tr_abc123", "msg_3", body);
  check("a provider we could not read stays RETRYABLE",
    unreadable.kind === "failed" && unreadable.category === "transfer_reconcile_failed",
    JSON.stringify(unreadable));
  /* THE DISTINCTION IS THE POINT. If both collapsed to one answer, one of the two
   * would be wrong — either an event is lost or it is retried forever. */
  check("the two failures are genuinely different answers",
    foreign.kind !== unreadable.kind);

  /* THE ID COMES FROM THE SIGNED ENVELOPE FIRST, then the payload — and a
   * delivery naming nothing is acknowledged rather than sent to the provider. */
  outcomes.length = 0;
  const noIdMod = withReconciler({ ok: true, status: "completed" });
  const noId = await noIdMod.handleWhopTransferUpdated(null, "msg_4", { data: {} });
  check("a delivery naming no transfer is acknowledged and unmapped",
    noId.kind === "business_mapping_not_implemented", JSON.stringify(noId));
  check("and never reaches the provider", outcomes.length === 0, outcomes.join(","));

  outcomes.length = 0;
  await noIdMod.handleWhopTransferUpdated(null, "msg_5", { data: { id: "tr_frompayload" } });
  check("a payload id is used when the envelope has none",
    outcomes[0] === "tr_frompayload", outcomes.join(","));
  outcomes.length = 0;
  await noIdMod.handleWhopTransferUpdated("tr_fromenvelope", "msg_6", { data: { id: "tr_frompayload" } });
  check("but the envelope id WINS when both are present",
    outcomes[0] === "tr_fromenvelope", outcomes.join(","));
}

/* ---------------------------------------------------------------- D ---- */
section("D. An unsupported event is cheap and harmless");

{
  const whole = codeOnly(HOOKS);
  check("an unsupported event is classified before any handler runs",
    /const supported = isSupportedEvent\(eventType\);/.test(whole) &&
      whole.indexOf("isSupportedEvent(eventType)") < whole.indexOf("HANDLERS["));
  check("its receipt reaches a terminal status",
    hooksMod.TERMINAL_STATUSES.includes("unsupported"));
  check("so it is acknowledged and never redelivered",
    /initialStatus = \(wrongCompany && !isChildAccount\) \? "rejected_company" : supported \? "received" : "unsupported"/.test(whole));
  check("an unknown event name is not supported",
    hooksMod.isSupportedEvent("card.frozen") === false &&
      hooksMod.isSupportedEvent("totally.invented") === false &&
      hooksMod.isSupportedEvent(null) === false &&
      hooksMod.isSupportedEvent(42) === false);
  check("and a supported one is",
    hooksMod.isSupportedEvent("transfer.completed") === true);
}

/* ---------------------------------------------------------------- E ---- */
section("E. Ordering: verify, gate, prove, post, notify");

{
  const routeBody = bodyOnly(ROUTE);
  /* THE RAW BODY IS VERIFIED BEFORE IT IS PARSED. Verifying a re-serialised body
   * verifies something else, and the SDK helper says so explicitly. */
  check("the route reads the raw text, never json()",
    /request\.text\(\)/.test(routeBody) && !/request\.json\(\)/.test(routeBody));
  check("and verifies before it dispatches",
    routeBody.indexOf("verifyWebhook") < routeBody.indexOf("processVerifiedWebhook"));
  check("nothing runs on an unverified body",
    /if \(!verified\.ok\)/.test(routeBody) &&
      routeBody.indexOf("if (!verified.ok)") < routeBody.indexOf("processVerifiedWebhook"));
  /* THE DEDUPLICATION KEY COMES FROM THE SIGNED HEADERS, AND FROM NOTHING ELSE.
   *
   * A body field is chosen by whoever sent the body. If the id could come from
   * there, two deliveries could claim one receipt — or one delivery could claim a
   * different event's — and the whole idempotency model rests on that key. It is
   * not enough that `readWebhookId(headers)` appears: a mutation run showed
   * `body.id ?? readWebhookId(headers)` satisfying that and still taking the id
   * from the payload whenever one was supplied. */
  const idLine = (routeBody.match(/const webhookId = [^\n;]+/) ?? ["absent"])[0];
  check("the delivery id comes from the signed headers and nowhere else",
    idLine === "const webhookId = readWebhookId(headers)", idLine);
  check("and a delivery without one is refused, not invented",
    /if \(!webhookId\) return json\(\{ error: "unverified" \}, 401\)/.test(routeBody));

  /* AN UNVERIFIED DELIVERY IS NEVER 2xx.
   *
   * Answering 200 to an unsigned body would accept a forgery and stop Whop
   * retrying a genuinely mis-signed one. No suite asserted the status at all
   * until a mutant returned 200 here and nothing noticed. */
  const statusLine = (routeBody.match(/const status = verified\.reason[^\n;]+/) ?? ["absent"])[0];
  check("an unverified delivery answers 401, or 503 when no secret is configured",
    /verified\.reason === "no_secret" \? 503 : 401/.test(statusLine), statusLine);
  check("and the refusal is returned rather than falling through",
    /return json\(\{ error: "unverified" \}, status\)/.test(routeBody));

  const whole = codeOnly(HOOKS);
  const proc = whole.slice(whole.indexOf("export async function processVerifiedWebhook"));
  check("the receipt is acquired before any handler is dispatched",
    proc.indexOf(".insert(whopWebhookReceipts)") < proc.indexOf("HANDLERS["));
  check("ownership is proved before dispatch",
    proc.indexOf("OWNERSHIP_GATED[") < proc.indexOf("HANDLERS["));

  /* NOTIFICATIONS CANNOT BREAK MONEY. A notification failure must not turn a
   * completed posting into a retried delivery, or a retry would post twice. */
  const notifySites = [...whole.matchAll(/notify\w+\(/g)].map((m) => m[0]);
  check("the receiver calls no individual notifier directly",
    notifySites.length === 0, notifySites.join(","));
  /* IT GOES THROUGH ONE DISPATCHER, AFTER the handler succeeded and with its
   * failures swallowed. Both halves matter: before the handler, a notification
   * would announce money that had not moved; unswallowed, a failed notification
   * would mark the delivery failed and a retry would post twice. */
  check("notifications fire through one dispatcher, after a successful handler",
    /await fireWebhookNotifications\(eventType, resourceId, body\)\.catch\(\(\) => \{\}\)/.test(whole) &&
      whole.indexOf("await HANDLERS[eventType]") < whole.indexOf("fireWebhookNotifications("));
  check("and only for a delivery that actually processed",
    /if \(status === "processed"\) \{\s*\n\s*await fireWebhookNotifications/.test(whole));

  /* EVERY MONEY EVENT THAT HAS SOMETHING TO SAY HAS A BRANCH THAT CAN SAY IT.
   *
   * `notifyPayoutCompleted` resolves `creator_transfers` by provider transfer id,
   * so it is the TRANSFER notification — and until Task #27 it was reachable only
   * from the `payout.*` branch, whose ids are `wdrl_` and live in the withdrawal
   * id space. The lookup could never match, so no creator was ever told a
   * transfer had landed or failed: an unreachable branch, the same shape Task #22
   * found one level in. Asserted as reachability, per event name. */
  const triggerCode = codeOnly("src/lib/server/notification-triggers.ts");
  for (const e of ["transfer.completed", "transfer.failed", "payout.updated",
                   "payout.reversed", "payment.succeeded", "account.updated"]) {
    check(`  ${e} has a notification branch`, triggerCode.includes(`"${e}"`), e);
  }
  check("the transfer branch can report BOTH outcomes",
    /notifyPayoutCompleted\(transferId, true\)/.test(triggerCode) &&
      /notifyPayoutCompleted\(transferId, false\)/.test(triggerCode));
  check("and a transfer still processing tells nobody anything",
    /const succeeded = !failed &&/.test(triggerCode) &&
      !/payloadStatus === "processing"/.test(triggerCode));
  /* They are triggered from the money modules, after the state is committed, and
   * every one is idempotent on an environment-scoped economic key. */
  const triggers = codeOnly("src/lib/server/notification-triggers.ts");
  check("every notification key carries the environment",
    (triggers.match(/notificationKey\(/g) ?? []).length >= 8 &&
      /function notificationKey\(\s*type[^)]*environment/s.test(triggers));
  check("and notification failures are swallowed, never propagated as money failures",
    /catch/.test(triggers));
}

/* ---------------------------------------------------------------- F ---- */
section("F. The secret, and the endpoint URL");

{
  const wp = load("src/lib/server/whop-payments.ts", { WhopClient: class {} });

  /* REGRESSION OF THE TASK #26 FIX: an empty secret must not report configured.
   * `isWhopWebhookConfigured` compares `!== null`, so a reader that returned ""
   * would call an endpoint with no secret "configured" — and an endpoint with no
   * secret can verify nothing, so it must refuse everything. */
  for (const [label, value] of [
    ["unset", undefined], ["empty", ""], ["whitespace", "   "], ["a tab", "\t"],
  ]) {
    check(`  a ${label} webhook secret is NOT configured`,
      wp.isWhopWebhookConfigured({ WHOP_WEBHOOK_SECRET: value }) === false);
    check(`    and yields no secret`,
      wp.getWhopWebhookSecret({ WHOP_WEBHOOK_SECRET: value }) === null);
  }
  check("a present secret is configured",
    wp.isWhopWebhookConfigured({ WHOP_WEBHOOK_SECRET: "ws_obviously_fake" }) === true);
  check("and is returned trimmed, never as padding",
    wp.getWhopWebhookSecret({ WHOP_WEBHOOK_SECRET: "  ws_fake  " }) === "ws_fake");

  /* SERVER ONLY. A webhook secret in a browser bundle would let anyone forge a
   * delivery. */
  check("the secret is read only in a server-only module",
    /import "server-only"/.test(src("src/lib/server/whop-payments.ts")));
  const all = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) all.push(p);
    }
  })("src");
  const leaks = all.filter((f) =>
    /^\s*["']use client["']/.test(src(f)) && /WHOP_WEBHOOK_SECRET/.test(src(f)));
  check("no client component names the webhook secret", leaks.length === 0, leaks.join(", "));
  check("it is never NEXT_PUBLIC_",
    !all.some((f) => /NEXT_PUBLIC_WHOP_WEBHOOK/.test(src(f))));
  /* AND IT NEVER REACHES A RESPONSE OR A LOG. A verification failure can quote
   * the material it was comparing, which is why the error object is not logged. */
  check("the verifier logs no error object",
    !/console\.\w+\(error/.test(codeOnly(HOOKS)));
  check("and the route's refusal names no reason a prober could use",
    /\{ error: "unverified" \}/.test(bodyOnly(ROUTE)));

  /* THE ENDPOINT PATH, derived from the route's own location. */
  const routes = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n === "route.ts") routes.push(p.replace(/\\/g, "/"));
    }
  })("src/app/api");
  const webhookRoutes = routes
    .filter((f) => /webhooks/.test(f))
    .map((f) => "/" + f.replace("src/app/", "").replace("/route.ts", ""));
  check("there is exactly one webhook route, at the documented path",
    webhookRoutes.length === 1 && webhookRoutes[0] === WEBHOOK_PATH,
    webhookRoutes.join(", "));

  /* THE PROVIDER IS NOT A BROWSER. An origin check here would drop every
   * legitimate delivery; the signature is the trust mechanism instead. */
  check("the webhook route requires no browser origin",
    !/checkRequestOrigin/.test(codeOnly(ROUTE)));
  check("nor a session or admin guard",
    !/withAdminApi|getUserFromRequest|requireAdmin/.test(codeOnly(ROUTE)));
  check("nor a per-caller rate limit, which would drop provider retries",
    !/checkRateLimit/.test(codeOnly(ROUTE)) && !/checkRateLimit/.test(codeOnly(HOOKS)));
  check("it runs on Node, not the edge — the driver and verifier need it",
    /export const runtime = "nodejs"/.test(src(ROUTE)));
  check("and is never cached",
    /export const dynamic = "force-dynamic"/.test(src(ROUTE)) &&
      /"cache-control": "no-store"/.test(src(ROUTE)));
  check("any method other than POST is refused",
    /export async function GET/.test(src(ROUTE)) && /method_not_allowed/.test(src(ROUTE)));
  /* THE CAP IS A COMPARISON, not a constant that happens to exist. Asserting the
   * name appears before `request.text()` was satisfied by the declaration alone,
   * so deleting the actual check survived a mutation run. */
  check("an oversized body is refused before it is read",
    /if \(length > MAX_BODY_BYTES\) return json\(\{ error: "payload_too_large" \}, 413\)/.test(codeOnly(ROUTE)) &&
      codeOnly(ROUTE).indexOf("length > MAX_BODY_BYTES") < codeOnly(ROUTE).indexOf("request.text()"));

  /* THE PRODUCTION URL. Built from configuration only — never from a Host or
   * forwarded header, which a caller controls. */
  const au = load("src/lib/server/app-url.ts", { getWhopEnvironment: () => "production" });
  for (const [label, value] of [
    ["localhost", "https://localhost:3000"],
    ["127.0.0.1", "https://127.0.0.1"],
    ["plaintext", "http://app.example.com"],
    ["an ngrok tunnel", "https://x.ngrok-free.app"],
    ["a cloudflare tunnel", "https://x.trycloudflare.com"],
  ]) {
    check(`  a ${label} origin cannot host the production endpoint`,
      au.resolveAppPublicUrl({ APP_PUBLIC_URL: value }, "production").ok === false,
      JSON.stringify(au.resolveAppPublicUrl({ APP_PUBLIC_URL: value }, "production")));
  }
  const ok = au.resolveAppPublicUrl({ APP_PUBLIC_URL: "https://app.example.com" }, "production");
  check("a real https origin can", ok.ok === true);
  check("and the endpoint URL is that origin plus the route",
    ok.ok && `${ok.origin}${WEBHOOK_PATH}` === "https://app.example.com/api/webhooks/whop",
    ok.ok ? `${ok.origin}${WEBHOOK_PATH}` : "");
  check("no forwarded host is consulted anywhere in the URL builder",
    !/x-forwarded|headers\.get|\brequest\b/i.test(codeOnly("src/lib/server/app-url.ts")));

  /* LOCAL CONFIG, as booleans only — no value is printed. */
  check("a webhook secret is present locally",
    wp.isWhopWebhookConfigured(process.env) === true);
  check("and the local environment is still sandbox",
    process.env.WHOP_ENV === "sandbox");
}

/* ---------------------------------------------------------------- G ---- */
section("G. Environment isolation through the receiver");

{
  const whole = codeOnly(HOOKS);
  check("the receipt records the resolved environment",
    /environment,/.test(whole.slice(whole.indexOf(".values({"), whole.indexOf(".values({") + 600)));
  check("the environment comes from server config, never the payload",
    /getWhopEnvironment\(\)/.test(whole) &&
      !/readString\(data, "environment"\)|body.*environment/.test(whole));
  check("an unresolved environment is refused rather than defaulted",
    /getWhopEnvironment\(\)/.test(whole) && !/\?\? "sandbox"|\|\| "sandbox"/.test(whole));

  /* THE THREE PROVIDER-ID LOOKUPS THE RECEIVER REACHES ARE ALL ENVIRONMENT
   * SCOPED — a provider id is Whop's namespace and is not unique across
   * environments, so the id alone could otherwise resolve the other
   * environment's row. */
  for (const [file, fn] of [
    ["src/lib/server/creator-withdrawals.ts", "findWithdrawalByProviderPayoutId"],
    ["src/lib/server/creator-transfers.ts", "refreshTransferFromProvider"],
    ["src/lib/server/whop-child-router.ts", "resolveChildAccount"],
  ]) {
    const text = codeOnly(file);
    const body = functionBody(text, fn);
    check(`  ${fn} was located`, body !== null && body.length > 100, `${body?.length ?? 0} chars`);
    /* THE RESOLVER CALL AND THE GUARD ARE ASSERTED AS ONE STATEMENT PAIR.
     *
     * Checking for the call and the guard separately let a mutant replace both
     * with `const environment = "sandbox" as const;` — which keeps the WHERE
     * predicate intact and therefore keeps the "constrains the query" check
     * green, while hard-wiring every lookup to one environment. The literal
     * sandbox would then resolve sandbox rows from production deliveries. */
    check(`    resolves the environment from server config and fails closed`,
      /const environment = (getWhopEnvironment|resolveTransferEnvironment)\(\);\s*\n\s*if \(!environment\) return/.test(body ?? ""),
      (body?.match(/const environment = [^\n;]+/) ?? ["absent"])[0]);
    check(`    and never hard-wires an environment literal`,
      !/const environment = ("sandbox"|"production")/.test(body ?? ""));
    check(`    and constrains the query by it`, /environment, environment\)/.test(body ?? ""));
  }
}

/* =========================================================================
   The real database — read only.
   ========================================================================= */

section("H. Real database, read-only");

{
  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [before] = await client`select count(*)::int as n from public.whop_webhook_receipts`;

    const [{ n: applied }] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check("all 16 migrations are applied", applied === 16, `${applied} applied`);

    const byEnv = await client`
      select environment, count(*)::int as n from public.whop_webhook_receipts
       group by environment`;
    const map = Object.fromEntries(byEnv.map((r) => [r.environment, r.n]));
    console.log(`  receipts: sandbox=${map.sandbox ?? 0} production=${map.production ?? 0}`);
    check("every receipt carries an environment",
      byEnv.every((r) => r.environment === "sandbox" || r.environment === "production"));
    check("no production receipt exists yet — nothing has been delivered live",
      (map.production ?? 0) === 0, String(map.production ?? 0));

    /* THE DEDUPLICATION KEY IS THE PRIMARY KEY, so a replayed delivery cannot
     * create a second row. Asserted against the real table. */
    const [dup] = await client`
      select count(*)::int as n from (
        select webhook_id from public.whop_webhook_receipts
         group by webhook_id having count(*) > 1) x`;
    check("no webhook_id appears twice", dup.n === 0, String(dup.n));
    const [retried] = await client`
      select count(*)::int as n from public.whop_webhook_receipts where delivery_count > 1`;
    check("a real redelivery was recorded as a repeat, not a new row",
      retried.n >= 1, `${retried.n} receipt(s) with delivery_count > 1`);

    /* AND NO PROVIDER RESOURCE ID STRADDLES ENVIRONMENTS. */
    const [straddle] = await client`
      select count(*)::int as n from (
        select resource_id from public.whop_webhook_receipts
         where resource_id is not null
         group by resource_id having count(distinct environment) > 1) x`;
    check("no resource id appears in both environments", straddle.n === 0, String(straddle.n));

    /* NOTHING IS STUCK. A receipt still `received` with a live lease after a
     * cutover would be a delivery nobody owns. */
    const stuck = await client`
      select status, count(*)::int as n from public.whop_webhook_receipts
       where status = 'received' group by status`;
    check("no delivery is stuck mid-processing",
      stuck.length === 0, stuck.map((r) => `${r.status}=${r.n}`).join(" "));

    const [after] = await client`select count(*)::int as n from public.whop_webhook_receipts`;
    check("this suite wrote no receipt", after.n === before.n, `${before.n} -> ${after.n}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

/* ========================================================================= */

console.log(`\n${"=".repeat(60)}`);
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks`);
  process.exit(0);
}
console.log(`FAIL — ${failures.length} of ${passed + failures.length} checks failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
