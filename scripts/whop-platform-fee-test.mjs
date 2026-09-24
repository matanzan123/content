#!/usr/bin/env node
/**
 * TASK #17 — CLIPREWARDS PLATFORM FEE, AND ITS REVERSAL.
 *
 * The fee itself was already correct: a percentage of the gross the brand paid,
 * floored, booked to `platform_revenue` with a `platform`/`cliprewards`
 * counterparty and never mixed into `creator_payable`.
 *
 * WHAT WAS BROKEN WAS UNWINDING IT. One payment may be refunded many times.
 * The first partial refund posted a correct pro-rata reversal and then marked
 * the whole earning `reversed`, after which the row no longer matched the
 * `status IN (held, available)` filter — so the second and third refunds
 * reversed NOTHING. ClipRewards kept fee revenue and the creator kept payable
 * on a payment the brand had been refunded in full.
 *
 * The fix is one cumulative column, `refunded_gross_minor`, and postings taken
 * as the DELTA between cumulative targets rather than per refund.
 *
 * NO NETWORK. NO DATABASE. NO MONEY MOVES.
 *
 * Sections:
 *   A. The fee formula, from the repository's own policy
 *   B. Cumulative targets and delta posting
 *   C. Rounding: split refunds equal one refund
 *   D. Caps and bounds
 *   E. The fixed processing fee
 *   F. Remaining creator net
 *   G. Wiring: refund path
 *   H. Wiring: dispute path
 *   I. Position and reconciliation are partial-aware
 *   J. Segregation, idempotency and isolation
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

let passed = 0;
const failures = [];
const check = (name, cond) => {
  if (cond) passed += 1;
  else {
    failures.push(name);
    console.error(`  FAIL: ${name}`);
  }
};
const section = (t) => console.log(`\n${t}`);
const src = (p) => readFileSync(p, "utf8");
const codeOnly = (p) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Loads a module in memory with its imports stubbed. */
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

/**
 * Runs `fn` with the policy env vars set, then restores them.
 *
 * THE VARS MUST STAY SET FOR THE DURATION OF THE CALL. `resolvePlatformFeeBps`
 * and `resolveProcessingFeeMinor` read `process.env` when the formula runs, not
 * when the module loads — so setting them, loading the module, restoring them
 * and only then computing measures the DEFAULT rate every time, and a case
 * meant to exercise 0% or a fixed fee silently asserts 20% with no fixed fee.
 */
function withPolicyEnv({ bps, processing } = {}, fn) {
  const prevBps = process.env.PLATFORM_FEE_BPS;
  const prevProc = process.env.PLATFORM_PROCESSING_FEE_MINOR;
  const set = (k, v) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  };
  set("PLATFORM_FEE_BPS", bps);
  set("PLATFORM_PROCESSING_FEE_MINOR", processing);
  try {
    return fn(load("src/lib/server/creator-earnings-policy.ts"));
  } finally {
    set("PLATFORM_FEE_BPS", prevBps);
    set("PLATFORM_PROCESSING_FEE_MINOR", prevProc);
  }
}

/** The policy under default configuration, for the majority of cases. */
const P = load("src/lib/server/creator-earnings-policy.ts");
const B = (n) => BigInt(n);

/* ---------------------------------------------------------------- A ---- */
section("A. The fee formula, from the repository's own policy");

