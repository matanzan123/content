import { withAdminApi } from "@/lib/server/admin-guard";
import { checkRequestOrigin } from "@/lib/server/request-origin";
import { querySandboxAudit } from "@/lib/server/sandbox-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  if (!checkRequestOrigin(request.headers).ok) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  return withAdminApi(async () => {
    const data = await querySandboxAudit();
    if (!data) {
      return Response.json({ ok: false, error: "db_unavailable" }, { status: 503, headers: NO_STORE });
    }
    return Response.json({ ok: true, data }, { status: 200, headers: NO_STORE });
  });
}
