import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { writeAudit } from "@/lib/server/admin-audit";
import { recoverProviderFeeDrift } from "@/lib/server/accounting/fee-recovery";
import { FEE_DRIFT_MAX_PAGE } from "@/lib/server/accounting/reconcile";

/* ==========================================================================
   POST /api/admin/reconciliation/repair/fees

   Walks a bounded page of recent settlements and corrects the ones whose
   provider fee total no longer matches the journal. This is the batch
   counterpart of the single-payment endpoint under /api/admin/fees/reconcile.

   SAFE BY DEFAULT: `dry_run` defaults to true.
   With dry_run=true  → no writes; reports in_sync / would_post / failed.
   With dry_run=false → posts fee corrections, writes audit trail.

   Body (JSON, optional):
     { dry_run?: boolean, limit?: number, offset?: number }

   `limit` is clamped to FEE_DRIFT_MAX_PAGE, the drift scan's own maximum, so
   there is one bound in the codebase and not a second one here. Each candidate
   costs exactly one provider call in either mode, which is what the bound is
   really protecting.

   `offset` pages back through history. It is LIMIT/OFFSET, so it is NOT
   snapshot-safe: a settlement inserted between two requests shifts the window
   and a row can be seen twice or missed across pages. That is tolerable here
   because every operation this drives is idempotent — seeing a row twice costs
   nothing — but it is not a guarantee of full coverage.

   No `environment` is accepted from the body, matching the other repair routes:
   the environment comes from server configuration alone, so a request cannot
   aim this environment's provider at the other environment's books.

   Response:
     {
       dry_run: boolean,
       examined: number,
       outcomes: FeeRepairOutcome[]
     }
   ========================================================================== */

export const runtime = "nodejs";

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
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, FEE_DRIFT_MAX_PAGE) : 100;
  const offsetRaw = typeof body.offset === "number" ? body.offset : 0;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  return withAdminApi(async (admin) => {
    const report = await recoverProviderFeeDrift({ limit, offset, dryRun });

    if (!dryRun) {
      await writeAudit({
        adminUid: admin.uid,
        adminEmail: admin.email,
        action: "repair_fee_postings",
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
