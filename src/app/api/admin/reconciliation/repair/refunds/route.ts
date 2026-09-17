import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import { recoverMissingRefundPostings } from "@/lib/server/accounting/refund-recovery";

/* ==========================================================================
   POST /api/admin/reconciliation/repair/refunds

   Finds every completed refund with no accounting transaction and (re-)posts
   the missing journal entry via the normal posting pipeline.

   SAFE BY DEFAULT: `dry_run` defaults to true.
   With dry_run=true  → no writes, returns what would happen.
   With dry_run=false → posts missing transactions, writes audit trail.

   Body (JSON, optional):
     { dry_run?: boolean, limit?: number }

   Response:
     {
       dry_run: boolean,
       examined: number,
       outcomes: RefundRecoveryOutcome[]
     }
   ========================================================================== */

export const runtime = "nodejs";

const MAX_LIMIT = 500;

export async function POST(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  const dryRun = body.dry_run !== false;
  const limitRaw = typeof body.limit === "number" ? body.limit : 100;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : 100;

  return withAdminApi(async (admin) => {
    const report = await recoverMissingRefundPostings({ limit, dryRun });

    if (!dryRun) {
      await writeAudit({
        adminUid: admin.uid,
        adminEmail: admin.email,
        action: "repair_refund_postings",
        targetType: "user",
        targetId: admin.uid,
        metadata: { examined: report.examined, dry_run: false },
      });
    }

    return {
      dry_run: dryRun,
      examined: report.examined,
      outcomes: report.outcomes,
    };
  });
}