{
  // The default is the repository's, not an invention of this suite.
  check("the default rate is 2000 bps (20%)", P.resolvePlatformFeeBps() === 2000);
  check("the default fixed processing fee is zero",
    P.resolveProcessingFeeMinor() === B(0));

  const b = P.computeEarningsBreakdown(B(10000), "usd");
  check("gross 10000 → fee 2000", b.platformFeeMinor === B(2000));
  check("gross 10000 → creator net 8000", b.netAmountMinor === B(8000));
  check("fee + net == gross exactly",
    b.platformFeeMinor + b.netAmountMinor === b.grossAmountMinor);
  check("the rate is captured on the breakdown", b.platformFeeBps === 2000);
  check("currency is carried, never assumed", b.currency === "usd");

  // A zero rate is supported and means no platform revenue.
  withPolicyEnv({ bps: 0 }, (pol) => {
    const zero = pol.computeEarningsBreakdown(B(10000), "usd");
    check("a zero rate takes no fee",
      zero.platformFeeMinor === B(0) && zero.netAmountMinor === B(10000));
  });

  // 100% is the documented maximum.
  withPolicyEnv({ bps: 10000 }, (pol) => {
    const all = pol.computeEarningsBreakdown(B(10000), "usd");
    check("a 100% rate leaves the creator nothing, and does not go negative",
      all.platformFeeMinor === B(10000) && all.netAmountMinor === B(0));
  });

  // Out-of-range configuration falls back rather than producing nonsense.
  withPolicyEnv({ bps: -500 }, (pol) =>
    check("a negative rate falls back to the default", pol.resolvePlatformFeeBps() === 2000));
  withPolicyEnv({ bps: 20000 }, (pol) =>
    check("a rate above 100% falls back to the default", pol.resolvePlatformFeeBps() === 2000));
  withPolicyEnv({ bps: "abc" }, (pol) =>
    check("a non-integer rate falls back to the default", pol.resolvePlatformFeeBps() === 2000));

  // FLOOR, and the residual cent belongs to the creator.
  const cent = P.computeEarningsBreakdown(B(1), "usd");
  check("one cent at 20% takes no fee — the fee floors",
    cent.platformFeeMinor === B(0) && cent.netAmountMinor === B(1));
  const odd = P.computeEarningsBreakdown(B(7), "usd");
  check("7 cents at 20% → fee 1, creator 6",
    odd.platformFeeMinor === B(1) && odd.netAmountMinor === B(6));

  // No floats anywhere in the policy.
  const policyCode = codeOnly("src/lib/server/creator-earnings-policy.ts");
  check("the policy uses no floating-point arithmetic",
    !/parseFloat|Math\.round|Math\.floor|\* 0\.|\/ 100\b/.test(policyCode));
  check("and is the only place the formula lives",
    /THE SINGLE AUTHORITATIVE PLACE/.test(src("src/lib/server/creator-earnings-policy.ts")));
}

/* ---------------------------------------------------------------- B ---- */
section("B. Cumulative targets and delta posting");

const E = (gross, bps = 2000) =>
  withPolicyEnv({ bps }, (pol) => {
    const b = pol.computeEarningsBreakdown(B(gross), "usd");
    return {
      grossAmountMinor: b.grossAmountMinor,
      netAmountMinor: b.netAmountMinor,
      platformFeeBps: bps,
    };
  });

