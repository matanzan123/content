import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { ledgerTrialBalance } from "@/lib/server/accounting/reconcile";

/* ==========================================================================
   GET /api/admin/reconciliation/balances

   Runs the ledger trial balance: sums every accounting_entries row by account
   and verifies the grand total is zero (double-entry invariant).

   No network calls — pure arithmetic on the local journal.

   Response:
     {
       configured: boolean,
       balanced: boolean,
       grand_total: string,    ← BigInt serialised as decimal string
       lines: [{
         account: string,
         total_minor: string,  ← BigInt serialised as decimal string
         entry_count: number
       }]
     }
   ========================================================================== */

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  return withAdminApi(async () => {
    const result = await ledgerTrialBalance();
    return {
      configured: result.configured,
      /* THE ENVIRONMENT THESE FIGURES DESCRIBE, reported so a reader can never
       * mistake one environment's ledger for the other's. It comes from server
       * configuration; no request may choose it. */
      environment: result.environment,
      balanced: result.balanced,
      /* ONE TOTAL PER CURRENCY. A single `grand_total` was a sum across
       * denominations, which is not a number. Every entry must be zero for the
       * ledger to balance. */
      grand_totals: result.grandTotals.map((g) => ({
        currency: g.currency,
        total_minor: g.totalMinor.toString(),
      })),
      lines: result.lines.map((l) => ({
        account: l.account,
        currency: l.currency,
        total_minor: l.totalMinor.toString(),
        entry_count: l.entryCount,
      })),
    };
  });
}
