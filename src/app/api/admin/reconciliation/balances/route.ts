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
      balanced: result.balanced,
      grand_total: result.grandTotal.toString(),
      lines: result.lines.map((l) => ({
        account: l.account,
        total_minor: l.totalMinor.toString(),
        entry_count: l.entryCount,
      })),
    };
  });
}
