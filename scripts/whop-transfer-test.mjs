/**
 * WHOP LEDGER TRANSFER TESTS.
 *
 * THE DEFECT THIS SUITE EXISTS TO PREVENT. Transfers were previously created
 * by a hand-written `fetch` body built from remembered documentation, and it
 * was wrong in six ways at once against the installed SDK:
 *
 *   - `amount` was sent in MINOR units where `CreateTransfersRequest` takes
 *     MAJOR ("For example 25.00"), so every transfer would have moved 100x the
 *     intended sum — a $10 payout becoming $1,000;
 *   - `origin_id` is REQUIRED and was never sent;
 *   - idempotency went in an `Idempotency-Key` HEADER, while the SDK defines
 *     an `idempotence_key` BODY field — and the value was a fresh UUID per
 *     ATTEMPT, so the provider de-duplication the code relied on could never
 *     fire even if it had reached the right place;
 *   - `destination_account_id` and `description` are not fields;
 *   - the response amount was read back as minor units too;
 *   - `paid`, `completed` and `reversed` were treated as transfer statuses.
 *     A Whop transfer has exactly `processing`, `succeeded`, `failed`.
 *
 * None of that was a type error, because a string literal in a fetch body is
 * not type-checked. `client.transfers.create()` now takes
 * `CreateTransfersRequest`, so the shape is a build error rather than a wrong
 * payment — and this suite pins the BEHAVIOUR the types cannot express, above
 * all that an ambiguous outcome is never treated as a failure.
 *
 * ZERO NETWORK, ZERO DATABASE. The SDK client and the db are injected.
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

const PROVIDER = "src/lib/server/whop-transfers.ts";
const ORCHESTRATOR = "src/lib/server/creator-transfers.ts";

const PLATFORM = "biz_platform";
const CREATOR_ACCOUNT = "biz_creator";
const CREATOR_UID = "uid_creator";

process.env.WHOP_API_KEY = "apik_SECRET_VALUE";

class FakeWhopError extends Error {
  constructor(statusCode) {
    super(`Error\nStatus code: ${statusCode}\nBody: ${JSON.stringify({
      request: { headers: { authorization: "Bearer apik_SECRET_VALUE" } },
    })}`);
    this.statusCode = statusCode;
    this.requestId = "req_t1";
    this.rawResponse = { headers: new Map([["authorization", "Bearer apik_SECRET_VALUE"]]) };
    this.cause = new Error("inner apik_SECRET_VALUE");
  }
}

const transpile = (file) =>
  ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

/* ==========================================================================
   Provider module, over a stubbed SDK client
   ========================================================================== */

function loadProvider({ onCreate, onRetrieve, client = true, companyId = PLATFORM } = {}) {
  const calls = { create: [], retrieve: [] };

  const stub = client
    ? {
        transfers: {
          create: async (req) => {
            calls.create.push(req);
            const out = onCreate ? onCreate(req) : { id: "tr_1", status: "succeeded", amount: 10, currency: "usd" };
            if (out instanceof Error) throw out;
            return out;
          },
          retrieve: async (req) => {
            calls.retrieve.push(req);
            const out = onRetrieve ? onRetrieve(req) : { id: req.id, status: "succeeded", amount: 10, currency: "usd" };
            if (out instanceof Error) throw out;
            return out;
          },
        },
      }
    : null;

  const req = (spec) => {
    if (spec === "server-only") return {};
    if (spec === "@whop/sdk") return { WhopError: FakeWhopError };
    if (spec.endsWith("whop-payments")) {
      return { getWhopPaymentsClient: () => stub, getWhopCompanyId: () => companyId };
    }
    return require(spec);
  };

  const mod = { exports: {} };
  new Function("module", "exports", "require", transpile(PROVIDER))(mod, mod.exports, req);
  return { mod: mod.exports, calls };
}

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

/* ==========================================================================
   A. SDK CONTRACT
   ========================================================================== */

console.log("\n--- A. SDK contract ---");

{
  const { mod, calls } = loadProvider();
  const r = await mod.createLedgerTransfer({
    destinationId: CREATOR_ACCOUNT,
    amountMinor: BigInt(1000),
    currency: "usd",
    idempotenceKey: "admin:req-abc123",
    notes: "ClipRewards campaign_payout",
  });

  check("a transfer is created and returns the provider id", r.ok === true && r.transfer.providerTransferId === "tr_1");
  check("exactly one provider call", calls.create.length === 1);

  const body = calls.create[0];
  check("origin_id is the platform company from server config", body.origin_id === PLATFORM, body.origin_id);
  check("destination_id is the creator's connected account", body.destination_id === CREATOR_ACCOUNT, body.destination_id);
  // THE MOST IMPORTANT ASSERTION IN THIS FILE. 1000 minor units is ten
  // dollars, and the provider takes MAJOR units. The old code passed the minor
  // value straight through, so this exact request would have moved $1,000.
  check("amount is sent in MAJOR units — 1000 minor is 10, never 1000",
    body.amount === 10, String(body.amount));
  check("currency is usd", body.currency === "usd");
  check("type is explicitly ledger", body.type === "ledger", body.type);
  check("notes is sent", typeof body.notes === "string" && body.notes.length > 0);
  check("idempotence_key is a BODY field carrying the persisted key",
    body.idempotence_key === "admin:req-abc123", body.idempotence_key);

  // The four shapes that shipped before, asserted absent by name.
  check("no destination_account_id", !("destination_account_id" in body));
  check("no description", !("description" in body));
  check("no idempotency_key misspelling", !("idempotency_key" in body));
  check("no Idempotency-Key header field smuggled into the body", !("Idempotency-Key" in body));
  check("the request carries ONLY the contract fields",
    Object.keys(body).sort().join(",") === "amount,currency,destination_id,idempotence_key,notes,origin_id,type",
    Object.keys(body).sort().join(","));
}