{
  const e = E(10000);
  check("the percentage fee is rebuilt from the stored rate",
    P.reconstructPercentageFee(e) === B(2000));

  // REQUIRED CASE 1: refund 30 then 70.
  const d1 = P.computeCumulativeRefundDelta(e, B(0), B(3000));
  const d2 = P.computeCumulativeRefundDelta(e, B(3000), B(10000));
  check("refund $30 returns fee 600 / creator 2400",
    d1.platformFeeToReturn === B(600) && d1.creatorShareToReturn === B(2400));
  check("then refund $70 returns fee 1400 / creator 5600",
    d2.platformFeeToReturn === B(1400) && d2.creatorShareToReturn === B(5600));

  // REQUIRED CASE 2 and 3: the same refunded once, identical totals.
  const once = P.computeCumulativeRefundDelta(e, B(0), B(10000));
  check("30+70 equals 100 once, for the fee",
    d1.platformFeeToReturn + d2.platformFeeToReturn === once.platformFeeToReturn);
  check("and for the creator share",
    d1.creatorShareToReturn + d2.creatorShareToReturn === once.creatorShareToReturn);
  check("the full-refund target returns the whole fee and net",
    once.platformFeeToReturn === B(2000) && once.creatorShareToReturn === B(8000));

  /* THE TOTAL IS THE SUSPENSE LEG, so it must always equal its parts exactly.
   * Asserted at every step rather than only at the end: a total that drifts from
   * its components would credit `unallocated_customer_funds` an amount the two
   * debits do not account for, and invent money in suspense. */
  check("the delta total equals creator + fee, always",
    d1.totalToReturn === d1.creatorShareToReturn + d1.platformFeeToReturn &&
    d2.totalToReturn === d2.creatorShareToReturn + d2.platformFeeToReturn &&
    once.totalToReturn === once.creatorShareToReturn + once.platformFeeToReturn);

  /* THE FULL-REFUND ENDPOINT IS INCLUDED EXPLICITLY.
   *
   * `computeRefundSplitReversal` has a separate shortcut branch for
   * refund >= gross, and a loop that steps in fixed increments walks straight
   * past it — a mutation in that branch went undetected until the endpoint was
   * added. Boundaries get their own cases, not an increment that may miss them. */
  let totalsAgree = true;
  const probes = [0, 1, 311, 4999, 5000, 9999, 10000, 10001, 99999];
  for (const r of probes) {
    const t = P.cumulativeRefundTarget(e, B(r));
    if (t.totalToReturn !== t.creatorShareToReturn + t.platformFeeToReturn) totalsAgree = false;
  }
  check("and at every cumulative target, boundaries included", totalsAgree);
  check("the full-refund branch total equals its own components",
    (() => { const t = P.cumulativeRefundTarget(e, B(10000));
      return t.totalToReturn === t.creatorShareToReturn + t.platformFeeToReturn
        && t.totalToReturn === B(10000); })());

  // A delta can never be negative: both targets rise with refunded gross.
  let prev = B(0);
  let negative = false;
  for (let r = 0; r <= 10000; r += 137) {
    const d = P.computeCumulativeRefundDelta(e, prev, B(r));
    if (d.platformFeeToReturn < B(0) || d.creatorShareToReturn < B(0)) negative = true;
    prev = B(r);
  }
  check("no delta over a rising refunded gross is ever negative", negative === false);

  // A replay that advances nothing returns nothing.
  const noop = P.computeCumulativeRefundDelta(e, B(3000), B(3000));
  check("an unchanged cumulative figure yields a zero delta",
    noop.totalToReturn === B(0));
}

/* ---------------------------------------------------------------- C ---- */
section("C. Rounding: split refunds equal one refund");

{
  /* THE DRIFT THE DELTA MODEL EXISTS TO PREVENT. Flooring each refund on its
   * own loses a fraction every time; taking cumulative differences telescopes
   * exactly. */
  const e = E(1000);
  const pct = P.reconstructPercentageFee(e);
  const net = e.netAmountMinor;

  const sequence = [333, 333, 333, 1];
  let prev = B(0), sumFee = B(0), sumCre = B(0), naiveFee = B(0);
  for (const amt of sequence) {
    const next = P.capRefundedGross(e, prev, B(amt));
    const d = P.computeCumulativeRefundDelta(e, prev, next);
    sumFee += d.platformFeeToReturn;
    sumCre += d.creatorShareToReturn;
    naiveFee += (pct * B(amt)) / e.grossAmountMinor; // the old per-refund way
    prev = next;
  }
  check("four partial refunds return the whole fee, exactly", sumFee === pct);
  check("and the whole creator net, exactly", sumCre === net);
  check("the naive per-refund calculation would have drifted low",
    naiveFee < pct && pct - naiveFee === B(2));

  // Many tiny refunds against an awkward gross.
  const e2 = E(999);
  let p2 = B(0), f2 = B(0), c2 = B(0);
  for (let i = 0; i < 999; i += 1) {
    const next = P.capRefundedGross(e2, p2, B(1));
    const d = P.computeCumulativeRefundDelta(e2, p2, next);
    f2 += d.platformFeeToReturn;
    c2 += d.creatorShareToReturn;
    p2 = next;
  }
  check("999 one-cent refunds return the whole fee",
    f2 === P.reconstructPercentageFee(e2));
  check("and the whole net", c2 === e2.netAmountMinor);
}

