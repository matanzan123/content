import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { reconcilePayoutsAgainstProvider } from "@/lib/server/accounting/reconcile";

/* ==========================================================================
   GET /api/admin/reconciliation/payouts

   Compares Whop's recent payout list against our `payout_sent` journal entries.

   Query params:
     limit  — how many payouts to fetch from Whop (default 100, max 500)

   NOTE: `payout_sent` postings do not yet exist in this build — the posting
   rule is unimplemented. Every completed Whop payout will therefore appear as
   `payout_missing_ledger` until that posting rule is added. This endpoint
   detects the gap and measures its size.

   Response:
     {
       payouts_checked: number,
       ledger_payouts_checked: number,
       provider_consulted: boolean,
       findings: PayoutDiscrepancy[]
     }
   ========================================================================== */

export const runtime = "nodejs";

const MAX_LIMIT = 500;

export async function GET(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit") ?? "100");
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : 100;

  return withAdminApi(async () => {
    const report = await reconcilePayoutsAgainstProvider(limit);
    return {
      payouts_checked: report.payoutsChecked,
      ledger_payouts_checked: report.ledgerPayoutsChecked,
      provider_consulted: report.providerConsulted,
      findings: report.discrepancies,
    };
  });
}