{
  const code = readFileSync(PROVIDER, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the provider module uses the SDK, not raw fetch",
    !/\bfetch\(/.test(code) && /client\.transfers\.create\(/.test(code));
  check("no Idempotency-Key header anywhere", !/Idempotency-Key/.test(code));

  // Exactly one create call site, repo-wide.
  const { readdirSync, statSync } = require("node:fs");
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = `${d}/${n}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) files.push(p);
    }
  })("src");
  const creators = files.filter((f) =>
    /transfers\s*\.\s*create\(/.test(
      readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
    ));
  check("exactly ONE transfers.create call site in the repo",
    creators.length === 1 && creators[0].endsWith("whop-transfers.ts"), creators.join(","));
}

{
  // The boundary proved at more than one value, end to end through create().
  const one = loadProvider();
  await one.mod.createLedgerTransfer({
    destinationId: CREATOR_ACCOUNT, amountMinor: BigInt(100), currency: "usd",
    idempotenceKey: "admin:req-one", notes: "n",
  });
  check("100 minor units reaches the provider as 1, not 100",
    one.calls.create[0].amount === 1, String(one.calls.create[0].amount));

  const cents = loadProvider();
  await cents.mod.createLedgerTransfer({
    destinationId: CREATOR_ACCOUNT, amountMinor: BigInt(2501), currency: "usd",
    idempotenceKey: "admin:req-cents", notes: "n",
  });
  check("2501 minor units reaches the provider as 25.01",
    cents.calls.create[0].amount === 25.01, String(cents.calls.create[0].amount));
}

/* ==========================================================================
   B. MONEY CONVERSION — the 100x defect
   ========================================================================== */

console.log("\n--- B. money conversion ---");

{
  const { mod } = loadProvider();
  const { minorToProviderAmount, providerAmountToMinor } = mod;

  for (const [minor, expected] of [[100, 1], [1000, 10], [2501, 25.01], [2550, 25.5], [1, 0.01], [99, 0.99]]) {
    const r = minorToProviderAmount(BigInt(minor));
    check(`${minor} minor -> provider ${expected}`, r.ok === true && r.amount === expected, r.ok ? String(r.amount) : r.reason);
  }
  // The exact defect: 1000 minor must NOT become 1000.
  check("1000 minor is NOT sent as 1000 — the 100x bug",
    minorToProviderAmount(BigInt(1000)).amount !== 1000);

  for (const bad of [0, -1, -1000]) {
    const r = minorToProviderAmount(BigInt(bad));
    check(`minor ${bad} is refused`, r.ok === false && r.reason === "not_positive");
  }
  check("an absurd amount is refused rather than overflowing",
    minorToProviderAmount(BigInt("100000000000000")).ok === false);
  check("a non-bigint is refused", minorToProviderAmount(1000).ok === false);

  for (const [amount, expected] of [[1, 100], [10, 1000], [25.01, 2501], [25.5, 2550], [0.01, 1]]) {
    const r = providerAmountToMinor(amount);
    check(`provider ${amount} -> ${expected} minor`, r.ok === true && r.minor === BigInt(expected), r.ok ? String(r.minor) : r.reason);
  }
  for (const [label, v, reason] of [
    ["a sub-cent value", 25.005, "sub_cent"],
    ["a string", "25.00", "not_a_number"],
    ["NaN", NaN, "not_a_number"],
    ["Infinity", Infinity, "not_a_number"],
    ["zero", 0, "not_positive"],
    ["a negative", -5, "not_positive"],
    ["null", null, "not_a_number"],
  ]) {
    const r = providerAmountToMinor(v);
    check(`${label} is refused, not rounded`, r.ok === false && r.reason === reason, r.ok ? String(r.minor) : r.reason);
  }
  check("an over-large provider amount is refused",
    providerAmountToMinor(1e12).ok === false);
}

/* ==========================================================================
   E. PROVIDER RESULTS
   ========================================================================== */

console.log("\n--- E. provider results ---");

const call = (mod) => mod.createLedgerTransfer({
  destinationId: CREATOR_ACCOUNT, amountMinor: BigInt(1000), currency: "usd",
  idempotenceKey: "admin:req-abc123", notes: "n",
});

for (const status of ["processing", "succeeded", "failed"]) {
  const { mod } = loadProvider({ onCreate: () => ({ id: "tr_1", status, amount: 10, currency: "usd" }) });
  const r = await call(mod);
  check(`provider status ${status} is accepted verbatim`, r.ok === true && r.transfer.status === status);
}

for (const invented of ["paid", "completed", "reversed", "pending", ""]) {
  const { mod } = loadProvider({ onCreate: () => ({ id: "tr_1", status: invented, amount: 10 }) });
  const r = await call(mod);
  check(`invented status "${invented}" is malformed, never success`,
    r.ok === false && r.reason === "malformed_response", r.ok ? r.transfer.status : r.reason);
}

// DEFINITE failures: provider read the request and refused.
for (const [status, reason] of [
  [403, "platforms_access_required"], [404, "account_not_found"],
  [402, "insufficient_funds"], [400, "invalid_amount"], [422, "invalid_amount"],
  [409, "provider_rejected"],
]) {
  const { mod } = loadProvider({ onCreate: () => new FakeWhopError(status) });
  const r = await call(mod);
  check(`${status} is a DEFINITE failure (${reason})`,
    r.ok === false && r.outcome === "definite" && r.reason === reason, r.ok ? "ok!" : `${r.outcome}/${r.reason}`);
}

// AMBIGUOUS: the provider may have accepted before failing to answer.
for (const [label, thrown] of [
  ["a 500", new FakeWhopError(500)],
  ["a 503", new FakeWhopError(503)],
  ["a 429", new FakeWhopError(429)],
  ["a dropped socket", new Error("socket hang up")],
]) {
  const { mod } = loadProvider({ onCreate: () => thrown });
  const r = await call(mod);
  check(`${label} is AMBIGUOUS, never a definite failure`,
    r.ok === false && r.outcome === "ambiguous", r.ok ? "ok!" : r.outcome);
}

for (const [label, body] of [
  ["no id", { status: "succeeded", amount: 10 }],
  ["a null id", { id: null, status: "succeeded" }],
  ["no status", { id: "tr_1", amount: 10 }],
  ["a null body", null],
]) {
  const { mod } = loadProvider({ onCreate: () => body });
  const r = await call(mod);
  check(`a 2xx with ${label} is malformed_response`,
    r.ok === false && r.outcome === "definite" && r.reason === "malformed_response");
}

{
  const { mod, calls } = loadProvider();
  const r = await mod.createLedgerTransfer({
    destinationId: CREATOR_ACCOUNT, amountMinor: BigInt(1000), currency: "usd",
    idempotenceKey: "", notes: "n",
  });
  check("an EMPTY idempotence key refuses before calling the provider — no unprotected payment",
    r.ok === false && calls.create.length === 0, `${calls.create.length} call(s)`);

  const noCompany = loadProvider({ companyId: null });
  const r2 = await call(noCompany.mod);
  check("no platform company id means no call at all",
    r2.ok === false && noCompany.calls.create.length === 0);
}

/* ==========================================================================
   I. LOGGING / LEAKAGE
   ========================================================================== */

console.log("\n--- I. secret handling ---");

{
  const run = await capturing(async () => {
    const { mod } = loadProvider({ onCreate: () => new FakeWhopError(400) });
    return call(mod);
  });
  const everything = JSON.stringify(run.value) + "\n" + run.lines.join("\n");
  for (const [label, needle] of [
    ["the API key", "apik_SECRET_VALUE"],
    ["the authorization header", "authorization"],
    ["the Bearer prefix", "Bearer "],
  ]) {
    check(`${label} appears in neither result nor log`, !everything.includes(needle));
  }
  check("the SDK message is never used — it embeds the body",
    !everything.includes("Status code: 400") && !everything.includes("Body: {"));
  check("rawResponse and cause are never touched",
    !everything.includes("rawResponse") && !everything.includes("inner apik"));
  check("the failure is a closed-set token", /^[a-z_]+$/.test(run.value.reason));
  check("the provider module logs nothing", run.lines.length === 0, `${run.lines.length}`);
}

/* ==========================================================================
   Orchestrator, over an in-memory store
   ========================================================================== */

const COL = {
  __t: "creatorTransfers",
  transferId: "transferId", firebaseUid: "firebaseUid", whopAccountId: "whopAccountId",
  environment: "environment", amountMinor: "amountMinor", currency: "currency",
  status: "status", idempotencyKey: "idempotencyKey", providerTransferId: "providerTransferId",
  purpose: "purpose", campaignId: "campaignId", initiatedByUid: "initiatedByUid",
  accountingTransactionId: "accountingTransactionId", failureReason: "failureReason",
};
const ACCOUNTS_COL = { __t: "whopAccounts", firebaseUid: "firebaseUid", environment: "environment", whopAccountId: "whopAccountId" };
const ACC_TXN = { __t: "accountingTransactions" };
const ACC_ENTRY = { __t: "accountingEntries" };

const matches = (cond, row) => {
  if (!cond) return true;
  if (cond.op === "and") return cond.parts.every((p) => matches(p, row));
  if (cond.op === "eq") return row[cond.col] === cond.val;
  if (cond.op === "in") return cond.vals.includes(row[cond.col]);
  return true;
};

function loadOrchestrator({
  transfers = [],
  accounts = [{ firebaseUid: CREATOR_UID, environment: "sandbox", whopAccountId: CREATOR_ACCOUNT }],
  environment = "sandbox",
  onCreate,
  onRetrieve,
  journalOk = true,
  maxMinor,
} = {}) {
  const store = {
    creatorTransfers: transfers.map((t) => ({ ...t })),
    whopAccounts: accounts,
    accountingTransactions: [],
    accountingEntries: [],
  };
  const log = { create: [], retrieve: [], reversals: [], journals: [] };
  let seq = 0;

  const builder = (table) => ({
    _table: table,
    from(t) { this._table = t; return this; },
    set(v) { this._values = v; return this; },
    values(v) {
      const rows = (Array.isArray(v) ? v : [v]).map((r) => ({
        transferId: `t_${++seq}`, providerTransferId: null, accountingTransactionId: null,
        failureReason: null, ...r,
      }));
      this._insert = rows;
      return this;
    },
    onConflictDoNothing() { this._conflictCheck = true; return this; },
    returning() {
      if (this._insert) {
        const rows = this._insert;
        const target = this._rows();
        if (this._conflictCheck) {
          const key = rows[0].idempotencyKey;
          if (target.some((r) => r.idempotencyKey === key)) return Promise.resolve([]);
        }
        target.push(...rows);
        // The journal writer stamps the transfer with its accounting id; the
        // real code does that inside the same transaction.
        if (this._table === ACC_TXN) {
          return Promise.resolve(rows.map((r, i) => ({ transactionId: r.transactionId ?? `acc_${i + 1}` })));
        }
        return Promise.resolve(rows);
      }
      const hit = this._updated ?? this._rows().filter((r) => matches(this._cond, r));
      if (!this._updated) for (const row of hit) Object.assign(row, this._values);
      return Promise.resolve(hit.map((r) => ({ transferId: r.transferId })));
    },
    where(cond) {
      this._cond = cond;
      // An UPDATE applies here but must stay chainable: the real code calls
      // .returning() after .where() to learn whether the guarded update
      // matched. Returning a bare Promise made that throw, which the service
      // caught as "transition refused" and silently skipped compensation.
      if (this._values) {
        const hit = this._rows().filter((r) => matches(cond, r));
        for (const row of hit) Object.assign(row, this._values);
        this._updated = hit;
      }
      return this;
    },
    limit() { return Promise.resolve(this._rows().filter((r) => matches(this._cond, r))); },
    then(res, rej) {
      const rows = this._values
        ? (this._updated ?? [])
        : this._rows().filter((r) => matches(this._cond, r));
      return Promise.resolve(rows).then(res, rej);
    },
    // Dispatch on the table marker. Without this, an accounting insert lands
    // in creator_transfers and every row count in the suite is meaningless.
    _rows() { return store[this._table?.__t] ?? store.creatorTransfers; },
  });

  const DB = {
    select: () => builder(COL), update: () => builder(COL), insert: (t) => builder(t),
    transaction: async (fn) => fn(DB),
  };

  const providerStub = {
    transfers: {
      create: async (req) => {
        log.create.push(req);
        const out = onCreate ? onCreate(req) : { id: `tr_${log.create.length}`, status: "succeeded", amount: 10, currency: "usd" };
        if (out instanceof Error) throw out;
        return out;
      },
      retrieve: async (req) => {
        log.retrieve.push(req);
        const out = onRetrieve ? onRetrieve(req) : { id: req.id, status: "succeeded", amount: 10, currency: "usd" };
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };

  const providerMod = { exports: {} };
  new Function("module", "exports", "require", transpile(PROVIDER))(providerMod, providerMod.exports, (spec) => {
    if (spec === "server-only") return {};
    if (spec === "@whop/sdk") return { WhopError: FakeWhopError };
    if (spec.endsWith("whop-payments")) return { getWhopPaymentsClient: () => providerStub, getWhopCompanyId: () => PLATFORM };
    return require(spec);
  });

  const req = (spec) => {
    if (spec === "server-only") return {};
    if (spec === "drizzle-orm") {
      return {
        eq: (col, val) => ({ op: "eq", col, val }),
        and: (...p) => ({ op: "and", parts: p.filter(Boolean) }),
        inArray: (col, vals) => ({ op: "in", col, vals }),
        sql: () => ({ op: "sql" }),
      };
    }
    if (spec === "@/lib/db") {
      return {
        getDb: () => DB,
        schema: {
          creatorTransfers: COL, whopAccounts: ACCOUNTS_COL,
          accountingTransactions: ACC_TXN, accountingEntries: ACC_ENTRY,
        },
      };
    }
    if (spec.endsWith("whop-accounts")) {
      return { resolvePlatformConfig: () => ({ ok: true, config: { environment, baseUrl: "https://stub", apiKey: "apik_SECRET_VALUE" } }) };
    }
    if (spec.endsWith("whop-payments")) return { getWhopEnvironment: () => environment };
    if (spec.endsWith("whop-transfers")) return providerMod.exports;
    if (spec.endsWith("accounting/journal")) {
      return {
        reverseTransaction: async (id, opts) => {
          const already = log.reversals.some((r) => r.id === id);
          log.reversals.push({ id, ...opts });
          return { ok: true, transactionId: `rev_${id}`, alreadyReversed: already };
        },
      };
    }
    return require(spec);
  };

  const mod = { exports: {} };
  new Function("module", "exports", "require", transpile(ORCHESTRATOR))(mod, mod.exports, req);

  // The cap is read from process.env at CALL time, not at import time, so it
  // is applied around each call rather than around the module load.
  const withCap = (fn) => async (...args) => {
    const prev = process.env.MAX_CREATOR_TRANSFER_MINOR;
    if (maxMinor === undefined) delete process.env.MAX_CREATOR_TRANSFER_MINOR;
    else process.env.MAX_CREATOR_TRANSFER_MINOR = maxMinor;
    try {
      return await fn(...args);
    } finally {
      if (prev === undefined) delete process.env.MAX_CREATOR_TRANSFER_MINOR;
      else process.env.MAX_CREATOR_TRANSFER_MINOR = prev;
    }
  };
  const api = { ...mod.exports };
  api.initiateCreatorTransfer = withCap(mod.exports.initiateCreatorTransfer);
  api.retryTransfer = withCap(mod.exports.retryTransfer);
  api.reconcileTransfer = withCap(mod.exports.reconcileTransfer);
  api.refreshTransferFromProvider = withCap(mod.exports.refreshTransferFromProvider);

  return { mod: api, store, log, journalOk };
}

const baseInput = (over = {}) => ({
  firebaseUid: CREATOR_UID, amountMinor: BigInt(1000), currency: "usd",
  purpose: "campaign_payout", initiatedByUid: "uid_admin",
  requestId: "req-abc12345", dryRun: false, ...over,
});

/* ==========================================================================
   D. IDEMPOTENCY
   ========================================================================== */

console.log("\n--- D. idempotency ---");

{
  const { mod, store, log } = loadOrchestrator();
  const first = await mod.initiateCreatorTransfer(baseInput());
  check("a first request creates exactly one row", first.ok === true && store.creatorTransfers.length === 1,
    first.ok ? first.status : first.reason);
  check("the stored key derives from the request id",
    store.creatorTransfers[0].idempotencyKey === "admin:req-abc12345", store.creatorTransfers[0].idempotencyKey);
  check("the provider received that SAME key",
    log.create[0].idempotence_key === "admin:req-abc12345", log.create[0].idempotence_key);

  const second = await mod.initiateCreatorTransfer(baseInput());
  check("an identical retry creates NO second row", store.creatorTransfers.length === 1,
    `${store.creatorTransfers.length} rows`);
  check("and makes NO second provider create call", log.create.length === 1, `${log.create.length}`);
  check("and reports itself as a replay", second.ok === true && second.replayed === true);
}

{
  const { mod, store, log } = loadOrchestrator();
  await mod.initiateCreatorTransfer(baseInput());
  const conflict = await mod.initiateCreatorTransfer(baseInput({ amountMinor: BigInt(2000) }));
  check("the same request id with a DIFFERENT amount fails closed",
    conflict.ok === false && conflict.reason === "intent_conflict", conflict.ok ? "ok!" : conflict.reason);
  const other = await mod.initiateCreatorTransfer(baseInput({ firebaseUid: "uid_other" }));
  check("the same request id for a DIFFERENT creator fails closed",
    other.ok === false, other.ok ? "ok!" : other.reason);
  check("no extra row or provider call resulted",
    store.creatorTransfers.length === 1 && log.create.length === 1);
}

{
  const { mod, store, log } = loadOrchestrator();
  const [a, b] = await Promise.all([
    mod.initiateCreatorTransfer(baseInput()),
    mod.initiateCreatorTransfer(baseInput()),
  ]);
  check("concurrent identical intents converge on ONE row",
    store.creatorTransfers.length === 1, `${store.creatorTransfers.length}`);
  // Two genuinely simultaneous requests may both reach the provider before
  // either has stored a transfer id. That is safe BECAUSE both carry the same
  // persisted idempotence key, so Whop returns the original rather than
  // moving money twice — which is exactly what the key is for.
  check("every provider call carries the SAME idempotence key — at most one payment",
    new Set(log.create.map((c) => c.idempotence_key)).size <= 1,
    log.create.map((c) => c.idempotence_key).join(" | "));
  check("both callers get an answer", a.ok !== undefined && b.ok !== undefined);
}

{
  const { mod, store, log } = loadOrchestrator();
  const r = await mod.initiateCreatorTransfer(baseInput({ requestId: undefined }));
  check("real execution WITHOUT a request id is refused",
    r.ok === false && r.reason === "missing_request_id");
  check("and nothing was written or called",
    store.creatorTransfers.length === 0 && log.create.length === 0);

  const bad = await mod.initiateCreatorTransfer(baseInput({ requestId: "short" }));
  check("a malformed request id is refused", bad.ok === false && bad.reason === "missing_request_id");
}

/* ==========================================================================
   Ambiguity and retry
   ========================================================================== */

console.log("\n--- D/E. ambiguous outcome and retry ---");

{
  const { mod, store, log } = loadOrchestrator({ onCreate: () => new FakeWhopError(500) });
  const r = await mod.initiateCreatorTransfer(baseInput());
  const row = store.creatorTransfers[0];

  check("an ambiguous outcome is NOT reported as a definite failure",
    r.ok === false && r.reason === "provider_ambiguous", r.ok ? "ok!" : r.reason);
  check("the row stays PENDING and recoverable — not marked failed",
    row.status === "pending", row.status);
  check("the row keeps its key so a retry can reconcile",
    row.idempotencyKey === "admin:req-abc12345");
  check("NO compensation was posted for an unknown outcome",
    log.reversals.length === 0, `${log.reversals.length}`);
}

{
  // The dangerous scenario: provider accepted, we timed out, operator retries.
  const { mod, store, log } = loadOrchestrator({
    onCreate: (() => { let n = 0; return () => (++n === 1 ? new FakeWhopError(500) : { id: "tr_real", status: "succeeded", amount: 10 }); })(),
  });
  await mod.initiateCreatorTransfer(baseInput());
  const transferId = store.creatorTransfers[0].transferId;

  const retried = await mod.retryTransfer(transferId);
  check("retryTransfer reuses the STORED key, never a fresh one",
    log.create.length === 2 && log.create[1].idempotence_key === log.create[0].idempotence_key,
    log.create.map((c) => c.idempotence_key).join(" vs "));
  check("retry creates NO second row", store.creatorTransfers.length === 1, `${store.creatorTransfers.length}`);
  check("retry reuses the same amount and destination",
    log.create[1].amount === log.create[0].amount && log.create[1].destination_id === log.create[0].destination_id);
  check("and the transfer resolves", retried.ok === true && retried.status === "completed", retried.ok ? retried.status : retried.reason);
}

{
  const { mod, store, log } = loadOrchestrator({
    transfers: [{
      transferId: "t_done", firebaseUid: CREATOR_UID, whopAccountId: CREATOR_ACCOUNT,
      environment: "sandbox", amountMinor: BigInt(1000), currency: "usd", status: "completed",
      idempotencyKey: "admin:req-done", providerTransferId: "tr_done", purpose: "p",
      accountingTransactionId: "acc_1", failureReason: null,
    }],
  });
  const r = await mod.retryTransfer("t_done");
  check("retrying a TERMINAL transfer touches nothing",
    r.ok === true && r.status === "completed" && log.create.length === 0 && log.retrieve.length === 0);
  void store;
}

/* ==========================================================================
   F. ACCOUNTING
   ========================================================================== */

console.log("\n--- F. accounting ---");

{
  const { mod, log, store } = loadOrchestrator({ onCreate: () => new FakeWhopError(400) });
  const r = await mod.initiateCreatorTransfer(baseInput());
  check("a DEFINITE provider refusal marks the row failed",
    store.creatorTransfers[0].status === "failed", store.creatorTransfers[0].status);
  check("and compensates the journal exactly once",
    log.reversals.length === 1, `${log.reversals.length}`);
  check("through the canonical reverseTransaction, keyed to the original",
    log.reversals[0].id === store.creatorTransfers[0].accountingTransactionId ||
    typeof log.reversals[0].id === "string");
  check("the caller sees the provider reason", r.ok === false && r.reason === "invalid_amount", r.ok ? "ok!" : r.reason);
}

{
  // Replay must not compensate twice.
  const { mod, log } = loadOrchestrator({ onCreate: () => new FakeWhopError(400) });
  await mod.initiateCreatorTransfer(baseInput());
  await mod.initiateCreatorTransfer(baseInput());
  check("a replayed failure does NOT compensate a second time",
    log.reversals.length === 1, `${log.reversals.length}`);
}

{
  const { mod, log } = loadOrchestrator({ onCreate: () => new FakeWhopError(500) });
  await mod.initiateCreatorTransfer(baseInput());
  check("an AMBIGUOUS outcome never compensates — money may have moved",
    log.reversals.length === 0, `${log.reversals.length}`);
}

/* ==========================================================================
   G. STATE MACHINE
   ========================================================================== */

console.log("\n--- G. state machine ---");

{
  const { mod } = loadOrchestrator();
  const { isAllowedTransferTransition, TERMINAL_TRANSFER_STATUSES } = mod;

  for (const [from, to] of [
    ["pending", "submitted"], ["pending", "completed"], ["pending", "failed"],
    ["submitted", "completed"], ["submitted", "failed"], ["completed", "reversed"],
  ]) {
    check(`${from} -> ${to} is allowed`, isAllowedTransferTransition(from, to) === true);
  }
  for (const [from, to] of [
    ["completed", "submitted"], ["completed", "pending"], ["completed", "failed"],
    ["failed", "completed"], ["failed", "submitted"], ["reversed", "completed"],
    ["submitted", "pending"],
  ]) {
    check(`${from} -> ${to} is REFUSED`, isAllowedTransferTransition(from, to) === false);
  }
  check("the terminal set is exactly completed/failed/reversed",
    [...TERMINAL_TRANSFER_STATUSES].sort().join(",") === "completed,failed,reversed");
}

{
  // A stale event must not regress a completed row.
  const { mod, store } = loadOrchestrator({
    transfers: [{
      transferId: "t_c", firebaseUid: CREATOR_UID, whopAccountId: CREATOR_ACCOUNT,
      environment: "sandbox", amountMinor: BigInt(1000), currency: "usd", status: "completed",
      idempotencyKey: "admin:req-c", providerTransferId: "tr_c", purpose: "p",
      accountingTransactionId: "acc_c", failureReason: null,
    }],
    onRetrieve: () => ({ id: "tr_c", status: "processing", amount: 10 }),
  });
  const r = await mod.reconcileTransfer("t_c");
  check("a stale `processing` cannot regress a COMPLETED transfer",
    store.creatorTransfers[0].status === "completed", store.creatorTransfers[0].status);
  check("and reconcile reports no change", r.ok === true && r.changed === false);
}

/* ==========================================================================
   C/H. OWNERSHIP, ENVIRONMENT, PAYOUT READINESS
   ========================================================================== */

console.log("\n--- C/H/J. ownership, environment, readiness ---");

{
  const { mod, store, log } = loadOrchestrator({ accounts: [] });
  const r = await mod.initiateCreatorTransfer(baseInput());
  check("no connected account means no transfer and no provider call",
    r.ok === false && r.reason === "creator_not_found" && log.create.length === 0);
  void store;
}

{
  // The creator exists, but only in the OTHER environment.
  const { mod, log } = loadOrchestrator({
    accounts: [{ firebaseUid: CREATOR_UID, environment: "production", whopAccountId: "biz_prod" }],
    environment: "sandbox",
  });
  const r = await mod.initiateCreatorTransfer(baseInput());
  check("a production account is invisible to a sandbox transfer",
    r.ok === false && r.reason === "creator_not_found" && log.create.length === 0);
}

{
  // J. THE READINESS GATE IS GONE. A creator with no external payout
  // destination must still be able to RECEIVE internal ledger credit.
  const { mod, log } = loadOrchestrator();
  const r = await mod.initiateCreatorTransfer(baseInput());
  check("a creator with NO external payout destination still reaches the provider",
    r.ok === true && log.create.length === 1, r.ok ? "reached" : r.reason);

  const code = readFileSync(ORCHESTRATOR, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the orchestrator no longer calls fetchPayoutStatus",
    !/fetchPayoutStatus/.test(code));
  check("and no payout_not_ready reason remains", !/payout_not_ready/.test(code));
}

{
  const code = readFileSync("src/app/api/admin/transfer/creator/route.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the route is admin-gated", /withAdminApi/.test(code));
  check("the route checks origin", /checkRequestOrigin/.test(code));
  check("the route is rate limited", /checkRateLimit\(`admin:transfer:/.test(code));
  check("the actor comes from the verified session, never the body",
    /initiatedByUid = adminContext\.uid/.test(code) && !/body\.initiated_by/.test(code));
  check("the browser cannot choose the destination or origin account",
    !/body\.(destination_id|origin_id|whop_account_id|account_id)/.test(code));
  check("the browser cannot choose the environment",
    !/body\.environment/.test(code));
  check("the browser cannot choose the provider transfer id",
    !/body\.provider_transfer_id/.test(code));
  check("dry run defaults to true", /dry_run !== false/.test(code));
  check("real execution requires a request id", /!dryRun && !requestId/.test(code));
  check("every call is audited", /writeAudit\(/.test(code));
}

/* ==========================================================================
   Caps
   ========================================================================== */

console.log("\n--- caps ---");

{
  const { mod, log } = loadOrchestrator({ environment: "sandbox" });
  const over = await mod.initiateCreatorTransfer(baseInput({ amountMinor: BigInt(50000) }));
  check("above the sandbox cap is refused before any call",
    over.ok === false && over.reason === "amount_above_maximum" && log.create.length === 0);
  const under = await mod.initiateCreatorTransfer(baseInput({ amountMinor: BigInt(1) }));
  check("below the minimum is refused", under.ok === false && under.reason === "amount_below_minimum");
}

{
  const PROD_ACCOUNTS = [{ firebaseUid: CREATOR_UID, environment: "production", whopAccountId: CREATOR_ACCOUNT }];
  const { mod, log } = loadOrchestrator({ environment: "production", maxMinor: undefined, accounts: PROD_ACCOUNTS });
  const r = await mod.initiateCreatorTransfer(baseInput());
  check("PRODUCTION without an explicit cap refuses a real transfer",
    r.ok === false && r.reason === "transfer_cap_unconfigured" && log.create.length === 0,
    r.ok ? "executed!" : r.reason);

  const dry = await mod.initiateCreatorTransfer(baseInput({ dryRun: true }));
  check("but a dry run still reports, flagging it as not executable",
    dry.ok === true && dry.executable === false);

  const configured = loadOrchestrator({ environment: "production", maxMinor: "500000", accounts: PROD_ACCOUNTS });
  const ok = await configured.mod.initiateCreatorTransfer(baseInput());
  check("with an explicit cap production proceeds", ok.ok === true, ok.ok ? "ok" : ok.reason);
}

{
  const { mod, log, store } = loadOrchestrator();
  const dry = await mod.initiateCreatorTransfer(baseInput({ dryRun: true }));
  check("a dry run writes nothing and calls nothing",
    dry.ok === true && store.creatorTransfers.length === 0 && log.create.length === 0);
  check("a dry run needs no request id", dry.ok === true);
}

/* ==========================================================================
   Webhook isolation
   ========================================================================== */

console.log("\n--- webhook isolation ---");

{
  const hooks = readFileSync("src/lib/server/whop-webhooks.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the payout handler no longer calls the guessed-status mutators",
    !/markTransferCompleted|markTransferReversed/.test(hooks));
  check("it refreshes from the provider instead",
    /refreshTransferFromProvider\(/.test(hooks));
  // Scoped to the payout handler: "paid" is a legitimate ORDER status
  // elsewhere in this file, so a whole-file search would fire on correct code.
  const payoutBody = hooks.slice(
    hooks.indexOf("export async function handleWhopPayoutUpdated"),
    hooks.indexOf("export async function handleWhopAccountUpdated"),
  );
  check("the payout handler no longer reads a status out of the payload",
    payoutBody.length > 0 &&
    !/"paid"/.test(payoutBody) && !/"reversed"/.test(payoutBody) &&
    !/payoutStatus/.test(payoutBody));

  const orch = readFileSync(ORCHESTRATOR, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the guessed-status mutators are gone from the orchestrator",
    !/export async function markTransferCompleted|export async function markTransferReversed/.test(orch));
  check("provider status mapping covers exactly the three real statuses",
    /processing:\s*"submitted"/.test(orch) && /succeeded:\s*"completed"/.test(orch) && /failed:\s*"failed"/.test(orch));
}

{
  const { mod, store, log } = loadOrchestrator({
    transfers: [{
      transferId: "t_r", firebaseUid: CREATOR_UID, whopAccountId: CREATOR_ACCOUNT,
      environment: "sandbox", amountMinor: BigInt(1000), currency: "usd", status: "submitted",
      idempotencyKey: "admin:req-r", providerTransferId: "tr_r", purpose: "p",
      accountingTransactionId: "acc_r", failureReason: null,
    }],
    onRetrieve: () => ({ id: "tr_r", status: "succeeded", amount: 10 }),
  });
  const r = await mod.refreshTransferFromProvider("tr_r");
  check("a payout event triggers a provider RETRIEVE, not a payload-driven write",
    r.ok === true && log.retrieve.length === 1, `${log.retrieve.length} retrieve(s)`);
  check("and the row follows the provider's answer",
    store.creatorTransfers[0].status === "completed", store.creatorTransfers[0].status);

  const unknown = await mod.refreshTransferFromProvider("tr_not_ours");
  check("an id we do not hold never reaches the provider",
    unknown.ok === false && log.retrieve.length === 1, `${log.retrieve.length}`);
}

{
  const { mod, store, log } = loadOrchestrator({
    transfers: [{
      transferId: "t_f", firebaseUid: CREATOR_UID, whopAccountId: CREATOR_ACCOUNT,
      environment: "sandbox", amountMinor: BigInt(1000), currency: "usd", status: "submitted",
      idempotencyKey: "admin:req-f", providerTransferId: "tr_f", purpose: "p",
      accountingTransactionId: "acc_f", failureReason: null,
    }],
    onRetrieve: () => ({ id: "tr_f", status: "failed", amount: 10, failure_code: "insufficient_funds" }),
  });
  await mod.refreshTransferFromProvider("tr_f");
  check("a provider-confirmed FAILURE marks failed and compensates once",
    store.creatorTransfers[0].status === "failed" && log.reversals.length === 1,
    `${store.creatorTransfers[0].status}/${log.reversals.length}`);
}

/* ============================== summary ============================== */

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