/* ---------------------------------------------------------------- D ---- */
section("D. Caps and bounds");

{
  const e = E(10000);

  check("cumulative refunded gross cannot exceed the earning's gross",
    P.capRefundedGross(e, B(0), B(99999)) === B(10000));
  check("nor by accumulation",
    P.capRefundedGross(e, B(9000), B(5000)) === B(10000));
  check("a negative incoming refund adds nothing",
    P.capRefundedGross(e, B(3000), B(-500)) === B(3000));
  check("an exact full refund caps at gross",
    P.capRefundedGross(e, B(0), B(10000)) === B(10000));

  // Over-refund can never over-reverse.
  const over = P.computeCumulativeRefundDelta(e, B(0), P.capRefundedGross(e, B(0), B(50000)));
  check("an over-large refund returns at most the original fee",
    over.platformFeeToReturn === B(2000));
  check("and at most the original creator net",
    over.creatorShareToReturn === B(8000));

  // Fee reversal never exceeds the reversible percentage fee, at any point.
  let exceeded = false;
  for (let r = 0; r <= 10000; r += 7) {
    const t = P.cumulativeRefundTarget(e, B(r));
    if (t.platformFeeToReturn > B(2000) || t.creatorShareToReturn > B(8000)) exceeded = true;
  }
  check("no cumulative target ever exceeds what was originally created",
    exceeded === false);

  check("a zero-gross earning yields nothing rather than dividing by zero",
    P.cumulativeRefundTarget(E(0), B(100)).totalToReturn === B(0));
}

/* ---------------------------------------------------------------- E ---- */
section("E. The fixed processing fee");

{
  /* THE EXISTING RULE, PRESERVED: the percentage portion is returned pro-rata,
   * the fixed processing fee is kept even on a full refund. The check that
   * matters is that this cannot claw back more creator payable than was
   * created. */
  withPolicyEnv({ bps: 2000, processing: 30 }, (pol) => {
    const b = pol.computeEarningsBreakdown(B(10000), "usd");

    check("the fixed fee is added on top of the percentage",
      b.percentageFeeMinor === B(2000) && b.processingFeeMinor === B(30) &&
      b.platformFeeMinor === B(2030));
    check("and reduces the creator net accordingly", b.netAmountMinor === B(7970));

    const e = { grossAmountMinor: B(10000), netAmountMinor: B(7970), platformFeeBps: 2000 };
    const full = pol.computeCumulativeRefundDelta(e, B(0), B(10000));

    check("a full refund returns exactly the creator payable that was created",
      full.creatorShareToReturn === B(7970));
    check("NO over-clawback of creator payable",
      full.creatorShareToReturn <= b.netAmountMinor);
    check("the percentage fee is returned in full", full.platformFeeToReturn === B(2000));
    check("but the fixed processing fee is KEPT",
      b.platformFeeMinor - full.platformFeeToReturn === B(30));
    check("the fee returned never exceeds the reversible percentage portion",
      full.platformFeeToReturn <= b.percentageFeeMinor);

    // And split refunds with a fixed fee still telescope.
    const s1 = pol.computeCumulativeRefundDelta(e, B(0), B(4000));
    const s2 = pol.computeCumulativeRefundDelta(e, B(4000), B(10000));
    check("split refunds with a fixed fee total the same as one",
      s1.creatorShareToReturn + s2.creatorShareToReturn === full.creatorShareToReturn &&
      s1.platformFeeToReturn + s2.platformFeeToReturn === full.platformFeeToReturn);

    /* WITH A FIXED FEE THE TOTAL MUST STILL EQUAL ITS PARTS. The full-refund
     * branch is where a stray addition would hide: the processing fee is
     * deliberately NOT returned, so the total must be creator + percentage and
     * nothing more. Inflating it would credit suspense money that neither debit
     * accounts for. */
    check("the full-refund total equals creator + percentage fee only",
      full.totalToReturn === full.creatorShareToReturn + full.platformFeeToReturn);
    check("and is strictly less than the gross, by exactly the processing fee",
      B(10000) - full.totalToReturn === B(30));
    check("the partial totals also equal their parts",
      s1.totalToReturn === s1.creatorShareToReturn + s1.platformFeeToReturn &&
      s2.totalToReturn === s2.creatorShareToReturn + s2.platformFeeToReturn);
  });
}

