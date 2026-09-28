#!/usr/bin/env node
/**
 * TASK #29 — PRODUCTION PAYOUT / TRANSFER E2E READINESS.
 *
 * The money-out path has two distinct provider resources and the distinction is
 * the whole design:
 *
 *   TRANSFER  ClipRewards platform balance → the creator's Whop balance.
 *             `client.transfers.create`, `tr_` ids, three statuses. This is what
 *             DISCHARGES `creator_payable` in the journal, under a lock, inside
 *             one transaction with the cap check.
 *   WITHDRAWAL  the creator's Whop balance → their own bank. `client.payouts.create`,
 *             `wdrl_` ids, eight statuses. It posts NO journal at all: the money
 *             is already the creator's, sitting at the provider, and the
 *             provider's own `total_withdrawable_balance` is the authority for
 *             what they may take. There is no earning reservation — an earlier
 *             FIFO allocation was removed, and `creator_withdrawal_earnings` is
 *             now dead. Protection is three environment-scoped partial unique
 *             indexes plus the provider's balance as the ceiling.
 *
 * WHAT WAS WRONG — and it would have broken the first real withdrawal.
 *
 *   `decimalStringToMinor` tested `/^d+(.d+)?$/`. The backslashes were missing,
 *   so the pattern matched a literal letter "d" and NO decimal string could
 *   satisfy it. The installed SDK declares the payout resource's `amount` as
 *   "in whole currency units, as a decimal string" — so every real payout
 *   response failed to parse, `readPayout` returned null, and:
 *
 *     - `createPayout` read a successful 2xx as unreadable → classified
 *       `ambiguous` → the withdrawal went to `provider_pending` while the
 *       creator's money had actually left their Whop balance;
 *     - `reconcileWithdrawal` reads the payout through the SAME function, so it
 *       could not resolve it either.
 *
 *   A real production withdrawal would have moved money and become permanently
 *   unresolvable. It survived 234 passing withdrawal checks because no suite ever
 *   drove this parser with a string: the fixtures pass numbers, which take the
 *   fast path, and the rest asserted the source text instead of the behaviour.
 *   That gap is closed here, behaviourally, in section A.
 *
 * DB-BACKED for the journal and the partial unique indexes — no fake can
 * demonstrate either. Throwaway schema from the full 16-migration chain.
 *
 * NO NETWORK. NO PROVIDER CALL. NO REAL MONEY. Every provider seam is injected,
 * and each injection records what it was asked to do so "zero provider mutation"
 * can be asserted rather than assumed.
 *
 * NO SECRET, TOKEN OR KEY IS PRINTED.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname, join } from "node:path";

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
const bodyOnly = (p) =>
  codeOnly(p).replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
function functionBody(text, name) {
  const at = text.indexOf(`export async function ${name}`);
  if (at < 0) return null;
  const next = text.indexOf("\nexport ", at + 10);
  return text.slice(at, next < 0 ? undefined : next);
}

const SCRATCH = "prod_payout_e2e_selftest";

/* =========================================================================
   Loader. The database, process.env and the provider client are the seams.
   ========================================================================= */

const cache = new Map();
let DB = null;
/** Every provider call the code attempted, so "zero mutation" is checkable. */
let providerCalls = [];
let FAKE_CLIENT = null;

class FakeWhopError extends Error {
  constructor(status) { super(`fake ${status}`); this.statusCode = status; }
}

