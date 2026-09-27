#!/usr/bin/env node
/**
 * TASK #21 — ADMIN FINANCE DASHBOARD.
 *
 * The dashboard is the one screen that answers "are the books sound", and it was
 * answering it wrongly in several ways at once:
 *
 *   - raw MINOR UNITS were rendered as if they were money, so $2.04 read as 204
 *   - a reconciler that failed contributed ZERO to the discrepancy count, so an
 *     outage displayed as a clean bill of health
 *   - the count was gated on the trial balance, so a balance failure hid
 *     discrepancies the reconcilers had actually found
 *   - Task #20's two reconcilers were never called, so every allocation and
 *     creator-earnings finding was invisible here
 *   - the fee-drift table showed no drift: no delta, no tax column
 *   - the trial balance keyed rows by account alone, which stopped being unique
 *     the moment one account held two currencies
 *   - the repair endpoints were prose an operator could read but not run
 *
 * NO NETWORK. NO DATABASE. The pure presentation logic is loaded and exercised
 * directly; the component and route contracts are asserted against source where
 * behaviour cannot be reached without a browser, and those assertions are
 * written to survive a rename.
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n--- ${t} ---`);
const src = (p) => readFileSync(p, "utf8");
const codeOnly = (p) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Loads a TS module in memory with its imports stubbed. */
function load(path, stubs = {}) {
  const js = ts.transpileModule(src(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  const shim = (id) => {
    if (id in stubs) return stubs[id];
    if (id === "server-only") return {};
    throw new Error(`unstubbed import: ${id}`);
  };
  new Function("require", "module", "exports", js)(shim, mod, mod.exports);
  return mod.exports;
}

/* THE REAL MONEY PRIMITIVES, not fakes. Whether a currency is supported and how
 * many decimals it carries decides every figure below, so faking that table
 * would let this suite agree with itself about a currency the build cannot
 * actually scale. */
const money = load("src/lib/server/money.ts", {});
const F = load("src/lib/admin/finance-format.ts", { "@/lib/server/money": money });
const B = (n) => BigInt(n);

/* ---------------------------------------------------------------- A ---- */
section("A. Minor units are not display units");

{
  check("204 USD minor units render as 2.04, not 204",
    F.formatLedgerAmount(B(204), "usd").display === "2.04",
    F.formatLedgerAmount(B(204), "usd").display);
  check("and carry their currency, upper-cased",
    F.formatLedgerAmount(B(204), "usd").currency === "USD");
  check("a negative balance keeps its sign",
    F.formatLedgerAmount(B(-1000), "usd").display === "-10.00",
    F.formatLedgerAmount(B(-1000), "usd").display);
  check("zero renders as zero, not as unavailable",
    F.formatLedgerAmount(B(0), "usd").display === "0.00" &&
      F.formatLedgerAmount(B(0), "usd").unresolved === false);

  /* ZERO-DECIMAL CURRENCIES. JPY is charged in whole yen: 1000 minor units is
   * ¥1000, and dividing by 100 would understate it a hundredfold. */
  check("JPY has no decimals — 1000 minor units is 1000, not 10.00",
    F.formatLedgerAmount(B(1000), "jpy").display === "1000",
    F.formatLedgerAmount(B(1000), "jpy").display);
  check("while the same integer in USD is 10.00",
    F.formatLedgerAmount(B(1000), "usd").display === "10.00");
  check("KRW is zero-decimal too",
    F.formatLedgerAmount(B(5000), "krw").display === "5000");
  check("EUR is two-decimal",
    F.formatLedgerAmount(B(4500), "eur").display === "45.00");

  /* THE RAW INTEGER IS ALWAYS AVAILABLE, so an operator can reconcile against
   * the ledger itself without trusting the formatting. */
  check("the raw minor units are always reported alongside",
    F.formatLedgerAmount(B(204), "usd").minor === "204" &&
      F.formatLedgerAmount(B(1000), "jpy").minor === "1000");
}

/* ---------------------------------------------------------------- B ---- */
section("B. An unknown currency fails visibly, never as dollars");

{
  for (const bad of [null, undefined, "", "xyz", "whop_usd", 42, {}]) {
    const f = F.formatLedgerAmount(B(1234), bad);
    check(`${JSON.stringify(bad)} is unresolved rather than guessed`,
      f.unresolved === true && f.display === null,
      JSON.stringify({ d: f.display, c: f.currency }));
  }
  check("an unresolved amount still surfaces its raw minor units",
    F.formatLedgerAmount(B(1234), "xyz").minor === "1234");
  check("and is NEVER labelled USD by default",
    F.formatLedgerAmount(B(1234), null).currency === null);

  const label = F.formatLedgerAmountLabel(B(1234), "xyz");
  check("its label marks the uncertainty visibly",
    label.includes("1234") && label.includes("?"), label);
}

/* ---------------------------------------------------------------- C ---- */
section("C. Currencies are never summed together");

{
  const totals = [
    { currency: "usd", totalMinor: B(1000) },
    { currency: "eur", totalMinor: B(4500) },
    { currency: "jpy", totalMinor: B(1000) },
  ];
  const out = F.formatPerCurrencyTotals(totals);

  check("three currencies produce three figures, not one",
    out.length === 3, String(out.length));
  check("each in its own denomination and scale",
    out.join(" · ") === "45.00 EUR · 1000 JPY · 10.00 USD", out.join(" · "));
  check("ordering is stable, so the same ledger always reads the same way",
    JSON.stringify(F.formatPerCurrencyTotals([...totals].reverse())) === JSON.stringify(out));
  check("no output line contains a sum of two currencies",
    out.every((line) => line.split(" ").length === 2));

  /* THE ARITHMETIC IS ABSENT BY DESIGN. There is deliberately no helper that
   * takes mixed currencies and returns one number, because the way to stop that
   * sum happening is to give nobody a tool for it. */
  const fmtSrc = codeOnly("src/lib/admin/finance-format.ts");
  check("the formatter exposes no cross-currency total function",
    !/reduce\([^)]*totalMinor/.test(fmtSrc) && !/sumTotals|grandTotalOf/.test(fmtSrc));
  check("and takes its scale from the currency, never from a constant",
    /currencyDecimals\(/.test(fmtSrc) && !/\/ 100\b|\* 100\b/.test(fmtSrc));
}

/* ---------------------------------------------------------------- D ---- */
section("D. Unavailable is not healthy, and not zero");

{
  check("all parts known sums normally",
    F.sumAvailableCounts([1, 2, 3]) === 6);
  check("an empty list is a real zero",
    F.sumAvailableCounts([]) === 0);
  check("zeros are a real zero",
    F.sumAvailableCounts([0, 0, 0]) === 0);

  /* THE DEFECT THIS EXISTS FOR: the dashboard summed with `?? 0`, so a failed
   * reconciler contributed nothing and the total read as a confident 0. */
  check("ONE unknown part makes the whole unknown",
    F.sumAvailableCounts([1, null, 3]) === null);
  check("undefined counts as unknown too",
    F.sumAvailableCounts([1, undefined]) === null);
  check("all unknown is unknown, not zero",
    F.sumAvailableCounts([null, null]) === null);
  check("an unknown among zeros does not read as zero",
    F.sumAvailableCounts([0, null, 0]) === null);

  /* HEALTHY REQUIRES BOTH REACHABLE AND EMPTY. */
  check("reachable and empty is healthy", F.isHealthy(true, 0) === true);
  check("reachable with findings is not healthy", F.isHealthy(true, 3) === false);
  check("unreachable is NOT healthy, even with a zero count",
    F.isHealthy(false, 0) === false);
  check("unknown count is not healthy",
    F.isHealthy(true, null) === false);
  check("undefined configured is not healthy",
    F.isHealthy(undefined, 0) === false);
}

/* ---------------------------------------------------------------- E ---- */
section("E. The dashboard uses those rules");

{
  const ui = src("src/components/admin/FinanceSections.tsx");
  const uiCode = codeOnly("src/components/admin/FinanceSections.tsx");

  check("the trial balance renders through the formatter, not raw minor units",
    /formatLedgerAmount\(row\.totalMinor, row\.currency\)/.test(uiCode));
  check("the grand total is per currency",
    /formatPerCurrencyTotals\(balance\.grandTotals\)/.test(uiCode));
  check("no raw `${g.totalMinor}` interpolation remains in the KPI row",
    !/\$\{g\.totalMinor\}/.test(ui));

  /* THE ROW KEY. One account can hold several currencies, so the account alone
   * stopped being unique when Task #20 split the trial balance by currency. */
  check("trial-balance rows are keyed by account AND currency",
    /rowKey=\{\(row\) => `\$\{row\.account\}:\$\{row\.currency\}`\}/.test(ui));

  /* THE DISCREPANCY COUNT. */
  check("the discrepancy count goes through sumAvailableCounts",
    /sumAvailableCounts\(\[/.test(uiCode));
  check("and is no longer gated on the trial balance",
    !/value=\{balance \? totalDiscrepancies : null\}/.test(uiCode));
  check("no `?? 0` remains in the discrepancy arithmetic",
    !/discrepancies\.length \?\? 0/.test(uiCode));

  /* TASK #20's DIMENSIONS ARE ACTUALLY FETCHED AND RENDERED. */
  check("the allocation reconciler is called",
    /reconcileAllocationInternal\(\)/.test(uiCode));
  check("the creator-earnings reconciler is called",
    /reconcileCreatorEarnings\(environment\)/.test(uiCode));
  check("both contribute to the discrepancy count",
    /allocation \? allocation\.discrepancies\.length : null/.test(uiCode) &&
      /earningsFindings \? earningsFindings\.length : null/.test(uiCode));
  check("and both have a table of their own",
    /ALLOCATION_COLS\(t\)/.test(uiCode) && /EARNINGS_COLS\(t\)/.test(uiCode));

  /* THE FEE DRIFT TABLE SHOWS THE DRIFT. */
  check("the fee-drift table has a fee delta column",
    /key: "feeDelta"/.test(uiCode) && /row\.deltaMinor/.test(uiCode));
  check("and a separate TAX delta column, which Task #20 made reportable",
    /key: "taxDelta"/.test(uiCode) && /row\.taxRemittanceDeltaMinor/.test(uiCode));
  check("both show posted and provider figures for context",
    /taxRemittancePostedMinor/.test(uiCode) && /taxRemittanceActualMinor/.test(uiCode));

  /* THE ENVIRONMENT COMES FROM THE SERVER. */
  check("the environment is read from server configuration",
    /const environment = getWhopEnvironment\(\)/.test(uiCode));
  check("and displayed, so figures can be interpreted",
    /label=\{t\.finance\.environmentLabel\}/.test(uiCode));
  check("the page accepts no environment from the browser",
    !/searchParams[\s\S]{0,200}environment/.test(uiCode) &&
      !/environment=/.test(uiCode));
}

/* ---------------------------------------------------------------- F ---- */
section("F. Finding codes render safely, including unknown ones");

{
  const uiCode = codeOnly("src/components/admin/FinanceSections.tsx");

  /* EVERY finding table prints the code as a plain string beside its detail.
   * That is what makes a code this build has never seen render instead of
   * disappearing through a lookup with no entry for it. */
  const codeRenders = uiCode.match(/render: \(row\) => <span className="font-mono text-\[11px\]">\{row\.(code|check)\}<\/span>/g) ?? [];
  check("every findings table prints the raw code, with no lookup to fall through",
    codeRenders.length >= 5, `${codeRenders.length} tables`);
  check("no finding table maps codes through a fixed dictionary",
    !/CODE_LABELS|FINDING_LABELS|codeLabel\[/.test(uiCode));

  /* THE DETAIL IS ALWAYS RENDERED, which is where Task #20's findings put the
   * figures an operator needs — "split moved 1080, settlement made 1000". */
  check("and always prints the accompanying detail",
    (uiCode.match(/header: t\.finance\.detailCol/g) ?? []).length >= 5);

  /* THE EARNINGS TABLE renders leftover fields generically, so a new variant of
   * that discriminated union arrives readable rather than blank. */
  check("the earnings table renders unknown variants' fields generically",
    /Object\.entries\(row as Record<string, unknown>\)/.test(uiCode));

  /* THE TASK #20 CODES ARE REACHABLE. They are not enumerated in the UI — which
   * is the point — so this asserts the backend still emits exactly them and the
   * table that renders them is fed the whole list. */
  const recon = src("src/lib/server/accounting/reconcile.ts");
  for (const code of [
    "allocation_duplicate",
    "allocation_amount_mismatch",
    "allocation_currency_mismatch",
    "suspense_residual",
    "absorbed_cost_misplaced",
    "allocation_without_settlement",
  ]) {
    check(`${code} is emitted by the reconciler the dashboard renders`,
      recon.includes(`"${code}"`));
  }
  check("and the allocation table is given every discrepancy, unfiltered",
    /rows=\{allocation\.discrepancies\}/.test(uiCode));
  check("mixed_currency_payable reaches the earnings table the same way",
    src("src/lib/server/creator-earnings-reconcile.ts").includes('"mixed_currency_payable"') &&
      /rows=\{earningsFindings\}/.test(uiCode));
}

/* ---------------------------------------------------------------- G ---- */
section("G. Repair actions: dry run by default, live confirmed");

{
  const ra = src("src/components/admin/RepairActions.tsx");
  const raCode = codeOnly("src/components/admin/RepairActions.tsx");

  check("it is a client component", /^"use client";/.test(ra));
  check("every run POSTs", /method: "POST"/.test(raCode));
  check("and sends dry_run explicitly, both ways",
    /body: JSON\.stringify\(\{ dry_run: dryRun \}\)/.test(raCode));

  /* THE DEFAULT. The dry-run button passes true; the live button is a separate
   * call that passes false and cannot be reached by accident. */
  check("the dry-run button requests a dry run",
    /onClick=\{\(\) => run\(target, true\)\}/.test(raCode));
  check("the live button is a distinct action",
    /onClick=\{\(\) => run\(target, false\)\}/.test(raCode));
  check("a live run is confirmed before it is sent",
    /if \(!dryRun && !window\.confirm\(/.test(raCode));
  check("and the confirmation names the endpoint being run",
    /window\.confirm\(`\$\{copy\.confirmLive\}\\n\\n\$\{target\.endpoint\}`\)/.test(raCode));

  /* HTTP SEMANTICS ARE PRESERVED. */
  check("a non-2xx response is a failure, with its status",
    /if \(!response\.ok\)/.test(raCode) && /status: response\.status/.test(raCode));
  check("and the server's own error name is shown",
    /body\?\.error/.test(raCode));
  /* THE ADMIN WRAPPER serialises an in-handler refusal as a 200 carrying
   * `{ error }`, so response.ok alone would read those as successes. */
  check("a 200 carrying an error is still treated as a failure",
    /if \(body\?\.error\)/.test(raCode));
  check("no branch reports success without inspecting the body",
    !/setNote\(\{ ok: true/.test(raCode));

  /* THE SERVER DECIDES WHICH MODE RAN. */
  check("the displayed mode comes from the server's dry_run, not the request",
    /const serverDryRun = body\?\.dry_run \?\? dryRun/.test(raCode));
  check("so a dry run cannot be reported as live",
    /serverDryRun \? copy\.dryRunBadge : copy\.liveBadge/.test(raCode));

  /* DOUBLE-SUBMIT. One run at a time across every button, because two live
   * repairs both post corrections. */
  check("a run is blocked while any run is in flight",
    /if \(busyId !== null \|\| pending\) return;/.test(raCode));
  check("and every button is disabled meanwhile",
    /const blocked = busyId !== null \|\| pending;/.test(raCode) &&
      (raCode.match(/disabled=\{blocked\}/g) ?? []).length === 2);
  check("with aria-busy for assistive technology",
    (raCode.match(/aria-busy=\{busy\}/g) ?? []).length === 2);

  /* REFRESH AFTER A REAL CHANGE. */
  check("a live run refreshes the page data from the server",
    /if \(!serverDryRun\) startTransition\(\(\) => router\.refresh\(\)\)/.test(raCode));
  /* A DRY RUN DOES NOT REFRESH, because it changed nothing — and the way to
   * assert that is to show there is exactly ONE refresh call and it sits behind
   * the `!serverDryRun` guard. An unguarded second call elsewhere would make the
   * positive assertion above true while still refreshing after a dry run. */
  check("there is exactly one refresh call, and it is the guarded one",
    (raCode.match(/router\.refresh\(\)/g) ?? []).length === 1,
    String((raCode.match(/router\.refresh\(\)/g) ?? []).length));
  check("nothing is patched into local state instead of re-reading",
    !/setBalance|setFindings|mutateLocal/.test(raCode));

  /* NO ALLOCATION REPAIR. Task #20 made those findings detection-only. */
  check("no repair action targets the allocation findings",
    !/repair\/allocation/.test(ra));

  const ui = src("src/components/admin/FinanceSections.tsx");
  check("the three real repair endpoints are wired as actions",
    /repair\/refunds"/.test(ui) && /repair\/disputes"/.test(ui) && /repair\/fees"/.test(ui));
  check("including the fee runner the dashboard never mentioned",
    /repairFeesLabel/.test(ui));
  check("and the repair endpoints are no longer duplicated as prose",
    (ui.match(/repair\/refunds/g) ?? []).length === 1);
  check("the allocation panel offers no repair button",
    /allocationFindingsHint/.test(ui) && !/RepairActions[\s\S]{0,400}allocation/.test(ui));
}

/* ---------------------------------------------------------------- H ---- */
section("H. Admin protection and server-only data");

{
  const page = src("src/app/[locale]/admin/finance/page.tsx");
  check("the finance page re-checks authorization itself",
    /getAdminPageContext/.test(page) && /if \(!ctx\.authorized\) return null;/.test(page));
  check("the dashboard body is a server component",
    /^import "server-only";/.test(src("src/components/admin/FinanceSections.tsx")));

  /* THE CLIENT COMPONENT RECEIVES LABELS AND URLS ONLY. No figures, no tokens,
   * no provider state — so nothing sensitive crosses the boundary. */
  const ra = src("src/components/admin/RepairActions.tsx");
  check("the client component imports no server module",
    !/@\/lib\/server/.test(ra));
  check("and receives only copy and endpoints as props",
    /targets: RepairTarget\[\]/.test(ra) && !/apiKey|token|secret|balance/i.test(ra));

  /* THE REPAIR ROUTES STILL GUARD THEMSELVES — the UI is not the security. */
  for (const r of ["refunds", "disputes", "fees"]) {
    const route = src(`src/app/api/admin/reconciliation/repair/${r}/route.ts`);
    check(`repair/${r} still checks origin and admin, and defaults to dry run`,
      /checkRequestOrigin/.test(route) &&
        /withAdminApi/.test(route) &&
        /body\.dry_run !== false/.test(route));
    check(`repair/${r} accepts no environment from the request`,
      !/body\.environment/.test(route));
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