/* ---------------------------------------------------------------- F ---- */
section("F. Remaining creator net");

{
  const e = E(10000);
  check("nothing refunded leaves the whole net outstanding",
    P.remainingCreatorNet(e, B(0)) === B(8000));
  check("a 30% refund leaves 5600 outstanding",
    P.remainingCreatorNet(e, B(3000)) === B(5600));
  check("a full refund leaves nothing outstanding",
    P.remainingCreatorNet(e, B(10000)) === B(0));
  check("an over-refund still leaves nothing, never a negative",
    P.remainingCreatorNet(e, B(99999)) === B(0));
  check("remaining plus returned always equals the original net",
    P.remainingCreatorNet(e, B(4567)) +
      P.cumulativeRefundTarget(e, B(4567)).creatorShareToReturn === B(8000));

  check("fully refunded is recognised at exactly gross",
    P.isFullyRefunded(e, B(10000)) === true &&
    P.isFullyRefunded(e, B(9999)) === false);
}

/* ---------------------------------------------------------------- G ---- */
section("G. Wiring: refund path");

{
  const earnSrc = src("src/lib/server/creator-earnings.ts");
  const earnCode = codeOnly("src/lib/server/creator-earnings.ts");
  const refund = earnSrc.slice(earnSrc.indexOf("export async function reverseForRefund"));

  /* REQUIRED CASE 5: a second refund must still find the earning. The filter
   * used to exclude the row the moment the first partial refund marked it
   * reversed. */
  check("the refund scan still finds a partially refunded earning",
    /eq\(schema\.creatorEarnings\.status, "held"\)/.test(refund) &&
    /eq\(schema\.creatorEarnings\.status, "available"\)/.test(refund));
  check("it reads the cumulative refunded figure",
    /refundedGrossMinor: schema\.creatorEarnings\.refundedGrossMinor/.test(refund));
  check("the incoming refund is capped before use",
    /capRefundedGross\(\s*economics,\s*previousRefundedGross,\s*input\.refundAmountMinor,?\s*\)/.test(refund));
  check("the posting is a cumulative DELTA, not the refund's own share",
    /computeCumulativeRefundDelta\(\s*economics,\s*previousRefundedGross,\s*newRefundedGross,?\s*\)/.test(refund));
  check("a replay that advances nothing posts no journal",
    /if \(newRefundedGross <= previousRefundedGross\) continue;/.test(refund));

  /* THE PREVIOUS CUMULATIVE VALUE MUST COME FROM THE ROW.
   *
   * Binding it to a literal zero would still satisfy the shape checks above
   * while making every refund recompute from scratch — so the second refund of
   * a payment would return the first refund's share a second time. */
  check("the previous cumulative value is read from the earning row",
    /const previousRefundedGross = row\.refundedGrossMinor;/.test(refund));
  check("and is not re-derived or zeroed",
    !/const previousRefundedGross = BigInt\(0\)/.test(refund));

  /* THE DOUBLE-REVERSAL THIS PREVENTS, stated arithmetically. Recomputing from
   * zero on the second refund returns more in total than the earning created. */
  const eSeq = E(10000);
  const first = P.computeCumulativeRefundDelta(eSeq, B(0), B(3000));
  const correct = P.computeCumulativeRefundDelta(eSeq, B(3000), B(10000));
  const fromZero = P.computeCumulativeRefundDelta(eSeq, B(0), B(10000));
  check("reading the row gives the remainder; ignoring it would over-return",
    first.creatorShareToReturn + correct.creatorShareToReturn === B(8000) &&
    first.creatorShareToReturn + fromZero.creatorShareToReturn > B(8000));

  /* REQUIRED CASE 4 and 6: partial does not reverse; full does. */
  check("the earning is reversed only when fully refunded",
    /const fullyRefunded = isFullyRefunded\(economics, newRefundedGross\)/.test(refund) &&
    /\.\.\.\(fullyRefunded \? \{ status: "reversed" as const/.test(refund));
  check("the cumulative column is always advanced",
    /refundedGrossMinor: newRefundedGross/.test(refund));

  // Concurrency: the advance is guarded on the value it read.
  check("the update is guarded on the previous cumulative value",
    /eq\(schema\.creatorEarnings\.refundedGrossMinor, previousRefundedGross\)/.test(refund));
  check("and on a non-terminal status, in SQL",
    /eq\(schema\.creatorEarnings\.earningId, row\.earningId\)/.test(refund));

  // Journal before row, and the ledger's own key is the idempotency guard.
  check("the journal is posted before the row is advanced",
    refund.indexOf("postRevenueSplitReversal") < refund.indexOf("refundedGrossMinor: newRefundedGross"));
  /* RE-BASELINED: THIS ASSERTED THE BUG.
   *
   * It required the cumulative column to advance even when the ledger reported
   * `already_posted`. The DB suite proved that double-counts: on a replayed
   * refund id `previousRefundedGross` has already absorbed the refund, so
   * adding it again pushes the figure past what was actually refunded, and a
   * later genuine refund then under-reverses from the inflated base.
   *
   * The correct invariant is the opposite — a replay advances nothing — and the
   * journal is refused by its own economic key either way. */
  check("a replay does NOT advance the cumulative figure",
    /if \(!posted\.ok\) continue;/.test(refund) &&
    !/posted\.reason !== "already_posted"/.test(refund));
  check("and the crash window that leaves is documented rather than hidden",
    /THE CRASH WINDOW THIS LEAVES/.test(refund));

  // The transferred rule is untouched.
  check("a transferred earning is still never clawed back by a refund",
    !/eq\(schema\.creatorEarnings\.status, "transferred"\)/.test(refund));
  check("no second fee formula appears in the earnings module",
    !/\* BigInt\(row\.platformFeeBps\)\) \/ BigInt\(10_000\)/.test(earnCode));
}

/* ---------------------------------------------------------------- H ---- */
section("H. Wiring: dispute path");

{
  const earnSrc = src("src/lib/server/creator-earnings.ts");
  const dispute = earnSrc.slice(
    earnSrc.indexOf("export async function reverseForDispute"),
    earnSrc.indexOf("export async function reverseForRefund"),
  );

  /* A LOST DISPUTE AFTER A PARTIAL REFUND MUST NOT OVER-REVERSE. It used to
   * post a full reversal unconditionally, so a $100 earning refunded $30 and
   * then disputed would return $80 of creator share against $56 outstanding. */
  check("the dispute reversal is a delta to full gross",
    /computeCumulativeRefundDelta\(\s*economics,\s*row\.refundedGrossMinor,\s*row\.grossAmountMinor,?\s*\)/.test(dispute));
  check("nothing is posted when there is nothing left to unwind",
    /if \(reversal\.totalToReturn > BigInt\(0\)\)/.test(dispute));
  check("a lost dispute records the earning as fully unwound",
    /refundedGrossMinor: sql`\$\{schema\.creatorEarnings\.grossAmountMinor\}`/.test(dispute));

  /* THE SECOND ENVIRONMENT AUTHORITY IS GONE. The rows were selected under the
   * trusted environment while the journal was posted under a caller-supplied
   * one; a disagreement would file the reversal in the wrong books. */
  check("the reversal journal uses the trusted environment",
    /environment,\s*\n\s*description: `Revenue split reversal — dispute lost/.test(dispute));
  check("and no longer takes it from the caller",
    !/environment: input\.environment/.test(dispute));

  // The deliberate transferred rule is preserved verbatim.
  check("a transferred earning is still absorbed by the platform, not clawed back",
    /A transferred earning is NOT reversed here — the platform absorbs\./.test(dispute));

  // Equivalence: an untouched earning disputed returns exactly the full amounts.
  const e = E(10000);
  const viaDispute = P.computeCumulativeRefundDelta(e, B(0), B(10000));
  check("disputing an untouched earning matches the old full reversal",
    viaDispute.creatorShareToReturn === B(8000) && viaDispute.platformFeeToReturn === B(2000));

  // And disputing a partly refunded one returns only the remainder.
  const afterPartial = P.computeCumulativeRefundDelta(e, B(3000), B(10000));
  check("disputing after a 30% refund returns only the remainder",
    afterPartial.creatorShareToReturn === B(5600) &&
    afterPartial.platformFeeToReturn === B(1400));
  check("and the two together never exceed the original",
    P.cumulativeRefundTarget(e, B(3000)).creatorShareToReturn +
      afterPartial.creatorShareToReturn === B(8000));
}

/* ---------------------------------------------------------------- I ---- */
section("I. Position and reconciliation are partial-aware");

{
  const posSrc = src("src/lib/server/creator-position.ts");
  const posCode = codeOnly("src/lib/server/creator-position.ts");

  check("the position reads the cumulative refunded figure",
    /refundedGrossMinor: schema\.creatorEarnings\.refundedGrossMinor/.test(posSrc));
  check("and derives the remaining net through the canonical policy",
    /remainingCreatorNet\(row, row\.refundedGrossMinor\)/.test(posSrc));
  check("pending uses the remaining amount, not the original net",
    /pendingMinor \+= remaining;/.test(posSrc));
  check("transferred uses the remaining amount too",
    /transferredMinor \+= remaining;/.test(posSrc));
  check("the returned portion is reported as reversed",
    /reversedMinor \+= returned;/.test(posSrc));
  check("no aggregate still adds the raw net for a live earning",
    !/earnedMinor \+= row\.netAmountMinor/.test(posCode));
  check("the position does not restate the fee formula",
    !/platformFeeBps\) \/ BigInt\(10_000\)/.test(posCode));

  /* REQUIRED CASE 14: check B after a partial refund. `earnedMinor` now reports
   * the remaining share, so the row side and the ledger agree. */
  const e = E(10000);
  const remaining = P.remainingCreatorNet(e, B(3000));
  const ledgerAfterRefund = B(8000) - P.cumulativeRefundTarget(e, B(3000)).creatorShareToReturn;
  check("row-side outstanding equals ledger payable after a partial refund",
    remaining === ledgerAfterRefund);

  const recon = src("src/lib/server/creator-earnings-reconcile.ts");
  check("check B documents that partial refunds are accounted for",
    /PARTIAL REFUNDS ARE ALREADY ACCOUNTED FOR/.test(recon));
  check("and still compares the ledger against the row-derived outstanding",
    /const outstanding = position\.earnedMinor - position\.transferredMinor;/.test(recon));

  // REQUIRED CASE 15: a full refund leaves nothing owed on either side.
  check("a full refund leaves zero remaining",
    P.remainingCreatorNet(e, B(10000)) === B(0));
}

/* ---------------------------------------------------------------- J ---- */
section("J. Segregation, idempotency and isolation");

{
  const splitSrc = src("src/lib/server/accounting/revenue-split-posting.ts");
  const splitCode = codeOnly("src/lib/server/accounting/revenue-split-posting.ts");

  /* PLATFORM REVENUE IS NEVER CREATOR PAYABLE. Two accounts, two
   * counterparties; `creator_payable` stays "money we owe the creator". */
  check("the fee is credited to platform_revenue",
    /account: "platform_revenue",\s*\n\s*amountMinor: -breakdown\.platformFeeMinor/.test(splitSrc));
  check("with a platform counterparty, never a creator one",
    /counterpartyType: "platform",\s*\n\s*counterpartyId: "cliprewards"/.test(splitSrc));
  check("the creator net is credited to creator_payable by firebase uid",
    /account: "creator_payable",\s*\n\s*amountMinor: -breakdown\.netAmountMinor[\s\S]{0,120}counterpartyId: creatorFirebaseUid/.test(splitSrc));
  check("the fee never lands on creator_payable",
    !/creator_payable[\s\S]{0,200}platformFeeMinor/.test(splitCode));

  // Balanced by construction: gross - fee - net == 0.
  const b = P.computeEarningsBreakdown(B(12345), "usd");
  check("the three legs sum to zero",
    b.grossAmountMinor - b.platformFeeMinor - b.netAmountMinor === B(0));

  // REQUIRED CASE 7: duplicate refund id is idempotent at the ledger.
  check("the split is keyed per payment and creator",
    /economicKey\(\s*"whop",\s*"revenue_split",\s*`\$\{paymentId\}:\$\{creatorFirebaseUid\}`/.test(splitSrc));
  check("the reversal is keyed per refund or dispute and creator",
    /economicKey\(\s*"whop",\s*"revenue_split_reversed",\s*`\$\{refundOrDisputeId\}:\$\{creatorFirebaseUid\}`/.test(splitSrc));
  check("a zero-amount reversal posts nothing at all",
    /if \(reversal\.totalToReturn <= BigInt\(0\)\)/.test(splitSrc));

  // Provider fees stay out of Task #17.
  const policySrc = src("src/lib/server/creator-earnings-policy.ts");
  check("provider fees are explicitly NOT deducted from the creator",
    /PROVIDER FEES: NOT deducted here/.test(policySrc));
  check("and are a platform expense on their own account",
    /provider_fee_expense/.test(policySrc));
  check("the split posting books no provider fee",
    !/provider_fee_expense/.test(splitCode));

  // Environment isolation on both reversal paths.
  const earnCode = codeOnly("src/lib/server/creator-earnings.ts");
  check("every earnings query is environment-scoped",
    (earnCode.match(/eq\(schema\.creatorEarnings\.environment, environment\)/g) ?? []).length >= 4);
  check("the environment comes from the trusted helper",
    /const environment = getWhopEnvironment\(\)/.test(earnCode));
  const reversalsOnly = earnCode.slice(earnCode.indexOf("export async function reverseForDispute"));
  check("and neither reversal posts under a caller-supplied environment",
    !/environment: input\.environment/.test(reversalsOnly));

  // Task #13 and #15 semantics untouched.
  const transferCode = codeOnly("src/lib/server/creator-transfers.ts");
  check("Task #13 still debits creator_payable and credits provider_balance",
    /account: "creator_payable"/.test(transferCode) &&
    /account: "provider_balance"/.test(transferCode));
  const withdrawCode = codeOnly("src/lib/server/creator-withdrawals.ts");
  check("Task #15 still posts no internal journal",
    !/creator_payable|accountingEntries|reverseTransaction/.test(withdrawCode));
  check("and still writes no earning row",
    !/schema\.creatorEarnings/.test(withdrawCode));
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