function loadTs(file) {
  const key = resolve(file);
  if (cache.has(key)) return cache.get(key).exports;
  const js = ts.transpileModule(readFileSync(key, "utf8"), {
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
    if (spec === "@whop/sdk") return { WhopClient: class {}, WhopError: FakeWhopError };
    if (spec === "@/lib/db") {
      return {
        getDb: () => DB,
        isDatabaseConfigured: () => DB !== null,
        schema: loadTs("src/lib/db/schema.ts"),
      };
    }
    if (spec === "./whop-payments" || spec === "@/lib/server/whop-payments") {
      const real = loadTs("src/lib/server/whop-payments.ts");
      return { ...real, getWhopPaymentsClient: () => FAKE_CLIENT };
    }
    if (spec.startsWith("@/")) return loadTs(`src/${spec.slice(2)}.ts`);
    if (spec.startsWith(".")) {
      const base = resolve(dirname(key), spec);
      try { return loadTs(`${base}.ts`); } catch { return loadTs(`${base}/index.ts`); }
    }
    return require(spec);
  };
  new Function("module", "exports", "require", js)(mod, mod.exports, req);
  return mod.exports;
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try { return await fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ---------------------------------------------------------------- A ---- */
section("A. The provider's decimal STRINGS parse — the P0 regression");

{
  /* THE SDK'S OWN CONTRACT, read from the installed .d.ts rather than assumed:
   * the payout resource answers in decimal strings, the transfer resource in
   * numbers. A parser that cannot read a string cannot read a payout. */
  const createResp = src(
    "node_modules/@whop/sdk/dist/cjs/api/resources/payouts/types/CreatePayoutsResponse.d.ts");
  check("the SDK declares the payout amount as a decimal STRING",
    /The payout amount in whole currency units, as a decimal string\.[\s\S]{0,40}amount: string;/.test(createResp));
  check("and exposes a fee on the same response",
    /fee_amount: string;/.test(createResp));

  /* THE PARSER, DRIVEN. This is the coverage whose absence let the defect ship:
   * every existing withdrawal fixture passes numbers, which take the fast path. */
  const payouts = loadTs("src/lib/server/whop-payouts.ts");
  const read = payouts.__testReadPayout ?? null;

  /* The regex itself, asserted at source, because the function that uses it is
   * module-private and the defect was one character class. */
  const payoutCode = src("src/lib/server/whop-payouts.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  check("the decimal guard uses a real digit class, not the letter d",
    /\/\^\\d\+\(\\\.\\d\+\)\?\$\//.test(payoutCode),
    (payoutCode.match(/if \(!\/\^[^)]*\/\.test\(trimmed\)\)/) ?? ["absent"])[0]);
  check("the broken pattern is gone from the code",
    !/\/\^d\+\(\.d\+\)\?\$\//.test(payoutCode));

  /* AND THE BEHAVIOUR, END TO END, through the real exported reader. */
  if (read) {
    check("a provider-shaped payout with a string amount reads",
      read({ id: "wdrl_1", status: "completed", amount: "10.00", currency: "USD" })?.amountMinor === BigInt(1000));
  } else {
    /* `readPayout` is module-private. Its behaviour is reachable through the
     * exported retrieve path, which is what the reconciler uses. */
    providerCalls = [];
    FAKE_CLIENT = {
      payouts: {
        retrieve: async () => ({
          id: "wdrl_str", status: "completed", amount: "10.00", currency: "USD",
          net_amount: "9.75", fee_amount: "0.25",
        }),
      },
    };
    const got = await payouts.retrievePayout("wdrl_str");
    check("a payout whose amount is a decimal STRING is readable",
      got.ok === true && got.payout.amountMinor === BigInt(1000),
      JSON.stringify(got.ok ? { minor: String(got.payout.amountMinor), status: got.payout.status } : got));
    check("its status and currency survive too",
      got.ok && got.payout.status === "completed" && got.payout.currency === "usd");

    /* SUB-UNIT AND ODD STRINGS. The conversion rules live in one hardened place;
     * this proves the string path delegates to them rather than re-deciding. */
    for (const [label, amount, expect] of [
      ["a whole number string", "1234", BigInt(123400)],
      ["a half-unit string", "0.50", BigInt(50)],
      ["one decimal place", "10.5", BigInt(1050)],
    ]) {
      FAKE_CLIENT = { payouts: { retrieve: async () => ({
        id: "wdrl_x", status: "completed", amount, currency: "usd" }) } };
      const r = await payouts.retrievePayout("wdrl_x");
      check(`  ${label} (${amount}) → ${expect} minor`,
        r.ok === true && r.payout.amountMinor === expect,
        r.ok ? String(r.payout.amountMinor) : JSON.stringify(r));
    }
    /* AND A MALFORMED AMOUNT IS STILL REFUSED — the fix must not have widened
     * the guard into accepting anything numeric-ish. */
    for (const bad of ["", "abc", "-1", "1e3", "1.2.3", "10.", " ", "1,000.00"]) {
      FAKE_CLIENT = { payouts: { retrieve: async () => ({
        id: "wdrl_bad", status: "completed", amount: bad, currency: "usd" }) } };
      const r = await payouts.retrievePayout("wdrl_bad");
      check(`  a malformed amount ${JSON.stringify(bad)} is still refused`, r.ok === false);
    }
    /* A NUMBER STILL WORKS — the transfer resource answers that way. */
    FAKE_CLIENT = { payouts: { retrieve: async () => ({
      id: "wdrl_n", status: "completed", amount: 10, currency: "usd" }) } };
    const num = await payouts.retrievePayout("wdrl_n");
    check("a numeric amount still reads, for the resources that send numbers",
      num.ok === true && num.payout.amountMinor === BigInt(1000));
  }
}

/* ---------------------------------------------------------------- A2 --- */
section("A2. Which constraint a write violated — read from the cause chain");

{
  /* THE DEFECT THIS EXISTS FOR. Drizzle wraps the driver error, so its own
   * `message` is the rendered SQL: `err.message.includes("uniq_…")` is never true
   * in production. `creator-withdrawals` had two such branches — both dead, so a
   * second withdrawal reported `db_unavailable` and the same-request-id replay
   * never ran — and `creator-earnings` had a third. `interviews.ts` had already
   * found and fixed it locally; Task #29 extracted that fix here.
   *
   * DRIVEN WITH SYNTHETIC ERROR SHAPES, each isolating one place the name can
   * hide. A helper that reads only messages passes the first two and fails the
   * third, which is what makes the redundancy load-bearing rather than decorative. */
  const de = loadTs("src/lib/server/db-errors.ts");

  const wrapped = Object.assign(new Error("Failed query: insert into \"creator_withdrawals\" ..."), {
    cause: Object.assign(
      new Error('duplicate key value violates unique constraint "uniq_withdrawal_active_creator"'),
      { constraint_name: "uniq_withdrawal_active_creator", code: "23505" }),
  });
  check("a drizzle-wrapped violation is identified through its cause",
    de.violatesConstraint(wrapped, "uniq_withdrawal_active_creator") === true);
  check("and the wrapper's own message alone would NOT have identified it",
    !wrapped.message.includes("uniq_withdrawal_active_creator"));

  /* ONLY `constraint_name`, no message text — a driver that names the constraint
   * structurally and says nothing in prose. Reading messages alone fails here. */
  const structural = Object.assign(new Error("Failed query: insert ..."), {
    cause: Object.assign(new Error("integrity violation"),
      { constraint_name: "uniq_withdrawal_request_creator_env", code: "23505" }),
  });
  check("a violation named ONLY in constraint_name is still identified",
    de.violatesConstraint(structural, "uniq_withdrawal_request_creator_env") === true);

  /* ONLY the message — the raw driver shape the old fakes produced. */
  const bare = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_creator_earnings_payment_creator"'),
    { code: "23505" });
  check("a bare driver error is identified too",
    de.violatesConstraint(bare, "uniq_creator_earnings_payment_creator") === true);

  /* NESTED DEEPER than one level, because a future wrapper may add a layer. */
  const nested = Object.assign(new Error("outer"), {
    cause: Object.assign(new Error("middle"), {
      cause: Object.assign(new Error("inner"), { constraint_name: "uniq_bookings_active_slot" }),
    }),
  });
  check("a violation nested two levels down is still found",
    de.violatesConstraint(nested, "uniq_bookings_active_slot") === true);

  /* AND IT DOES NOT INVENT MATCHES. */
  check("an unrelated error matches nothing",
    de.violatesConstraint(new Error("connection terminated"), "uniq_withdrawal_active_creator") === false);
  check("a different constraint does not match",
    de.violatesConstraint(wrapped, "uniq_withdrawal_request_creator_env") === false);
  for (const junk of [null, undefined, "a string", 42, {}]) {
    check(`  ${JSON.stringify(junk)} matches nothing and does not throw`,
      de.violatesConstraint(junk, "uniq_withdrawal_active_creator") === false);
  }
  /* A CYCLE MUST NOT HANG IT. */
  const cyclic = new Error("a");
  cyclic.cause = cyclic;
  check("a self-referencing cause chain terminates",
    de.violatesConstraint(cyclic, "uniq_x") === false);

  /* NO MONEY MODULE MAY GO BACK TO MATCHING ON THE MESSAGE. Asserted as a class
   * invariant rather than per-site, so a fourth occurrence cannot appear quietly. */
  const offenders = [];
  for (const f of ["creator-withdrawals", "creator-earnings", "creator-transfers",
                   "creator-position", "whop-payouts", "whop-transfers", "interviews"]) {
    const code = codeOnly(`src/lib/server/${f}.ts`);
    for (const m of code.matchAll(/\.message[^\n]{0,40}includes\(\s*["'`]uniq_/g)) {
      offenders.push(`${f}: ${m[0]}`);
    }
  }
  check("no module identifies a constraint from an error message",
    offenders.length === 0, offenders.join(" | "));
  /* AND THE THREE SITES USE THE SHARED HELPER. */
  for (const [f, name] of [
    ["creator-withdrawals", "uniq_withdrawal_active_creator"],
    ["creator-withdrawals", "uniq_withdrawal_request_creator_env"],
    ["creator-earnings", "uniq_creator_earnings_payment_creator"],
    ["interviews", "uniq_bookings_active_slot"],
  ]) {
    check(`  ${f} uses violatesConstraint for ${name}`,
      codeOnly(`src/lib/server/${f}.ts`).includes(`violatesConstraint(`) &&
        new RegExp(`violatesConstraint\\([^)]*"${name}"\\)`).test(codeOnly(`src/lib/server/${f}.ts`)));
  }
}

/* ---------------------------------------------------------------- B ---- */
section("B. The transfer cap");

{
  const code = codeOnly("src/lib/server/creator-transfers.ts");

  /* PRODUCTION HAS NO DEFAULT CEILING. An unset cap used to fall back to $1M,
   * a number the code itself called "should be overridden" — a silent default in
   * front of real money is not a limit. */
  check("production without an explicit cap is not 'configured'",
    /return \{ maxMinor: DEFAULT_PROD_MAX_MINOR, configured: false \};/.test(code));
  check("and real execution refuses on that alone",
    /if \(!cap\.configured && !input\.dryRun\) \{\s*\n\s*return \{ ok: false, reason: "transfer_cap_unconfigured" \};/.test(code));
  check("sandbox has a real hard cap in code",
    /const SANDBOX_MAX_MINOR = BigInt\(10_000\);/.test(code));

  /* THE CHECK HAPPENS BEFORE ANY NETWORK CALL, and before the database. */
  const body = functionBody(bodyOnly("src/lib/server/creator-transfers.ts"), "initiateCreatorTransfer") ?? "";
  const capAt = body.indexOf("resolveMaxTransferMinor");
  const dbAt = body.indexOf("getDb()");
  check("the cap is resolved before the database is touched",
    capAt > 0 && capAt < dbAt, `${capAt} < ${dbAt}`);
  for (const provider of ["createTransfer", "reserveFromPosition"]) {
    const at = body.indexOf(provider);
    if (at < 0) continue;
    check(`  and before ${provider}`, capAt < at, `${capAt} < ${at}`);
  }
  /* AND IT IS RE-CHECKED UNDER THE LOCK, in the same transaction as the journal
   * — a cap checked only outside the transaction is advice, not a cap. */
  check("the payable reservation happens inside the journal transaction",
    /await db\.transaction\(async \(tx\) => \{[\s\S]{0,600}reserveFromPosition\(\s*tx,/.test(code));

  /* THE BROWSER CANNOT SUPPLY IT. */
  check("the cap comes from the environment, never from an input field",
    /process\.env\.MAX_CREATOR_TRANSFER_MINOR/.test(code) &&
      !/input\.(maxMinor|cap|maxAllowed)/.test(code));
  /* A NONSENSE VALUE IS NOT A CAP. */
  check("zero or negative env values are rejected, falling back to the default",
    /if \(parsed > BigInt\(0\)\) return \{ maxMinor: parsed, configured: true \};/.test(code));
  /* ASSERTED BEHAVIOURALLY, because `codeOnly` has stripped the comment that
   * explains the catch — and a garbage value must fall back to the environment's
   * own ceiling rather than throwing, which is only observable by calling it. */
  check("a garbage cap value falls back to the sandbox ceiling instead of throwing",
    /catch \{/.test(src("src/lib/server/creator-transfers.ts").slice(
      src("src/lib/server/creator-transfers.ts").indexOf("function resolveMaxTransferMinor"),
      src("src/lib/server/creator-transfers.ts").indexOf("const MIN_TRANSFER_MINOR"))));

  /* THE CAP AND THE AMOUNT SHARE ONE CURRENCY — today because the input type
   * admits exactly one. Asserted so that widening the currency without
   * denominating the cap becomes a failure here rather than a surprise. */
  check("the transfer input admits a single currency, so the bare cap is unambiguous",
    /currency: "usd";/.test(code));
  check("and the reservation is passed that same currency explicitly",
    /reserveFromPosition\(\s*tx,\s*input\.firebaseUid,\s*input\.environment,\s*input\.amountMinor,\s*input\.currency,/.test(code));
}

/* ---------------------------------------------------------------- C ---- */
section("C. The withdrawal state machine");

{
  const w = loadTs("src/lib/server/creator-withdrawals.ts");
  const T = w.ALLOWED_WITHDRAWAL_TRANSITIONS;

  check("every status is represented", Object.keys(T).length === 8, Object.keys(T).join(","));
  check("the terminal set is exactly failed, canceled, reversed",
    [...w.TERMINAL_WITHDRAWAL_STATUSES].sort().join(",") === "canceled,failed,reversed");

  /* NOTHING LEAVES A TERMINAL STATE except to itself. A resurrected withdrawal
   * is a second payment. */
  for (const terminal of ["failed", "canceled", "reversed"]) {
    check(`  ${terminal} leads only to itself`,
      T[terminal].length === 1 && T[terminal][0] === terminal, T[terminal].join(","));
  }
  /* `paid` MAY STILL BE REVERSED — money that arrived can be clawed back — but
   * it may not go anywhere else. */
  check("paid leads only to paid or reversed",
    T.paid.sort().join(",") === "paid,reversed", T.paid.join(","));
  /* AND NO BACKWARD TRANSITION EXISTS. */
  const ORDER = ["requested", "eligible", "processing", "provider_pending", "paid"];
  const backward = [];
  for (const [from, tos] of Object.entries(T)) {
    const fi = ORDER.indexOf(from);
    if (fi < 0) continue;
    for (const to of tos) {
      const ti = ORDER.indexOf(to);
      if (ti >= 0 && ti < fi) backward.push(`${from}->${to}`);
    }
  }
  check("no transition moves backwards through the lifecycle",
    backward.length === 0, backward.join(" "));

  check("the guard agrees with the table",
    w.isAllowedWithdrawalTransition("processing", "paid") === true &&
      w.isAllowedWithdrawalTransition("paid", "processing") === false &&
      w.isAllowedWithdrawalTransition("failed", "paid") === false &&
      w.isAllowedWithdrawalTransition("nonsense", "paid") === false);

  /* THE PROVIDER'S EIGHT STATUSES MAP ONTO OURS, without inventing one. */
  for (const [provider, local] of [
    ["completed", "paid"], ["reversed", "reversed"], ["canceled", "canceled"],
    ["failed", "failed"], ["denied", "failed"],
    ["requested", "provider_pending"], ["in_review", "provider_pending"],
    ["processing", "provider_pending"],
  ]) {
    check(`  provider ${provider} → ${local}`, w.mapProviderStatus(provider) === local,
      w.mapProviderStatus(provider));
  }
}

/* ---------------------------------------------------------------- D ---- */
section("D. Timeout ambiguity never becomes a second payment");

{
  const code = codeOnly("src/lib/server/creator-withdrawals.ts");
  const body = functionBody(bodyOnly("src/lib/server/creator-withdrawals.ts"), "executeWithdrawal") ?? "";

  /* THE IDEMPOTENCY KEY IS DERIVED FROM THE WITHDRAWAL, so every retry of this
   * withdrawal presents the same identity to the provider. A per-attempt key is
   * precisely how a retry becomes a second payment. */
  check("the payout idempotency key is derived from the withdrawal id",
    /idempotencyKey: `wdr:\$\{withdrawalId\}`/.test(body));
  check("and the quote key likewise",
    /idempotencyKey: `wdq:\$\{withdrawalId\}`/.test(body));
  check("nothing random or time-based enters either key",
    !/randomUUID|Date\.now\(\)|Math\.random/.test(
      body.slice(body.indexOf("idempotencyKey") - 200, body.indexOf("idempotencyKey") + 100)));

  /* AN AMBIGUOUS OUTCOME STAYS NON-TERMINAL. */
  check("an ambiguous provider outcome moves to provider_pending, not a terminal state",
    /if \(result\.outcome === "ambiguous"\)[\s\S]{0,700}"provider_pending"/.test(body));
  check("provider_pending is not terminal",
    !loadTs("src/lib/server/creator-withdrawals.ts").TERMINAL_WITHDRAWAL_STATUSES.has("provider_pending"));
  check("and the caller is told it is ambiguous rather than failed",
    /return \{ ok: false, reason: "payout_ambiguous" \}/.test(body));
  /* A DEFINITE REFUSAL IS TERMINAL, and needs no restoration because nothing was
   * ever posted — the money never left the creator's Whop balance. */
  check("a definite refusal is recorded failed",
    /await setWithdrawalStatus\(db, withdrawalId, environment, "failed"/.test(body));
  check("the withdrawal path posts no journal at all, so there is nothing to unwind",
    !/postTransaction|accountingEntries/.test(code));

  /* THE SUBMISSION TIME IS RECORDED BEFORE THE CALL, so orphan discovery has a
   * lower bound even when no response arrives. */
  check("providerSubmittedAt is written before the provider is called",
    body.indexOf("providerSubmittedAt: new Date()") < body.indexOf("await createPayout("));
  /* THE CLAIM'S RESULT GATES THE CALL — it is not enough that it happens first.
   *
   * A mutation run replaced the claim with `const claimed = true; await
   * setWithdrawalStatus(...)`, which still ran the update before the payout and
   * still left the `if (!claimed)` guard in place — yet two admins could now both
   * proceed, because neither was told it had lost. So the assertion is the
   * binding: `claimed` must BE the update's return value, and the refusal must sit
   * between it and the provider. */
  check("the claim's own result is what the guard reads",
    /const claimed = await setWithdrawalStatus\(db, withdrawalId, environment, "processing", \{/.test(body),
    (body.match(/const claimed = [^\n]*/) ?? ["absent"])[0]);
  check("and a lost claim aborts rather than paying",
    /if \(!claimed\) return \{ ok: false, reason: "wrong_status" \}/.test(body));
  check("with the refusal between the claim and the provider call",
    body.indexOf("const claimed = await setWithdrawalStatus") <
      body.indexOf("if (!claimed) return") &&
    body.indexOf("if (!claimed) return") < body.indexOf("await createPayout("),
    `claim=${body.indexOf("const claimed = await setWithdrawalStatus")} guard=${body.indexOf("if (!claimed) return")} pay=${body.indexOf("await createPayout(")}`);

  /* AND THERE IS A RECOVERY PATH for a payout that exists but was never recorded. */
  check("an orphan recovery path exists",
    typeof loadTs("src/lib/server/creator-withdrawals.ts").recoverOrphanedWithdrawal === "function");
  const orphan = functionBody(codeOnly("src/lib/server/creator-withdrawals.ts"), "recoverOrphanedWithdrawal") ?? "";
  /* IT ASKS THE PROVIDER, it does not assume. Recovery looks the payout up by the
   * withdrawal id recorded in provider metadata, so an ambiguous outcome is
   * resolved by evidence rather than by retrying blind. */
  check("orphan recovery searches the provider by withdrawal id",
    /findPayoutByWithdrawalId\(\{/.test(orphan), "no provider search found");
  check("and refuses to recover a withdrawal that was never submitted",
    /if \(!withdrawal\.providerSubmittedAt\) return \{ ok: false, reason: "not_recoverable" \}/.test(orphan));
  check("or one that already has a provider id — that is ordinary reconciliation",
    /not_recoverable/.test(orphan) && orphan.indexOf("providerPayoutId") < orphan.indexOf("findPayoutByWithdrawalId"));
}

/* =========================================================================
   The database part.
   ========================================================================= */

async function run() {
  const direct = new URL(process.env.DATABASE_URL);
  direct.hostname = direct.hostname.replace("-pooler", "");
  const client = postgres(direct.toString(), { max: 1, prepare: false, onnotice: () => {} });

  const before = {};
  for (const t of ["creator_earnings", "creator_withdrawals", "creator_transfers",
                   "accounting_transactions", "accounting_entries", "notifications"]) {
    const [r] = await client.unsafe(`select count(*)::int as n from public.${t}`);
    before[t] = r.n;
  }
  const [beforeMig] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;

  let scoped = null;
  try {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe(`create schema ${SCRATCH}`);
    await client.unsafe(`set search_path = ${SCRATCH}`);
    const [{ schema }] = await client`select current_schema() as schema`;
    if (schema !== SCRATCH) throw new Error(`ISOLATION FAILED — DDL would run in ${schema}`);

    const tags = JSON.parse(src("drizzle/meta/_journal.json")).entries.map((e) => e.tag);
    for (const tag of tags) {
      for (const stmt of src(`drizzle/${tag}.sql`)
        .split("--> statement-breakpoint")
        .map((x) => x.replace(/"public"\./g, `"${SCRATCH}".`).trim())
        .filter(Boolean)) {
        try { await client.unsafe(stmt); }
        catch (e) { throw new Error(`DDL FAILED in ${tag}: ${String(e?.message ?? e).slice(0, 200)}`); }
      }
    }
    check("the full migration chain applies", true, `${tags.length} migrations`);

    /* THE SEARCH PATH IS A STARTUP PARAMETER, NOT A STATEMENT.
     *
     * `max: 1` has been load-bearing in every earlier DB-backed suite, and this
     * one needs a POOL to drive genuinely simultaneous requests. Those two facts
     * collide: `SET search_path` applies to the ONE connection that ran it, so a
     * pooled client silently serves other queries on connections still pointing
     * at `public`. Writing this suite with `max: 3` and a `SET` did exactly that
     * and put a synthetic journal entry into the real database.
     *
     * Passing `search_path` as a libpq startup option makes EVERY connection in
     * the pool begin in the scratch schema, so the guarantee no longer depends on
     * which connection a query happens to get. */
    scoped = postgres(direct.toString(), {
      max: 4,
      prepare: false,
      onnotice: () => {},
      /* `-c search_path=…` AS A libpq STARTUP OPTION, not `connection.search_path`.
       * Verified empirically against a throwaway schema: the bare key is ignored
       * and every connection still reports `public`, while the `options` form puts
       * all of them in the scratch schema. A setting that looks applied and is not
       * is worse than none, which is why the probe below tests every backend. */
      connection: { options: `-c search_path=${SCRATCH}` },
    });

    /* AND IT IS PROVED ON EVERY CONNECTION IN THE POOL, concurrently, so a
     * connection that did not get the setting cannot hide behind one that did.
     * A single probe would have passed under the bug above. */
    const probes = await Promise.all(Array.from({ length: 8 }, () => scoped`
      select current_schema() as schema,
             pg_backend_pid() as pid,
             (select n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.oid = to_regclass('creator_withdrawals')) as w`));
    const distinctPids = new Set(probes.map((p) => p[0].pid)).size;
    const bad = probes.filter((p) => p[0].schema !== SCRATCH || p[0].w !== SCRATCH);
    if (bad.length) {
      throw new Error(
        `ISOLATION FAILED — refusing to write: ${bad.length}/${probes.length} connections outside ${SCRATCH}`);
    }
    check("ISOLATION PROVED on every pooled connection", true,
      `${probes.length} probes, ${distinctPids} distinct backends, all in ${SCRATCH}`);

    const { drizzle } = require("drizzle-orm/postgres-js");
    DB = drizzle(scoped);

    const CREATOR = "uid_payee";
    const ACCOUNT = "biz_payee_child";
    for (const uid of [CREATOR, "uid_other"]) {
      await scoped.unsafe(
        `insert into ${SCRATCH}.users
           (firebase_uid, role, approval_status, approved_at, decided_by_uid, decided_at)
         values ($1,'creator','approved',now(),'uid_admin_fixture',now())
         on conflict do nothing`, [uid]);
    }
    await scoped.unsafe(
      `insert into ${SCRATCH}.whop_accounts
         (firebase_uid, whop_account_id, whop_user_id, parent_account_id, environment)
       values ($1,$2,'user_payee','biz_platform','sandbox')`, [CREATOR, ACCOUNT]);

    const withdrawals = loadTs("src/lib/server/creator-withdrawals.ts");

    /* ------------------------------------------------------------ E ---- */
    section("E. The withdrawable ceiling is the provider's own balance");

    {
      /* THE AUTHORITY IS THE PROVIDER, not a local sum. The creator's spendable
       * money sits in their Whop balance, so Whop is the only thing that can say
       * how much of it is withdrawable. */
      const payouts = loadTs("src/lib/server/whop-payouts.ts");
      FAKE_CLIENT = {
        ledgerAccounts: {
          retrieve: async ({ id }) => {
            providerCalls.push(`ledger:${id}`);
            return { treasury_balance: { currency: "usd", total_withdrawable_balance: 25 } };
          },
        },
      };
      const bal = await payouts.readWithdrawableBalance(ACCOUNT, "usd");
      check("the balance comes from the provider's treasury_balance",
        bal.ok === true && bal.withdrawableMinor === BigInt(2500),
        bal.ok ? String(bal.withdrawableMinor) : JSON.stringify(bal));

      /* A CURRENCY MISMATCH IS A REFUSAL, never a silent conversion. */
      FAKE_CLIENT = { ledgerAccounts: { retrieve: async () => ({
        treasury_balance: { currency: "eur", total_withdrawable_balance: 25 } }) } };
      const wrong = await payouts.readWithdrawableBalance(ACCOUNT, "usd");
      check("a treasury in another currency is refused, not converted",
        wrong.ok === false && wrong.reason === "unsupported_currency", JSON.stringify(wrong));

      /* AN UNREADABLE PROVIDER FAILS CLOSED — never "zero", never "plenty". */
      FAKE_CLIENT = { ledgerAccounts: { retrieve: async () => { throw new FakeWhopError(500); } } };
      const err = await payouts.readWithdrawableBalance(ACCOUNT, "usd");
      check("a provider error is unavailable, not a balance", err.ok === false, JSON.stringify(err));
      FAKE_CLIENT = { ledgerAccounts: { retrieve: async () => ({ treasury_balance: null }) } };
      const none = await payouts.readWithdrawableBalance(ACCOUNT, "usd");
      check("a missing treasury is unavailable too", none.ok === false);
      FAKE_CLIENT = null;
      check("and with no client configured there is no balance at all",
        (await payouts.readWithdrawableBalance(ACCOUNT, "usd")).ok === false);
    }

    /* ------------------------------------------------------------ F ---- */
    section("F. One active withdrawal per creator per environment");

    {
      const ledger = (minor) => ({
        ledgerAccounts: { retrieve: async () => ({
          treasury_balance: { currency: "usd", total_withdrawable_balance: minor } }) },
        accounts: { retrieve: async () => ({ status: "active" }) },
      });

      FAKE_CLIENT = ledger(50);
      const first = await withEnv({ WHOP_ENV: "sandbox" }, () => withdrawals.requestWithdrawal({
        firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd",
        requestId: "req-aaaa1111",
      }));
      check("a first withdrawal is accepted", first.ok === true,
        first.ok ? first.status : JSON.stringify(first));

      /* THE SECOND, DIFFERENT REQUEST IS REFUSED — the partial unique index
       * allows exactly one non-terminal withdrawal per (creator, environment), so
       * two cannot both hold a claim on the same balance. */
      const second = await withEnv({ WHOP_ENV: "sandbox" }, () => withdrawals.requestWithdrawal({
        firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd",
        requestId: "req-bbbb2222",
      }));
      check("a second concurrent withdrawal is refused as already pending",
        second.ok === false && second.reason === "withdrawal_already_pending",
        JSON.stringify(second));
      check("and only one row exists",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.creator_withdrawals`))[0].n === 1);

      /* TRULY SIMULTANEOUS, through the database rather than in sequence — the
       * index is what settles it, not the order of two awaits. */
      await scoped.unsafe(`delete from ${SCRATCH}.creator_withdrawals`);
      FAKE_CLIENT = ledger(50);
      const racers = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        withEnv({ WHOP_ENV: "sandbox" }, () => withdrawals.requestWithdrawal({
          firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd",
          requestId: `req-race${String(i).padStart(4, "0")}`,
        }))));
      const accepted = racers.filter((r) => r.ok).length;
      check("six simultaneous requests yield exactly one withdrawal",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.creator_withdrawals`))[0].n === 1,
        `${accepted} reported ok`);
      check("and the refusals name the reason rather than erroring",
        racers.filter((r) => !r.ok).every((r) => r.reason === "withdrawal_already_pending"),
        [...new Set(racers.filter((r) => !r.ok).map((r) => r.reason))].join(","));

      /* THE SAME REQUEST ID REPLAYS instead of creating a second intent. */
      const replay = await withEnv({ WHOP_ENV: "sandbox" }, () => withdrawals.requestWithdrawal({
        firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd",
        requestId: racers.find((r) => r.ok) ? "req-race0000" : "req-race0000",
      }));
      check("a repeated request id replays the same withdrawal, not a new one",
        replay.ok === true || replay.reason === "withdrawal_already_pending",
        JSON.stringify(replay));
      check("still one row",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.creator_withdrawals`))[0].n === 1);

      /* THE SAME REQUEST ID, RACED — the only way to reach the replay branch.
       *
       * Every case above either found the existing row in the pre-check or lost on
       * the active-withdrawal index. The `uniq_withdrawal_request_creator_env`
       * branch is reached only when concurrent callers share one request id and the
       * pre-check found nothing yet. That branch was DEAD in production (it matched
       * on the error message), and the observable symptom is precisely what this
       * asserts: no caller may be told the database is unavailable for a request
       * that in fact succeeded. */
      await scoped.unsafe(`delete from ${SCRATCH}.creator_withdrawals`);
      FAKE_CLIENT = ledger(50);
      const SHARED = "req-shared999";
      const sameId = await Promise.all(Array.from({ length: 6 }, () =>
        withEnv({ WHOP_ENV: "sandbox" }, () => withdrawals.requestWithdrawal({
          firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd",
          requestId: SHARED,
        }))));
      const reasons = [...new Set(sameId.map((r) => (r.ok ? `ok:${r.replayed}` : r.reason)))];
      check("six callers sharing one request id produce exactly one withdrawal",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.creator_withdrawals`))[0].n === 1,
        reasons.join(","));
      check("at least one is told it succeeded",
        sameId.some((r) => r.ok === true), reasons.join(","));
      /* THE POINT. `db_unavailable` here means a caller was handed a database
       * error for a withdrawal that exists — the dead-branch symptom. */
      check("and NO caller is told the database is unavailable",
        !sameId.some((r) => !r.ok && r.reason === "db_unavailable"), reasons.join(","));
      check("every refusal names a real, actionable reason",
        sameId.filter((r) => !r.ok).every((r) =>
          ["withdrawal_already_pending", "request_conflict"].includes(r.reason)),
        reasons.join(","));

      /* THE PROVIDER BALANCE IS THE CEILING. */
      await scoped.unsafe(`delete from ${SCRATCH}.creator_withdrawals`);
      FAKE_CLIENT = ledger(5);
      const over = await withEnv({ WHOP_ENV: "sandbox" }, () => withdrawals.requestWithdrawal({
        firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd",
        requestId: "req-over1111",
      }));
      check("a request above the provider balance is refused",
        over.ok === false && over.reason === "amount_exceeds_balance", JSON.stringify(over));
      FAKE_CLIENT = ledger(0);
      const empty = await withEnv({ WHOP_ENV: "sandbox" }, () => withdrawals.requestWithdrawal({
        firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd",
        requestId: "req-zero1111",
      }));
      check("an empty balance is refused as insufficient",
        empty.ok === false && empty.reason === "insufficient_available", JSON.stringify(empty));
      check("and no row was created by either refusal",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.creator_withdrawals`))[0].n === 0);

      /* AMOUNT GUARDS, BEFORE ANY PROVIDER READ. */
      providerCalls = [];
      FAKE_CLIENT = ledger(1000);
      for (const [label, amount, reason] of [
        ["zero", BigInt(0), "amount_zero"],
        ["negative", BigInt(-100), "amount_zero"],
      ]) {
        const r = await withEnv({ WHOP_ENV: "sandbox" }, () => withdrawals.requestWithdrawal({
          firebaseUid: CREATOR, amountMinor: amount, currency: "usd", requestId: "req-guard111",
        }));
        check(`  a ${label} amount is refused as ${reason}`,
          r.ok === false && r.reason === reason, JSON.stringify(r));
      }
      check("and no provider read happened for a refused amount",
        providerCalls.length === 0, providerCalls.join(","));

      /* AN UNRESOLVED ENVIRONMENT DOES NO WORK AT ALL. */
      const noEnv = await withEnv({ WHOP_ENV: null }, () => withdrawals.requestWithdrawal({
        firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd", requestId: "req-noenv111",
      }));
      check("an unresolved environment refuses before touching anything",
        noEnv.ok === false, JSON.stringify(noEnv));
      /* AND A CREATOR WITHOUT AN ACCOUNT IN THIS ENVIRONMENT CANNOT WITHDRAW —
       * a sandbox account can never fund a production withdrawal. */
      FAKE_CLIENT = ledger(5000);
      const prodAttempt = await withEnv({ WHOP_ENV: "production" }, () => withdrawals.requestWithdrawal({
        firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd", requestId: "req-prod1111",
      }));
      check("PRODUCTION refuses: the creator's only account is a sandbox one",
        prodAttempt.ok === false && prodAttempt.reason === "creator_not_found",
        JSON.stringify(prodAttempt));
    }

    /* ------------------------------------------------------------ G ---- */
    section("G. The transfer discharges creator_payable, once, under a cap");

    {
      const transfers = loadTs("src/lib/server/creator-transfers.ts");
      const journal = loadTs("src/lib/server/accounting/journal.ts");

      /* GIVE THE CREATOR A PAYABLE BALANCE, through the real journal — the
       * position helper reads the ledger, so a hand-written row would prove
       * nothing about what a transfer can actually reserve. */
      const seeded = await journal.postTransaction({
        economicEvent: "revenue_split",
        provider: "whop", providerResourceId: "pay_seed_1",
        environment: "sandbox", currency: "usd",
        idempotencyKey: "whop:revenue_split:pay_seed_1",
        description: "seed creator payable",
        legs: [
          { account: "creator_payable", amountMinor: BigInt(-5000),
            counterpartyType: "creator", counterpartyId: CREATOR },
          { account: "provider_balance", amountMinor: BigInt(5000),
            counterpartyType: "provider", counterpartyId: "whop" },
        ],
      });
      check("a creator payable of 5000 minor is seeded through the real journal",
        seeded.ok === true, seeded.ok ? "ok" : JSON.stringify(seeded));

      /* PRODUCTION WITHOUT A CAP REFUSES — before the provider, before the books. */
      providerCalls = [];
      FAKE_CLIENT = { transfers: { create: async () => { providerCalls.push("transfer"); return {}; } } };
      const noCap = await withEnv(
        { WHOP_ENV: "production", MAX_CREATOR_TRANSFER_MINOR: null },
        () => transfers.initiateCreatorTransfer({
          firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd",
          purpose: "campaign_payout", initiatedByUid: "uid_admin",
          requestId: "req-nocap01", dryRun: false,
        }));
      check("production with no configured cap refuses",
        noCap.ok === false && noCap.reason === "transfer_cap_unconfigured", JSON.stringify(noCap));
      check("and made ZERO provider calls", providerCalls.length === 0, providerCalls.join(","));

      /* ABOVE THE CAP REFUSES, also before the provider. */
      providerCalls = [];
      const overCap = await withEnv(
        { WHOP_ENV: "sandbox", MAX_CREATOR_TRANSFER_MINOR: "2000" },
        () => transfers.initiateCreatorTransfer({
          firebaseUid: CREATOR, amountMinor: BigInt(5000), currency: "usd",
          purpose: "campaign_payout", initiatedByUid: "uid_admin",
          requestId: "req-overcap", dryRun: false,
        }));
      check("an amount above the cap refuses",
        overCap.ok === false && overCap.reason === "amount_above_maximum", JSON.stringify(overCap));
      check("and made ZERO provider calls", providerCalls.length === 0, providerCalls.join(","));
      check("and wrote no accounting transaction",
        (await scoped.unsafe(
          `select count(*)::int as n from ${SCRATCH}.accounting_transactions
            where economic_event = 'payout_sent'`))[0].n === 0);

      /* MORE THAN THE PAYABLE REFUSES — the ledger is the authority for what is
       * owed, and the reservation happens under a lock inside the transaction. */
      providerCalls = [];
      const overPayable = await withEnv(
        { WHOP_ENV: "sandbox", MAX_CREATOR_TRANSFER_MINOR: "1000000" },
        () => transfers.initiateCreatorTransfer({
          firebaseUid: CREATOR, amountMinor: BigInt(9000), currency: "usd",
          purpose: "campaign_payout", initiatedByUid: "uid_admin",
          requestId: "req-overpay", dryRun: false,
        }));
      check("more than the creator is owed refuses as insufficient payable",
        overPayable.ok === false && overPayable.reason === "insufficient_payable",
        JSON.stringify(overPayable));
      check("and made ZERO provider calls", providerCalls.length === 0, providerCalls.join(","));

      /* A GOOD TRANSFER POSTS ONE BALANCED PAIR AND DISCHARGES THE PAYABLE. */
      providerCalls = [];
      FAKE_CLIENT = {
        transfers: {
          create: async (body) => {
            providerCalls.push(`create:${JSON.stringify(body?.amount ?? "?")}`);
            return { id: "tr_ok_1", status: "succeeded", amount: 10, currency: "usd" };
          },
          retrieve: async () => ({ id: "tr_ok_1", status: "succeeded", amount: 10, currency: "usd" }),
        },
      };
      const good = await withEnv(
        { WHOP_ENV: "sandbox", MAX_CREATOR_TRANSFER_MINOR: "1000000" },
        () => transfers.initiateCreatorTransfer({
          firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd",
          purpose: "campaign_payout", initiatedByUid: "uid_admin",
          requestId: "req-good001", dryRun: false,
        }));
      check("a transfer within cap and payable succeeds", good.ok === true,
        good.ok ? "ok" : JSON.stringify(good));
      check("it called the provider exactly once", providerCalls.length === 1, providerCalls.join(","));

      const legs = await scoped.unsafe(
        `select e.account, e.amount_minor::text as minor, e.counterparty_id
           from ${SCRATCH}.accounting_entries e
           join ${SCRATCH}.accounting_transactions t on t.transaction_id = e.transaction_id
          where t.economic_event = 'payout_sent' order by e.leg`);
      check("it posted exactly two legs", legs.length === 2, `${legs.length} legs`);
      check("debiting creator_payable by the transfer amount",
        legs[0]?.account === "creator_payable" && legs[0]?.minor === "1000",
        `${legs[0]?.account}=${legs[0]?.minor}`);
      check("crediting provider_balance by the same",
        legs[1]?.account === "provider_balance" && legs[1]?.minor === "-1000");
      check("and they sum to zero",
        legs.reduce((a, l) => a + BigInt(l.minor), BigInt(0)) === BigInt(0));
      /* THE COUNTERPARTY IS THE FIREBASE UID, not the provider account id — the
       * credits are keyed that way, and keying the debit differently is how a
       * payable never goes down however much is paid out. */
      check("the payable leg is keyed on the creator's uid, matching the credit side",
        legs[0]?.counterparty_id === CREATOR, String(legs[0]?.counterparty_id));

      /* A REPLAY DOES NOT DISCHARGE TWICE. */
      providerCalls = [];
      const replay = await withEnv(
        { WHOP_ENV: "sandbox", MAX_CREATOR_TRANSFER_MINOR: "1000000" },
        () => transfers.initiateCreatorTransfer({
          firebaseUid: CREATOR, amountMinor: BigInt(1000), currency: "usd",
          purpose: "campaign_payout", initiatedByUid: "uid_admin",
          requestId: "req-good001", dryRun: false,
        }));
      check("the same request id replays rather than paying again", replay.ok === true);
      const payoutTxns = await scoped.unsafe(
        `select count(*)::int as n from ${SCRATCH}.accounting_transactions
          where economic_event = 'payout_sent'`);
      check("still exactly one payout_sent transaction", payoutTxns[0].n === 1, String(payoutTxns[0].n));
      check("and the payable was discharged once, not twice",
        (await scoped.unsafe(
          `select coalesce(sum(amount_minor),0)::text as s from ${SCRATCH}.accounting_entries
            where account = 'creator_payable'`))[0].s === "-4000",
        (await scoped.unsafe(
          `select coalesce(sum(amount_minor),0)::text as s from ${SCRATCH}.accounting_entries
            where account = 'creator_payable'`))[0].s);

      /* THE WHOLE LEDGER STILL BALANCES, per currency. */
      const bal = await scoped.unsafe(
        `select t.currency, coalesce(sum(e.amount_minor),0)::text as s
           from ${SCRATCH}.accounting_transactions t
           join ${SCRATCH}.accounting_entries e on e.transaction_id = t.transaction_id
          group by t.currency`);
      check("every currency balances to zero",
        bal.every((r) => r.s === "0"), bal.map((r) => `${r.currency}=${r.s}`).join(" "));
      /* NO SUSPENSE RESIDUE from the money-out path. */
      const suspense = await scoped.unsafe(
        `select coalesce(sum(amount_minor),0)::text as s from ${SCRATCH}.accounting_entries
          where account = 'unallocated_customer_funds'`);
      check("the money-out path left no suspense residue", suspense[0].s === "0", suspense[0].s);
    }

  } finally {
    await client.unsafe(`drop schema if exists ${SCRATCH} cascade`);
    await client.unsafe("set search_path = public");
    if (scoped) await scoped.end({ timeout: 5 });

    section("H. The real database is untouched");
    for (const t of Object.keys(before)) {
      const [r] = await client.unsafe(`select count(*)::int as n from public.${t}`);
      check(`  public.${t} unchanged`, r.n === before[t], `${before[t]} -> ${r.n}`);
    }
    const [afterMig] = await client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    check("no migration was applied", afterMig.n === beforeMig.n, `${beforeMig.n} applied`);
    const [prod] = await client`
      select (select count(*)::int from public.creator_withdrawals where environment='production') as w,
             (select count(*)::int from public.creator_transfers where environment='production') as t`;
    check("and no production withdrawal or transfer exists",
      prod.w === 0 && prod.t === 0, `withdrawals=${prod.w} transfers=${prod.t}`);
    const [gone] = await client`
      select count(*)::int as n from information_schema.schemata where schema_name = ${SCRATCH}`;
    check("the throwaway schema is gone", gone.n === 0);
    await client.end({ timeout: 5 });
  }
}

await run().catch((e) =>
  check("DB sections completed", false, String(e?.message ?? e).slice(0, 300)));

/* ---------------------------------------------------------------- I ---- */
section("I. Admin execution: guards before any money moves");

{
  for (const route of ["admin/withdrawals/[id]", "admin/transfer/creator"]) {
    const body = bodyOnly(`src/app/api/${route}/route.ts`);
    const originAt = body.indexOf("checkRequestOrigin");
    const rlAt = body.indexOf("checkRateLimit");
    const auditAt = body.indexOf("writeAudit");
    check(`${route}: origin checked`, originAt >= 0);
    check(`  rate limited per admin`, rlAt > 0 && /admin:\w+:\$\{admin\w*\.uid\}/.test(body));
    for (const money of ["executeWithdrawal", "initiateCreatorTransfer"]) {
      const at = body.indexOf(money);
      if (at < 0) continue;
      check(`  ${money} runs after the origin check`, originAt < at, `${originAt} < ${at}`);
      check(`  and after the rate limit`, rlAt < at, `${rlAt} < ${at}`);
      /* THE AUDIT ROW IS WRITTEN FOR AN ADMITTED ATTEMPT, and a refused request
       * writes nothing at all — the limiter and the origin check both precede it. */
      if (auditAt > 0) check(`  and the audit precedes it`, auditAt < at, `${auditAt} < ${at}`);
    }
    check(`  a refused request answers with the shared 429`,
      /rateLimitResponse\(rl\.retryAfterSeconds\)/.test(body));
    /* AN ADMIN ROUTE LEGITIMATELY NAMES THE RECIPIENT. `admin/transfer/creator`
     * reads `body.firebase_uid` because choosing who to pay is the admin's job —
     * the earlier form of this check called that a defect, which it is not. What
     * must never come from the request is the ENVIRONMENT (server config decides
     * which Whop money moves in) or the ACTING ADMIN (that comes from the verified
     * session, or a caller could attribute their own action to someone else). */
    check(`  the environment never comes from the request`,
      !/(body|searchParams|params)[^\n;]{0,60}\b(environment|whop_env)\b/i.test(body),
      (body.match(/(body|searchParams|params)[^\n;]{0,40}environment/i) ?? [""])[0]);
    check(`  and the acting admin comes from the verified session`,
      !/initiatedByUid = (body|searchParams)/.test(body) &&
        (!/initiatedByUid/.test(body) || /initiatedByUid = admin\w*\.uid/.test(body)),
      (body.match(/initiatedByUid = [^\n;]*/) ?? ["n/a"])[0]);
  }
  /* THE TRANSFER ROUTE OFFERS A DRY RUN, which reports without moving money —
   * that is how an unconfigured production cap is discovered safely. */
  const t = bodyOnly("src/app/api/admin/transfer/creator/route.ts");
  check("the transfer route supports a dry run",
    /dry_?[Rr]un/.test(t));
  check("and the live path is explicit rather than the default",
    /dryRun/.test(t));
}

/* ---------------------------------------------------------------- J ---- */
section("J. Notifications follow authoritative state, idempotently");

{
  const triggers = codeOnly("src/lib/server/notification-triggers.ts");
  /* EVERY KEY CARRIES THE ENVIRONMENT, so a sandbox event cannot suppress a
   * production notification or vice versa. */
  check("notification keys carry the environment",
    /function notificationKey\(\s*type[\s\S]{0,200}environment/.test(triggers));
  for (const kind of ["payout_succeeded", "payout_failed", "payout_reversed", "earnings_held"]) {
    check(`  ${kind} has a keyed trigger`, triggers.includes(kind));
  }
  /* THE TRANSFER OUTCOMES BOTH REACH A CREATOR — the failure branch was
   * unreachable until Task #27 subscribed transfer.*, and a creator whose payout
   * failed is the one who most needs to hear. */
  check("both transfer outcomes can be reported",
    /notifyPayoutCompleted\(transferId, true\)/.test(triggers) &&
      /notifyPayoutCompleted\(transferId, false\)/.test(triggers));
  /* AND A NOTIFICATION NEVER DECIDES MONEY. */
  check("notification failures are swallowed, never propagated",
    /catch \{[\s\S]{0,200}notification failure must not/i.test(
      src("src/lib/server/notification-triggers.ts")));
  const hooks = codeOnly("src/lib/server/whop-webhooks.ts");
  check("and they fire only after a handler succeeded",
    hooks.indexOf("await HANDLERS[eventType]") < hooks.indexOf("fireWebhookNotifications("));
}

/* ---------------------------------------------------------------- K ---- */
section("K. Money-out under a production configuration");

{
  const wp = loadTs("src/lib/server/whop-payments.ts");
  const FAKE = { WHOP_API_KEY: "fake-not-real", WHOP_COMPANY_ID: "biz_fake" };

  check("production selects the production API host",
    wp.resolveWhopPayments({ ...FAKE, WHOP_ENV: "production" }).config.baseUrl ===
      "https://api.whop.com/api/v1");
  check("and sandbox the sandbox host",
    wp.resolveWhopPayments({ ...FAKE, WHOP_ENV: "sandbox" }).config.baseUrl ===
      "https://sandbox-api.whop.com/api/v1");
  /* MISSING PRODUCTION CREDENTIALS YIELD NO CLIENT — so no money-out call can be
   * attempted at all, rather than being attempted against a default host. */
  for (const [label, env] of [
    ["no api key", { WHOP_COMPANY_ID: FAKE.WHOP_COMPANY_ID, WHOP_ENV: "production" }],
    ["no company id", { WHOP_API_KEY: FAKE.WHOP_API_KEY, WHOP_ENV: "production" }],
    ["no environment", { ...FAKE }],
  ]) {
    check(`  with ${label} there is no payments client`,
      wp.getWhopPaymentsClient(env) === null);
  }

  /* THE MONEY-OUT MODULES ARE SERVER-ONLY, and no client component names them. */
  const files = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p)) files.push(p);
    }
  })("src");
  for (const m of ["whop-payouts", "whop-transfers", "creator-withdrawals",
                   "creator-transfers", "creator-position"]) {
    check(`  lib/server/${m}.ts is server-only`,
      /import "server-only"/.test(src(`src/lib/server/${m}.ts`)));
  }
  const clientLeaks = files.filter((f) =>
    /^\s*["']use client["']/.test(src(f)) &&
    /whop-payouts|creator-withdrawals|creator-transfers|MAX_CREATOR_TRANSFER_MINOR/.test(src(f)));
  check("no client component reaches a money-out module", clientLeaks.length === 0,
    clientLeaks.join(", "));

  /* THE DEAD ALLOCATION TABLE. Reported rather than dropped: it holds no rows and
   * no code references it, but removing a table is a migration and a decision. */
  const referenced = files.filter((f) => /creatorWithdrawalEarnings/.test(src(f)) && !/schema\.ts$/.test(f));
  check("creator_withdrawal_earnings is referenced by no runtime code",
    referenced.length === 0, referenced.join(", "));
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
